package mail

import (
	"bufio"
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"errors"
	"fmt"
	"io"
	"math/big"
	"mime"
	"mime/multipart"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// 假服务器用的固定凭据（测试值，不是真实凭据）：断言 AUTH 带的就是配置里的
// 账户与密码，且任何错误文案都不得回显密码。
const (
	testSMTPUser = "service@test.example"
	testSMTPPass = "client-pass-not-a-real-one"
)

// smtpKeySet / graphKeySet 是两套凭据键的完整形态，测试往里删键造缺键态。
func smtpKeySet(host, port string) map[string]string {
	return map[string]string{
		smtpHostKey: host,
		smtpPortKey: port,
		smtpUserKey: testSMTPUser,
		smtpPassKey: testSMTPPass,
	}
}

func graphKeySet() map[string]string {
	return map[string]string{
		graphTenantKey: "11111111-2222-3333-4444-555555555555",
		graphClientKey: "test-client-id",
		graphSecretKey: "test-client-secret",
	}
}

// senderWith 拼一个测试发送器：cfg 注入键表；smtpTLSConfig 只信测试自签证书
//（InsecureSkipVerify 的前提仅是本地假服务器，生产该字段恒 nil）。
func senderWith(keys map[string]string) *Sender {
	return &Sender{
		client:        &http.Client{Timeout: 5 * time.Second},
		cfg:           func(k string) string { return keys[k] },
		smtpTLSConfig: &tls.Config{InsecureSkipVerify: true},
	}
}

// selfSignedCert 生成只服务本测试的自签证书（SAN 带 127.0.0.1）：假 SMTP 服务器
// 起 TLS 监听用。凭据、真实网络、真实证书都不进测试。
func selfSignedCert(t *testing.T) tls.Certificate {
	t.Helper()
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("生成测试密钥: %v", err)
	}
	tmpl := x509.Certificate{
		SerialNumber:          big.NewInt(1),
		Subject:               pkix.Name{CommonName: "smtp-test"},
		NotBefore:             time.Now().Add(-time.Hour),
		NotAfter:              time.Now().Add(24 * time.Hour),
		KeyUsage:              x509.KeyUsageDigitalSignature | x509.KeyUsageKeyEncipherment,
		ExtKeyUsage:           []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		BasicConstraintsValid: true,
		IPAddresses:           []net.IP{net.ParseIP("127.0.0.1")},
	}
	der, err := x509.CreateCertificate(rand.Reader, &tmpl, &tmpl, &key.PublicKey, key)
	if err != nil {
		t.Fatalf("签发测试证书: %v", err)
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}
}

// fakeSMTP 是握手级假服务器：只按 SMTP 脚本应答 220/EHLO/AUTH/MAIL/RCPT/DATA/
// QUIT，把认证凭据、信封与 DATA 原文记下来供断言——不碰真实网络与真实凭据。
type fakeSMTP struct {
	ln       net.Listener
	authFail bool

	mu       sync.Mutex
	authUser string
	authPass string
	mailFrom string
	rcpt     string
	data     string
}

func startFakeSMTP(t *testing.T, authFail bool) *fakeSMTP {
	t.Helper()
	ln, err := tls.Listen("tcp", "127.0.0.1:0",
		&tls.Config{Certificates: []tls.Certificate{selfSignedCert(t)}})
	if err != nil {
		t.Fatalf("起假 SMTP 监听: %v", err)
	}
	s := &fakeSMTP{ln: ln, authFail: authFail}
	go s.serve()
	t.Cleanup(func() { _ = ln.Close() })
	return s
}

func (s *fakeSMTP) serve() {
	for {
		conn, err := s.ln.Accept()
		if err != nil {
			return
		}
		go s.handle(conn)
	}
}

