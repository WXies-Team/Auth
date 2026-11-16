package db

import (
	"context"
	"time"
)

// 查询预算（P0 加固，2026-11-17）：全部 DB 查询原先裸用 context.Background()
// ——一条慢查询（行锁等待、OTP GET_LOCK 持锁等连接）就能把连接池占满，全站 503；
// 极端时 /health 的 ping 也拿不到连接，部署健康检查会误触发自动回滚。
// 查询统一由下面两个 helper 提供超时，按操作类别分两档。
const (
	// QueryTimeout 是普通单条读写与少量语句共享 ctx 的预算。取 2~5s 区间的上限：
	// 既兜得住锁等待类卡死，又不把偶发慢但健康的查询误杀成错误（超时即失败，
	// 是把「无限排队」换成「快速失败」，失败仍走原有的 503/错误回执口径）。
	QueryTimeout = 5 * time.Second
	// SlowTimeout 是事务整体、批量/迁移与全表清理的预算（30s）。BeginTx 的 ctx
	// 到点会回滚整个事务，把 5s 一刀切给事务会把多语句事务切死；同类还有
	// OTP 发码的 GET_LOCK（对端最长等 5s，之前还要等池连接）与无界的全表 DELETE。
	SlowTimeout = 30 * time.Second
)

// QueryCtx 返回带 QueryTimeout 的 context，替代裸 context.Background()。
//
// 刻意不把 cancel 交回调用方：调用点全是单行表达式
//（`s.pool.QueryContext(context.Background(), …)`），塞不进
// `ctx, cancel := …; defer cancel()` 两行写法；定时器最迟在超时时刻自行触发释放，
// 每次调用至多多挂一个 5 秒寿命的短命对象，不构成泄漏（vet lostcancel 对
// `_ = cancel` 的显式丢弃放行，`go vet ./...` 保持干净）。
func QueryCtx() context.Context { return timeoutCtx(QueryTimeout) }

// SlowCtx 同 QueryCtx，预算 SlowTimeout——适用范围见上面 SlowTimeout 的分类说明。
func SlowCtx() context.Context { return timeoutCtx(SlowTimeout) }

func timeoutCtx(d time.Duration) context.Context {
	ctx, cancel := context.WithTimeout(context.Background(), d)
	_ = cancel
	return ctx
}
