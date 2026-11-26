package main

import (
	"net/http"
	"strings"

	"github.com/WXies-Team/Auth/internal/auth"
	"github.com/WXies-Team/Auth/internal/ui"
)

// 页面路由只做一件事：按登录态/角色决定能不能进入 SPA，然后回 index.html。
// 页面内容、导航与权限提示都在 React 里；真正的数据权限仍由每个 JSON 端点
// 逐请求现查（SPA 隐藏按钮不构成任何安全边界）。
type pageGate int

const (
	gatePublic pageGate = iota // 登录页：已登录就别再看
	gateNone                   // 公开页：邀请、设密
	gateAuth                   // 自助台：未登录跳登录页
	gateAdmin                  // 管理后台：未登录跳登录页，非管理员跳概览
	gateSuper                  // 平台级页：app-admin 跳会话总览
)

func registerPageRoutes(mux *http.ServeMux, svc *auth.Service) {
	mux.Handle("GET /web/login", pageHandler(svc, "login", gatePublic))
	mux.Handle("GET /web/register", pageHandler(svc, "register", gatePublic))
	mux.Handle("GET /web/invite", pageHandler(svc, "invite", gateNone))
	mux.Handle("GET /web/setup-password", pageHandler(svc, "setup", gateNone))

	mux.Handle("GET /web/console", pageHandler(svc, "console", gateAuth))
	mux.Handle("GET /web/console/{rest...}", pageHandler(svc, "console", gateAuth))

	mux.Handle("GET /web/admin", pageHandler(svc, "admin", gateSuper))
	mux.Handle("GET /web/admin/config", pageHandler(svc, "admin", gateSuper))
	mux.Handle("GET /web/admin/config/{rest...}", pageHandler(svc, "admin", gateSuper))
	mux.Handle("GET /web/admin/system", pageHandler(svc, "admin", gateSuper))
	mux.Handle("GET /web/admin/system/{rest...}", pageHandler(svc, "admin", gateSuper))
	mux.Handle("GET /web/admin/users", pageHandler(svc, "admin", gateSuper))
	mux.Handle("GET /web/admin/users/{rest...}", pageHandler(svc, "admin", gateSuper))
	mux.Handle("GET /web/admin/{rest...}", pageHandler(svc, "admin", gateAdmin))

	// 其余 GET /web/* 属于 SPA 内部路由（深链、404 兜底）。API 都是非 GET 的
	// 精确注册，不会被这条吃掉；/web/delete-cancel 与 /web/registry 有更具体的
	// 精确模式，同样优先于通配。
	mux.Handle("GET /web/{rest...}", pageHandler(svc, "spa", gateNone))

	mux.Handle("GET /web/registry", http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		writeJSON(w, http.StatusOK, ui.Registry())
	}))

	mux.Handle("GET /web", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if webSessionOK(svc, r) {
			http.Redirect(w, r, "/web/console", http.StatusFound)
			return
		}
		http.Redirect(w, r, "/web/login", http.StatusFound)
	}))
	mux.Handle("GET /web/{$}", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/web", http.StatusFound)
	}))
}

func registerStaticRoutes(mux *http.ServeMux) {
	mux.Handle("GET /assets/{rest...}", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		serveAsset(w, r, "assets/"+r.PathValue("rest"), "public, max-age=31536000, immutable")
	}))
	for _, name := range []string{"theme.js", "favicon.svg", "favicon.ico", "apple-touch-icon.png", "manifest.webmanifest", "sw.js", "offline.html", "icon-192.png", "icon-512.png"} {
		// Service Worker 必须每次导航都回源检查更新（浏览器更新检查默认绕过 HTTP 缓存，
		// 但中间代理不该缓存它）；其余静态文件按周缓存。
		cache := "public, max-age=604800"
		if name == "sw.js" {
			cache = "no-cache"
		}
		mux.Handle("GET /"+name, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			serveAsset(w, r, name, cache)
		}))
	}
	mux.Handle("GET /brand/{name}", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		data, ctype, ok := ui.BrandStatic(r.PathValue("name"))
		if !ok {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", ctype)
		w.Header().Set("Cache-Control", "public, max-age=31536000, immutable")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		_, _ = w.Write(data)
	}))
	mux.Handle("GET /{$}", http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/web/login", http.StatusFound)
	}))
}

