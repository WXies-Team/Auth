package mail

import (
	"encoding/base64"
	"errors"
	"io"
	"mime"
	"mime/multipart"
	"net/mail"
	"strings"
	"testing"
	"time"
)

// parseMessage 把 MIME 信件原文解析成标准头对象（解析失败直接 Fatal）。
func parseMessage(t *testing.T, msg string) *mail.Message {
	t.Helper()
	parsed, err := mail.ReadMessage(strings.NewReader(msg))
	if err != nil {
		t.Fatalf("MIME 信件不可解析: %v\n%s", err, msg)
	}
	return parsed
}

// 信封头逐项钉住（固定时间 → 形态确定）：Date/From/To/Subject/MIME-Version/
// Content-Type。ASCII 主题与显示名保持原样不编码（编码只服务非 ASCII）。
func TestBuildMIMEEnvelope(t *testing.T) {
	now := time.Date(2026, 10, 22, 15, 4, 5, 0, time.UTC)
	msg, err := buildMIME("Auth", testSMTPUser, "u@example.com", "Auth 注册验证码", "<p>b</p>", "b", now)
	if err != nil {
		t.Fatalf("buildMIME 失败: %v", err)
	}
	head := parseMessage(t, msg)

	wantHeaders := map[string]string{
		"Date":         "Thu, 22 Oct 2026 15:04:05 +0000",
		"From":         "Auth <" + testSMTPUser + ">",
		"To":           "u@example.com",
		"Subject":      "=?UTF-8?B?" + base64.StdEncoding.EncodeToString([]byte("Auth 注册验证码")) + "?=",
		"MIME-Version": "1.0",
	}
	for k, want := range wantHeaders {
		if got := head.Header.Get(k); got != want {
			t.Errorf("%s 头应为 %q，得到 %q", k, want, got)
		}
	}
	mediaType, params, err := mime.ParseMediaType(head.Header.Get("Content-Type"))
	if err != nil || mediaType != "multipart/alternative" || params["boundary"] == "" {
		t.Errorf("Content-Type 应为带 boundary 的 multipart/alternative，得到 %q（解析错误 %v）",
			head.Header.Get("Content-Type"), err)
	}

	// ASCII 主题/显示名原样直出，不做多余编码
	msgASCII, err := buildMIME("Auth", testSMTPUser, "u@example.com", "code 123456", "<p>b</p>", "b", now)
	if err != nil {
		t.Fatalf("buildMIME 失败: %v", err)
	}
	headASCII := parseMessage(t, msgASCII)
	if got := headASCII.Header.Get("Subject"); got != "code 123456" {
		t.Errorf("ASCII Subject 应原样，得到 %q", got)
	}
	if got := headASCII.Header.Get("From"); got != "Auth <"+testSMTPUser+">" {
		t.Errorf("ASCII From 显示名应原样，得到 %q", got)
	}
}

// 正文必须是 multipart/alternative：text/plain 在前、text/html 在后，两部件均为
// base64 传输编码、解码后与入参逐字一致；全信 CRLF 行尾。
// 只发 HTML（或把纯文本丢了）都会让纯文本客户端降级失败。
func TestBuildMIMEBodyMultipartAlternative(t *testing.T) {
	const htmlBody = `<html><body><p>654321</p></body></html>`
	const textBody = "验证码 654321"
	now := time.Date(2026, 10, 22, 15, 4, 5, 0, time.UTC)
	msg, err := buildMIME("热量日记", testSMTPUser, "u@example.com",
		"【热量日记】注册验证码", htmlBody, textBody, now)
	if err != nil {
		t.Fatalf("buildMIME 失败: %v", err)
	}

	// 全信 CRLF：任何裸 \n/\r 都说明拼装混进了平台行尾（8bit 时代的老隐患）
	if rest := strings.ReplaceAll(msg, "\r\n", ""); strings.ContainsAny(rest, "\r\n") {
		t.Errorf("MIME 行尾必须全部是 CRLF:\n%q", msg)
	}

	head := parseMessage(t, msg)
	if v := head.Header.Get("MIME-Version"); v != "1.0" {
		t.Errorf("MIME-Version 应为 1.0，得到 %q", v)
	}
	if _, err := time.Parse(time.RFC1123Z, head.Header.Get("Date")); err != nil {
		t.Errorf("Date 头应为 RFC 5322 date-time，得到 %q（%v）", head.Header.Get("Date"), err)
	}

	mediaType, params, err := mime.ParseMediaType(head.Header.Get("Content-Type"))
	if err != nil {
		t.Fatalf("MIME 头部不可解析: %v\n%s", err, head.Header.Get("Content-Type"))
	}
	if mediaType != "multipart/alternative" {
		t.Errorf("正文应为 multipart/alternative，得到 %q %v", mediaType, params)
	}

	var gotText, gotHTML string
	var order []string
	mr := multipart.NewReader(head.Body, params["boundary"])
	for {
		p, err := mr.NextPart()
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			t.Fatalf("读 MIME 部件: %v", err)
		}
		if cte := p.Header.Get("Content-Transfer-Encoding"); cte != "base64" {
			t.Errorf("部件 %s 的 CTE 应为 base64（8bit 裸 UTF-8 在转发链路上不可靠），得到 %q",
				p.Header.Get("Content-Type"), cte)
		}
		raw, _ := io.ReadAll(p)
		decoded, err := base64.StdEncoding.DecodeString(string(raw))
		if err != nil {
			t.Fatalf("部件 base64 不可解: %v\n%s", err, raw)
		}
		switch ct := p.Header.Get("Content-Type"); {
		case strings.HasPrefix(ct, "text/plain"):
			gotText = string(decoded)
			order = append(order, "plain")
		case strings.HasPrefix(ct, "text/html"):
			gotHTML = string(decoded)
			order = append(order, "html")
		default:
			t.Errorf("未知 MIME 部件类型: %q", ct)
		}
	}
	if gotHTML != htmlBody {
		t.Errorf("HTML 部件与入参不一致:\n%s", gotHTML)
	}
	if gotText != textBody {
		t.Errorf("纯文本部件与入参不一致:\n%s", gotText)
	}
	if strings.Join(order, ",") != "plain,html" {
		t.Errorf("部件顺序应为 plain,html（客户端取最后一个能渲染的），得到 %v", order)
	}
}
