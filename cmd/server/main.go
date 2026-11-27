// Command server 是统一账号服务（auth.horatio.cn）。
//
// 与两个日记服务的 /auth/* 端点一一对应、JSON 字段完全一致（见 internal/protocol），
// 客户端从日记自带后端切到本端点时只需改 base URL 并在登录请求加 app 字段。
// 部署形态与日记服务相同：Go 单二进制 + supervisord，对外只经 nginx TLS 反代
// （默认绑 127.0.0.1:8868）。
package main

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/WXies-Team/Auth/internal/auth"
	"github.com/WXies-Team/Auth/internal/config"
	"github.com/WXies-Team/Auth/internal/db"
	// 别名 mailsvc：包名 mail 与标准库 net/mail 同名，直引易混
	mailsvc "github.com/WXies-Team/Auth/internal/mail"
	"github.com/WXies-Team/Auth/internal/protocol"
)

// 请求体上限：认证请求都是小 JSON，64KB 足够挡住异常大包
const maxBodyBytes = 64 << 10

// maxProfileBodyBytes 是 PUT /api/profile 单独放大的请求体上限（1.5MB）：档案带
// 头像 base64，700KB 解码上限对应 955,736 个字符（见 internal/auth 的
// maxAvatarImageBytes 及其实测依据），通用 64KB 装不下。其余端点一律 maxBodyBytes。
const maxProfileBodyBytes = 1536 * 1024

type ctxKey int

// callerKey 放业务身份（老端点只认它）；webCallerKey 放双凭据解析的完整现场
// （CSRF hash、role、凭 cookie 还是 Bearer 进来）——两把钥匙同一次解析填。
const (
	callerKey ctxKey = iota
	webCallerKey
)

func main() {
	// 日志按级别分流（12-factor 口径）：Info→stdout，Warn/Error→stderr，
	// 让 supervisord 的两个日志文件各归各位。
	slog.SetDefault(slog.New(&splitHandler{
		out: slog.NewTextHandler(os.Stdout, nil),
		err: slog.NewTextHandler(os.Stderr, nil),
	}))

	if err := requireJWTSecret(os.Getenv("JWT_SECRET")); err != nil {
		slog.Error("JWT_SECRET 不可用", "err", err)
		os.Exit(1)
	}
	secret := os.Getenv("JWT_SECRET")

	// 连接串只认 MYSQL_DSN。启动失败 → supervisord 拉不起来 → deploy 脚本的
	// 健康检查失败 → 自动回滚。
	dsn, err := db.FromEnv()
	if err != nil {
		slog.Error("数据库连接串不可用", "err", err)
		os.Exit(1)
	}
	// 带重试地连库（不是一次失败就退出）：MySQL 冷启实测约 9 秒，立刻退出会让
	// supervisor 的 startretries 耗尽变成 FATAL，而且 MySQL 恢复后进程已不在、
	// **不会自己回来**。等 90 秒期间进程一直存活，MySQL 一就绪就自动服务。
	pool, err := db.OpenWithRetry(dsn, 90*time.Second)
	if err != nil {
		slog.Error("等待数据库超时，退出交给 supervisord 继续重试", "err", err)
		os.Exit(1)
	}
	defer func() { _ = pool.Close() }()
	if err := db.EnsureSchema(pool); err != nil {
		slog.Error("建表失败", "err", err)
		os.Exit(1)
	}

	cfg := config.New(pool)
	// 邮件凭据从 app_config 现读（10s 缓存，改库即热生效）。没配好时发码回 503
	//「邮件服务暂不可用」，属于可自愈的配置态而不是崩溃；启动时 Warn 一次，
	// 免得等用户注册失败才发现。配齐口径 = **SMTP 四键齐**（与 Send、/health
	// 同源判定），缺哪键 Warn 点名哪键。
	if ok, missing, err := mailsvc.ConfigState(cfg.Require); err != nil {
		// 读库失败 ≠ 没配：分开喊，否则 DB 抖动会被「未配置」这条 Warn 带偏
		slog.Error("读邮件凭据失败（继续启动）", "err", err)
	} else if !ok {
		for _, key := range missing {
			slog.Warn("邮件凭据未配置，注册与验证码邮件会失败", "key", key)
		}
	}
	// Passkey 的 RP 实例：网页 origin 固定；Android 原生仪式的 apk-key-hash 指纹
	// 从 app_config 键现读（webauthn_opaque_origins，逗号分隔，App 批次供指纹后灌库，
	// 改库 ≤10 秒热生效）。键没配 = 只放行网页端，两个 App 的原生仪式暂不可用。
	// 指纹写错也不拖垮启动：记 Error 后降级为「仅网页端」——登录服务的可用性优先，
	// 错误状态在启动日志里可见。
	wa, err := auth.NewWebAuthn(splitList(cfgRequire(cfg, "webauthn_opaque_origins")))
	if err != nil {
		slog.Error("Passkey 不透明 origin 配置无效，降级为仅网页端可用", "err", err)
		if plain, err2 := auth.NewWebAuthn(nil); err2 == nil {
			wa = plain
		}
	}

	authSvc, err := auth.NewService(pool, secret, mailsvc.New(cfg.StringFunc), auth.NewHooks(cfg.Require), wa)
	if err != nil {
		slog.Error("初始化认证服务", "err", err)
		os.Exit(1)
	}
	// 配置中心热读：老客户端 2FA 兼容开关 + 风险登录/泄露库/自助注册等缺省开值。
	// 两者都传 cfg.Require（10 秒缓存）；此前 SetEnforceApps 从未接线，
	// totp_enforce_apps 实际是死键，这里一并修好。
	authSvc.SetEnforceApps(cfg.Require)
	authSvc.SetConfig(cfg.Require)

	mux := http.NewServeMux()
	// 路由注册整体挪进 registerRoutes：端点形状只有打到 handler 上才作数，
	// 抽出来才能被路由级回归测试钉住（老客户端契约见 routes_test.go）。
	registerRoutes(mux, authSvc, cfg, pool)

	// 安全响应头挂在最外层：静态页、JSON、错误页都覆盖（OWASP HTTP Headers CS：
	// 这些头要在所有响应上，而不只是首页）。CSP 只声明 frame-ancestors /
	// object-src / base-uri，不限制 script-src——现有页面有内联脚本（注销撤销页），
	// 收紧 script-src 需要先做 nonce 改造，属于 UI 批次，不能在这里静默打破页面。
	handler := withSecurityHeaders(withRecover(mux))

	// 默认只绑回环：对外一律经 nginx TLS 反代，直连 8868 会把 JWT 走明文。
	addr := envOr("BIND_ADDR", "127.0.0.1:8868")
	// 超时三件套：没有它们，慢速 body（slowloris）或挂住不读的连接能长期占着 fd
	// 把服务拖垮。认证请求都是小包，60s 读写绰绰有余。
	srv := &http.Server{
		Addr:              addr,
		Handler:           handler,
		ReadHeaderTimeout: 10 * time.Second,
		ReadTimeout:       60 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       120 * time.Second,
		// 头部上限收到 16KB（默认 1MB）：防超大 header 内存占用
		MaxHeaderBytes: 16 << 10,
	}

	// 优雅关闭：supervisor stop/restart 发 SIGTERM，等在途请求处理完再退
	//（健康检查轮询有 30s 窗口，15s 收尾足够且不至于拖慢部署）。
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	// W3 到期注销清扫：启动立即跑一遍、之后每小时一轮（进程内 goroutine，
	// 单实例假设与进程内限流一致），随优雅关闭信号一起退出
	go authSvc.RunPendingDeleteSweeper(ctx)
	go func() {
		<-ctx.Done()
		slog.Info("收到退出信号，等待在途请求完成")
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
		defer cancel()
		if err := srv.Shutdown(shutdownCtx); err != nil {
			slog.Error("优雅关闭超时，强制退出", "err", err)
		}
	}()

	slog.Info("server starting", "addr", addr)
	if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
		slog.Error("server stopped", "err", err)
		os.Exit(1)
	}
	slog.Info("server exited")
}

