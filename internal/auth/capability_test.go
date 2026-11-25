package auth

import (
	"strconv"
	"strings"
	"testing"
	"time"
)

// TestRootIdentityAnchors 钉住根管理员的**身份锚点**（不是凭据）：
//
//	uid   = 5939716（authoritative：改绑邮箱不失权）
//	email = hs@horatio.cn（兜底：库里还没有 RootUID 行时按它解析一次）
//
// 出处见 admin.go 的头注释：Google Cloud super admin best practices 要求破窗
// 账号唯一、受 MFA 保护；CWE-798 禁止的是硬编码凭据，钉身份 id 不等于钉口令。
func TestRootIdentityAnchors(t *testing.T) {
	if RootUID != 5939716 {
		t.Errorf("RootUID 应为 5939716（作者定案），得到 %d", RootUID)
	}
	if RootSuperEmail != "hs@horatio.cn" {
		t.Errorf("兜底邮箱应为 hs@horatio.cn，得到 %q", RootSuperEmail)
	}
	if normalizeEmail(RootSuperEmail) != RootSuperEmail {
		t.Error("兜底邮箱必须是归一化形态（小写去空格），否则按邮箱解析会漂")
	}
}

// TestRoleRank 钉角色能力等级：user < admin < super，未知值按最低权限。
func TestRoleRank(t *testing.T) {
	for role, want := range map[string]int{
		adminRoleUser: 0, adminRoleAdmin: 1, adminRoleSuper: 2, "": 0, "root": 0,
	} {
		if got := roleRank(role); got != want {
			t.Errorf("roleRank(%q) = %d，应为 %d", role, got, want)
		}
	}
}

// TestRoleAssignAllowedMatrix 是能力矩阵的**逐格**测试：谁能把谁改成什么角色。
//
//	actor \ target | user | admin | super | 从 super 降级
//	user           | 拒   | 拒    | 拒    | 拒
//	app-admin      | 拒   | 拒    | 拒    | 拒
//	super(非根)    | 允   | 允    | 拒    | 拒
//	root           | 允   | 允    | 允    | 允
//
// 「拒」必须带 permission reason（前端据此显示「申请权限」而不是「联系管理员解封」）。
func TestRoleAssignAllowedMatrix(t *testing.T) {
	type actor struct {
		name   string
		role   string
		isRoot bool
	}
	actors := []actor{
		{"user", adminRoleUser, false},
		{"app-admin", adminRoleAdmin, false},
		{"super", adminRoleSuper, false},
		{"root", adminRoleSuper, true},
	}
	type target struct {
		name    string
		current string
		newRole string
	}
	targets := []target{
		{"user→user", adminRoleUser, adminRoleUser},
		{"user→admin", adminRoleUser, adminRoleAdmin},
		{"user→super", adminRoleUser, adminRoleSuper},
		{"admin→user", adminRoleAdmin, adminRoleUser},
		{"admin→super", adminRoleAdmin, adminRoleSuper},
		{"super→admin", adminRoleSuper, adminRoleAdmin},
		{"super→super", adminRoleSuper, adminRoleSuper},
	}
	// 期望：每个 actor 对每个 target 是否允许。
	want := map[string]map[string]bool{
		"user":      {"user→user": false, "user→admin": false, "user→super": false, "admin→user": false, "admin→super": false, "super→admin": false, "super→super": false},
		"app-admin": {"user→user": false, "user→admin": false, "user→super": false, "admin→user": false, "admin→super": false, "super→admin": false, "super→super": false},
		"super":     {"user→user": true, "user→admin": true, "user→super": false, "admin→user": true, "admin→super": false, "super→admin": false, "super→super": false},
		"root":      {"user→user": true, "user→admin": true, "user→super": true, "admin→user": true, "admin→super": true, "super→admin": true, "super→super": true},
	}
	for _, a := range actors {
		for _, tg := range targets {
			err := roleAssignAllowed(a.role, a.isRoot, tg.current, tg.newRole)
			allowed := err == nil
			if allowed != want[a.name][tg.name] {
				t.Errorf("%s %s: allowed=%v，应为 %v（err=%v）", a.name, tg.name, allowed, want[a.name][tg.name], err)
			}
			if err != nil {
				var he *HTTPError
				if !asHTTPError(err, &he) || he.Code != 403 || he.Reason != ReasonPermission {
					t.Errorf("%s %s: 拒绝应是 403/permission，得到 %+v", a.name, tg.name, err)
				}
			}
		}
	}
}