func (s *fakeSMTP) handle(conn net.Conn) {
	defer func() { _ = conn.Close() }()
	r := bufio.NewReader(conn)
	w := bufio.NewWriter(conn)
	reply := func(format string, args ...any) {
		_, _ = fmt.Fprintf(w, format, args...)
		_ = w.Flush()
	}
	reply("220 fake.exmail.qq.com ESMTP\r\n")
	for {
		line, err := r.ReadString('\n')
		if err != nil {
			return
		}
		cmd := strings.TrimRight(line, "\r\n")
		verb := strings.ToUpper(cmd)
		switch {
		case strings.HasPrefix(verb, "EHLO"), strings.HasPrefix(verb, "HELO"):
			// 能力行必须走 250- 续行，客户端才解析得出 AUTH 扩展
			reply("250-fake.exmail.qq.com\r\n250 AUTH PLAIN\r\n")
		case strings.HasPrefix(verb, "AUTH PLAIN"):
			fields := strings.Fields(cmd)
			raw, err := base64.StdEncoding.DecodeString(fields[len(fields)-1])
			// PLAIN 载荷 = identity \0 user \0 pass
			parts := strings.Split(string(raw), "\x00")
			if err != nil || len(fields) != 3 || len(parts) != 3 {
				reply("535 5.7.8 Authentication credentials invalid\r\n")
				continue
			}
			s.mu.Lock()
			s.authUser, s.authPass = parts[1], parts[2]
			s.mu.Unlock()
			if s.authFail {
				reply("535 5.7.8 Authentication credentials invalid\r\n")
				continue
			}
			reply("235 2.7.0 Authentication successful\r\n")
		case strings.HasPrefix(verb, "MAIL FROM:"):
			s.mu.Lock()
			s.mailFrom = between(cmd, "<", ">")
			s.mu.Unlock()
			reply("250 OK\r\n")
		case strings.HasPrefix(verb, "RCPT TO:"):
			s.mu.Lock()
			s.rcpt = between(cmd, "<", ">")
			s.mu.Unlock()
			reply("250 OK\r\n")
		case verb == "DATA":
			reply("354 End data with <CR><LF>.<CR><LF>\r\n")
			var buf strings.Builder
			for {
				l, err := r.ReadString('\n')
				if err != nil {
					break
				}
				if l == ".\r\n" {
					break
				}
				// 客户端 DotWriter 把行首的 . 加倍传输，这里还原
				if strings.HasPrefix(l, "..") {
					l = l[1:]
				}
				buf.WriteString(l)
			}
			s.mu.Lock()
			s.data = buf.String()
			s.mu.Unlock()
			reply("250 OK: queued\r\n")
		case verb == "QUIT":
			reply("221 Bye\r\n")
			return
		default:
			// 含认证被拒后客户端的中止命令 "*"
			reply("500 Command unimplemented\r\n")
		}
	}
}

func between(s, a, b string) string {
	i := strings.Index(s, a)
	if i < 0 {
		return ""
	}
	s = s[i+len(a):]
	if j := strings.Index(s, b); j >= 0 {
		return s[:j]
	}
	return s
}

func srvPort(t *testing.T, srv *fakeSMTP) string {
	t.Helper()
	_, port, err := net.SplitHostPort(srv.ln.Addr().String())
	if err != nil {
		t.Fatalf("取假服务器端口: %v", err)
	}
	return port
}