// requireJWTSecret 校验签名密钥：缺失或短于 32 字节直接拒启——短 secret = 弱签名，
// 统一账号服务的 token 被破解波及所有下游应用，这里没有妥协余地。
func requireJWTSecret(secret string) error {
	if secret == "" {
		return errors.New("缺少 JWT_SECRET（环境变量），检查 supervisord 的 environment")
	}
	if len(secret) < 32 {
		return fmt.Errorf("JWT_SECRET 过短，至少 32 字节（当前 %d）", len(secret))
	}
	return nil
}

// envOr 读环境变量，空则给默认值。
func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

// cfgRequire 读配置键；读失败只记日志后按未配置处理——可选功能的配置读不出
// 不该挡住启动（mail 凭据那三键是另一档：发信是主流程，读失败会单独喊）。
func cfgRequire(cfg *config.Store, key string) string {
	v, err := cfg.Require(key)
	if err != nil {
		slog.Error("读配置键失败（按未配置处理）", "key", key, "err", err)
	}
	return v
}

// splitList 把逗号分隔的配置值拆成去空白的非空列表。
func splitList(raw string) []string {
	out := make([]string, 0, 4)
	for _, part := range strings.Split(raw, ",") {
		if p := strings.TrimSpace(part); p != "" {
			out = append(out, p)
		}
	}
	return out
}

// health 复刻日记服务的 /health 语义：**ping 数据库**（DB 挂了返回 5xx，
// deploy-server.sh 靠 `curl -fsS` 判定失败并自动回滚），再给两个配置开关位。
// 开关位**刻意外显**（定案不改）：本服务的健康即运维监控面，布尔只报
// 「凭据配没配」，不含任何敏感值。
func health(pool *sql.DB, require func(string) (string, error)) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Ping 带 2s 超时：连接池被占满时 /health 不能无限排队——
		// 部署健康检查拿不到响应会误判回滚
		pingCtx, cancel := context.WithTimeout(r.Context(), 2*time.Second)
		defer cancel()
		if err := pool.PingContext(pingCtx); err != nil {
			writeError(w, http.StatusServiceUnavailable, "数据库不可用，请稍后重试")
			return
		}
		// 邮件凭据没有兜底值：缺键时发码全 503，/health 给个开关位让部署方自查，
		// 不用翻日志。配齐口径 = SMTP 四键齐（与 Send 同源，见 mail.ConfigState）；
		// 读配置失败与「数据库挂了」是两回事，文案分开（n9）——
		// 写成「数据库不可用」会把排障方向带偏到 DB 上。
		mailOK, _, err := mailsvc.ConfigState(require)
		if err != nil {
			slog.Error("读邮件凭据配置失败", "err", err)
			writeError(w, http.StatusServiceUnavailable, "配置读取失败，请检查邮件凭据配置")
			return
		}
		writeJSON(w, http.StatusOK, healthResponse{
			Status:         "ok",
			MailConfigured: mailOK,
			// 能启动到这里就说明 JWT_SECRET 已通过 ≥32 字节校验（拒启在 main 最前面），
			// 恒为 true——给部署方一眼确认「这个进程带着可用密钥在跑」
			JWTConfigured: true,
		})
	})
}

type healthResponse struct {
	Status         string `json:"status"`
	MailConfigured bool   `json:"mailConfigured"`
	JWTConfigured  bool   `json:"jwtConfigured"`
}

// verifier 是 internalVerify 依赖的最小接口：路由层测试注入假实现，不必拉起真库。
type verifier interface {
	Verify(bearer, expectApp string) (*auth.VerifyResult, error)
}

// verifyRatePerApp 是 /internal/verify 每个 app 每分钟的上限，额度与原设计一致
// （600 = 给多租户共享留的余量，挡的是误配置成公网可达后的打爆）。
const verifyRatePerApp = 600

