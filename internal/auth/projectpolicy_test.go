package auth

import "testing"

func TestDomainAllowed(t *testing.T) {
	cases := []struct {
		email, domains string
		want           bool
	}{
		{"a@example.com", "example.com", true},
		{"a@sub.example.com", "example.com", true},
		{"a@example.com", "sub.example.com", false},
		{"a@evil.com", "example.com", false},
		{"a@example.com", "", false},
		{"bad-email", "example.com", false},
		{"a@EXAMPLE.com", "Example.COM", true},
	}
	for _, c := range cases {
		if got := domainAllowed(c.email, c.domains); got != c.want {
			t.Errorf("domainAllowed(%q,%q)=%v，期望 %v", c.email, c.domains, got, c.want)
		}
	}
}

func TestNormalizeDomains(t *testing.T) {
	got, err := normalizeDomains([]string{" Example.COM ", "@foo.cn", "example.com", ""})
	if err != nil {
		t.Fatalf("normalize: %v", err)
	}
	if got != "example.com,foo.cn" {
		t.Errorf("归一化结果不对: %q", got)
	}
	if _, err := normalizeDomains([]string{"not a domain"}); err == nil {
		t.Error("非法域名应报错")
	}
}
