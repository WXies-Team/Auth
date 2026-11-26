package auth

import (
	"testing"
)

// 真库：可信设备 30 天令牌只跳过 2FA，绑定 uid + UA，可列可撤。
func TestTrustedDeviceLifecycle(t *testing.T) {
	svc, mailer := newTestService(t)
	user := registerViaCode(t, svc, mailer, "trusted@example.com", "correct-horse-1")
	var uid int64
	if err := svc.pool.QueryRow("SELECT id FROM users WHERE email = ?", user.Email).Scan(&uid); err != nil {
		t.Fatalf("查 uid: %v", err)
	}
	meta := SessionMeta{UserAgent: "Mozilla/5.0 Chrome/141", IP: "203.0.113.9"}
	token, exp, err := svc.TrustDevice(uid, meta)
	if err != nil {
		t.Fatalf("签发可信设备: %v", err)
	}
	if token == "" || exp.UnixMilli() <= 0 {
		t.Fatalf("令牌/过期时间不对: %q %v", token, exp)
	}
	if !svc.CheckTrustedDevice(uid, token, meta.UserAgent) {
		t.Fatal("同 UA 应命中可信设备")
	}
	if svc.CheckTrustedDevice(uid, token, "Mozilla/5.0 Firefox/130") {
		t.Fatal("换 UA 不应命中")
	}
	list, err := svc.ListTrustedDevices(uid, token)
	if err != nil || len(list) != 1 || !list[0].Current {
		t.Fatalf("列表应有一台当前设备: %v %+v", err, list)
	}
	if err := svc.RevokeTrustedDevice(uid, list[0].ID); err != nil {
		t.Fatalf("撤销: %v", err)
	}
	if svc.CheckTrustedDevice(uid, token, meta.UserAgent) {
		t.Fatal("撤销后不应再命中")
	}
}