// verifyUidWarnPerMin 是单 uid 每分钟 verify 次数的**告警线**——只记 Warn、
// 不拒绝：600/分按 app 分键是共享桶，单个风暴客户端经日记服务放大就能吃掉整桶、
// 挤兑该 app 全部用户（P1-3）；但把拒绝下沉到 per-uid 会给正常大流量用户
// （首同步突发）新增一刀切的天花板。取 300/分：正常客户端单账号的各端点 per-uid
// 额度之和到不了它，越线即在日志里点名 uid，运维据此决定是否提额或处置。
const verifyUidWarnPerMin = 300

// internalVerify 是日记服务 withUID 中间件要调的端点：POST /internal/verify，
// Bearer 用户 token + body {"app":"<期望 aud>"}。通过回 uid/email/app，
// 否则 401（错误体走 writeResult，含 503 的 DB 抖动分支）。
func internalVerify(v verifier) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req protocol.VerifyRequest
		if !decodeOr400(w, r, &req) {
			return
		}
		// app 缺失/未知在这里挡掉，不进 Verify——期望值都对不上就别浪费一次查库
		if req.App == "" {
			writeError(w, http.StatusBadRequest, "参数不正确，请在请求体里带上 app 字段")
			return
		}
		// 限流**按 app 分键**（键里不含来源）：两个日记服务都经同机回环调用，
		// clientIP 恒为 127.0.0.1——按 IP 分键等于全站共享一个 600/分桶，两家
		// 业务互相挤兑成 10rps 天花板。键里不放来源还有个副作用是正向的：
		// 误配公网可达时攻击者换 IP 也换不出新桶，整体打爆面仍然有界。
		// 未知 app 值乱敲会攒出无主桶，由 allow 的 >4096 惰性清理兜底。
		if !limiter.allow("verify:"+req.App, verifyRatePerApp, time.Minute) {
			limit429(w, r, "verify", "verify:"+req.App)
			return
		}
		res, err := v.Verify(r.Header.Get("Authorization"), req.App)
		if err != nil {
			writeResult(w, nil, err)
			return
		}
		// 单 uid 用量监控（只告警不拒绝，见 verifyUidWarnPerMin）：跨过告警线的
		// 那一次记一条 Warn，同窗口不重复刷屏（计数过线后 n恒大于线，只在线+1
		// 这一次命中）。
		if n := limiter.observe("verifyuid:"+req.App+":"+strconv.FormatInt(res.UID, 10), time.Minute); n == verifyUidWarnPerMin+1 {
			slog.Warn("verify 单用户调用异常频繁", "app", req.App, "uid", res.UID, "per_min", n)
		}
		writeJSON(w, http.StatusOK, protocol.VerifyResponse{UID: res.UID, Email: res.Email, App: res.App})
	})
}

// userEnsurer 是 internalEnsure 依赖的最小接口：路由层测试注入假实现，不必拉起真库。
// Audit 也收进接口：并入成功后要补一条审计（actor 是 hook_token 持有方，匿名事件）。
type userEnsurer interface {
	EnsureUsers(entries []protocol.EnsureUserEntry) ([]protocol.EnsureUserResult, error)
	Audit(e auth.AuditEvent)
}

// internalEnsure 是存量用户并入端点：POST /internal/users/ensure，
// 头 `Authorization: Bearer <hook_token>`，体是 0~100 条 EnsureUserEntry 数组，
// 回与入参同序的 [{email,uid}]。用途见 Service.EnsureUsers 的注释。
//
// hook_token 从 app_config 现读（10s 缓存，改库即热生效）。**键没配时恒 401**——
// 迁移凭据没进库就该一条也进不来；而读库失败回 503 而不是 401：把 DB 抖动当成
// 鉴权失败，会把排障方向带偏到「token 插错了」。
func internalEnsure(tokenFor auth.ConfigFunc, svc userEnsurer) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		want, err := tokenFor(auth.HookTokenKey)
		if err != nil {
			slog.Error("读 hook_token 失败", "err", err)
			writeError(w, http.StatusServiceUnavailable, "服务暂时不可用，请稍后重试")
			return
		}
		if want == "" {
			slog.Warn("hook_token 未配置，内部并入端点拒绝一切请求")
		}
		// 对不上连请求体都不读：不给为错配凭据白解一次 JSON 的机会。
		// 比较走常数时间（各自 sha256 后再比，长度差也被散列拉平）：直比字符串
		// 会按匹配前缀泄露进度，等于把这根共享密钥摆上线上逐位爆破的台面。
		wantSum := sha256.Sum256([]byte("Bearer " + want))
		gotSum := sha256.Sum256([]byte(r.Header.Get("Authorization")))
		if want == "" || subtle.ConstantTimeCompare(gotSum[:], wantSum[:]) != 1 {
			writeError(w, http.StatusUnauthorized, "内部凭据无效，请检查调用方的令牌配置")
			return
		}
		var entries []protocol.EnsureUserEntry
		if !decodeOr400(w, r, &entries) {
			return
		}
		// 结果按入参顺序回，uid 是 int64（writeJSON 不会把它转成浮点）
		results, err := svc.EnsureUsers(entries)
		// 并入是账号生命周期的大动作（存量迁移的唯一入口）：成功必记（m9）。
		// actor 是 hook_token 持有方——迁移脚本没有用户身份，落匿名事件，
		// detail 只记批量数（邮箱在 users 表里，审计表不留明文）。
		if err == nil {
			svc.Audit(auth.AuditEvent{
				Action: auth.AuditInternalEnsure, OK: true,
				Detail: map[string]string{"count": strconv.Itoa(len(entries))},
			})
		}
		writeResult(w, results, err)
	})
}

