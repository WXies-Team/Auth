package mail

import (
	"context"
	"crypto/tls"
	"errors"
	"fmt"
	"io"
	"net"
	"net/smtp"
	"time"
)

// ---- 发信凭据键（两套）与配齐判定 ----

// 键列表是三处的唯一来源：Send 的分流与发送、/health 的 mailConfigured、
// 启动时的未配置 Warn。两套任一配齐即可发信——切主路径不等于作废另一套，
// Graph 是留着的回退（见 graph.go 包注释），别因为 SMTP 上线就删 Graph 键。
const (
	smtpHostKey    = "mail_smtp_host"
	smtpPortKey    = "mail_smtp_port"
	smtpUserKey    = "mail_smtp_user"
	smtpPassKey    = "mail_smtp_pass"
	graphTenantKey = "mail_tenant_id"
	graphClientKey = "mail_client_id"
	graphSecretKey = "mail_client_secret"
)

var (
	smtpKeys  = []string{smtpHostKey, smtpPortKey, smtpUserKey, smtpPassKey}
	graphKeys = []string{graphTenantKey, graphClientKey, graphSecretKey}
)

// RequireFunc 读一个 app_config 键：键缺失返回 ("", nil)，读库失败返回
// error——/health 要把「没配」（开关位 false）与「读不出来」（503）分开。
// config.Store.Require 就是这个形状。
type RequireFunc func(key string) (string, error)

// ConfigState 判定发信凭据配齐没有：**SMTP 四键齐 或 Graph 三键齐**，任一齐
// ok=true（与 Send 的分流同源：谁配齐走谁）。missing 是两套里所有空键，只在
// 两套都没配齐时有运维意义（启动 Warn 据此点名补哪个键）；任一套齐立即返回、
// 不再收集——「SMTP 配好了、Graph 没配」是正常态，不是故障，不许 Warn。
func ConfigState(read RequireFunc) (ok bool, missing []string, err error) {
	for _, keys := range [][]string{smtpKeys, graphKeys} {
		complete := true
		for _, key := range keys {
			v, e := read(key)
			if e != nil {
				return false, nil, fmt.Errorf("读配置键 %s: %w", key, e)
			}
			if v == "" {
				complete = false
				missing = append(missing, key)
			}
		}
		if complete {
			return true, nil, nil
		}
	}
	return false, missing, nil
}

// errNoSMTPCredential 是「app_config 缺 SMTP 键」的唯一出口，与 Graph 侧的
// errNoCredential 同属配置态错误：调用方回 503，运维照文案补键，不重试。
// 文案列全四键（补键照单抓药），绝不回显任何键值。
var errNoSMTPCredential = errors.New("邮件 SMTP 凭据未配置（app_config 缺 mail_smtp_host / mail_smtp_port / mail_smtp_user / mail_smtp_pass）")

