package auth

import (
	"testing"
	"time"
)

// 退避时长的阶梯：前 3 次不退避，之后 2s 起逐次翻倍、60s 封顶。
func TestBackoffDelayProgression(t *testing.T) {
	cases := []struct {
		n    int
		want time.Duration
	}{
		{0, 0},
		{1, 0},
		{2, 0},
		{3, 2 * time.Second},
		{4, 4 * time.Second},
		{5, 8 * time.Second},
		{6, 16 * time.Second},
		{7, 32 * time.Second},
		{8, 60 * time.Second}, // 64s 被封顶压回 60s
		{100, 60 * time.Second},
	}
	for _, c := range cases {
		if got := backoffDelay(c.n); got != c.want {
			t.Errorf("backoffDelay(%d) 应 %s，得到 %s", c.n, c.want, got)
		}
	}
}

// 退避窗口的读写语义：无失败放行、连续失败后进入窗口、窗口过后放行、
// 成功清零，且**退避中的尝试不计数**（否则攻击者能靠连打锁满真实用户）。
func TestLoginBackoffWindowAndReset(t *testing.T) {
	b := newLoginBackoff()
	email := "user@example.com"
	now := time.Now()

	// 没有失败记录 → 放行
	if got := b.retryAfter(email, now); got != 0 {
		t.Fatalf("无失败应放行，得到 %s", got)
	}

	// 连续 3 次失败进入退避（第 3 次起 2s 窗口）
	for i := 0; i < 3; i++ {
		b.fail(email, now)
	}
	if got := b.retryAfter(email, now.Add(time.Second)); got <= 0 || got > 2*time.Second {
		t.Fatalf("窗口内应等待剩余 0~2s，得到 %s", got)
	}
	if got := b.retryAfter(email, now.Add(3*time.Second)); got != 0 {
		t.Fatalf("窗口过后应放行，得到 %s", got)
	}

	// 退避期间的尝试不计数：窗口里反复 retryAfter 后，失败数仍是 3——
	// 窗口过后 fail 一次应到 4（等待 4s 档），而不是被刷高的档位
	for i := 0; i < 10; i++ {
		b.retryAfter(email, now.Add(time.Second))
	}
	_ = b.fail(email, now.Add(3*time.Second))
	got := b.retryAfter(email, now.Add(3*time.Second))
	if got <= 0 || got > 4*time.Second {
		t.Fatalf("第 4 次失败的窗口应 0~4s（证明此前不计数），得到 %s", got)
	}

	// 成功登录清零：再失败一次从第 1 次爬（< backoffAfter，不进窗口）
	b.succeed(email)
	if got := b.retryAfter(email, now.Add(3*time.Second)); got != 0 {
		t.Fatalf("成功后应无窗口，得到 %s", got)
	}
	_ = b.fail(email, now.Add(3*time.Second))
	if got := b.retryAfter(email, now.Add(3*time.Second)); got != 0 {
		t.Fatalf("清零后第 1 次失败不该进窗口，得到 %s", got)
	}
}