// internalTokenGate 是 /internal/ai/* 三端点与 /internal/config 的内部凭据闸（M3）：
// 头 `X-Internal-Token: <hook_token>`。token 来源与 internalEnsure 同一个 app_config 键
// （10s 热读，改库即生效），比对也同款——各自 sha256 后 subtle 常数时间比，
// 长度差被散列拉平，直比字符串会按匹配前缀泄露进度。
// **缺失 / 对不上 / 键没配（want 空）一律 401**：内部凭据没进库就该一条也进不来；
// 读库失败回 503 而不是 401，别把 DB 抖动的排障方向带偏到「token 插错了」。
// 闸排在 handler 之前：对不上连请求体都不读。
func internalTokenGate(tokenFor auth.ConfigFunc, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		want, err := tokenFor(auth.HookTokenKey)
		if err != nil {
			slog.Error("读 hook_token 失败", "err", err)
			writeError(w, http.StatusServiceUnavailable, "服务暂时不可用，请稍后重试")
			return
		}
		if want == "" {
			slog.Warn("hook_token 未配置，内部端点（AI 限额 / 配置分发）拒绝一切请求")
		}
		wantSum := sha256.Sum256([]byte(want))
		gotSum := sha256.Sum256([]byte(r.Header.Get("X-Internal-Token")))
		if want == "" || subtle.ConstantTimeCompare(gotSum[:], wantSum[:]) != 1 {
			writeError(w, http.StatusUnauthorized, "内部凭据无效，请检查调用方的令牌配置")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// ---- 以下为通用中间件与 JSON 工具 ----

// decodeLimited 解码请求体。**故意不拒绝未知字段**——日记客户端的 DTO 可能多发字段，
// 客户端多发不该报错（否则加字段会让老客户端直接失败）。
// 超限走 http.MaxBytesReader：截断回结构化 413 而不是静默截断后的 400。
// limit 由调用方给：常规端点 maxBodyBytes（64KB），PUT /api/profile 单独放大到
// maxProfileBodyBytes——头像 base64 装不下小包口径，但只放大这一条路由。
func decodeLimited(w http.ResponseWriter, r *http.Request, v any, limit int64) error {
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	err := json.NewDecoder(r.Body).Decode(v)
	var maxErr *http.MaxBytesError
	if errors.As(err, &maxErr) {
		return errBodyTooLarge
	}
	return err
}

var errBodyTooLarge = errors.New("body too large")

// decodeOr400：decode 失败统一回执——超限 413、其余 400。全部 decode 入口共用，
// 避免每处手抄错误映射再漏掉 413。
func decodeOr400(w http.ResponseWriter, r *http.Request, v any) bool {
	return decodeOr400Limit(w, r, v, maxBodyBytes)
}

// decodeOr400Limit 同 decodeOr400 但可指定请求体上限（档案端点用）。
func decodeOr400Limit(w http.ResponseWriter, r *http.Request, v any, limit int64) bool {
	if err := decodeLimited(w, r, v, limit); err != nil {
		if errors.Is(err, errBodyTooLarge) {
			writeError(w, http.StatusRequestEntityTooLarge, "请求体过大，请精简内容后重试")
		} else {
			writeError(w, http.StatusBadRequest, "请求格式不正确，请检查后重试")
		}
		return false
	}
	return true
}

// writeJSON 是全部 JSON 回执的唯一出口：Content-Type + **Cache-Control: no-store**
// （规格 B1 原文要求「全部会话响应 no-store」，落到实现层即所有 JSON 响应——
// 登录/改密/会话回执落在共享缓存或浏览器 bfcache 里，等于把凭据外泄给下一个
// 用同一台机器的人）。限流 429 与 recover 500 也走这里，同样带 no-store。
func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.Header().Set("Cache-Control", "no-store")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(v)
}

func writeError(w http.ResponseWriter, code int, message string) {
	writeJSON(w, code, protocol.ApiError{Message: message})
}

// writeErrorReason 是「message + 机器可读 reason」的统一出口。reason 的值域按
// 状态码分段：403 = policy / permission（下一步是联系管理员还是申请权限），
// 400 = origin / challenge / verification，404 = ceremony_expired（Passkey 仪式
// 失败的分级）。401/429 这类「下一步唯一」的拒绝不带 reason——多一个字段只会让
// 前端多一条无意义分支。
// 5xx 一律丢掉 reason：服务故障给不出可执行的下一步，分级反而是误导。
func writeErrorReason(w http.ResponseWriter, code int, message, reason string) {
	if code < 400 || code >= 500 {
		reason = ""
	}
	writeJSON(w, code, protocol.ApiError{Message: message, Reason: reason})
}

// writeDenied 是路由层 403 的快捷方式（reason 由调用方给 policy/permission）。
func writeDenied(w http.ResponseWriter, message, reason string) {
	writeErrorReason(w, http.StatusForbidden, message, reason)
}

// writeResult 把业务结果翻译成「状态码 + ApiError 体」。
func writeResult(w http.ResponseWriter, v any, err error) {
	if err == nil {
		writeJSON(w, http.StatusOK, v)
		return
	}
	var he *auth.HTTPError
	if errors.As(err, &he) {
		writeErrorReason(w, he.Code, he.Message, he.Reason)
		return
	}
	// 内部错误（含 SQL 与路径）全进日志，客户端只拿固定文案——排障信息不丢，
	// 但不再外泄
	slog.Error("handler failed", "err", err, "cause", err.Error())
	writeError(w, http.StatusInternalServerError, "服务出了点问题，请稍后重试")
}

// contentSecurityPolicy 是统一 CSP（nonce 为空 = 一律不放行内联脚本）。
//
// 页面结构已经适配严格 CSP：所有可执行脚本都在外部 /app.js（`<script src>`），
// 模板里的 `<script type="application/json">` 是数据块、不执行；没有内联事件属性
// （onclick= 之类）也没有 javascript: 链接。仍保留两处放宽，各有明确理由：
//   - style-src 'unsafe-inline'：模板有 style="…" 属性与 <style> 块，样式注入不
//     构成脚本执行面；
//   - img-src data:：档案头像是 data:image/jpeg;base64 内联。
//
// 唯一的内联**可执行**脚本是「注销撤销页」（cmd/server/web.go 自渲染、脚本里带
// 一次性 token），它走 contentSecurityPolicy(nonce) 并把同一个 nonce 写在 <script>
// 上——token 是每请求变化的，哈希白名单不适用。
func contentSecurityPolicy(nonce string) string {
	return contentSecurityPolicyWithFormAction(nonce)
}

// contentSecurityPolicyWithFormAction 在基线 CSP 上放行额外的表单回跳源。
// `form-action` 同样约束「表单 POST 之后的 302 跳转」：授权确认页把结果 302
// 回应用（tio.fyi / passport-mikey.horatio.cn）时，如果只写 'self'，Chrome 会
// 拦下外站回跳，页面停在按钮 loading 上——表现为「点继续授权一直转圈」。
// 只按当前 tx 的 redirect_uri 精确放行，不放宽成全站 https:。
func contentSecurityPolicyWithFormAction(nonce string, extra ...string) string {
	script := "script-src 'self'"
	if nonce != "" {
		script += " 'nonce-" + nonce + "'"
	}
	formAction := "form-action 'self'"
	for _, origin := range extra {
		if origin != "" {
			formAction += " " + origin
		}
	}
	return "default-src 'self'; " + script + "; style-src 'self' 'unsafe-inline'; " +
		"img-src 'self' data:; font-src 'self' https://static.horatio.cn; connect-src 'self'; " + formAction + "; " +
		"frame-ancestors 'none'; object-src 'none'; base-uri 'self'"
}

// withSecurityHeaders 给所有响应加基线安全头（OWASP HTTP Headers Cheat Sheet）：
//
//	X-Content-Type-Options  nosniff（禁止 MIME 嗅探；withLogging 里也有一份，
//	                        这里覆盖 429/404 等不走 withLogging 的分支）
//	X-Frame-Options         DENY（旧浏览器兜底）
//	Content-Security-Policy frame-ancestors 'none'（现代浏览器的点击劫持主防线）、
//	                        default-src/script-src 'self'（XSS 纵深：注入的脚本没有
//	                        nonce 就不执行）、object-src 'none'、base-uri 'self'、
//	                        form-action 'self'（外站提交不了本站表单）
//	Referrer-Policy         strict-origin-when-cross-origin（query 里的 token 不随
//	                        外链 Referer 泄露）
//	Permissions-Policy      camera/microphone/geolocation 全关（本服务不需要）
//	Strict-Transport-Security 仅在确认走 HTTPS 时发（TLS 直连或受信反代声明）；
//	                        HSTS 在 HTTP 上无效，误发只会让本地调试困惑。
//
// 不放 script-src 'unsafe-inline'：那一条等于让 CSP 对 XSS 完全失效。页面自带的
// 内联脚本只有注销撤销页，它按请求发 nonce（见 contentSecurityPolicy）。
func withSecurityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		h := w.Header()
		h.Set("X-Content-Type-Options", "nosniff")
		h.Set("X-Frame-Options", "DENY")
		h.Set("Content-Security-Policy", contentSecurityPolicy(""))
		h.Set("Referrer-Policy", "strict-origin-when-cross-origin")
		h.Set("Permissions-Policy", "camera=(), microphone=(), geolocation=()")
		if r.TLS != nil || strings.EqualFold(strings.TrimSpace(r.Header.Get("X-Forwarded-Proto")), "https") {
			h.Set("Strict-Transport-Security", "max-age=31536000; includeSubDomains")
		}
		next.ServeHTTP(w, r)
	})
}