func serveAsset(w http.ResponseWriter, r *http.Request, name, cache string) {
	data, ctype, ok := ui.Asset(name)
	if !ok {
		http.Error(w, "404 page not found", http.StatusNotFound)
		return
	}
	w.Header().Set("Vary", "Accept-Encoding")
	if gz, ok := ui.Gzip(name); ok && strings.Contains(r.Header.Get("Accept-Encoding"), "gzip") {
		w.Header().Set("Content-Encoding", "gzip")
		data = gz
	}
	w.Header().Set("Content-Type", ctype)
	w.Header().Set("Cache-Control", cache)
	w.Header().Set("X-Content-Type-Options", "nosniff")
	_, _ = w.Write(data)
}

// pageHandler 只做「能不能进 SPA」的门禁。角色与 MFA 的真实判定在 /admin/* 数据
// 端点；这里提前拦是为了避免用户打开一页空壳再被 403 弹回来。
func pageHandler(svc *auth.Service, name string, gate pageGate) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var (
			ok           bool
			role         string
			impersonator int64
		)
		// 模拟会话优先（独立 cookie）：模拟期间不进管理后台页面，数据层也会 403。
		if ck, err := r.Cookie(auth.ImpersonationCookieName); err == nil && ck.Value != "" {
			if c, err := svc.ValidWebSession(ck.Value); err == nil && c.ImpersonatorUID > 0 {
				ok, role, impersonator = true, c.Role, c.ImpersonatorUID
			}
		}
		if !ok {
			if ck, err := r.Cookie(auth.WebCookieName); err == nil && ck.Value != "" {
				if c, err := svc.ValidWebSession(ck.Value); err == nil {
					ok = true
					role = c.Role
				}
			}
		}
		if ok && impersonator > 0 && (gate == gateAdmin || gate == gateSuper) {
			http.Redirect(w, r, "/web/console", http.StatusFound)
			return
		}
		switch gate {
		case gatePublic:
			if ok {
				http.Redirect(w, r, "/web/console", http.StatusFound)
				return
			}
		case gateAuth:
			if !ok {
				http.Redirect(w, r, "/web/login?next="+r.URL.RequestURI(), http.StatusFound)
				return
			}
		case gateAdmin:
			if !ok {
				http.Redirect(w, r, "/web/login?next="+r.URL.RequestURI(), http.StatusFound)
				return
			}
			if !auth.IsAdminRole(role) {
				http.Redirect(w, r, "/web/console", http.StatusFound)
				return
			}
		case gateSuper:
			if !ok {
				http.Redirect(w, r, "/web/login?next="+r.URL.RequestURI(), http.StatusFound)
				return
			}
			if !auth.IsAdminRole(role) {
				http.Redirect(w, r, "/web/console", http.StatusFound)
				return
			}
			if !auth.IsSuperRole(role) {
				http.Redirect(w, r, "/web/admin/sessions", http.StatusFound)
				return
			}
		}
		serveSPA(w)
	})
}

func serveSPA(w http.ResponseWriter) {
	serveSPAStatus(w, http.StatusOK)
}

func serveSPAStatus(w http.ResponseWriter, status int) {
	h := w.Header()
	h.Set("Content-Type", "text/html; charset=utf-8")
	h.Set("Cache-Control", "no-store")
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Referrer-Policy", "same-origin")
	// UA Client Hints 的 opt-in：浏览器见到后才会在后续请求带高熵机型。
	h.Set("Accept-CH", "Sec-CH-UA-Platform, Sec-CH-UA-Model")
	w.WriteHeader(status)
	_, _ = w.Write(ui.Index())
}

func webSessionOK(svc *auth.Service, r *http.Request) bool {
	for _, name := range []string{auth.ImpersonationCookieName, auth.WebCookieName} {
		ck, err := r.Cookie(name)
		if err != nil || ck.Value == "" {
			continue
		}
		if _, err = svc.ValidWebSession(ck.Value); err == nil {
			return true
		}
	}
	return false
}