// sendSMTP 走腾讯企业邮箱 SMTP 发信：465 隐式 TLS + PLAIN AUTH。
//
// **为什么 465 要自己起 TLS**：Go 的 net/smtp 只会先连明文、再发 STARTTLS
// 升级（25 端口的形态），而腾讯的发送服务器只给 SSL 端口 465、不支持非 SSL——
// 只能先 tls.Dial 出 TLS 连接再交给 smtp.NewClient：它认出 *tls.Conn 后
// PLAIN AUTH 才肯带密码（对非 TLS 连接 net/smtp 直接回 unencrypted
// connection，压根不发凭据）。
//
// **发件人 = mail_smtp_user**：发件地址没有独立键，腾讯口径是账户名/发件人
// 同为完整地址（邮箱开了安全登录时 mail_smtp_pass 填授权码），信封 MAIL FROM
// 与信头 From 都取它。
//
// **信件复用 buildMIME**：与 Graph 路径同一份 RFC 5322 实体（信封头 +
// multipart/alternative 双部件），模板、样式、RFC 2047 头编码零差异；fromName
// 是 Send 入参传下来的品牌名（email.go 注册表），显示名照旧编码进 From 头——
// 腾讯不改写 From 显示名，收件人看到的就是品牌名。
func (s *Sender) sendSMTP(ctx context.Context, fromName, to, subject, html, text string) error {
	host, port := s.cfg(smtpHostKey), s.cfg(smtpPortKey)
	user, pass := s.cfg(smtpUserKey), s.cfg(smtpPassKey)
	// 分流已保证 host 非空，这里兜住其余三键——缺任一键都不该拨号
	if host == "" || port == "" || user == "" || pass == "" {
		return errNoSMTPCredential
	}
	mimeMsg, err := buildMIME(fromName, user, to, subject, html, text, time.Now())
	if err != nil {
		return err
	}

	// 总预算与 Graph 路径同口径（sendTimeout）：罩住建连、握手、AUTH 与投信全程
	ctx, cancel := context.WithTimeout(ctx, sendTimeout)
	defer cancel()

	addr := net.JoinHostPort(host, port)
	conn, err := s.dialSMTP(ctx, addr, host)
	if err != nil {
		return fmt.Errorf("连接邮件服务器 %s 失败: %w（检查 mail_smtp_host / mail_smtp_port 配置与服务器连通性）", addr, err)
	}
	defer func() { _ = conn.Close() }()
	// net/smtp 的会话不认 ctx：把总预算落到连接读写上，对端半开连接才挂不满 15s
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	}
	c, err := smtp.NewClient(conn, host)
	if err != nil {
		return fmt.Errorf("与邮件服务器 %s 握手失败: %w（检查 mail_smtp_host / mail_smtp_port）", addr, err)
	}
	defer func() { _ = c.Close() }()

	if err := c.Auth(smtp.PlainAuth("", user, pass, host)); err != nil {
		return fmt.Errorf("登录邮件服务器失败: %w（检查 mail_smtp_user / mail_smtp_pass：密码是客户端密码，邮箱开了安全登录时填授权码）", err)
	}
	if err := c.Mail(user); err != nil {
		return fmt.Errorf("发件人被邮件服务器拒绝: %w（检查 mail_smtp_user 是否为完整邮箱地址）", err)
	}
	if err := c.Rcpt(to); err != nil {
		// 收件人不进错误文案：mailLog 会把 err 整条落日志，带收件地址等于绕过 maskEmail
		return fmt.Errorf("收件人被邮件服务器拒绝: %w（检查收件地址，或服务器对该发件人/收件人的限制）", err)
	}
	w, err := c.Data()
	if err != nil {
		return fmt.Errorf("请求投递邮件: %w", err)
	}
	if _, err := io.WriteString(w, mimeMsg); err != nil {
		return fmt.Errorf("写入邮件正文: %w", err)
	}
	if err := w.Close(); err != nil {
		return fmt.Errorf("邮件正文被服务器拒绝: %w（检查发件人是否与 mail_smtp_user 一致）", err)
	}
	// 信已被 250 接受：QUIT 只是收尾断开，失败不改判——把已投出的信报成失败，
	// 调用方会撤销验证码并给用户 503，用户重发后收件人收到两封
	_ = c.Quit()
	return nil
}

// dialSMTP 拨 465 隐式 TLS。smtpTLSConfig 是测试钩子（与 tokenURL/sendURL
// 同款）：生产恒 nil，用默认配置 + ServerName=host 做 SNI 与证书校验；测试指到
// 自签证书的信任配置。
func (s *Sender) dialSMTP(ctx context.Context, addr, host string) (net.Conn, error) {
	tlsCfg := s.smtpTLSConfig
	if tlsCfg == nil {
		tlsCfg = &tls.Config{ServerName: host}
	}
	d := &tls.Dialer{NetDialer: &net.Dialer{}, Config: tlsCfg}
	return d.DialContext(ctx, "tcp", addr)
}
