// Package mail 发验证码等通知邮件：**唯一发送路径是阿里企业邮箱 SMTP**
// （smtp.go，465 隐式 TLS + PLAIN AUTH，发件地址取 `mail_smtp_user`）。凭据只在
// 生产库 `app_config`、仓库不出现任何值；/health 的 mailConfigured 与启动未配置
// Warn 用同一套配齐判定（[ConfigState]：SMTP 四键齐）。
//
// **历史沿革**：2026-11 从 Microsoft Graph（Exchange Online）切腾讯企业邮箱 SMTP、
// 2026-11-25 切阿里企业邮箱 SMTP；Graph 回退路径已随之移除（库内 Graph 凭据键
// 已删），SMTP 是唯一发信通道。
//
// **缺键错误口径**：缺任一 SMTP 键 Send 回 errNoSMTPCredential（路由侧表现为
// 503，启动日志另有一条 Warn 提醒，省得等用户注册失败才发现），且不出网。
//
// **发件人显示名随信取品牌**：From 落在信封头里（见 buildMIME），显示名是这封信
// 的品牌名（热量日记 / 开支日记 / Auth，来自 email.go 注册表、随 Send 入参传下
// 来），与正文品牌同源；SMTP 路径不改写 From 显示名，收件人看到的仍是品牌名。
// 发件地址取 mail_smtp_user，没有独立键。
//
// **正文是完整 RFC 5322 信件**：信封头 + multipart/alternative 双部件
// （text/plain 降级 + text/html，见 buildMIME），由 sendSMTP 原样写进 DATA。
// 品牌 logo 走 https 托管图（auth.horatio.cn/brand/…），不内嵌 CID。
package mail

import (
	"bytes"
	"context"
	"crypto/tls"
	"encoding/base64"
	"fmt"
	"io"
	"mime/multipart"
	"net/textproto"
	"strings"
	"time"
)

// rfc2047B 按 RFC 2047 的 B 编码（base64）给头值里的非 ASCII 段加编码：裸 UTF-8
// 头在部分收件链路上被按 Latin-1 误读（乱码的另一隐患），头编码不能赌对端代劳。
// 纯 ASCII 原样返回——ASCII 头值不该编码。
func rfc2047B(s string) string {
	if s == "" || isASCII(s) {
		return s
	}
	data := base64.StdEncoding.EncodeToString([]byte(s))
	// RFC 2047 限定单个 encoded-word 的字符数据 ≤76 字符：超长按 76 切段，段间用
	// 折行空白（CRLF + SP，RFC 5322 头折叠）连接。本站主题/品牌名都是短串，切段
	// 实际不触发，但头编码函数不该赌输入长度。
	var b strings.Builder
	for len(data) > 76 {
		b.WriteString("=?UTF-8?B?" + data[:76] + "?=\r\n ")
		data = data[76:]
	}
	b.WriteString("=?UTF-8?B?" + data + "?=")
	return b.String()
}

func isASCII(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] >= 0x80 {
			return false
		}
	}
	return true
}

// base64CTE 把正文编成 RFC 2045 的 base64 传输编码（部件头 CTE: base64）：
// 76 字符折行、行尾 CRLF。用 base64 而不是 8bit 裸 UTF-8：裸 8bit 在转发链路上
// 会被某一段重新判定编码（正是本包 2026-10-22 乱码报告的第二隐患）。
func base64CTE(s string) string {
	data := base64.StdEncoding.EncodeToString([]byte(s))
	var b strings.Builder
	for len(data) > 76 {
		b.WriteString(data[:76])
		b.WriteString("\r\n")
		data = data[76:]
	}
	b.WriteString(data)
	b.WriteString("\r\n")
	return b.String()
}