func withRecover(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				slog.Error("panic", "err", rec, "path", r.URL.Path)
				// panic 穿过路由层的 withLogging（其 slog.Info 不再执行）：
				// 这里补一条同构 request 日志，panic 轮次也能按 500 检索
				slog.Info("request", "method", r.Method, "path", r.URL.Path,
					"status", http.StatusInternalServerError, "panicked", true)
				writeError(w, http.StatusInternalServerError, "服务出了点问题，请稍后重试")
			}
		}()
		next.ServeHTTP(w, r)
	})
}

// statusRecorder 记录状态码给 withLogging（只记 method/path 没法事后发现
// 429/503 异常与限流误伤）。
type statusRecorder struct {
	http.ResponseWriter
	status int
}

func (s *statusRecorder) WriteHeader(code int) {
	s.status = code
	s.ResponseWriter.WriteHeader(code)
}

func withLogging(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		// nosniff 防 MIME 嗅探
		w.Header().Set("X-Content-Type-Options", "nosniff")
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		slog.Info("request", "method", r.Method, "path", r.URL.Path,
			"status", rec.status, "took", time.Since(start).Round(time.Millisecond))
	})
}

// withUID 解析**双凭据**并把身份放进 context；失败直接回 401/503。
//
// 三条路径（见 resolveCaller）：网页会话 cookie、JWT Bearer（老客户端的 /auth/login
// 与日记 App 经 app 分流拿到的同一种 token）、以及 web 会话 token 的 Bearer。顺带做两件事：
//
//   - 本次请求的来源（IP/UA）填进 Caller.Meta——改密换发新会话、审计都要它，
//     过了这层再想取原始请求就取不到了；
//   - **凭 cookie 进来的非 GET 请求校验 CSRF**（同步器 token，见 auth.WebCaller.CheckCSRF）。
//     Bearer 请求不做这一步：跨站脚本设置不了 Authorization 头，没有可搭的顺风车，
//     给它加校验只会把老客户端挡在门外。
func withUID(svc *auth.Service, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		wc, err := resolveCaller(svc, r)
		if err != nil {
			writeResult(w, nil, err)
			return
		}
		wc.Meta = sessMeta(r)
		// 模拟会话只读：除「退出模拟」与登出外，一律不接受写操作。集中在这里判定，
		// 比逐个端点记着加闸可靠——漏一个端点就是一个提权口子。
		if wc.ImpersonatorUID > 0 && !readMethod(r.Method) &&
			r.URL.Path != "/api/impersonation/stop" && r.URL.Path != "/web/logout" {
			writeDenied(w, "模拟登录为只读模式，不能修改目标账号或进入管理后台", auth.ReasonPermission)
			return
		}
		// 模拟会话没有自己的 CSRF cookie（不能覆盖管理员的那枚），两条允许的写路径
		//（退出模拟 / 登出）改由 SameSite=Lax + 路由内 originGuard 兜底。
		if wc.ViaCookie && wc.ImpersonatorUID == 0 && !readMethod(r.Method) && !wc.CheckCSRF(r.Header.Get("X-CSRF-Token")) {
			// 不带 reason：CSRF 失配是「页面/请求过期」，既不是 policy（策略拦截）
			// 也不是 permission（授权不足），前端按 message 提示刷新即可。
			writeError(w, http.StatusForbidden, "请求校验失败，请刷新页面后重试")
			return
		}
		ctx := context.WithValue(r.Context(), callerKey, wc.Caller)
		ctx = context.WithValue(ctx, webCallerKey, wc)
		next.ServeHTTP(w, r.WithContext(ctx))
	})
}

