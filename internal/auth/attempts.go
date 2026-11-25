package auth

import (
	"net"
	"strings"
	"sync"
	"time"
)

// attemptLimiter 是进程内的滑动窗口限流器：只记「失败尝试/请求」的时间点，
// 用于登录密码与邮箱验证码这类可被暴力枚举的入口。
//
// 单实例假设与 oauthStore 一致（当前部署就是一进程），不落库：重启后窗口清零是可接受的
// 代价，换来的是零 DB 写入——登录失败的路径本来就不该再打数据库。
type attemptLimiter struct {
	mu     sync.Mutex
	limit  int
	window time.Duration
	hits   map[string][]time.Time
	swept  time.Time
}

func newAttemptLimiter(limit int, window time.Duration) *attemptLimiter {
	return &attemptLimiter{
		limit:  limit,
		window: window,
		hits:   make(map[string][]time.Time),
	}
}

// allow 记录一次尝试并返回是否放行；key 为空（拿不到 IP 等）时直接放行，
// 不让「取不到维度」变成全局拒绝。
func (l *attemptLimiter) allow(key string, now time.Time) bool {
	if key == "" || l.limit <= 0 {
		return true
	}
	l.mu.Lock()
	defer l.mu.Unlock()

	// 每次窗口翻转清一遍过期键，防止攻击者用海量随机邮箱把 map 撑大
	if now.Sub(l.swept) > l.window {
		for k, v := range l.hits {
			if len(v) == 0 || now.Sub(v[len(v)-1]) > l.window {
				delete(l.hits, k)
			}
		}
		l.swept = now
	}

	cutoff := now.Add(-l.window)
	list := l.hits[key]
	i := 0
	for i < len(list) && !list[i].After(cutoff) {
		i++
	}
	list = list[i:]
	if len(list) >= l.limit {
		l.hits[key] = list
		return false
	}
	l.hits[key] = append(list, now)
	return true
}

// RateKey 把客户端 IP 归一成**限流桶的键**（展示/存储仍用原地址）：
//
//	IPv4            → 完整地址（一个地址 = 一个客户端）
//	IPv4-mapped     → 还原成 v4
//	IPv6            → /64 前缀（RFC 6177：住宅/企业用户按 /64 分配，一台机器能用
//	                  该前缀下的 2^64 个地址轮换）
//	非法/空          → 原样（空串由调用方的「拿不到维度就放行」语义处理）
//
// 为什么必须按前缀：按完整 /128 记桶时，一个 IPv6 客户端每次换源地址（隐私地址
// RFC 8981 本来就会轮换主机位）就得到一个全新预算，per-IP 闸等于不存在——这是
// fastify-rate-limit / better-auth 都发过通告的一类绕过（CWE-307 的放大面）。
// 桶键与 geoip 的 /64 缓存键同口径，避免「同一客户端在限流与归属地上被判成两人」。
func RateKey(ip string) string {
	v := strings.TrimSpace(ip)
	if v == "" {
		return ""
	}
	if i := strings.LastIndexByte(v, '%'); i > 0 && strings.Contains(v, ":") {
		v = v[:i] // IPv6 zone 不是地址的一部分
	}
	parsed := net.ParseIP(v)
	if parsed == nil {
		return v
	}
	if v4 := parsed.To4(); v4 != nil {
		return v4.String()
	}
	return parsed.Mask(net.CIDRMask(64, 128)).String() + "/64"
}