// buildMIME 拼出完整 RFC 5322 信件：信封头（Date/From/To/Subject/MIME-Version/
// Content-Type）+ multipart/alternative 正文（text/plain 在前、text/html 在后，
// 两部件均 base64 传输编码），所有行尾 CRLF。
//
// fromName 是发件显示名（品牌名，来自 email.go 注册表、随 Send 入参传入），
// fromAddr 是发件地址——取 mail_smtp_user，发件地址没有独立键。Subject/From
// 含中文时按 RFC 2047 B 编码（裸 UTF-8 头在部分收件链路上被按 Latin-1 误读）。
//
// **为什么必须补信封头**：收件人与主题只能从信封头来——缺 To/Subject 的 MIME
// 会被邮件服务器拒、要么丢收件人。
func buildMIME(fromName, fromAddr, to, subject, html, text string, now time.Time) (string, error) {
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	plain, err := w.CreatePart(textproto.MIMEHeader{
		"Content-Type":              {"text/plain; charset=utf-8"},
		"Content-Transfer-Encoding": {"base64"},
	})
	if err != nil {
		return "", fmt.Errorf("拼纯文本部件: %w", err)
	}
	if _, err := io.WriteString(plain, base64CTE(text)); err != nil {
		return "", fmt.Errorf("写纯文本部件: %w", err)
	}
	part, err := w.CreatePart(textproto.MIMEHeader{
		"Content-Type":              {"text/html; charset=utf-8"},
		"Content-Transfer-Encoding": {"base64"},
	})
	if err != nil {
		return "", fmt.Errorf("拼 HTML 部件: %w", err)
	}
	if _, err := io.WriteString(part, base64CTE(html)); err != nil {
		return "", fmt.Errorf("写 HTML 部件: %w", err)
	}
	if err := w.Close(); err != nil {
		return "", fmt.Errorf("收尾 multipart: %w", err)
	}

	var msg bytes.Buffer
	// Date 走 RFC 5322 date-time（time.RFC1123Z 同型）：收件链路按 RFC 5322
	// 校验信封头形态。
	fmt.Fprintf(&msg, "Date: %s\r\n", now.Format(time.RFC1123Z))
	fmt.Fprintf(&msg, "From: %s <%s>\r\n", rfc2047B(fromName), fromAddr)
	fmt.Fprintf(&msg, "To: %s\r\n", to)
	fmt.Fprintf(&msg, "Subject: %s\r\n", rfc2047B(subject))
	msg.WriteString("MIME-Version: 1.0\r\n")
	fmt.Fprintf(&msg, "Content-Type: multipart/alternative; boundary=%q\r\n\r\n", w.Boundary())
	msg.Write(body.Bytes())
	return msg.String(), nil
}

// ConfigFunc 读 app_config 的一个键（改库即热生效），取不到返回 ""。
type ConfigFunc func(key string) string

// Sender 发一封信。零值不可用，用 [New]。
type Sender struct {
	cfg ConfigFunc
	// SMTP 的 TLS 信任覆盖：生产恒 nil（默认配置 + ServerName=host 校验证书），
	// 测试指到自签证书的信任配置（见 dialSMTP）。
	smtpTLSConfig *tls.Config
}

// sendTimeout 是**一次 Send 的总预算**：罩住 SMTP 建连、握手、AUTH 与投信全程。
// 声明成变量只是让测试能塞进毫秒级预算，生产不改。
var sendTimeout = 15 * time.Second

// New 返回生产实现：凭据从 app_config 现读（10s 缺省缓存），发信 15s 总超时
// （见 sendTimeout）。
func New(cfg ConfigFunc) *Sender {
	return &Sender{cfg: cfg}
}

// Send 发一封邮件：正文是完整 RFC 5322 信件（信封头 + multipart/alternative
// 双部件，见 buildMIME），交给阿里企业邮箱 SMTP 投递（sendSMTP）。fromName 是
// 发件人显示名（品牌名），落进信封 From 头（非 ASCII 按 RFC 2047 编码）；
// text 是 HTML 的忠实纯文本降级（auth 模板逐封提供）。
//
// 缺任一 SMTP 键回 errNoSMTPCredential（配置态错误：路由侧 503、一个网络请求
// 都不发，运维照文案补键）。
//
// **不自动重试**：发码本身有 60 秒冷却与每 IP 5 次/分的闸，重试省不下用户等待、
// 还多一份重复投递的风险——失败就把码撤销回 503，让用户手动重发，是最短也最
// 安全的路径（SMTP 单次会话投递，同样不重试）。
func (s *Sender) Send(ctx context.Context, fromName, to, subject, html, text string) error {
	return s.sendSMTP(ctx, fromName, to, subject, html, text)
}
