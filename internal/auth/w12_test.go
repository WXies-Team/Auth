package auth

import (
	"crypto/sha1"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// HIBP k-Anonymity 的本地替身：只回一个前缀下的「后缀:次数」清单。
func breachTestServer(t *testing.T, password string, mode string) *httptest.Server {
	t.Helper()
	sum := sha1.Sum([]byte(password))
	full := strings.ToUpper(hex.EncodeToString(sum[:]))
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !strings.HasPrefix(r.URL.Path, "/range/") || len(r.URL.Path) != len("/range/")+5 {
			t.Errorf("请求路径应是 5 位前缀，得到 %s", r.URL.Path)
		}
		if r.Header.Get("Add-Padding") != "true" {
			t.Error("缺 Add-Padding，响应长度可被流量分析")
		}
		switch mode {
		case "error":
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		if r.URL.Path != "/range/"+full[:5] {
			_, _ = fmt.Fprint(w, "0000000000000000000000000000000000A:1\r\n")
			return
		}
		// 「未命中」的前缀行也回几行，确保按完整 suffix 比对而不是看有没有任何行
		_, _ = fmt.Fprintf(w, "0000000000000000000000000000000000A:1\r\n%s:42\r\n", full[5:])
	}))
}

func withBreachServer(t *testing.T, url string) {
	t.Helper()
	oldURL, oldClient := breachRangeURL, breachHTTPClient
	breachRangeURL = url
	t.Cleanup(func() { breachRangeURL, breachHTTPClient = oldURL, oldClient })
}

// 未注入 cfg 时默认不查（单测/未接线不打外网）。
func TestBreachCheckDisabledWithoutConfig(t *testing.T) {
	s := &Service{}
	if s.breachCheckEnabled() {
		t.Fatal("未注入 cfg 时泄露库校验应关闭")
	}
	if err := s.rejectBreached("anything"); err != nil {
		t.Fatalf("关闭时不应拒绝: %v", err)
	}
}

func TestBreachCheckDetectsLeakedPassword(t *testing.T) {
	srv := breachTestServer(t, "Password123!", "hit")
	defer srv.Close()
	withBreachServer(t, srv.URL+"/range/")

	s := &Service{cfg: func(string) (string, error) { return "1", nil }}
	if err := s.rejectBreached("Password123!"); err == nil {
		t.Fatal("命中泄露库的密码应被拒绝")
	}
	if err := s.rejectBreached("a-different-not-leaked-password"); err != nil {
		t.Fatalf("未命中的密码不应被拒绝: %v", err)
	}
}

func TestBreachCheckFailsOpenOnServerError(t *testing.T) {
	srv := breachTestServer(t, "Password123!", "error")
	defer srv.Close()
	withBreachServer(t, srv.URL+"/range/")

	s := &Service{cfg: func(string) (string, error) { return "1", nil }}
	if err := s.rejectBreached("Password123!"); err != nil {
		t.Fatalf("第三方不可用时应放行（本地强度规则仍在）: %v", err)
	}
}

func TestBreachCheckCanBeDisabled(t *testing.T) {
	s := &Service{cfg: func(string) (string, error) { return "off", nil }}
	if s.breachCheckEnabled() {
		t.Fatal("显式 off 应关闭泄露库校验")
	}
}

// 自助注册默认关闭：未注入 cfg 时不能注册（即使凭据先验全过）。
func TestSelfRegisterDefaultsClosed(t *testing.T) {
	s := &Service{}
	if s.SelfRegisterEnabled() {
		t.Fatal("未注入 cfg 时自助注册应关闭")
	}
}

func TestSelfRegisterConfigParsing(t *testing.T) {
	s := &Service{cfg: func(string) (string, error) { return "1", nil }}
	if !s.SelfRegisterEnabled() {
		t.Fatal("配置为 1 时应开启")
	}
	s.cfg = func(string) (string, error) { return "0", nil }
	if s.SelfRegisterEnabled() {
		t.Fatal("配置为 0 时应关闭")
	}
}

// 模拟登录的入参守卫在查库之前：短理由/自模拟必须当场 400。
func TestImpersonationGuards(t *testing.T) {
	s := &Service{}
	if _, _, err := s.StartImpersonation(1, 2, "短", "", SessionMeta{}); err == nil {
		t.Fatal("过短的理由应被拒绝")
	}
	if _, _, err := s.StartImpersonation(1, 1, "排查用户反馈", "", SessionMeta{}); err == nil {
		t.Fatal("模拟自己应被拒绝")
	}
}

func TestRiskNewIPMFADefaultsOn(t *testing.T) {
	s := &Service{}
	if !s.riskNewIPMFA() {
		t.Fatal("未配置时应默认开启新 IP 强制 2FA")
	}
	s.cfg = func(string) (string, error) { return "0", nil }
	if s.riskNewIPMFA() {
		t.Fatal("显式 0 应关闭")
	}
	s.cfg = func(string) (string, error) { return "", nil }
	if !s.riskNewIPMFA() {
		t.Fatal("空值应回默认开启")
	}
}

func TestParseOAuthScope(t *testing.T) {
	for _, tc := range []struct {
		raw  string
		want string
		ok   bool
	}{
		{"", "uid email", true},
		{"email", "email", true},
		{"email uid", "uid email", true}, // 顺序归一
		{"uid uid", "uid", true},
		{"uid profile", "", false},
		{"   ", "uid email", true},
	} {
		got, err := parseOAuthScope(tc.raw)
		if tc.ok {
			if err != nil {
				t.Fatalf("scope=%q 不应报错: %v", tc.raw, err)
			}
			if joined := strings.Join(got, " "); joined != tc.want {
				t.Errorf("scope=%q 归一化应为 %q，得到 %q", tc.raw, tc.want, joined)
			}
		} else if err == nil {
			t.Errorf("scope=%q 应报错", tc.raw)
		}
	}
}

// 审计邮箱的展示口径：自己的事件全文，别人的事件掩码（存储层保留全文）。
func TestMaskActorEmailFor(t *testing.T) {
	if got := maskActorEmailFor(7, 7, "owner@example.com"); got != "owner@example.com" {
		t.Errorf("自己的事件应保留全文，得到 %q", got)
	}
	if got := maskActorEmailFor(9, 7, "admin@example.com"); got != "a***@example.com" {
		t.Errorf("他人的事件应掩码，得到 %q", got)
	}
	if got := maskActorEmailFor(0, 7, "anon@example.com"); got != "a***@example.com" {
		t.Errorf("匿名 actor 也应掩码，得到 %q", got)
	}
	if got := maskActorEmailFor(9, 7, ""); got != "" {
		t.Errorf("空邮箱应保持空，得到 %q", got)
	}
}