// 分流主用例：两套凭据都配齐时走 SMTP、Graph 一次都不碰；信件沿用品牌显示名
//（email.go 注册表经 Send 入参传入）、发件人取 mail_smtp_user、模板正文与
// Graph 路径同一份 MIME。
func TestSendPrefersSMTPAndCarriesBrandFrom(t *testing.T) {
	srv := startFakeSMTP(t, false)
	keys := smtpKeySet("127.0.0.1", srvPort(t, srv))
	// 叠上 Graph 键：证明 host 非空时 Graph 路径根本不被走
	for k, v := range graphKeySet() {
		keys[k] = v
	}

	var graphHits atomic.Int32
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		graphHits.Add(1)
		if r.URL.Path == "/token" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"access_token":"t","token_type":"Bearer","expires_in":3600}`)
			return
		}
		w.WriteHeader(http.StatusAccepted)
	}))
	defer ts.Close()

	s := senderWith(keys)
	s.tokenURL, s.sendURL = ts.URL+"/token", ts.URL+"/sendMail"

	const htmlBody = `<html><body><p>654321</p></body></html>`
	const textBody = "验证码 654321"
	if err := s.Send(context.Background(),
		"热量日记", "u@example.com", "【热量日记】注册验证码", htmlBody, textBody); err != nil {
		t.Fatalf("发送失败: %v", err)
	}
	if n := graphHits.Load(); n != 0 {
		t.Errorf("mail_smtp_host 配齐时不该碰 Graph，得到 %d 次请求", n)
	}

	srv.mu.Lock()
	authUser, authPass, mailFrom, rcpt, data := srv.authUser, srv.authPass, srv.mailFrom, srv.rcpt, srv.data
	srv.mu.Unlock()
	if authUser != testSMTPUser || authPass != testSMTPPass {
		t.Errorf("AUTH 应带配置的账户与密码，得到 user=%q pass=%q", authUser, authPass)
	}
	if mailFrom != testSMTPUser {
		t.Errorf("信封发件人应取 mail_smtp_user（%s），得到 %q", testSMTPUser, mailFrom)
	}
	if rcpt != "u@example.com" {
		t.Errorf("信封收件人应为 u@example.com，得到 %q", rcpt)
	}
	if data == "" {
		t.Fatal("没收到 DATA 信件")
	}

	head := parseMessage(t, data)
	dec := new(mime.WordDecoder)
	from, err := dec.DecodeHeader(head.Header.Get("From"))
	if err != nil {
		t.Fatalf("From 头解码失败: %v（原文 %q）", err, head.Header.Get("From"))
	}
	if from != "热量日记 <"+testSMTPUser+">" {
		t.Errorf("From 显示名应沿用品牌注册表传入的品牌名，得到 %q", from)
	}
	// 负例：显示名必须是 RFC 2047 编码形态（裸 UTF-8 头在部分收件链路按 Latin-1 误读）
	if !strings.Contains(head.Header.Get("From"), "=?UTF-8?B?") {
		t.Errorf("非 ASCII 的 From 显示名必须是 RFC 2047 B 编码，得到 %q", head.Header.Get("From"))
	}
	subj, err := dec.DecodeHeader(head.Header.Get("Subject"))
	if err != nil || subj != "【热量日记】注册验证码" {
		t.Errorf("Subject 解码后应还原原文，得到 %q（%v）", subj, err)
	}

	mediaType, params, err := mime.ParseMediaType(head.Header.Get("Content-Type"))
	if err != nil || mediaType != "multipart/alternative" {
		t.Fatalf("正文应为 multipart/alternative: %q（%v）", head.Header.Get("Content-Type"), err)
	}
	var gotText, gotHTML string
	mr := multipart.NewReader(head.Body, params["boundary"])
	for {
		p, err := mr.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatalf("读 MIME 部件: %v", err)
		}
		raw, _ := io.ReadAll(p)
		decoded, err := base64.StdEncoding.DecodeString(string(raw))
		if err != nil {
			t.Fatalf("部件 base64 不可解: %v", err)
		}
		switch ct := p.Header.Get("Content-Type"); {
		case strings.HasPrefix(ct, "text/plain"):
			gotText = string(decoded)
		case strings.HasPrefix(ct, "text/html"):
			gotHTML = string(decoded)
		}
	}
	if gotHTML != htmlBody || gotText != textBody {
		t.Errorf("双部件应与入参逐字一致，得到 plain=%q html=%q", gotText, gotHTML)
	}
}

// mail_smtp_host 空（哪怕其余三键都配了）→ 回退 Graph，缺键错误口径不变。
func TestSendFallsBackToGraphWhenSMTPHostEmpty(t *testing.T) {
	keys := graphKeySet()
	keys[smtpPortKey], keys[smtpUserKey], keys[smtpPassKey] = "465", testSMTPUser, testSMTPPass // host 故意不配

	var tokenHits, sendHits int
	ts := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/token" {
			tokenHits++
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{"access_token":"t","token_type":"Bearer","expires_in":3600}`)
			return
		}
		sendHits++
		w.WriteHeader(http.StatusAccepted)
	}))
	defer ts.Close()

	s := senderWith(keys)
	s.tokenURL, s.sendURL = ts.URL+"/token", ts.URL+"/sendMail"
	if err := s.Send(context.Background(), "Auth", "u@example.com", "s", "<p>b</p>", "b"); err != nil {
		t.Fatalf("回退 Graph 应发送成功: %v", err)
	}
	if tokenHits != 1 || sendHits != 1 {
		t.Errorf("应走完整 Graph 取票+投信，得到 token=%d send=%d", tokenHits, sendHits)
	}
}

