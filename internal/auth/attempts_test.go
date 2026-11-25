package auth

import (
	"testing"
	"time"
)

func TestAttemptLimiterWindowAndKeys(t *testing.T) {
	l := newAttemptLimiter(3, time.Minute)
	start := time.Unix(1_700_000_000, 0)
	for i := 0; i < 3; i++ {
		if !l.allow("a", start.Add(time.Duration(i)*time.Second)) {
			t.Fatalf("第 %d 次应放行", i+1)
		}
	}
	if l.allow("a", start.Add(4*time.Second)) {
		t.Fatal("超过窗口上限仍放行")
	}
	if !l.allow("b", start.Add(4*time.Second)) {
		t.Fatal("不同 key 不应互相影响")
	}
	if !l.allow("a", start.Add(2*time.Minute)) {
		t.Fatal("窗口外的旧记录应过期")
	}
	if !l.allow("", start) {
		t.Fatal("空 key（拿不到维度）应直接放行")
	}
}

// RateKey：限流桶按「一个客户端」聚合，而不是按地址文本——IPv6 换主机位、
// IPv4-mapped 写法差异都不能换出新预算；展示/存储用的原地址不受影响。
func TestRateKeyAggregatesIPv6ByPrefix(t *testing.T) {
	cases := map[string]string{
		"203.0.113.7":                 "203.0.113.7",
		"::ffff:203.0.113.7":          "203.0.113.7",
		"2001:db8:abcd:12::1":         "2001:db8:abcd:12::/64",
		"2001:db8:abcd:12:ffff::9":    "2001:db8:abcd:12::/64",
		"2001:0db8:abcd:0012:0:0:0:1": "2001:db8:abcd:12::/64",
		"2001:db8:abcd:13::1":         "2001:db8:abcd:13::/64",
		"fe80::1%eth0":                "fe80::/64",
		"":                            "",
		"not-an-ip":                   "not-an-ip",
	}
	for in, want := range cases {
		if got := RateKey(in); got != want {
			t.Errorf("RateKey(%q) = %q，应为 %q", in, got, want)
		}
	}
	// 同一 /64 的两个地址必须同桶：这正是「换地址绕过 per-IP 限流」的堵口点。
	if RateKey("2001:db8:1:2::1") != RateKey("2001:db8:1:2:aaaa:bbbb:cccc:dddd") {
		t.Error("同一 /64 的地址应共用一个限流桶")
	}
}
