package ai

import (
	"testing"
	"time"
)

// 全局并发总闸：per-uid 档之外的全站上限，满即 QuotaGlobalConcurrency（不排队），
// 归还一个槽后恢复放行。
func TestAIGlobalConcurrencyCap(t *testing.T) {
	svc := &Service{slots: map[int64][]time.Time{}, ttl: slotTTL}
	// per-uid 给足 8（不会先撞 uid 档），全局压到 4
	cfg := intCfgOf(map[string]int{"ai_concurrency": 8, "ai_concurrency_global": 4})
	u1, u2, u3 := int64(1000001), int64(1000002), int64(1000003)

	// 三个 uid 合计占满 4 槽
	if svc.Acquire(cfg, u1) != QuotaOK || svc.Acquire(cfg, u1) != QuotaOK ||
		svc.Acquire(cfg, u2) != QuotaOK || svc.Acquire(cfg, u3) != QuotaOK {
		t.Fatal("全局 4 槽内应全部放行")
	}
	// 全局满：任何一个 uid 再来都拒——u1 自己才 2 槽（< per-uid 8），
	// 拒它的只能是全局档
	if got := svc.Acquire(cfg, u1); got != QuotaGlobalConcurrency {
		t.Fatalf("全局占满应 QuotaGlobalConcurrency，得到 %v", got)
	}
	// 归还一个槽后恢复
	svc.Release(u2)
	if got := svc.Acquire(cfg, u2); got != QuotaOK {
		t.Fatalf("归还后应放行，得到 %v", got)
	}

	// 反向：全局档不削弱 per-uid 档——全局给足、per-uid 压小时，先撞的仍是
	// per-uid 档（两档各自独立生效）
	svc2 := &Service{slots: map[int64][]time.Time{}, ttl: slotTTL}
	uidCfg := intCfgOf(map[string]int{"ai_concurrency": 3, "ai_concurrency_global": 10})
	for i := 0; i < 3; i++ {
		if got := svc2.Acquire(uidCfg, u1); got != QuotaOK {
			t.Fatalf("per-uid 第 %d 槽应放行，得到 %v", i+1, got)
		}
	}
	if got := svc2.Acquire(uidCfg, u1); got != QuotaConcurrency {
		t.Fatalf("per-uid 占满应 QuotaConcurrency，得到 %v", got)
	}
	if got := svc2.Acquire(uidCfg, u2); got != QuotaOK {
		t.Fatalf("另一 uid 不该被挤兑，得到 %v", got)
	}
}
