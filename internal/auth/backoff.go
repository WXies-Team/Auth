package auth

import (
	"log/slog"
	"sync"
	"time"
)

// 登录失败渐进退避（P1，2026-11-17；口径参照 OWASP Authentication Cheat Sheet
// 的 Account Lockout 一节与 Entra smart lockout）：
//
//   - **不做硬锁**：锁死账号会被攻击者用来批量 DoS 真实用户（OWASP 明确列为
//     反模式），所以退避有上限——被投毒的邮箱最坏等 60 秒，之后照常尝试。
//   - 与 attemptLimiter（attempts.go，滑动窗口）分工：窗口挡稳定速率的试探
//     （5 次/分/邮箱），退避把**连续失败**后的猜测间隔拉成指数——稳态从
//     7200 次/日/邮箱压到约 1440 次/日，且每次猜测都要等。
//   - 退避中的尝试**不计数**：否则攻击者靠连打就能把真实用户的失败数一直推高、
//     锁满一个又一个 60 秒，正是要避免的 DoS 面。
//   - 成功登录即清零；条目闲置 10 分钟后在下次扫描时清掉，map 不随撞库邮箱攒大。
//   - 失败突增告警：连续失败到 5、10 与之后每 20 次记一条 Warn——登录失败率
//     监控的最小可行形态，运维侧的告警规则可以直接接这条日志。
const (
	backoffAfter = 3               // 前 3 次连续失败不退避（试探期交给滑动窗口）
	backoffBase  = 2 * time.Second // 第 backoffAfter 次失败后的等待
	backoffMax   = 60 * time.Second
	backoffStale = 10 * time.Minute // 闲置超过它的条目视为陈旧
)

// backoffDelay 是第 n 次连续失败后的退避时长：2s 起逐次翻倍、60s 封顶。
func backoffDelay(n int) time.Duration {
	if n < backoffAfter {
		return 0
	}
	d := backoffBase
	for i := backoffAfter; i < n && d < backoffMax; i++ {
		d *= 2
	}
	if d > backoffMax {
		return backoffMax
	}
	return d
}

type loginFailState struct {
	n    int
	last time.Time
}

// loginBackoff 按**归一化邮箱**记连续失败并给出退避窗口。单实例假设与
// attemptLimiter / 路由层限流一致（重启清零，同款已接受的代价）。
type loginBackoff struct {
	mu    sync.Mutex
	fails map[string]*loginFailState
}

func newLoginBackoff() *loginBackoff {
	return &loginBackoff{fails: map[string]*loginFailState{}}
}

// retryAfter 回还需要等待的剩余时长；0 表示放行。**只读不记数**——退避中的
// 尝试不延长退避（见文件头的 DoS 反制说明）。
func (b *loginBackoff) retryAfter(email string, now time.Time) time.Duration {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.sweepLocked(now)
	st := b.fails[email]
	if st == nil {
		return 0
	}
	wait := st.last.Add(backoffDelay(st.n)).Sub(now)
	if wait <= 0 {
		return 0
	}
	return wait
}

// fail 记一次连续失败，返回新的失败数；到告警线时记一条突增日志。
func (b *loginBackoff) fail(email string, now time.Time) int {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.sweepLocked(now)
	st := b.fails[email]
	if st == nil {
		st = &loginFailState{}
		b.fails[email] = st
	}
	st.n++
	st.last = now
	n := st.n
	// 邮箱掩码后才进日志：告警记录本身不能变成邮箱明文的分发面
	if n == 5 || n == 10 || (n > 10 && n%20 == 0) {
		slog.Warn("登录失败突增", "email", maskEmail(email), "fails", n)
	}
	return n
}

// succeed 成功登录即清零：正常使用后重新开始的失败数从头爬，不会带着历史包袱。
func (b *loginBackoff) succeed(email string) {
	b.mu.Lock()
	defer b.mu.Unlock()
	delete(b.fails, email)
}

// sweepLocked 清掉闲置过久的条目；调用方必须持锁。只在 map 攒大后才扫，
// 与 attemptLimiter / 路由层 rateLimiter 的惰性清理同款。
func (b *loginBackoff) sweepLocked(now time.Time) {
	if len(b.fails) <= 4096 {
		return
	}
	for k, st := range b.fails {
		if now.Sub(st.last) > backoffStale {
			delete(b.fails, k)
		}
	}
}
