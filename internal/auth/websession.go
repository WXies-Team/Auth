package auth

import (
	"crypto/rand"
	"crypto/subtle"
	"database/sql"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/WXies-Team/Auth/internal/db"
)

// Web 会话的两个 cookie 名。__Host- 前缀把 Secure/Path=/ 绑进浏览器（子域伪造与
// HTTPS 降级都写不进来），OWASP Session Management Cheat Sheet 的推荐形态。
// 名字在包里导出：cookie 的读写在路由层，hash 的校验在业务层，两边必须同名。
const (
	WebCookieName     = "__Host-auth_web"
	WebCSRFCookieName = "__Host-auth_web_csrf"
)

const (
	// webAppLabel 是 sessions.app 在 Web 台登录行上的取值——设备页因此能把
	// 网页登录和两个日记 App 的登录分列显示。
	webAppLabel = "web"
	// webTokenBytes 是会话 token 与 CSRF token 的熵：32 字节 CSPRNG（ASVS 7.2.3
	// 要求 ≥128 位），base64url 落 cookie。
	webTokenBytes = 32
	// 空闲 7 天 / 绝对 90 天：个人控制台存的是低敏数据，设备页本身还能踢人自卫。
	// OWASP 的 15~30 分钟参考区间对这个场景过激，属 documented deviation（ASVS 7.1.1）。
	webIdleTTL     = 7 * 24 * time.Hour
	webAbsoluteTTL = 90 * 24 * time.Hour
	// WebCookieMaxAgeSeconds 是会话 cookie 的绝对寿命（与 webAbsoluteTTL 同值的秒数）。
	// 路由层给 Set-Cookie 用——cookie 的读写在 HTTP 层，业务层不碰它。
	WebCookieMaxAgeSeconds = 90 * 24 * 3600
	// ReauthWindow 是「强认证（输密码 / 过 TOTP）」的有效窗：改密、改邮、绑解 2FA、
	// 管理写操作都要求它在 2 小时内（ASVS V7.5.1；窗口对齐 GitHub sudo mode 的
	// 2 小时，且每次成功的敏感操作都会滑动续期——slideReauth）。
	ReauthWindow = 2 * time.Hour
	// webRotateGrace 是 token 轮换后的**旧 token 宽限窗**：轮换响应可能在网络上
	// 滞后，或同页的并发请求已经带着旧 cookie 出发。宽限窗内旧 token 仍认（CSRF
	// 也认旧值），窗外旧 token 再出现即判为重放（Auth0 / OWASP 的 refresh token
	// rotation + reuse detection 口径）。30s 取 Okta 默认宽限，兼顾重试容错与
	// 重放检测的有效窗口（Ory 指出宽限窗内 reuse detection 实质失效）。
	webRotateGrace = 30 * time.Second
)

// MsgReauthRequired 是 reauth 窗过期时的固定文案。前端据此弹「重新验证」框
// （ApiError 只有 message 一个字段，不能为了机器可读去改它的形状——老客户端在读它；
// 前端匹配「重新验证」四字）。文案不再枚举验证方式：弹框按账号能力出方案
// （Passkey / 两步验证码，无 MFA 才出密码框），方式在框内自解释。
const MsgReauthRequired = "需要重新验证身份"

// WebSession 是一次 Web 登录签发的凭据：两串都只以 sha256 落库，明文只在这一刻
// 回给调用方（cookie 与 /web/session 的 csrfToken）。
type WebSession struct {
	SID       int64
	Token     string
	CSRFToken string
	ExpiresAt time.Time
}

// randomToken 生成 n 字节 CSPRNG 的 base64url 串（URL 安全、无填充）。
// 用 crypto/rand——token 可预测等于没有会话。
func randomToken(n int) (string, error) {
	b := make([]byte, n)
	if _, err := rand.Read(b); err != nil {
		return "", fmt.Errorf("生成随机 token: %w", err)
	}
	return base64.RawURLEncoding.EncodeToString(b), nil
}

// CreateWebSession 给 Web 台登录建一行会话（app='web'）并返回双 token。
//
// 与两条老登录路的差别只有「多存两列 hash」：id 仍是雪花、device 仍走 shortDevice、
// 踢人与 revoked_at 闸完全复用——网页登录的这行会出现在 App 的设备页里，可被踢。
func (s *Service) CreateWebSession(userID int64, meta SessionMeta) (*WebSession, error) {
	return s.createWebSessionOn(s.pool, userID, meta)
}

