package db

import (
	"testing"
	"time"
)

// QueryCtx / SlowCtx 的 deadline 必须落在各自的预算内（P0：裸 context.Background()
// 换成有界 ctx，这里钉住两档预算确实生效、且没有被谁改小/改没）。
func TestQueryAndSlowCtxDeadline(t *testing.T) {
	for _, c := range []struct {
		name string
		ctx  interface{ Deadline() (time.Time, bool) }
		bud  time.Duration
	}{
		{"QueryCtx", QueryCtx(), QueryTimeout},
		{"SlowCtx", SlowCtx(), SlowTimeout},
	} {
		dl, ok := c.ctx.Deadline()
		if !ok {
			t.Errorf("%s 应带 deadline", c.name)
			continue
		}
		if until := time.Until(dl); until <= 0 || until > c.bud {
			t.Errorf("%s 的 deadline 应落在 0~%s 内，得到 %s", c.name, c.bud, until)
		}
	}
}

// 超时机制本身：短预算的 ctx 到点自动 Done（不 cancel 也会自己过期，
// 这是 QueryCtx 故意不交还 cancel 的前提）。用 30ms 预算避免拖慢测试套件。
func TestTimeoutCtxExpiresWithoutCancel(t *testing.T) {
	ctx := timeoutCtx(30 * time.Millisecond)
	select {
	case <-ctx.Done():
	case <-time.After(2 * time.Second):
		t.Fatal("短预算 ctx 到点后应自动 Done")
	}
}
