package main

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/WXies-Team/Auth/internal/auth"
)

// 契约 2：老 APK 的旧注销 body（只有 password）→ 400 指引升级、账号分毫不动；
// 新 body {email, code} 走 W3 宽限：pending 落库、会话全杀、回执 {ok:true}。
// （route 环境不接 mailer，注销码直插 otp_codes——sha256 口径与业务层一致。）
func TestDeleteRouteLegacyBodyAndNewFlow(t *testing.T) {
	e := newRouteEnv(t)
	uid := seedUser(t, e, "del-route@example.com", "secret123", "user")
	resp, err := e.svc.Login("del-route@example.com", "secret123", "CalorieDiary", auth.SessionMeta{})
	if err != nil {
		t.Fatalf("登录: %v", err)
	}
	bearer := func(r *http.Request) { r.Header.Set("Authorization", "Bearer "+resp.Token) }

	// 老 body：只有 password → 400 升级提示
	rec := e.do(t, "POST", "/auth/delete", `{"password":"secret123"}`, bearer)
	if rec.Code != http.StatusBadRequest || !strings.Contains(rec.Body.String(), "注销流程已更新") {
		t.Fatalf("老注销 body 应 400 指引升级，得到 %d %s", rec.Code, rec.Body.String())
	}
	var users, pending int
	_ = e.pool.QueryRow("SELECT COUNT(*) FROM users").Scan(&users)
	_ = e.pool.QueryRow("SELECT pending_delete_at FROM users WHERE id = ?", uid).Scan(&pending)
	if users != 1 || pending != 0 {
		t.Errorf("被拒的请求不该动账号（users=%d pending=%d）", users, pending)
	}

	// 新 body 缺有效码 → 400（走既有 OTP 闸）
	rec = e.do(t, "POST", "/auth/delete", `{"email":"del-route@example.com","code":"123456"}`, bearer)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("缺码应 400，得到 %d %s", rec.Code, rec.Body.String())
	}

	// 直插一条 purpose=delete 的码，再走完整新流程
	const code = "654321"
	sum := sha256.Sum256([]byte(code))
	now := time.Now().UnixMilli()
	if _, err := e.pool.Exec(
		"INSERT INTO otp_codes (email, purpose, code_hash, expires_at, attempts, used, created_at, last_sent_at)"+
			" VALUES (?,?,?,?,0,0,?,?)",
		"del-route@example.com", auth.PurposeDelete, hex.EncodeToString(sum[:]),
		now+int64((5*time.Minute).Milliseconds()), now, now); err != nil {
		t.Fatalf("种注销码: %v", err)
	}
	rec = e.do(t, "POST", "/auth/delete", `{"email":"del-route@example.com","code":"654321"}`, bearer)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), `"ok":true`) {
		t.Fatalf("新流程应 200 {ok:true}，得到 %d %s", rec.Code, rec.Body.String())
	}
	_ = e.pool.QueryRow("SELECT pending_delete_at FROM users WHERE id = ?", uid).Scan(&pending)
	if pending == 0 {
		t.Error("新流程应置 pending_delete_at")
	}
	// 全部会话（含当前）被杀：旧 token 再打受保护端点 401
	after := e.do(t, "GET", "/api/sessions", "", bearer)
	if after.Code != http.StatusUnauthorized {
		t.Errorf("申请注销后旧 token 应 401，得到 %d", after.Code)
	}
}