// 缺键错误：两套都没配回 Graph 的 errNoCredential（口径不变）；进了 SMTP 路径
// 缺任一键回 errNoSMTPCredential，两者都是配置态错误、一个网络请求都不发。
func TestSendMissingKeysFailOffline(t *testing.T) {
	cases := []struct {
		name string
		keys map[string]string
		want error
	}{
		{"两套都没配（回 Graph，口径不变）", map[string]string{}, errNoCredential},
		{"只配了 host", map[string]string{smtpHostKey: "smtp.exmail.qq.com"}, errNoSMTPCredential},
		{"缺 pass", map[string]string{
			smtpHostKey: "smtp.exmail.qq.com", smtpPortKey: "465", smtpUserKey: testSMTPUser,
		}, errNoSMTPCredential},
		{"缺 port", map[string]string{
			smtpHostKey: "smtp.exmail.qq.com", smtpUserKey: testSMTPUser, smtpPassKey: testSMTPPass,
		}, errNoSMTPCredential},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			// 指向必然拨不通的端点：若缺键后还去拨号，报的会是连接错误而不是配置错误
			s := senderWith(tc.keys)
			s.tokenURL, s.sendURL = "http://127.0.0.1:0/token", "http://127.0.0.1:0/sendMail"
			err := s.Send(context.Background(), "Auth", "u@example.com", "s", "<p>b</p>", "b")
			if !errors.Is(err, tc.want) {
				t.Fatalf("应报 %v，得到 %v", tc.want, err)
			}
			if strings.Contains(err.Error(), testSMTPPass) {
				t.Errorf("错误文案不许回显密码: %q", err)
			}
		})
	}
}

// 认证失败要给「出了什么 + 怎么解决」的白话（客户端密码/授权码），且不带密码。
func TestSendSMTPAuthFailureIsActionable(t *testing.T) {
	srv := startFakeSMTP(t, true)
	s := senderWith(smtpKeySet("127.0.0.1", srvPort(t, srv)))
	err := s.Send(context.Background(), "Auth", "u@example.com", "s", "<p>b</p>", "b")
	if err == nil {
		t.Fatal("认证被拒必须报错")
	}
	msg := err.Error()
	if !strings.Contains(msg, "登录邮件服务器失败") || !strings.Contains(msg, "授权码") {
		t.Errorf("认证失败应给白话错误（出了什么 + 检查哪把钥匙），得到 %q", msg)
	}
	if strings.Contains(msg, testSMTPPass) {
		t.Errorf("错误文案不许回显密码: %q", msg)
	}
}

