package auth

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"time"

	"github.com/WXies-Team/Auth/internal/db"
	"github.com/WXies-Team/Auth/internal/protocol"
)

// ConnectedApp 是「已授权应用」页的一行。
type ConnectedApp struct {
	App        string   `json:"app"`
	Name       string   `json:"name"`
	Scopes     []string `json:"scopes"`
	CreatedAt  int64    `json:"createdAt"`
	LastUsedAt int64    `json:"lastUsedAt"`
}

const consentScopes = "uid email"

// RecordConsent 在用户点「继续授权」后落一行（重复授权只刷新时间）。
// 授权主流程不因这张表失败而中止——它是可撤销的展示层，不是凭证。
func (s *Service) RecordConsent(uid int64, app string) {
	s.recordConsentScopes(uid, app, consentScopes)
}

// recordConsentScopes 与 RecordConsent 同一实现，多带本次请求的 scope 串。
func (s *Service) recordConsentScopes(uid int64, app, scopes string) {
	if strings.TrimSpace(scopes) == "" {
		scopes = consentScopes
	}
	now := time.Now().UnixMilli()
	_, err := s.pool.ExecContext(db.QueryCtx(),
		`INSERT INTO oauth_consents (app, uid, scopes, created_at, last_used_at)
		 VALUES (?, ?, ?, ?, ?)
		 ON DUPLICATE KEY UPDATE last_used_at = VALUES(last_used_at), scopes = VALUES(scopes)`,
		app, uid, scopes, now, now)
	if err != nil {
		slog.Warn("记录 OAuth 授权失败（不阻断授权）", "uid", uid, "app", app, "err", err)
		return
	}
	s.Audit(AuditEvent{
		Action: AuditConsentGrant, OK: true, ActorUID: uidPtr(uid),
		TargetUID: uidPtr(uid), Detail: map[string]string{"app": app, "scope": scopes},
	})
}

// TouchConsent 在授权码换 token 成功时刷新「最近使用」，不新增行。
func (s *Service) TouchConsent(uid int64, app string) {
	_, _ = s.pool.ExecContext(db.QueryCtx(),
		"UPDATE oauth_consents SET last_used_at = ? WHERE uid = ? AND app = ?",
		time.Now().UnixMilli(), uid, app)
}

