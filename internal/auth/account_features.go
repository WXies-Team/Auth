package auth

import (
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
	now := time.Now().UnixMilli()
	_, err := s.pool.ExecContext(db.QueryCtx(),
		`INSERT INTO oauth_consents (app, uid, scopes, created_at, last_used_at)
		 VALUES (?, ?, ?, ?, ?)
		 ON DUPLICATE KEY UPDATE last_used_at = VALUES(last_used_at), scopes = VALUES(scopes)`,
		app, uid, consentScopes, now, now)
	if err != nil {
		slog.Warn("记录 OAuth 授权失败（不阻断授权）", "uid", uid, "app", app, "err", err)
		return
	}
	s.Audit(AuditEvent{
		Action: AuditConsentGrant, OK: true, ActorUID: uidPtr(uid),
		TargetUID: uidPtr(uid), Detail: map[string]string{"app": app},
	})
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

// UserAuditLog 是用户自己的安全活动：actor 或 target 命中该 uid 的事件。
func (s *Service) UserAuditLog(uid int64, limit, offset int) ([]AuditRow, int, error) {
	limit, offset = clampPage(limit, offset)
	var total int
	if err := s.pool.QueryRowContext(db.QueryCtx(),
		"SELECT COUNT(*) FROM audit_logs WHERE actor_uid = ? OR target_uid = ?", uid, uid).Scan(&total); err != nil {
		return nil, 0, fmt.Errorf("数安全活动: %w", err)
	}
	rows, err := s.pool.QueryContext(db.QueryCtx(),
		`SELECT id, ts, actor_uid, actor_email, action, result, target_uid, ip, user_agent, detail
		 FROM audit_logs WHERE actor_uid = ? OR target_uid = ?
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
	return &AccountExport{
		ExportedAt: time.Now().UnixMilli(), UID: uid, Email: email, CreatedAt: createdAt,
		Profile: *profile, Sessions: sessions, Passkeys: passkeys, TOTP: totp,
		ConnectedApps: apps, Audit: audit,
	}, nil
}

// AdminResetMFA 清空目标用户的 TOTP 与 Passkey，并吊销全部会话。只在
// /admin/users/{uid}/mfa-reset（super）调用；审计落 admin.mfa.reset。
func (s *Service) AdminResetMFA(actor Caller, targetUID int64) (err error) {
	if s.isRootAccount(targetUID) && !s.isRootSuper(actor) {
		return &HTTPError{Code: 403, Message: "根管理员的 MFA 只能由根管理员本人重置", Reason: ReasonPermission}
	}
	defer func() {
		s.Audit(AuditEvent{
			Action: AuditAdminMFAReset, OK: err == nil, ActorUID: uidPtr(actor.UID),
			ActorEmail: maskEmail(actor.Email), TargetUID: uidPtr(targetUID), Meta: actor.Meta,
		})
	}()
	ctx := db.QueryCtx()
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
	if _, err = tx.ExecContext(ctx,
		"UPDATE users SET token_version = token_version + 1 WHERE id = ?", targetUID); err != nil {
		return fmt.Errorf("升 token_version: %w", err)
	}
	if _, err = tx.ExecContext(ctx,
		"UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL",
		time.Now().UnixMilli(), targetUID); err != nil {
		return fmt.Errorf("吊销会话: %w", err)
	}
	return tx.Commit()
}

// SystemCounts 是 /admin/status 的只读汇总。
type SystemCounts struct {
	Users    int `json:"users"`
	Sessions int `json:"sessions"`
	Passkeys int `json:"passkeys"`
	TOTP     int `json:"totp"`
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
	}
	for _, it := range qs {
		if err := s.pool.QueryRowContext(db.QueryCtx(), it.q).Scan(it.dst); err != nil {
			return c, fmt.Errorf("统计: %w", err)
		}
	}
	return c, nil
}