// readMethod 判定「不改状态的动词」——GET/HEAD/OPTIONS 不需要 CSRF token。
func readMethod(method string) bool {
	return method == http.MethodGet || method == http.MethodHead || method == http.MethodOptions
}

// resolveCaller 按优先级解析凭据：
//
//  1. 会话 cookie（网页）→ sha256 点查 sessions.web_token_hash；
//  2. Bearer 是 JWT 形状（三个点）→ 走原有 ValidUserID，**语义与老客户端时代一字不变**
//     （日记 App 经 /web/login/* 与 /webauthn/login/finish 的 app 分流拿到的也是它）；
//  3. Bearer 不是 JWT 形状（web 台登录签的 32 字节会话 token）→ 同 1 的点查。
//
// 只有「非 JWT 形状」才落到 3：JWT 的验签失败在解析阶段就出错、不打库，
// 少一次无谓的点查；真 503（DB 抖动）原样往上抛，不能被当成「换个凭据再试」。
//
// **cookie 校验失败且带了 Bearer 头时继续尝试 Bearer**：浏览器会把过期/被踢的
// 残留 cookie 一并发上来，旧实现被它绑架成 401——同一浏览器里的 API 调用方
// （App WebView、脚本）明明带着有效 Bearer 也进不来。cookie 失败分两档：
// 503（DB 抖动）仍原样上抛（不能把抖动当成「换凭据再试」）；401 才回落 Bearer，
// 两者皆败才 401。
func resolveCaller(svc *auth.Service, r *http.Request) (auth.WebCaller, error) {
	header := r.Header.Get("Authorization")
	// 模拟会话优先：独立 cookie 不覆盖管理员自己的 web 会话，关掉模拟即回原身份。
	if ck, err := r.Cookie(auth.ImpersonationCookieName); err == nil && ck.Value != "" {
		if wc, werr := svc.ValidWebSession(ck.Value); werr == nil && wc.ImpersonatorUID > 0 {
			return wc, nil
		}
	}
	if ck, err := r.Cookie(auth.WebCookieName); err == nil && ck.Value != "" {
		wc, werr := svc.ValidWebSession(ck.Value)
		if werr == nil {
			return wc, nil
		}
		if header == "" {
			return auth.WebCaller{}, werr
		}
		var he *auth.HTTPError
		if errors.As(werr, &he) && he.Code == http.StatusServiceUnavailable {
			return auth.WebCaller{}, werr
		}
		// 401 的残留 cookie：落到下面的 Bearer 尝试
	}
	if header == "" {
		return auth.WebCaller{}, &auth.HTTPError{Code: 401, Message: "请先登录"}
	}
	caller, err := svc.ValidUserID(header)
	if err == nil {
		return auth.WebCaller{Caller: caller}, nil
	}
	if strings.Contains(strings.TrimPrefix(header, "Bearer "), ".") {
		return auth.WebCaller{}, err
	}
	return svc.ValidWebBearer(header)
}

// sessMeta 取登录会话要记的来源：IP 用限流同一套 clientIP（受信代理口径——
// 生产里裸 RemoteAddr 恒是同机 nginx，记它等于所有设备一个 IP），
// UA 取原文，设备标签由 auth 包解析（解析不出就存原文）。
func sessMeta(r *http.Request) auth.SessionMeta {
	return auth.SessionMeta{IP: clientIP(r), UserAgent: r.UserAgent()}
}

// webSessMeta 在 sessMeta 之上再取 UA Client Hints 两头：Sec-CH-UA-Platform
// （低熵，默认随请求带）与 Sec-CH-UA-Model（高熵，要 /web 页面响应先带过
// Accept-CH——见 cmd/server/ui.go 的 serveSPA——浏览器才自动带上；Firefox/Safari 不支持，
// 取不到就是空串，存储串不加后缀，设备名回退 UA 解析，零回归）。
//
// **只在 web 登录路用**（/web/login/*、/webauthn/login/finish、/web/invite、
// OAuth 确认）：App 端点（/auth/*）与审计照走 sessMeta，App UA 一个字节不受影响。
func webSessMeta(r *http.Request) auth.SessionMeta {
	m := sessMeta(r)
	m.CHPlatform = r.Header.Get("Sec-CH-UA-Platform")
	m.CHModel = r.Header.Get("Sec-CH-UA-Model")
	return m
}

