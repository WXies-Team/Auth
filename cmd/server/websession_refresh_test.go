package main

import (
	"net/http"
	"strings"
	"testing"

	"github.com/WXies-Team/Auth/internal/auth"
)

// /web/session/refresh 的 HTTP 契约（会话子系统重写的安全面）：
//
//	① 双 cookie 轮换：新 token/CSRF 落 Set-Cookie，旧 cookie 进宽限窗；
//	② 宽限窗内的旧 cookie 仍能读身份（并发请求不静默登出），但**换不出**新 token（409）；
//	③ 轮换必须带 CSRF 头（cookie 请求的写操作闸）；
//	④ 只认 cookie 登录态：Bearer（web token 或 JWT）一律 403。
//
// 业务层的不落库/条件 UPDATE 语义由 internal/auth 的
// TestWebSessionRotationAndReuseDetection 钉住；这里只钉传输层。
func TestWebSessionRefreshRoute(t *testing.T) {
	e := newRouteEnv(t)
	drainLoginBucket()
	t.Cleanup(drainLoginBucket)
	seedUser(t, e, "refresh-route@example.com", "secret123", "user")
	oldSess, oldCSRF := loginCookie(t, e, "refresh-route@example.com", "secret123")
	withCookies := func(sess, csrf *http.Cookie) func(*http.Request) {
		return func(r *http.Request) {
			r.AddCookie(sess)
			r.AddCookie(csrf)
			r.Header.Set("X-CSRF-Token", csrf.Value)
		}
	}

	// ① 轮换成功：两枚 cookie 都换新，回执带 expiresAt
	rec := e.do(t, "POST", "/web/session/refresh", "", withCookies(oldSess, oldCSRF))
	if rec.Code != http.StatusOK {
		t.Fatalf("轮换应 200，得到 %d %s", rec.Code, rec.Body.String())
	}
	newSess := cookieNamed(rec, auth.WebCookieName)
	newCSRF := cookieNamed(rec, auth.WebCSRFCookieName)
	if newSess == nil || newCSRF == nil {
		t.Fatalf("轮换应重发两枚 cookie，得到 %s", rec.Body.String())
	}
	if newSess.Value == oldSess.Value || newCSRF.Value == oldCSRF.Value {
		t.Error("轮换应同时换掉 token 与 CSRF")
	}
	if !strings.Contains(rec.Body.String(), "expiresAt") {
		t.Errorf("回执应带 expiresAt，得到 %s", rec.Body.String())
	}

	// ② 宽限窗内的旧 cookie：读身份照常（并发请求不 401），但换不出新 token
	if rec := e.do(t, "POST", "/web/session", "", withCookies(oldSess, oldCSRF)); rec.Code != http.StatusOK {
		t.Errorf("宽限窗内旧 cookie 读取身份应 200，得到 %d %s", rec.Code, rec.Body.String())
	}
	if rec := e.do(t, "POST", "/web/session/refresh", "", withCookies(oldSess, oldCSRF)); rec.Code != http.StatusConflict {
		t.Errorf("宽限窗旧 cookie 轮换应 409（不能洗出新 token），得到 %d %s", rec.Code, rec.Body.String())
	}
	// 新 cookie 仍可继续轮换（链式）
	if rec := e.do(t, "POST", "/web/session/refresh", "", withCookies(newSess, newCSRF)); rec.Code != http.StatusOK {
		t.Errorf("新 cookie 轮换应 200，得到 %d %s", rec.Code, rec.Body.String())
	}

	// ③ 缺 CSRF 头：cookie 写操作被 withUID 挡下（403）
	if rec := e.do(t, "POST", "/web/session/refresh", "", func(r *http.Request) {
		r.AddCookie(newSess)
		r.AddCookie(newCSRF)
	}); rec.Code != http.StatusForbidden {
		t.Errorf("无 CSRF 头应 403，得到 %d %s", rec.Code, rec.Body.String())
	}

	// ④ Bearer 调用方没有可 Set-Cookie 的通道：明确拒绝，而不是静默回新 token
	if rec := e.do(t, "POST", "/web/session/refresh", "", func(r *http.Request) {
		r.Header.Set("Authorization", "Bearer "+newSess.Value)
	}); rec.Code != http.StatusForbidden {
		t.Errorf("Bearer 轮换应 403，得到 %d %s", rec.Code, rec.Body.String())
	}
}