// TestScopeGrantAllowedMatrix：授予/回收项目权限 = 任一平台管理员（含 root），
// app-admin 与普通用户无授予权（W2 契约的「只能授予低于自己」）。
func TestScopeGrantAllowedMatrix(t *testing.T) {
	for role, want := range map[string]bool{
		adminRoleSuper: true, adminRoleAdmin: false, adminRoleUser: false, "": false,
	} {
		if got := scopeGrantAllowed(role) == nil; got != want {
			t.Errorf("scopeGrantAllowed(%q)=%v，应为 %v", role, got, want)
		}
	}
	// 非平台管理员的拒绝同样带 permission reason
	err := scopeGrantAllowed(adminRoleAdmin)
	var he *HTTPError
	if !asHTTPError(err, &he) || he.Code != 403 || he.Reason != ReasonPermission {
		t.Errorf("app-admin 授予应 403/permission，得到 %+v", err)
	}
}

// TestPolicyDeniedReasons：封禁 / 项目白名单 = policy；根收口 / scope = permission。
// 只测纯构造，不拉库（真库矩阵在 admin/scope/passkey 的真库用例里）。
func TestPolicyDeniedReasons(t *testing.T) {
	for _, err := range []error{policyDenied("封禁"), policyDenied("项目白名单")} {
		var he *HTTPError
		if !asHTTPError(err, &he) || he.Code != 403 || he.Reason != ReasonPolicy {
			t.Errorf("policy 拒绝应为 403/policy，得到 %+v", err)
		}
	}
	for _, err := range []error{permissionDenied("角色"), permissionDenied("scope")} {
		var he *HTTPError
		if !asHTTPError(err, &he) || he.Code != 403 || he.Reason != ReasonPermission {
			t.Errorf("permission 拒绝应为 403/permission，得到 %+v", err)
		}
	}
}

// asHTTPError 是测试里的 errors.As 小包装（避免每个用例重复 import errors）。
func asHTTPError(err error, target **HTTPError) bool {
	for err != nil {
		if he, ok := err.(*HTTPError); ok {
			*target = he
			return true
		}
		type unwrapper interface{ Unwrap() error }
		u, ok := err.(unwrapper)
		if !ok {
			return false
		}
		err = u.Unwrap()
	}
	return false
}

// ---- 真库用例（无 TEST_MYSQL_DSN 时 Skip，与包内其它真库测试同策略）----

// TestRootAccountResolvedByUID：库里有 RootUID 行时，即使邮箱不是兜底地址，
// 根判定仍按 uid 成立（换绑邮箱不失权）。非根 super 不能冒充。
func TestRootAccountResolvedByUID(t *testing.T) {
	svc, mailer := newTestService(t)
	now := time.Now().UnixMilli()
	if _, err := svc.pool.Exec(
		"INSERT INTO users (id, email, created_at, token_version, role) VALUES (?,?,?,1,?)",
		RootUID, "root-alt@example.com", now, adminRoleSuper); err != nil {
		t.Fatalf("落根账号: %v", err)
	}
	other := newPasskeyUser(t, svc, mailer, "root-other@example.com")
	if _, err := svc.pool.Exec("UPDATE users SET role = ? WHERE id = ?", adminRoleSuper, other.UID); err != nil {
		t.Fatalf("提 other 为 super: %v", err)
	}
	svc.rootUID.Store(0) // 强制下一次判定重新解析
	if !svc.IsRootUID(RootUID) {
		t.Error("RootUID 必须被判为根（按 uid，不按邮箱）")
	}
	if svc.IsRootUID(other.UID) {
		t.Error("非根 super 不该被判为根")
	}
	if !svc.isRootSuper(Caller{UID: RootUID, Email: "whatever@example.com"}) {
		t.Error("根账号换绑邮箱后仍应是根（uid 锚点）")
	}
	if svc.isRootSuper(Caller{UID: other.UID, Email: "root-alt@example.com"}) {
		t.Error("邮箱相同但 uid 不同不该是根")
	}
}