// 注销撤销页渲染（纯 HTTP 层，无 DB）：确认页带按钮与内嵌 token、成功区与登录
// 入口；错误页 400 + 友好文案（HTML 转义）；errText 的两级文案。
func TestDeleteCancelPageRender(t *testing.T) {
	rec := httptest.NewRecorder()
	writeDeleteCancelPage(rec, "abc.def-ghi", true, "")
	if rec.Code != http.StatusOK {
		t.Fatalf("确认页应 200，得到 %d", rec.Code)
	}
	body := rec.Body.String()
	for _, want := range []string{"撤销注销", `const TOKEN = "abc.def-ghi";`, "/web/login", "注销已撤销"} {
		if !strings.Contains(body, want) {
			t.Errorf("确认页缺 %q", want)
		}
	}
	if ct := rec.Header().Get("Content-Type"); !strings.Contains(ct, "text/html") {
		t.Errorf("页面应是 text/html，得到 %q", ct)
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
		t.Errorf("页面应 no-store，得到 %q", cc)
	}

	rec2 := httptest.NewRecorder()
	writeDeleteCancelPage(rec2, "", false, `撤销链接无效或已过期<img src=x>`)
	if rec2.Code != http.StatusBadRequest {
		t.Errorf("错误页应 400，得到 %d", rec2.Code)
	}
	errBody := rec2.Body.String()
	if strings.Contains(errBody, "<img src=x>") || !strings.Contains(errBody, "&lt;img") {
		t.Errorf("错误文案应 HTML 转义后落页: %s", errBody)
	}

	if got := errText(&auth.HTTPError{Code: 400, Message: "当前没有待执行的注销申请"}); got != "当前没有待执行的注销申请" {
		t.Errorf("HTTPError 应取自带文案，得到 %q", got)
	}
	if got := errText(errors.New("db boom")); got != "服务暂时不可用，请稍后重试" {
		t.Errorf("非 HTTPError 应回中性 503 文案，得到 %q", got)
	}
}

// 注销撤销页是唯一「脚本内联」的页面：CSP 用按请求的 nonce 放宽**这一条**脚本，
// 其余策略仍严格（不放 'unsafe-inline'）。nonce 每请求不同，哈希白名单不适用。
func TestDeleteCancelPageCSPNonce(t *testing.T) {
	rec := httptest.NewRecorder()
	writeDeleteCancelPage(rec, "tok-1", true, "")
	csp := rec.Header().Get("Content-Security-Policy")
	scriptSrc := ""
	if i := strings.Index(csp, "script-src "); i >= 0 {
		scriptSrc = strings.SplitN(csp[i+len("script-src "):], ";", 2)[0]
	}
	if !strings.Contains(scriptSrc, "'self'") || strings.Contains(scriptSrc, "unsafe-inline") {
		t.Fatalf("script-src 应只含 'self' + nonce，得到 %q（整条 %q）", scriptSrc, csp)
	}
	i := strings.Index(scriptSrc, "'nonce-")
	if i < 0 {
		t.Fatalf("script-src 应带 nonce，得到 %q", scriptSrc)
	}
	nonce := scriptSrc[i+len("'nonce-"):]
	if j := strings.Index(nonce, "'"); j >= 0 {
		nonce = nonce[:j]
	}
	if len(nonce) < 16 {
		t.Errorf("nonce 太短: %q", nonce)
	}
	if !strings.Contains(rec.Body.String(), `<script nonce="`+nonce+`">`) {
		t.Error("内联脚本必须带同一个 nonce，否则严格 CSP 下不会执行")
	}
	// 每请求一个 nonce：不能被复用成固定值
	rec2 := httptest.NewRecorder()
	writeDeleteCancelPage(rec2, "tok-1", true, "")
	if rec2.Header().Get("Content-Security-Policy") == csp {
		t.Error("nonce 应每请求不同")
	}
}

// 403 页用 ui.Data.Status 起头，而不是先 WriteHeader：先冲刷会让 Render 设置的
// Cache-Control: no-store 等头丢失（403 页被缓存是真实后果）。
func TestRenderDeniedKeepsRenderHeaders(t *testing.T) {
	rec := httptest.NewRecorder()
	renderDenied(rec, "CalorieDiary", auth.ReasonPermission)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("应 403，得到 %d", rec.Code)
	}
	if cc := rec.Header().Get("Cache-Control"); cc != "no-store" {
		t.Errorf("403 页应 no-store，得到 %q", cc)
	}
	if ct := rec.Header().Get("Content-Type"); !strings.Contains(ct, "text/html") {
		t.Errorf("403 页应是 text/html，得到 %q", ct)
	}
	if body := rec.Body.String(); !strings.Contains(body, "无权访问") {
		t.Errorf("403 页正文不对: %s", body)
	}
}