// createWebSessionOn 在给定执行器上建 web 会话。**接受邀请用事务执行器**：用户行、
// 邀请消费与会话行必须同批提交（与 Register 的 createSessionOn 同款理由——分开写
// 会留下「已建号但拿不到登录态」的半截状态）。
func (s *Service) createWebSessionOn(ex execer, userID int64, meta SessionMeta) (*WebSession, error) {
	token, err := randomToken(webTokenBytes)
	if err != nil {
		return nil, err
	}
	csrf, err := randomToken(webTokenBytes)
	if err != nil {
		return nil, err
	}
	now := time.Now()
	sid := s.ids.Generate().Int64()
	ua := meta.uaWithCH() // web 登录采到 CH 就并进后缀（与 createSessionOn 同一口径）
	if _, err := ex.ExecContext(db.QueryCtx(),
		`INSERT INTO sessions (id, user_id, app, device, ip, user_agent, created_at, last_seen_at,
		                       web_token_hash, web_csrf_hash, absolute_expires_at, family_id)
		 VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
		sid, userID, webAppLabel, truncateRunes(shortDevice(ua), 191),
		meta.IP, truncateRunes(ua, 512), now.UnixMilli(), now.UnixMilli(),
		sha256Hex(token), sha256Hex(csrf), now.Add(webAbsoluteTTL).UnixMilli(), sid); err != nil {
		return nil, fmt.Errorf("建 web 会话: %w", err)
	}
	return &WebSession{SID: sid, Token: token, CSRFToken: csrf, ExpiresAt: now.Add(webAbsoluteTTL)}, nil
}

// WebCaller 是 Web 会话解析结果：内嵌 Caller（业务层照旧用它的 UID/SID），
// 多带两项只有路由层关心的现场——CSRF hash（cookie 请求要对）与「凭 cookie 进来的」
// 标记（Bearer 请求不走 CSRF：跨站脚本设置不了 Authorization，没有可搭的顺风车）。
type WebCaller struct {
	Caller
	CSRFHash  string
	ViaCookie bool
	// TokenHash 是**本次请求实际出示的**会话 token 的 sha256（cookie 或 Bearer 均可）。
	// 轮换要用它做「条件更新」的期望值：只有出示当前 token 的请求才能换发新 token，
	// 宽限窗里的旧 token 不能拿来续命（否则被偷的旧 cookie 能在 30 秒内换一枚新的
	// 90 天 token，/web/session/refresh 就成了洗白通道）。
	TokenHash string
	// Role 是 users.role 的现查结果（web 会话解析时顺带取回，省一次点查）；
	// 管理端点的最终判定仍要再查一次——撤销必须当场生效。
	Role string
}

// ValidWebSession 用会话 cookie 的明文 token 换身份：sha256 点查 → 行活着 →
// 两道超时（空闲 7 天 / 绝对 90 天）→ 节流回写 last_seen_at。
//
// 任一不满足都回 401「登录已过期」——前端据此清状态、跳登录页。
// DB 抖动按 503 报：把一次 MySQL 超时当成会话失效会把人静默踢出控制台。
func (s *Service) ValidWebSession(token string) (WebCaller, error) {
	if token == "" {
		return WebCaller{}, unauthorized("登录已过期，请重新登录")
	}
	ctx := db.QueryCtx()
	presented := sha256Hex(token) // 本次出示的 token（宽限窗判定与轮换的期望值都用它）
	type webRow struct {
		sid, uid, createdAt, lastSeen, absExpires int64
		revokedAt                                 sql.NullInt64
		csrfHash, prevCSRF, email, role           string
		prevValid, familyID                       int64
	}
	// 列名只在本函数内由常量给出（web_token_hash / prev_token_hash），不是用户输入。
	load := func(column, hash string) (webRow, error) {
		var r webRow
		err := s.pool.QueryRowContext(ctx,
			`SELECT s.id, s.user_id, s.created_at, s.last_seen_at, s.absolute_expires_at,
			        s.revoked_at, s.web_csrf_hash, COALESCE(s.prev_csrf_hash, ''), s.prev_valid_until,
			        s.family_id, u.email, u.role
			 FROM sessions s JOIN users u ON u.id = s.user_id
			 WHERE `+column+` = ?`, hash).
			Scan(&r.sid, &r.uid, &r.createdAt, &r.lastSeen, &r.absExpires, &r.revokedAt,
				&r.csrfHash, &r.prevCSRF, &r.prevValid, &r.familyID, &r.email, &r.role)
		return r, err
	}
	row, err := load("s.web_token_hash", presented)
	if errors.Is(err, sql.ErrNoRows) {
		// 当前 hash 查不到：可能刚被轮换。查「上一枚 token」列——
		//   宽限窗内：正常并发/网络滞后，照常认（CSRF 用旧值）；
		//   窗外：旧 token 重放，吊销整个 family 并记审计（Auth0 reuse detection）。
		row, err = load("s.prev_token_hash", presented)
		if err == nil {
			if time.Now().UnixMilli() > row.prevValid {
				// 已经吊销过的行不再重复吊销/记审计：否则任何持有旧 cookie 的人都能
				// 用重放把 audit_logs 写成无限增长（每请求一行，且不需要有效会话）。
				// 第一次重放（行还活着）才动 family + 审计。
				if !row.revokedAt.Valid {
					s.revokeSessionFamily(row.sid, row.familyID, row.uid, row.email)
				}
				return WebCaller{}, unauthorized("登录已过期，请重新登录")
			}
			row.csrfHash = row.prevCSRF // 宽限窗内旧 CSRF 也认，避免并发请求 403
		}
	}
	if errors.Is(err, sql.ErrNoRows) {
		return WebCaller{}, unauthorized("登录已过期，请重新登录")
	}
	if err != nil {
		return WebCaller{}, &HTTPError{Code: 503, Message: "服务暂时不可用，请稍后重试"}
	}
	sid, uid, createdAt, lastSeen, absExpires := row.sid, row.uid, row.createdAt, row.lastSeen, row.absExpires
	revokedAt, csrfHash, email, role := row.revokedAt, row.csrfHash, row.email, row.role
	now := time.Now().UnixMilli()
	switch {
	case revokedAt.Valid:
		return WebCaller{}, unauthorized("登录已过期，请重新登录")
	case now > sessionAbsoluteExpiry(createdAt, absExpires):
		// 绝对寿命：会话行有 absolute_expires_at 就以它为准（新行 = 建行 + 90 天）；
		// 老行 0 按 created_at + 90 天兜底。到期行不自动吊销（与空闲超时同口径），
		// 下次登录/踢人/清理会收掉它。
		return WebCaller{}, unauthorized("登录已过期，请重新登录")
	case now-lastSeen > webIdleTTL.Milliseconds():
		// 空闲超时的行不自动吊销：下次登录/踢人照常把它收掉，这里只是不再认它
		return WebCaller{}, unauthorized("登录已过期，请重新登录")
	}
	// 节流回写：与 sessionAlive 同款（60 秒内不重复写），失败不拦请求——它只是
	// 设备页的排序字段
	if now-lastSeen >= sessionTouchInterval.Milliseconds() {
		if _, err := s.pool.ExecContext(ctx,
			"UPDATE sessions SET last_seen_at = ? WHERE id = ? AND revoked_at IS NULL", now, sid); err != nil {
			slog.Warn("回写 web 会话活跃时间失败（不影响请求）", "sid", sid, "err", err)
		}
	}
	return WebCaller{
		Caller:    Caller{UID: uid, Email: email, App: webAppLabel, SID: sid},
		CSRFHash:  csrfHash,
		ViaCookie: true,
		TokenHash: presented,
		Role:      role,
	}, nil
}

// sessionFamilyID 回会话的轮换家族：新行 family_id 已填自己的 id；补列前的存量行
// 为 0，按「一行一家族」处理（id 即 family）。
func sessionFamilyID(sid, family int64) int64 {
	if family > 0 {
		return family
	}
	return sid
}

// revokeSessionFamily 吊销一个轮换家族的全部活会话（重放检测的响应动作）。
// 审计复用 session.kick 事件（detail.reason=token_reuse）——不新增事件名，避免
// 管理台审计筛选下拉漏项；取证靠 detail 区分。
//
// 只有**真的吊销了活行**才记审计：并发重放/重复重放时后来的请求命中 0 行，
// 记了就是白长一行（audit_logs 是重放攻击者唯一能直接写大的表）。
func (s *Service) revokeSessionFamily(sid, family, uid int64, email string) {
	fam := sessionFamilyID(sid, family)
	res, err := s.pool.ExecContext(db.QueryCtx(),
		"UPDATE sessions SET revoked_at = ? WHERE (id = ? OR family_id = ?) AND revoked_at IS NULL",
		time.Now().UnixMilli(), sid, fam)
	if err != nil {
		slog.Warn("吊销重放会话家族失败", "family", fam, "err", err)
	} else if n, aerr := res.RowsAffected(); aerr == nil && n == 0 {
		// 行已经被吊销（并发重放/上一次重放已经处理过）：不重复记审计
		return
	}
	// OK=false：被记录的是「这次请求被拒」的安全信号，不是一次正常的管理踢人；
	// 审计页按 result=fail 一眼能筛出重放尝试。
	s.Audit(AuditEvent{
		Action: AuditSessionKick, OK: false, ActorUID: uidPtr(uid),
		ActorEmail: maskEmail(email),
		Detail:     map[string]string{"scope": "family", "reason": "token_reuse", "family": strconv.FormatInt(fam, 10)},
	})
}

// 轮换 / 重放检测的出处：
//   - OWASP Session CS "Renewal Timeout"（旧 ID 保留一小段安全间隔后失效）：
//     https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html
//   - OWASP ASVS 5.0 V7.2.4 / V7.4.1：
//     https://github.com/OWASP/ASVS/blob/master/5.0/en/0x16-V7-Session-Management.md
//   - Auth0 Refresh Token Rotation（reuse → 吊销整个 family）：
//     https://auth0.com/docs/secure/tokens/refresh-token-rotation
//
// RotateWebSession 轮换一个 web 会话 token（POST /web/session/refresh 的业务体）：
// 新 token/CSRF 立即生效，旧 token 进 30 秒宽限窗（prev_* 列），窗外再出现即由
// ValidWebSession 判为重放并吊销整个 family。
//
// 为什么需要它：ASVS 7.2.4 要求认证/再认证时轮换会话标识；OWASP Session CS 的
// Renewal Timeout 也要求会话中途定期换 ID，并把旧 ID 保留一小段安全间隔。当前
// cookie 是 90 天长效凭据，轮换把「一枚 token 被复制后可用的窗口」从 90 天压到
// 「直到下一次刷新 + 30 秒」。
//
// expectedHash 是**本次请求实际出示的 token** 的 sha256（WebCaller.TokenHash），
// 条件 UPDATE 拿它当期望值。两点都不能省：
//   - 并发轮换只有一个赢家，输家 409。若改成「先 SELECT 当前 hash 再拿它当条件」
//     （或在同一事务里 `SELECT ... FOR UPDATE` 后重读），第二个请求读到的是**已经
//     被换掉的** hash，仍然匹配成功——同一会话被连发两枚新 token，客户端存错一枚
//     就会在宽限窗过后被判重放、整会话被误吊销（自伤式登出）。
//   - 宽限窗里的旧 token 不能拿来续命。否则被偷的旧 cookie 只要在 30 秒内刷一次，
//     就能换一枚新的 90 天 token，轮换把攻击窗口压小的意义全部抵消。
//
// 不改 token_version、不动其它会话行：只换这一条会话的凭据。
func (s *Service) RotateWebSession(sid int64, expectedHash string) (*WebSession, error) {
	if expectedHash == "" {
		return nil, unauthorized("登录已过期，请重新登录")
	}
	token, err := randomToken(webTokenBytes)
	if err != nil {
		return nil, err
	}
	csrf, err := randomToken(webTokenBytes)
	if err != nil {
		return nil, err
	}
	ctx := db.SlowCtx()
	var (
		createdAt, absExp int64
		revokedAt         sql.NullInt64
	)
	err = s.pool.QueryRowContext(ctx,
		"SELECT created_at, absolute_expires_at, revoked_at FROM sessions WHERE id = ?", sid).
		Scan(&createdAt, &absExp, &revokedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, unauthorized("登录已过期，请重新登录")
	}
	if err != nil {
		return nil, fmt.Errorf("查 web 会话: %w", err)
	}
	now := time.Now()
	if revokedAt.Valid || now.UnixMilli() > sessionAbsoluteExpiry(createdAt, absExp) {
		return nil, unauthorized("登录已过期，请重新登录")
	}
	// 单条条件 UPDATE 就是全部分界：SET 左→右求值，prev_* 捕获的是**更新前**的
	// web_token_hash / web_csrf_hash；期望 hash 不匹配（被别人换过）或行已吊销
	// （并发登出/踢人）都命中 0 行。
	res, err := s.pool.ExecContext(ctx,
		`UPDATE sessions SET prev_token_hash = web_token_hash, prev_csrf_hash = web_csrf_hash,
		        prev_valid_until = ?, web_token_hash = ?, web_csrf_hash = ?, rotated_at = ?, last_seen_at = ?
		 WHERE id = ? AND web_token_hash = ? AND revoked_at IS NULL`,
		now.Add(webRotateGrace).UnixMilli(), sha256Hex(token), sha256Hex(csrf), now.UnixMilli(),
		now.UnixMilli(), sid, expectedHash)
	if err != nil {
		return nil, fmt.Errorf("轮换 web 会话: %w", err)
	}
	if n, _ := res.RowsAffected(); n != 1 {
		// 0 行 = 输给了并发轮换，或这一行刚被吊销/清理。前者 409 让前端刷新后重试，
		// 后者按登录过期收尾——两种都绝不把没落库的新 token 回给客户端。
		var alive int
		if qerr := s.pool.QueryRowContext(ctx,
			"SELECT COUNT(*) FROM sessions WHERE id = ? AND revoked_at IS NULL", sid).Scan(&alive); qerr == nil && alive == 0 {
			return nil, unauthorized("登录已过期，请重新登录")
		}
		return nil, &HTTPError{Code: 409, Message: "会话已在其它请求中更新，请刷新页面后重试"}
	}
	return &WebSession{
		SID: sid, Token: token, CSRFToken: csrf,
		ExpiresAt: time.UnixMilli(sessionAbsoluteExpiry(createdAt, absExp)),
	}, nil
}

// ValidWebBearer 识别并解析以 Authorization: Bearer 携带的 **web 会话 token**
// （Web 台登录签的那串）。日记 App 拿到的是 JWT（C 批起 /web/login/* 与
// /webauthn/login/finish 按 app 分流签发），走 ValidUserID；两种 Bearer 各走各的
// 解析、互不串用，但两条路各自都要撞 revoked_at 与超时闸。
func (s *Service) ValidWebBearer(header string) (WebCaller, error) {
	raw := bearerLike(header)
	if raw == "" {
		return WebCaller{}, unauthorized("请先登录")
	}
	c, err := s.ValidWebSession(raw)
	if err != nil {
		return WebCaller{}, err
	}
	c.ViaCookie = false
	return c, nil
}

// bearerLike 去掉 "Bearer " 前缀取 token；没这个前缀回空串。
func bearerLike(header string) string {
	if !strings.HasPrefix(header, "Bearer ") {
		return ""
	}
	return strings.TrimSpace(strings.TrimPrefix(header, "Bearer "))
}

// CheckWebCSRF 校验同步器 token：请求头 X-CSRF-Token 的 sha256 要等于本会话存的。
// 常数时间比对（值是等长 64 位 hex，subtle 走满长度）。
func (c WebCaller) CheckCSRF(provided string) bool {
	if c.CSRFHash == "" || provided == "" {
		return false
	}
	return subtle.ConstantTimeCompare([]byte(c.CSRFHash), []byte(sha256Hex(provided))) == 1
}

// MarkReauth 记下「刚刚强认证过」，写在**本会话行**上：换设备、换登录方式都不串。
func (s *Service) MarkReauth(sid int64) error {
	_, err := s.pool.ExecContext(db.QueryCtx(),
		"UPDATE sessions SET reauth_at = ? WHERE id = ? AND revoked_at IS NULL", time.Now().UnixMilli(), sid)
	if err != nil {
		return fmt.Errorf("记录强认证时间: %w", err)
	}
	return nil
}

// RequireReauth 强认证窗（2 小时）内的请求放行，否则 401 + 固定文案，
// 前端弹重新验证框后调 /web/reauth 刷新。
func (s *Service) RequireReauth(sid int64) error {
	var reauth sql.NullInt64
	err := s.pool.QueryRowContext(db.QueryCtx(),
		"SELECT reauth_at FROM sessions WHERE id = ? AND revoked_at IS NULL", sid).Scan(&reauth)
	if errors.Is(err, sql.ErrNoRows) {
		return unauthorized("登录已过期，请重新登录")
	}
	if err != nil {
		return &HTTPError{Code: 503, Message: "服务暂时不可用，请稍后重试"}
	}
	if !reauth.Valid || time.Now().UnixMilli()-reauth.Int64 > ReauthWindow.Milliseconds() {
		return &HTTPError{Code: 401, Message: MsgReauthRequired, Reason: ReasonReauthRequired}
	}
	return nil
}

// Reauth 完成一次强认证并刷新**本会话**的 reauth_at：密码 / 两步验证码 /
// 恢复码三选一（哪个非空用哪个，密码优先）。
//
// 恢复码按**格式分流**（与安全页一框二选一同款判定，见 totp.go 的 recoveryShaped）：
// 专门提交的 recoveryCode 字段直接走恢复码表；两步验证码框里粘了恢复码也能被认出来
// （形态像恢复码的输入先按恢复码验），用户把码填进错通道也只报一次错。
// 恢复码单次使用、用掉即废（consumeRecoveryCode 落 used=1 + recovery.consume 审计）。
//
// 密码路复用 checkPassword（与登录同一份凭据判定，含防枚举的恒时假比对），
// 并按 uid 比对而不是邮箱——token 里的邮箱可能已是旧值，uid 才是会话的锚。
// 成败都进审计：这是「持登录态重拿高危操作许可」的动作，被反复尝试值得看见。
func (s *Service) Reauth(c Caller, password, totpCode, recoveryCode string) (err error) {
	method := "totp"
	switch {
	case strings.TrimSpace(password) != "":
		method = "password"
	case strings.TrimSpace(recoveryCode) != "" || recoveryShaped(totpCode):
		// 恢复码框里的输入一律按恢复码记账；验证码框里粘了恢复码同样分流过去
		method = "recovery"
	}
	defer func() {
		s.Audit(AuditEvent{
			Action: AuditReauth, OK: err == nil, ActorUID: uidPtr(c.UID),
			ActorEmail: maskEmail(c.Email), Meta: c.Meta,
			Detail: map[string]string{"method": method},
		})
	}()
	switch {
	case strings.TrimSpace(password) != "":
		uid, _, err := s.checkPassword(c.Email, password)
		if err != nil {
			return err
		}
		if uid != c.UID {
			// 邮箱对不上说明 token 身份与库不一致（改绑竞态等），按凭据错误处理
			return unauthorized("密码不正确，请重新输入")
		}
	case strings.TrimSpace(recoveryCode) != "":
		if !recoveryShaped(recoveryCode) {
			return badRequest("恢复码格式不正确，请输入 16 位恢复码（形如 XXXX-XXXX-XXXX-XXXX）")
		}
		return s.reauthByRecovery(c, recoveryCode)
	case strings.TrimSpace(totpCode) != "":
		if recoveryShaped(totpCode) {
			// 一框二选一：粘进验证码框的恢复码照样认（与安全页同款分流）
			return s.reauthByRecovery(c, totpCode)
		}
		enabled, err := s.TOTPEnabled(c.UID)
		if err != nil {
			return err
		}
		if !enabled {
			return badRequest("两步验证尚未开启，请改用密码验证")
		}
		ok, err := s.VerifyTOTPCode(c.UID, totpCode)
		if err != nil {
			return err
		}
		if !ok {
			// 走到这里输入已排除恢复码形态（上面分流过），文案必然落在两步验证码一侧
			return wrongCodeError(totpCode)
		}
	default:
		return badRequest("请输入密码、两步验证码或恢复码")
	}
	return s.MarkReauth(c.SID)
}

// reauthByRecovery 用一个恢复码完成强认证：必须已开两步验证（恢复码随启用签发、
// 关闭即删，没开两步验证的账号不可能有恢复码），命中即作废该码并刷 reauth_at。
func (s *Service) reauthByRecovery(c Caller, code string) error {
	enabled, err := s.TOTPEnabled(c.UID)
	if err != nil {
		return err
	}
	if !enabled {
		return badRequest("两步验证尚未开启，请改用密码验证")
	}
	ok, err := s.consumeRecoveryCode(c.UID, c.Email, code, c.Meta)
	if err != nil {
		return err
	}
	if !ok {
		// 重新验证场景的恢复码错：旧码多半用过，给「换一个」与「改用密码」两条出路
		return badRequest(wrongCodeMsg(true, "或改用密码验证"))
	}
	return s.MarkReauth(c.SID)
}

// SessionRole 取当前会话用户的 role（管理后台每请求现查，不缓存——与 token_version
// 「吊销从不缓存」同款理由：撤销管理员资格必须当场生效）。
func (s *Service) SessionRole(uid int64) (string, error) {
	var role string
	err := s.pool.QueryRowContext(db.QueryCtx(), "SELECT role FROM users WHERE id = ?", uid).Scan(&role)
	if errors.Is(err, sql.ErrNoRows) {
		return "", unauthorized("登录已过期，请重新登录")
	}
	if err != nil {
		return "", &HTTPError{Code: 503, Message: "服务暂时不可用，请稍后重试"}
	}
	return role, nil
}