// TestAdminSearchUsersFiltered：role / banned 两个可选过滤与 query 叠加；
// 过期封禁不算「生效封禁」（与 gate.go 的惰性判定同口径）。
func TestAdminSearchUsersFiltered(t *testing.T) {
	svc, mailer := newTestService(t)
	a := newPasskeyUser(t, svc, mailer, "filter-a@example.com")
	b := newPasskeyUser(t, svc, mailer, "filter-b@example.com")
	if _, err := svc.pool.Exec("UPDATE users SET role = ? WHERE id = ?", adminRoleAdmin, b.UID); err != nil {
		t.Fatalf("设 b 为 admin: %v", err)
	}
	now := time.Now().UnixMilli()
	// a 永久封禁；另一条过期封禁不应让它出现在 banned=true 里
	if _, err := svc.pool.Exec(
		"INSERT INTO user_bans (uid, app, until_ms, reason, banned_by, created_at) VALUES (?,?,?,?,0,?)",
		a.UID, "*", 0, "test", now); err != nil {
		t.Fatalf("封 a: %v", err)
	}
	if _, err := svc.pool.Exec(
		"INSERT INTO user_bans (uid, app, until_ms, reason, banned_by, created_at) VALUES (?,?,?,?,0,?)",
		b.UID, "CalorieDiary", now-1000, "expired", now); err != nil {
		t.Fatalf("种过期封禁: %v", err)
	}
	// role=admin 只回 b
	admins, total, err := svc.AdminSearchUsersFiltered("", adminRoleAdmin, nil, 50, 0)
	if err != nil || total != 1 || len(admins) != 1 || admins[0].UID != b.UID {
		t.Errorf("role=admin 应只回 b，得到 total=%d list=%+v err=%v", total, admins, err)
	}
	// banned=true 只回 a
	banned := true
	bans, total, err := svc.AdminSearchUsersFiltered("", "", &banned, 50, 0)
	if err != nil || total != 1 || len(bans) != 1 || bans[0].UID != a.UID {
		t.Errorf("banned=true 应只回 a，得到 total=%d list=%+v err=%v", total, bans, err)
	}
	// banned=false 不含 a（b 的封禁已过期，算未封）
	unbanned := false
	clean, total, err := svc.AdminSearchUsersFiltered("", "", &unbanned, 50, 0)
	if err != nil || total < 1 {
		t.Fatalf("banned=false 应有行: total=%d err=%v", total, err)
	}
	for _, u := range clean {
		if u.UID == a.UID {
			t.Error("banned=false 不该包含生效封禁的 a")
		}
	}
	// 非法 role → 400
	_, _, rerr := svc.AdminSearchUsersFiltered("", "root", nil, 10, 0)
	if code, _ := httpMsg(rerr); code != 400 {
		t.Errorf("非法 role 应 400，得到 %d", code)
	}
}