// loopbackOnly 只放行环回与受信内网来源的请求，其余 403。
//
// 内部端点（/internal/*）不该经 nginx 暴露：它们凭一根共享 bearer 就能用、
// 不挂面向公网的限流——一旦被反代到公网，等于在防火墙外开了扇没锁的侧门，
// 所以先按来源掐掉，再谈鉴权与限流。
//
// 判定只看 RemoteAddr：环回上的调用方就是同机的日记服务与迁移脚本，受信代理头
// （X-Forwarded-For / X-Real-IP）一律不看——公网客户端能随便伪造它们，看了等于没设。
// 信任范围与限流共用 TRUSTED_PROXIES（默认环回 + RFC1918/ULA 内网段）。
func loopbackOnly(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !containsIP(trustedProxies(), hostOnly(r.RemoteAddr)) {
			slog.Warn("内部端点拒绝非受信来源", "path", r.URL.Path, "remote", r.RemoteAddr)
			writeError(w, http.StatusForbidden, "仅限服务端调用，请从内网调用方发起")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// ---- 进程内滑动窗口限流（单实例部署假设：supervisord 只跑一个进程，多实例时
// 每个实例各自一套窗口，限流额度翻倍——上多实例前要把这里换成共享存储）----

type window struct {
	hits []time.Time
}

type rateLimiter struct {
	mu      sync.Mutex
	windows map[string]*window
}

var limiter = &rateLimiter{windows: map[string]*window{}}

// allow 每 [scope:key] 每 windowMs 内最多 max 次。
func (l *rateLimiter) allow(key string, max int, windowMs time.Duration) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	// 攒太多时全量扫一遍，把**过期且再没人来过**的键清掉：惰性清理只在该键
	// 再次被访问时发生，长期不访问的键（如已注销账号）会永远留在 map 里。
	if len(l.windows) > 4096 {
		for k, w := range l.windows {
			stale := true
			for _, t := range w.hits {
				if now.Sub(t) < windowMs {
					stale = false
					break
				}
			}
			if stale {
				delete(l.windows, k)
			}
		}
	}
	w := l.windows[key]
	if w == nil {
		w = &window{}
		l.windows[key] = w
	}
	// 淘汰窗口外的；窗口清空后**整个键重建**——否则键会随账号数无限攒；
	// 重建时必须把当前请求记上，只删不记会把这一次漏计（首请求被静默放行两次）。
	kept := w.hits[:0]
	for _, t := range w.hits {
		if now.Sub(t) < windowMs {
			kept = append(kept, t)
		}
	}
	if len(kept) == 0 {
		if max <= 0 {
			delete(l.windows, key)
			return false
		}
		l.windows[key] = &window{hits: []time.Time{now}}
		return true
	}
	w.hits = kept
	if len(w.hits) >= max {
		return false
	}
	w.hits = append(w.hits, now)
	return true
}

func limit(scope string, next http.Handler) http.Handler {
	return limitN(scope, 15, next)
}

// limitN 同 limit 但可指定每分钟上限（健康检查要放行部署轮询，15/分不够用）。
// 注意几条路由把本闸放在 withLogging **之外**（挡在读体/JWT 之前是刻意的）：
// 拒绝分支因此要自带 nosniff 与访问日志，否则 429 轮次在运维侧不可见。
func limitN(scope string, max int, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// 桶键按 auth.RateKey 归一（IPv6 → /64）：同一客户端换主机位不能换出新预算。
		// 日志里的 ip 仍是完整地址，取证不受影响。
		bucket := scope + ":" + auth.RateKey(clientIP(r))
		if !limiter.allow(bucket, max, time.Minute) {
			limit429(w, r, scope, bucket)
			return
		}
		next.ServeHTTP(w, r)
	})
}

// limit429 是限流拒绝的统一回执（limitN、internalVerify 的按 app 分键与 AI 三
// 端点共用）：429 + Retry-After + nosniff，外加两条日志——
//
//   - `限流命中`（Warn，stderr）是**可检索的取证记录**：scope=闸名、bucket=实际
//     分键（IP 桶带 ip、verify/AI 桶带 app，uid 桶在调用处直接带 uid）、ip=受信
//     代理口径的客户端 IP。限流误伤（CGNAT 共享出口、风暴挤兑）事后要能回答
//     「谁在什么时候被哪个桶拒了」。走结构化日志而不是 audit_logs：429 不是业务
//     动作，风暴时逐条写库的放大面正好打在要保护的连接池上；保留期由 supervisord
//     的日志轮转负责（≥7 天）。
//   - 原 `request` 行（Info，stdout）保留：与 withLogging 同构，按 status 检索
//     429 的老习惯不断线。
func limit429(w http.ResponseWriter, r *http.Request, scope, bucket string) {
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Retry-After", "60")
	slog.Warn("限流命中", "scope", scope, "bucket", bucket, "ip", clientIP(r),
		"method", r.Method, "path", r.URL.Path)
	slog.Info("request", "method", r.Method, "path", r.URL.Path,
		"status", http.StatusTooManyRequests, "scope", scope)
	writeError(w, http.StatusTooManyRequests, "操作过于频繁，请稍后再试")
}

// observe 记一次命中并返回该键在窗口内的计数，**只记不拒**——/internal/verify
// 的单 uid 用量监控用：共享桶（600/分/app）被单个风暴客户端吃掉时，日志里要能
// 指名道姓是哪个 uid 在吃。与 allow 同一套窗口与惰性清理，单实例假设一致。
func (l *rateLimiter) observe(key string, win time.Duration) int {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := time.Now()
	if len(l.windows) > 4096 {
		for k, w := range l.windows {
			stale := true
			for _, t := range w.hits {
				if now.Sub(t) < win {
					stale = false
					break
				}
			}
			if stale {
				delete(l.windows, k)
			}
		}
	}
	w := l.windows[key]
	if w == nil {
		w = &window{}
		l.windows[key] = w
	}
	kept := w.hits[:0]
	for _, t := range w.hits {
		if now.Sub(t) < win {
			kept = append(kept, t)
		}
	}
	w.hits = append(kept, now)
	return len(w.hits)
}

