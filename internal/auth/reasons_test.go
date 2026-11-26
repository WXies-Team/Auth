package auth

import "testing"

// 401 的 reason 是前端分流的机器可读契约：会话过期才跳登录，凭据错误留在原地。
func TestUnauthorizedReasons(t *testing.T) {
	cases := []struct {
		msg  string
		want string
	}{
		{"登录已过期，请重新登录", ReasonSessionExpired},
		{"请先登录", ReasonSessionExpired},
		{"邮箱或密码错误", ""},
	}
	for _, c := range cases {
		var he *HTTPError
		if !asHTTPError(unauthorized(c.msg), &he) {
			t.Fatalf("%q 应是 HTTPError", c.msg)
		}
		if he.Code != 401 || he.Reason != c.want {
			t.Errorf("%q: 得到 %d/%q，期望 401/%q", c.msg, he.Code, he.Reason, c.want)
		}
	}
	var he *HTTPError
	if !asHTTPError(&HTTPError{Code: 401, Message: MsgReauthRequired, Reason: ReasonReauthRequired}, &he) ||
		he.Reason != ReasonReauthRequired {
		t.Error("重新验证应带 reauth_required")
	}
}
