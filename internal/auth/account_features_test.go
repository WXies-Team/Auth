package auth

import (
	"strings"
	"testing"
	"time"
)

// 真库端到端：授权记录 → 数据导出 → 安全活动 → 撤销；管理员重置 MFA 清凭证并通知。
// 无 TEST_MYSQL_DSN 时整组 Skip（与包内其它真库用例同策略）。
func TestAccountFeaturesEndToEnd(t *testing.T) {
	svc, mailer := newTestService(t)
	user := registerViaCode(t, svc, mailer, "features@example.com", "correct-horse-1")
	var uid int64
	if err := svc.pool.QueryRow("SELECT id FROM users WHERE email = ?", user.Email).Scan(&uid); err != nil {
		t.Fatalf("查 uid: %v", err)
	}

	// 授权记录：重复授权只刷新时间，不新增行。
	svc.RecordConsent(uid, "CalorieDiary")
	svc.RecordConsent(uid, "CalorieDiary")
	apps, err := svc.ListConnectedApps(uid)
	if err != nil {
		t.Fatalf("列授权: %v", err)
	}
	if len(apps) != 1 || apps[0].App != "CalorieDiary" || len(apps[0].Scopes) == 0 {
		t.Fatalf("授权记录不对: %+v", apps)
	}

	// 导出包含账号、授权与审计。
	exp, err := svc.ExportAccount(uid)
	if err != nil {
		t.Fatalf("导出: %v", err)
	}
	if exp.Email != user.Email || len(exp.ConnectedApps) != 1 || len(exp.Audit) == 0 {
		t.Errorf("导出内容不完整: %+v", exp)
	}

	// 安全活动至少能看到授权事件。
	rows, total, err := svc.UserAuditLog(uid, 20, 0)
	if err != nil {
		t.Fatalf("安全活动: %v", err)
	}
	if total == 0 || len(rows) == 0 {
		t.Fatal("安全活动应有记录")
	}

	// 撤销授权：行消失，审计留下撤销事件。
	if err := svc.RevokeConnectedApp(uid, "CalorieDiary"); err != nil {
		t.Fatalf("撤销授权: %v", err)
	}
	apps, err = svc.ListConnectedApps(uid)
	if err != nil || len(apps) != 0 {
		t.Fatalf("撤销后应为空: %v %+v", err, apps)
	}

	// 管理员重置 MFA：清 TOTP + 恢复码、吊销会话、发通知。
	now := time.Now().UnixMilli()
	if _, err := svc.pool.Exec("INSERT INTO totp_factors (user_id, secret_cipher, enabled, created_at) VALUES (?, ?, 1, ?)",
		uid, []byte("cipher"), now); err != nil {
		t.Fatalf("造 TOTP 行: %v", err)
	}
	if _, err := svc.pool.Exec("INSERT INTO recovery_codes (user_id, code_hash, used, created_at) VALUES (?, ?, 0, ?)",
		uid, strings.Repeat("a", 64), now); err != nil {
		t.Fatalf("造恢复码: %v", err)
	}
	super := seedAdminUser(t, svc, mailer, "features-super@example.com", adminRoleSuper)
	if err := svc.AdminResetMFA(super, uid); err != nil {
		t.Fatalf("重置 MFA: %v", err)
	}
	var factors, codes int
	_ = svc.pool.QueryRow("SELECT COUNT(*) FROM totp_factors WHERE user_id = ?", uid).Scan(&factors)
	_ = svc.pool.QueryRow("SELECT COUNT(*) FROM recovery_codes WHERE user_id = ?", uid).Scan(&codes)
	if factors != 0 || codes != 0 {
		t.Errorf("重置后 TOTP/恢复码应清空，得到 %d/%d", factors, codes)
	}
	found := false
	for _, m := range mailer.sent {
		if strings.Contains(m.subject, "两步验证") {
			found = true
		}
	}
	if !found {
		t.Error("重置 MFA 应发通知邮件")
	}
}