// 连接失败同样给白话：点名 host:port 与要查的键，而不是裸 dial 错误。
func TestSendSMTPDialFailureIsActionable(t *testing.T) {
	// 占一个端口再立刻释放：拨号必然被拒，且不依赖固定端口号
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("占端口: %v", err)
	}
	addr := ln.Addr().String()
	_ = ln.Close()
	_, port, err := net.SplitHostPort(addr)
	if err != nil {
		t.Fatalf("取端口: %v", err)
	}

	s := senderWith(smtpKeySet("127.0.0.1", port))
	err = s.Send(context.Background(), "Auth", "u@example.com", "s", "<p>b</p>", "b")
	if err == nil {
		t.Fatal("连不上必须报错")
	}
	if !strings.Contains(err.Error(), "连接邮件服务器") || !strings.Contains(err.Error(), addr) {
		t.Errorf("连接失败应点名服务器地址并给排查方向，得到 %q", err)
	}
	if !strings.Contains(err.Error(), "mail_smtp_host") {
		t.Errorf("连接失败应提示检查的配置键，得到 %q", err)
	}
}

// 配齐判定（/health mailConfigured 与启动 Warn 的同源逻辑）：SMTP 四键齐 或
// Graph 三键齐任一即 true；两套都没齐回 missing 供 Warn 点名；读库失败上抛。
func TestConfigState(t *testing.T) {
	fullSMTP := smtpKeySet("smtp.exmail.qq.com", "465")
	fullGraph := graphKeySet()
	merge := func(ms ...map[string]string) map[string]string {
		out := map[string]string{}
		for _, m := range ms {
			for k, v := range m {
				out[k] = v
			}
		}
		return out
	}
	read := func(m map[string]string) RequireFunc {
		return func(k string) (string, error) { return m[k], nil }
	}

	noPassSMTP := merge(fullSMTP)
	delete(noPassSMTP, smtpPassKey)

	allMissing := strings.Join(append(append([]string{}, smtpKeys...), graphKeys...), ",")
	onlyHost := merge(fullSMTP)
	for _, k := range []string{smtpPortKey, smtpUserKey, smtpPassKey} {
		delete(onlyHost, k)
	}
	// 两套里除 host 外全缺（顺带钉住键名本身）
	onlyHostMissing := strings.Join([]string{
		smtpPortKey, smtpUserKey, smtpPassKey, graphTenantKey, graphClientKey, graphSecretKey,
	}, ",")

	cases := []struct {
		name        string
		keys        map[string]string
		wantOK      bool
		wantMissing string // 只在 !wantOK 时校验，逗号连接
	}{
		{"SMTP 四键齐", fullSMTP, true, ""},
		{"Graph 三键齐", fullGraph, true, ""},
		{"两套都齐", merge(fullSMTP, fullGraph), true, ""},
		{"SMTP 缺 pass、Graph 齐（回退可用即算配好）", merge(noPassSMTP, fullGraph), true, ""},
		{"两套都缺", map[string]string{}, false, allMissing},
		{"只配了 host", onlyHost, false, onlyHostMissing},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			ok, missing, err := ConfigState(read(tc.keys))
			if err != nil {
				t.Fatalf("不该报读取错误: %v", err)
			}
			if ok != tc.wantOK {
				t.Errorf("ok 应为 %v，得到 %v（missing=%v）", tc.wantOK, ok, missing)
			}
			if !tc.wantOK && strings.Join(missing, ",") != tc.wantMissing {
				t.Errorf("missing 应为 %s，得到 %s", tc.wantMissing, strings.Join(missing, ","))
			}
		})
	}

	t.Run("读库失败上抛", func(t *testing.T) {
		boom := func(string) (string, error) { return "", errors.New("db down") }
		ok, _, err := ConfigState(boom)
		if ok || err == nil {
			t.Errorf("读取失败应 ok=false 且上抛错误，得到 ok=%v err=%v", ok, err)
		}
		if !strings.Contains(err.Error(), "db down") {
			t.Errorf("错误应带上根因，得到 %v", err)
		}
	})
}