// TestAdminProjectListsAdmins：GET /admin/projects 的 admins 字段来自 admin_scopes，
// 与 members（project_access）分开。
func TestAdminProjectListsAdmins(t *testing.T) {
	svc, mailer := newTestService(t)
	admin := newPasskeyUser(t, svc, mailer, "proj-admin@example.com")
	if err := svc.AdminSetScope(Caller{UID: RootUID, Email: RootSuperEmail}, admin.UID, "CalorieDiary", true); err != nil {
		// 根账号未入库时 AdminSetScope 会因操作者非 super 拒绝；直接落行造数据
		if _, xerr := svc.pool.Exec(
			"INSERT INTO admin_scopes (uid, app, granted_by, granted_at) VALUES (?,?,?,?)",
			admin.UID, "CalorieDiary", admin.UID, time.Now().UnixMilli()); xerr != nil {
			t.Fatalf("落授权行: %v", xerr)
		}
		// 有效 app-admin 需要 role=admin（只留 scope 行是脏数据，列表不该当管理员）
		if _, xerr := svc.pool.Exec("UPDATE users SET role = ? WHERE id = ?", adminRoleAdmin, admin.UID); xerr != nil {
			t.Fatalf("提 admin: %v", xerr)
		}
	}
	projects, err := svc.AdminListProjects(AdminScope{Super: true})
	if err != nil {
		t.Fatalf("列项目: %v", err)
	}
	var cal *AdminProject
	for i := range projects {
		if projects[i].App == "CalorieDiary" {
			cal = &projects[i]
		}
	}
	if cal == nil {
		t.Fatal("缺 CalorieDiary 项目")
	}
	if len(cal.Admins) != 1 || cal.Admins[0].UID != admin.UID {
		t.Errorf("admins 应含该项目管理员，得到 %+v", cal.Admins)
	}
}

// TestAdminSessionAggregates：聚合与列表吃同一套筛选；地区算不出的行不进展汇总。
func TestAdminSessionAggregates(t *testing.T) {
	svc, mailer := newTestService(t)
	u := newPasskeyUser(t, svc, mailer, "agg@example.com")
	if _, err := svc.Login("agg@example.com", "secret123", "CalorieDiary", testMeta); err != nil {
		t.Fatalf("calorie 登录: %v", err)
	}
	if _, err := svc.CreateWebSession(u.UID, SessionMeta{IP: "127.0.0.1", UserAgent: "Chrome"}); err != nil {
		t.Fatalf("web 会话: %v", err)
	}
	apps, regions, err := svc.AdminSessionAggregates(u.UID, nil, "", "")
	if err != nil {
		t.Fatalf("聚合: %v", err)
	}
	var calCount int
	for _, a := range apps {
		if a.Name == "CalorieDiary" {
			calCount = a.Count
		}
	}
	if calCount == 0 {
		t.Errorf("app 汇总应含 CalorieDiary，得到 %+v", apps)
	}
	for _, r := range regions {
		if strings.TrimSpace(r.Name) == "" {
			t.Errorf("地区汇总不该出现空名桶: %+v", regions)
		}
	}
}

// TestSessionExposesExpiry：列表带绝对到期时刻（新行 = now + 90 天）。
func TestSessionExposesExpiry(t *testing.T) {
	svc, mailer := newTestService(t)
	reg := registerViaCode(t, svc, mailer, "expiry@example.com", "secret123")
	c, err := svc.ValidUserID("Bearer " + reg.Token)
	if err != nil {
		t.Fatalf("解析 token: %v", err)
	}
	items, err := svc.ListSessions(c.UID, c.SID, nil)
	if err != nil || len(items) == 0 {
		t.Fatalf("列会话: %v", err)
	}
	want := time.Now().Add(tokenTTL).UnixMilli()
	if d := items[0].ExpiresAt - want; d < -time.Minute.Milliseconds() || d > time.Minute.Milliseconds() {
		t.Errorf("ExpiresAt 应约等于 now+90d，得到 %d（差 %dms）", items[0].ExpiresAt, d)
	}
	if items[0].IdleExpiresAt != 0 {
		t.Errorf("App 会话不该有空闲到期，得到 %d", items[0].IdleExpiresAt)
	}
	_ = strconv.FormatInt(c.SID, 10)
}