func (s *Service) ListConnectedApps(uid int64) ([]ConnectedApp, error) {
	rows, err := s.pool.QueryContext(db.QueryCtx(),
		"SELECT app, scopes, created_at, last_used_at FROM oauth_consents WHERE uid = ? ORDER BY last_used_at DESC, app", uid)
	if err != nil {
		return nil, fmt.Errorf("查已授权应用: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := make([]ConnectedApp, 0, 4)
	for rows.Next() {
		var (
			a      ConnectedApp
			scopes string
		)
		if err := rows.Scan(&a.App, &scopes, &a.CreatedAt, &a.LastUsedAt); err != nil {
			return nil, fmt.Errorf("读已授权应用: %w", err)
		}
		a.Scopes = strings.Fields(scopes)
		out = append(out, a)
	}
	return out, rows.Err()
}

// RevokeConnectedApp 删授权并吊销该用户在该应用下的全部会话：撤销之后应用
// 再拿旧 JWT 来 /internal/verify 会因会话不在了而 401。
func (s *Service) RevokeConnectedApp(uid int64, app string) error {
	if _, err := s.pool.ExecContext(db.QueryCtx(),
		"DELETE FROM oauth_consents WHERE uid = ? AND app = ?", uid, app); err != nil {
		return fmt.Errorf("撤销授权: %w", err)
	}
	now := time.Now().UnixMilli()
	if _, err := s.pool.ExecContext(db.QueryCtx(),
		"UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND app = ? AND revoked_at IS NULL",
		now, uid, app); err != nil {
		return fmt.Errorf("吊销应用会话: %w", err)
	}
	s.Audit(AuditEvent{
		Action: AuditConsentRevoke, OK: true, ActorUID: uidPtr(uid),
		TargetUID: uidPtr(uid), Detail: map[string]string{"app": app},
	})
	return nil
}

// maskActorEmailFor 按受众决定是否遮邮箱：自己的事件不遮，他人的一律遮。
// 抽成纯函数便于单测（不依赖数据库）。
func maskActorEmailFor(actorUID, viewerUID int64, email string) string {
	if email == "" || actorUID == viewerUID {
		return email
	}
	return maskEmail(email)
}

// UserAuditLog 是用户自己的安全活动：actor 或 target 命中该 uid 的事件。
func (s *Service) UserAuditLog(uid int64, limit, offset int) ([]AuditRow, int, error) {
	limit, offset = clampPage(limit, offset)
	// admin.audit.view 是管理员翻看审计的读事件：把它塞进用户的「我的安全活动」
	// 只会淹没真正的登录/凭证事件，所以自助视图排除它（管理台审计页仍完整可见）。
	var total int
	if err := s.pool.QueryRowContext(db.QueryCtx(),
		"SELECT COUNT(*) FROM audit_logs WHERE (actor_uid = ? OR target_uid = ?) AND action <> 'admin.audit.view'",
		uid, uid).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("数安全活动: %w", err)
	}
	rows, err := s.pool.QueryContext(db.QueryCtx(),
		`SELECT id, ts, actor_uid, actor_email, action, result, target_uid, ip, user_agent, detail
		 FROM audit_logs WHERE (actor_uid = ? OR target_uid = ?) AND action <> 'admin.audit.view'
		 ORDER BY ts DESC, id DESC LIMIT ? OFFSET ?`, uid, uid, limit, offset)
	if err != nil {
		return nil, 0, fmt.Errorf("查安全活动: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := make([]AuditRow, 0, limit)
	for rows.Next() {
		var (
			r      AuditRow
			actor  sql.NullInt64
			target sql.NullInt64
			detail sql.NullString
			action string
			result string
			ua     string
		)
		if err := rows.Scan(&r.ID, &r.TS, &actor, &r.ActorEmail, &action, &result, &target, &r.IP, &ua, &detail); err != nil {
			return nil, 0, fmt.Errorf("读安全活动: %w", err)
		}
		r.Action, r.Result, r.UserAgent = action, result, ua
		r.ActorUID = actor.Int64
		// 别人的邮箱在自己的活动页里没有知道全称的必要（管理员改角色等事件会带
		// 操作者邮箱）：统一遮掉；自己的事件保持全文，便于核对。
		r.ActorEmail = maskActorEmailFor(r.ActorUID, uid, r.ActorEmail)
		r.TargetUID = target.Int64
		if detail.Valid && detail.String != "" {
			r.Detail = map[string]string{}
			if err := json.Unmarshal([]byte(detail.String), &r.Detail); err != nil {
				r.Detail = nil
			}
		}
		out = append(out, r)
	}
	return out, total, rows.Err()
}

// AccountExport 是 /api/account/export 的回执：账号能看到的自己全部数据。
type AccountExport struct {
	ExportedAt    int64                    `json:"exportedAt"`
	UID           int64                    `json:"uid"`
	Email         string                   `json:"email"`
	CreatedAt     int64                    `json:"createdAt"`
	Profile       protocol.ProfileResponse `json:"profile"`
	Sessions      []protocol.SessionInfo   `json:"sessions"`
	Passkeys      []PasskeyInfo            `json:"passkeys"`
	TOTP          TOTPStatus               `json:"totp"`
	ConnectedApps []ConnectedApp           `json:"connectedApps"`
	Audit         []AuditRow               `json:"audit"`
	// AIUsage 是最近 30 天的个人 AI 用量；查询失败不阻断导出（omitempty）。
	AIUsage *AIUsageUserDetail `json:"aiUsage,omitempty"`
}

func (s *Service) ExportAccount(uid int64) (*AccountExport, error) {
	var email string
	var createdAt int64
	if err := s.pool.QueryRowContext(db.QueryCtx(),
		"SELECT email, created_at FROM users WHERE id = ?", uid).Scan(&email, &createdAt); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return nil, unauthorized("登录已过期，请重新登录")
		}
		return nil, fmt.Errorf("查导出账号: %w", err)
	}
	profile, err := s.GetProfile(uid)
	if err != nil {
		return nil, err
	}
	sessions, err := s.ListSessions(uid, 0, nil)
	if err != nil {
		return nil, err
	}
	passkeys, err := s.ListPasskeys(uid, 0)
	if err != nil {
		return nil, err
	}
	totp, err := s.TOTPStatus(uid)
	if err != nil {
		return nil, err
	}
	apps, err := s.ListConnectedApps(uid)
	if err != nil {
		return nil, err
	}
	audit, _, err := s.UserAuditLog(uid, 200, 0)
	if err != nil {
		return nil, err
	}
	aiUsage, _ := s.AdminAIUsageUser(30, nil, uid)
	return &AccountExport{
		ExportedAt: time.Now().UnixMilli(), UID: uid, Email: email, CreatedAt: createdAt,
		Profile: *profile, Sessions: sessions, Passkeys: passkeys, TOTP: totp,
		ConnectedApps: apps, Audit: audit, AIUsage: aiUsage,
	}, nil
}

// AdminResetMFA 清空目标用户的 TOTP 与 Passkey，并吊销全部会话。只在
// /admin/users/{uid}/mfa-reset（super）调用；审计落 admin.mfa.reset。
func (s *Service) AdminResetMFA(actor Caller, targetUID int64) (err error) {
	if s.isRootAccount(targetUID) && !s.isRootSuper(actor) {
		return &HTTPError{Code: 403, Message: "根管理员的 MFA 只能由根管理员本人重置", Reason: ReasonPermission}
	}
	var targetEmail string
	if qerr := s.pool.QueryRowContext(db.QueryCtx(),
		"SELECT email FROM users WHERE id = ?", targetUID).Scan(&targetEmail); qerr != nil {
		if errors.Is(qerr, sql.ErrNoRows) {
			return &HTTPError{Code: 404, Message: "该用户不存在，请刷新后重试"}
		}
		return fmt.Errorf("查目标邮箱: %w", qerr)
	}
	defer func() {
		s.Audit(AuditEvent{
			Action: AuditAdminMFAReset, OK: err == nil, ActorUID: uidPtr(actor.UID),
			ActorEmail: maskEmail(actor.Email), TargetUID: uidPtr(targetUID), Meta: actor.Meta,
		})
	}()
	ctx := db.SlowCtx()
	tx, err := s.pool.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("开事务: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err = tx.ExecContext(ctx, "DELETE FROM totp_factors WHERE user_id = ?", targetUID); err != nil {
		return fmt.Errorf("清 TOTP: %w", err)
	}
	if _, err = tx.ExecContext(ctx, "DELETE FROM passkeys WHERE user_id = ?", targetUID); err != nil {
		return fmt.Errorf("清 Passkey: %w", err)
	}
	if _, err = tx.ExecContext(ctx, "DELETE FROM recovery_codes WHERE user_id = ?", targetUID); err != nil {
		return fmt.Errorf("清恢复码: %w", err)
	}
	// 在途的 2FA 中间态与 Passkey 仪式一并清掉：重置后不能让半截登录继续完成。
	if _, err = tx.ExecContext(ctx, "DELETE FROM login_states WHERE user_id = ?", targetUID); err != nil {
		return fmt.Errorf("清登录中间态: %w", err)
	}
	if _, err = tx.ExecContext(ctx, "DELETE FROM webauthn_challenges WHERE user_id = ?", targetUID); err != nil {
		return fmt.Errorf("清 Passkey 仪式: %w", err)
	}
	if _, err = tx.ExecContext(ctx, "DELETE FROM trusted_devices WHERE uid = ?", targetUID); err != nil {
		return fmt.Errorf("清可信设备: %w", err)
	}
	if _, err = tx.ExecContext(ctx,
		"UPDATE users SET token_version = token_version + 1 WHERE id = ?", targetUID); err != nil {
		return fmt.Errorf("升 token_version: %w", err)
	}
	if _, err = tx.ExecContext(ctx,
		"UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL",
		time.Now().UnixMilli(), targetUID); err != nil {
		return fmt.Errorf("吊销会话: %w", err)
	}
	if err = tx.Commit(); err != nil {
		return err
	}
	s.notifyMFAReset(targetEmail)
	return nil
}

func (s *Service) notifyMFAReset(email string) {
	if s.mailer == nil {
		return
	}
	b := brandFor("")
	subject, htmlBody, text := mfaResetNoticeEmail(b, time.Now())
	if err := s.mailer.Send(context.Background(), b.name, email, subject, htmlBody, text); err != nil {
		mailLog(err, "mfa_reset_notice", email)
	}
}

// SystemCounts 是 /admin/status 的只读汇总。
type SystemCounts struct {
	Users    int `json:"users"`
	Sessions int `json:"sessions"`
	Passkeys int `json:"passkeys"`
	TOTP     int `json:"totp"`
	Tables   int `json:"tables"`
	Indexes  int `json:"indexes"`
}

func (s *Service) PingDB() (time.Duration, error) {
	start := time.Now()
	err := s.pool.PingContext(db.QueryCtx())
	return time.Since(start), err
}

func (s *Service) PasskeysConfigured() bool { return s.wa != nil }

func (s *Service) SystemCounts() (SystemCounts, error) {
	var c SystemCounts
	qs := []struct {
		q   string
		dst *int
	}{
		{"SELECT COUNT(*) FROM users", &c.Users},
		{"SELECT COUNT(*) FROM sessions WHERE revoked_at IS NULL", &c.Sessions},
		{"SELECT COUNT(*) FROM passkeys", &c.Passkeys},
		{"SELECT COUNT(*) FROM totp_factors WHERE enabled = 1", &c.TOTP},
		{"SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE()", &c.Tables},
		{"SELECT COUNT(DISTINCT table_name, index_name) FROM information_schema.statistics WHERE table_schema = DATABASE()", &c.Indexes},
	}
	for _, it := range qs {
		if err := s.pool.QueryRowContext(db.QueryCtx(), it.q).Scan(it.dst); err != nil {
			return c, fmt.Errorf("统计: %w", err)
		}
	}
	return c, nil
}

// SendTestMail 是配置中心的 SMTP 自检：只发一封最小邮件，不落任何账号状态。
func (s *Service) SendTestMail(to string) error {
	if s.mailer == nil {
		return &HTTPError{Code: 503, Message: "邮件服务未配置，请先在配置中心填写 SMTP 四键"}
	}
	email := normalizeEmail(to)
	if err := validateEmail(email); err != nil {
		return err
	}
	b := brandFor("")
	subject, htmlBody, text := smtpTestEmail(b)
	if err := s.mailer.Send(context.Background(), b.name, email, subject, htmlBody, text); err != nil {
		return &HTTPError{Code: 503, Message: "测试邮件发送失败，请检查 SMTP 配置"}
	}
	return nil
}
