package main

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/WXies-Team/Auth/internal/auth"
)

// 契约缺口（UI 批次转来的 7 条）里的服务端可测部分：/admin/projects.admins、
// /admin/users 的 role/banned 过滤、/admin/sessions 的 apps/regions 汇总、
// /web/session.isRoot、403 的 reason 分级。全部是**只增字段**，老形状不变。
func TestContractGapsRouteShapes(t *testing.T) {
	e := newRouteEnv(t)
	super := makeActor(t, e, "gap-super", "super", nil)

	// 一个带 CalorieDiary scope 的 app-admin + 一个生效封禁的普通用户
	appAdminUID := seedUser(t, e, "gap-appadmin@example.com", "secret123", "user")
	if _, err := e.pool.Exec(
		"INSERT INTO admin_scopes (uid, app, granted_by, granted_at) VALUES (?,?,?,?)",
		appAdminUID, "CalorieDiary", super.uid, time.Now().UnixMilli()); err != nil {
		t.Fatalf("落 scope: %v", err)
	}
	if _, err := e.pool.Exec("UPDATE users SET role = 'admin' WHERE id = ?", appAdminUID); err != nil {
		t.Fatalf("提 admin: %v", err)
	}
	bannedUID := seedUser(t, e, "gap-banned@example.com", "secret123", "user")
	// 先造会话再封禁：登录闸会挡被封账号，封禁前登录才是生产里「先有会话、后被封」的形态
	if _, err := e.svc.Login("gap-banned@example.com", "secret123", "CalorieDiary",
		auth.SessionMeta{IP: "10.0.0.44", UserAgent: "Gap/1.0"}); err != nil {
		t.Fatalf("造会话: %v", err)
	}
	if _, err := e.pool.Exec(
		"INSERT INTO user_bans (uid, app, until_ms, reason, banned_by, created_at) VALUES (?,?,?,?,0,?)",
		bannedUID, "*", 0, "gap", time.Now().UnixMilli()); err != nil {
		t.Fatalf("封禁: %v", err)
	}

	// ① /admin/projects 带 admins
	rec := e.do(t, "GET", "/admin/projects", "", super.cookieOnly)
	if rec.Code != http.StatusOK {
		t.Fatalf("/admin/projects 应 200，得到 %d %s", rec.Code, rec.Body.String())
	}
	var projects struct {
		Projects []struct {
			App    string `json:"app"`
			Admins []struct {
				UID   int64  `json:"uid"`
				Email string `json:"email"`
			} `json:"admins"`
		} `json:"projects"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &projects); err != nil {
		t.Fatalf("解析 projects: %v", err)
	}
	var found bool
	for _, p := range projects.Projects {
		if p.App != "CalorieDiary" {
			continue
		}
		if p.Admins == nil {
			t.Error("admins 应恒为数组，不能是 null")
		}
		for _, a := range p.Admins {
			if a.UID == appAdminUID {
				found = true
			}
		}
	}
	if !found {
		t.Error("CalorieDiary.admins 应含刚授予的 app-admin")
	}

	// ② /admin/users?role=admin 与 ?banned=true
	rec = e.do(t, "GET", "/admin/users?role=admin", "", super.cookieOnly)
	if rec.Code != http.StatusOK {
		t.Fatalf("role 过滤应 200，得到 %d %s", rec.Code, rec.Body.String())
	}
	var usersPage struct {
		Items []struct {
			UID  int64  `json:"uid"`
			Role string `json:"role"`
		} `json:"items"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &usersPage); err != nil {
		t.Fatalf("解析 users: %v", err)
	}
	for _, u := range usersPage.Items {
		if u.Role != "admin" {
			t.Errorf("role=admin 过滤混入 %+v", u)
		}
	}
	rec = e.do(t, "GET", "/admin/users?banned=true", "", super.cookieOnly)
	if rec.Code != http.StatusOK || !strings.Contains(rec.Body.String(), "gap-banned@example.com") {
		t.Errorf("banned=true 应命中被封用户，得到 %d %s", rec.Code, rec.Body.String())
	}
	// 非法过滤值 → 400（不静默回全量）
	if rec := e.do(t, "GET", "/admin/users?banned=maybe", "", super.cookieOnly); rec.Code != http.StatusBadRequest {
		t.Errorf("非法 banned 应 400，得到 %d", rec.Code)
	}

	// ③ /admin/sessions 带 apps/regions 汇总（即使为空也必须是数组）
	rec = e.do(t, "GET", "/admin/sessions", "", super.cookieOnly)
	if rec.Code != http.StatusOK {
		t.Fatalf("/admin/sessions 应 200，得到 %d %s", rec.Code, rec.Body.String())
	}
	var sessPage struct {
		Apps    []auth.SessionAggregate `json:"apps"`
		Regions []auth.SessionAggregate `json:"regions"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &sessPage); err != nil {
		t.Fatalf("解析 sessions: %v", err)
	}
	if sessPage.Apps == nil || sessPage.Regions == nil {
		t.Error("apps/regions 应恒为数组，不能是 null")
	}
	if len(sessPage.Apps) == 0 {
		t.Error("至少应有 CalorieDiary 的会话汇总")
	}

	// ④ 403 reason=permission：普通用户（过 MFA + reauth 也进不了后台）
	plain := makeActor(t, e, "gap-plain", "user", nil)
	rec = e.do(t, "GET", "/admin/users", "", plain.cookieOnly)
	if rec.Code != http.StatusForbidden {
		t.Fatalf("普通用户进后台应 403，得到 %d", rec.Code)
	}
	var apiErr struct {
		Message string `json:"message"`
		Reason  string `json:"reason"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &apiErr); err != nil {
		t.Fatalf("解析 403 体: %v", err)
	}
	if apiErr.Reason != auth.ReasonPermission {
		t.Errorf("后台拒绝 reason 应为 permission，得到 %q（%s）", apiErr.Reason, rec.Body.String())
	}
}

// /web/session.isRoot 与后端 RootUID 同源：根账号 true、非根 super false。
func TestWebSessionIsRootField(t *testing.T) {
	e := newRouteEnv(t)
	root := makeActorEmail(t, e, "gap-root", auth.RootSuperEmail, "super", nil)
	super := makeActor(t, e, "gap-super2", "super", nil)
	for _, c := range []struct {
		a    *adminActor
		want bool
	}{{root, true}, {super, false}} {
		rec := e.do(t, "POST", "/web/session", "", c.a.withCSRF)
		if rec.Code != http.StatusOK {
			t.Fatalf("%s /web/session 应 200，得到 %d %s", c.a.name, rec.Code, rec.Body.String())
		}
		var body struct {
			IsRoot bool `json:"isRoot"`
		}
		if err := json.Unmarshal(rec.Body.Bytes(), &body); err != nil {
			t.Fatalf("解析 session: %v", err)
		}
		if body.IsRoot != c.want {
			t.Errorf("%s isRoot=%v，应为 %v", c.a.name, body.IsRoot, c.want)
		}
	}
}