// 兜底邮箱不能成为提权入口：有人注册了 RootSuperEmail 但 role=user 时，
// 解析（要求 role=super）必须失败，根判定 fail closed。
func TestRootEmailWithoutSuperRoleIsNotRoot(t *testing.T) {
	svc, mailer := newTestService(t)
	c := newPasskeyUser(t, svc, mailer, RootSuperEmail) // newPasskeyUser 建的是 role=user
	svc.rootUID.Store(0)
	if svc.IsRootUID(c.UID) {
		t.Error("只有兜底邮箱、role=user 的账号不该是根（fail closed）")
	}
	if svc.isRootSuper(c) {
		t.Error("isRootSuper 也不该认这个账号")
	}
}

// 根账号的**保护侧**必须 fail closed = 「当作根」：解析失败（DB 抖动、兜底邮箱
// 尚未入库、职责行被误降级）时若回 false，那一刻任何非根 su 都能重置根的口令/邮箱。
// 纯锚点用例不触库：service 只留零值，isRootAccount 在查到 RootUID 时直接返回。
func TestRootAnchorProtectsEvenWhenUnresolved(t *testing.T) {
	svc := &Service{} // 不设 pool：本用例只走「保留号即根」的锚点分支
	if !svc.isRootAccount(RootUID) {
		t.Error("保留号 RootUID 在解析失败时仍应被当作根（保护侧 fail closed）")
	}
	if !svc.IsRootUID(RootUID) {
		t.Error("IsRootUID 与 isRootAccount 同源，保留号应判真")
	}
}

// 授权侧相反：解析不出根时 isRootSuper 必须 false（否则「占着保留号」或「注册兜底
// 邮箱」就成了提权路径）。restricted service 直接短路在 rootUID==0 的判定上。
func TestRootSuperFailsClosedWithoutResolution(t *testing.T) {
	svc := &Service{}
	svc.rootUID.Store(RootUID) // 已解析出根 = 保留号
	if !svc.isRootSuper(Caller{UID: RootUID}) {
		t.Error("已解析出根时，保留号本人应是根 su")
	}
	if svc.isRootSuper(Caller{UID: RootUID + 1}) {
		t.Error("非保留号不该是根 su")
	}
}

// 根账号的收口要覆盖**全部**管理写操作：整户踢会话也必须走 adminTarget，
// 否则非根 su 能把破窗账号的全部设备定向踢下线（只影响可用性，但违反
// 「只有根能操作该账号」的口径）。顺带钉住「目标不存在 = 404」与其它端点一致。
func TestAdminRevokeUserSessionsProtectsRoot(t *testing.T) {
	svc, mailer := newTestService(t)
	now := time.Now().UnixMilli()
	if _, err := svc.pool.Exec(
		"INSERT INTO users (id, email, created_at, token_version, role) VALUES (?,?,?,1,?)",
		RootUID, RootSuperEmail, now, adminRoleSuper); err != nil {
		t.Fatalf("落根账号: %v", err)
	}
	svc.rootUID.Store(0) // 走一次真实解析
	other := seedAdminUser(t, svc, mailer, "kick-super@example.com", adminRoleSuper)

	if code, msg := httpMsg(svc.AdminRevokeUserSessions(other, RootUID)); code != 403 || !strings.Contains(msg, "根管理员") {
		t.Errorf("非根 su 踢根账号应 403 并点名根管理员，得到 %d %q", code, msg)
	}
	if code, _ := httpMsg(svc.AdminRevokeUserSessions(other, 999999999)); code != 404 {
		t.Errorf("不存在的目标应 404，得到 %d", code)
	}
	if err := svc.AdminRevokeUserSessions(other, other.UID); err != nil {
		t.Errorf("普通目标应放行: %v", err)
	}
}