// clientIP 解析真实客户端 IP，只用于限流键。
//
// 生产里 nginx 在同机做 TLS 反代，请求转到本进程时 RemoteAddr 恒为代理地址——
// 直接当键会让**所有用户挤进同一个桶**，15 次/分的全站共享额度可被单点打满
// （打挂登录注册），反爆破的分 IP 粒度也完全失效。业界共识是「只信任受信代理
// 追加的转发值」，所以：
//
//  1. RemoteAddr 不是受信代理（环回/内网）→ 认定直连，用 RemoteAddr，XFF 一律不信
//     （否则任何客户端伪造一个 X-Forwarded-For 就能每请求换一个键，限流被绕过）
//  2. 是受信代理 → 优先 X-Forwarded-For：从**右端**往左找第一个非受信地址——右端是
//     代理自己按 TCP 对端追加的、客户端伪造不了；左端的旧值才可能是客户端自带的。
//     XFF 没有（nginx 只配了 X-Real-IP 的常见部署）→ 用 X-Real-IP（同样是代理
//     按 $remote_addr 写的，客户端改不了），它也不可信才回落 RemoteAddr
//  3. 两个头都没有（本机 curl /health 这类）→ 回落 RemoteAddr
//
// 想改信任范围用 TRUSTED_PROXIES（逗号分隔 CIDR/IP，默认环回+内网）。
func clientIP(r *http.Request) string {
	remote := normalizeClientIP(r.RemoteAddr)
	trusted := trustedProxies()
	if !containsIP(trusted, remote) {
		return remote
	}
	for _, header := range r.Header.Values("X-Forwarded-For") {
		parts := strings.Split(header, ",")
		for i := len(parts) - 1; i >= 0; i-- {
			ip := normalizeClientIP(parts[i])
			if ip == "" {
				continue // 空串/非 IP（伪造垃圾）跳过，继续往左找
			}
			if !containsIP(trusted, ip) {
				return ip
			}
		}
	}
	if real := normalizeClientIP(r.Header.Get("X-Real-IP")); real != "" {
		return real
	}
	return remote
}

// normalizeClientIP 把各种来源写法归一成一个可比较的 IP：
//
//	host:port（含 [::1]:443）→ 去端口；IPv6 zone（fe80::1%eth0）→ 去 zone；
//	IPv4-mapped（::ffff:203.0.113.7）→ 还原成 v4 点分十进制。
//
// 为什么必须归一：限流桶、会话 IP、GeoIP 三处都拿这个值做键/判定；同一客户端
// 在 XFF 里写成 ::ffff:1.2.3.4、在 RemoteAddr 写成 1.2.3.4，不归一会分成两个
// 桶（绕过限流）并在设备页显示成两个地址。非法/空值回空串，由调用方跳过。
func normalizeClientIP(raw string) string {
	v := strings.TrimSpace(raw)
	if v == "" {
		return ""
	}
	// IPv6 zone：RFC 4007 的 %zone 不是地址的一部分
	if i := strings.LastIndexByte(v, '%'); i > 0 && strings.Contains(v, ":") {
		v = v[:i]
	}
	// 去端口：先按 host:port 试，再处理裸 IPv6（SplitHostPort 对裸 v6 会失败）
	if host, _, err := net.SplitHostPort(v); err == nil {
		v = host
	} else {
		v = strings.Trim(v, "[]")
	}
	parsed := net.ParseIP(v)
	if parsed == nil {
		return ""
	}
	if v4 := parsed.To4(); v4 != nil {
		return v4.String()
	}
	return parsed.String()
}

// hostOnly 去掉 RemoteAddr 的端口；SplitHostPort 失败时按原样返回。
func hostOnly(addr string) string {
	host, _, err := net.SplitHostPort(addr)
	if err != nil {
		return addr
	}
	return host
}

// trustedProxies 解析受信代理集合：TRUSTED_PROXIES 显式配置优先，
// 未配置时默认环回 + RFC1918/ULA 内网段（同机 nginx 与机房内部负载都在此列）。
func trustedProxies() []string {
	if v := os.Getenv("TRUSTED_PROXIES"); v != "" {
		return strings.Split(v, ",")
	}
	return []string{"127.0.0.0/8", "::1/128", "10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "fc00::/7"}
}

// containsIP 判断 ip 是否命中受信集合中的某一项（精确 IP 或 CIDR）。
func containsIP(trusted []string, ip string) bool {
	parsed := net.ParseIP(ip)
	if parsed == nil {
		return false
	}
	for _, t := range trusted {
		t = strings.TrimSpace(t)
		if t == "" {
			continue
		}
		if strings.Contains(t, "/") {
			if _, cidr, err := net.ParseCIDR(t); err == nil && cidr.Contains(parsed) {
				return true
			}
			continue
		}
		if addr := net.ParseIP(t); addr != nil && addr.Equal(parsed) {
			return true
		}
	}
	return false
}

// jsonBody 解码请求体后交给 h。不拒绝未知字段（见 decode 注释）。
func jsonBody[T any](h func(*T, http.ResponseWriter, *http.Request)) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var req T
		if !decodeOr400(w, r, &req) {
			return
		}
		h(&req, w, r)
	})
}

// splitHandler 按级别把记录分流到两个 handler（<Warn→stdout，≥Warn→stderr），
// 让 supervisord 的 stdout/stderr 两个日志文件各归各位。
type splitHandler struct {
	out slog.Handler
	err slog.Handler
}

func (h *splitHandler) Enabled(ctx context.Context, level slog.Level) bool {
	return h.out.Enabled(ctx, level) || h.err.Enabled(ctx, level)
}

func (h *splitHandler) Handle(ctx context.Context, r slog.Record) error {
	if r.Level >= slog.LevelWarn {
		return h.err.Handle(ctx, r)
	}
	return h.out.Handle(ctx, r)
}

func (h *splitHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return &splitHandler{out: h.out.WithAttrs(attrs), err: h.err.WithAttrs(attrs)}
}

func (h *splitHandler) WithGroup(name string) slog.Handler {
	return &splitHandler{out: h.out.WithGroup(name), err: h.err.WithGroup(name)}
}
