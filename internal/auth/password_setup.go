package auth

import (
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/WXies-Team/Auth/internal/db"
)

// 管理员重置密码后的「一次性设密链接」。复用 otp_codes 的 token 形态：
// 同样是高熵随机串 + 库里只存哈希 + 短过期 + 单次核销，不另建一套令牌表。
// 与安全码共用表但 purpose 不同，互不干扰。

const (
	passwordSetupPurpose = "setup"
	passwordSetupTTL     = time.Hour
)

// CreatePasswordSetup 生成一条一次性设密链接，返回完整 URL（token 只在 URL 里出现一次）。
func (s *Service) CreatePasswordSetup(uid int64, email string) (string, error) {
	token, err := randomToken(inviteTokenBytes)
	if err != nil {
		return "", err
	}
	now := time.Now().UnixMilli()
	if _, err = s.pool.ExecContext(db.SlowCtx(),
		"INSERT INTO otp_codes (email, purpose, code_hash, expires_at, uid, created_at, last_sent_at) VALUES (?,?,?,?,?,?,?)",
		email, passwordSetupPurpose, sha256Hex(token), now+passwordSetupTTL.Milliseconds(), uid, now, now); err != nil {
		return "", fmt.Errorf("生成设密链接: %w", err)
	}
	return siteBase + "/web/setup-password?token=" + token, nil
}

// PasswordSetup 是一次性设密链接验过后的展示信息。
type PasswordSetup struct {
	UID   int64
	Email string
}

// PasswordSetupLookup 校验 token 是否有效（未用、未过期）。
func (s *Service) PasswordSetupLookup(token string) (*PasswordSetup, error) {
	var uid int64
	var email string
	var expiresAt, used int64
	err := s.pool.QueryRowContext(db.QueryCtx(),
		"SELECT uid, email, expires_at, used FROM otp_codes WHERE code_hash = ? AND purpose = ?",
		sha256Hex(token), passwordSetupPurpose).Scan(&uid, &email, &expiresAt, &used)
	if errors.Is(err, sql.ErrNoRows) || used != 0 || expiresAt < time.Now().UnixMilli() {
		return nil, badRequest("链接已失效，请联系管理员重新设置密码")
	}
	if err != nil {
		return nil, fmt.Errorf("核对设密链接: %w", err)
	}
	return &PasswordSetup{UID: uid, Email: email}, nil
}

// CompletePasswordSetup 设置新密码并核销链接：同一事务里改密、吊销旧会话、标记 token 已用。
func (s *Service) CompletePasswordSetup(token, password string) error {
	info, err := s.PasswordSetupLookup(token)
	if err != nil {
		return err
	}
	if err = validateManualPassword(password); err != nil {
		return err
	}
	hashed, err := hash(password)
	if err != nil {
		return err
	}
	ctx := db.SlowCtx()
	tx, err := s.pool.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("开事务: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if _, err = tx.ExecContext(ctx,
		"UPDATE users SET password_hash = ?, token_version = token_version + 1, password_must_change = 0 WHERE id = ?",
		hashed, info.UID); err != nil {
		return fmt.Errorf("设置新密码: %w", err)
	}
	if err = revokeUserSessions(ctx, tx, info.UID, 0, nil); err != nil {
		return err
	}
	// 条件更新：与并发重复提交只有一边生效
	res, err := tx.ExecContext(ctx,
		"UPDATE otp_codes SET used = 1 WHERE code_hash = ? AND purpose = ? AND used = 0",
		sha256Hex(token), passwordSetupPurpose)
	if err != nil {
		return fmt.Errorf("核销设密链接: %w", err)
	}
	if n, _ := res.RowsAffected(); n != 1 {
		return badRequest("链接已失效，请联系管理员重新设置密码")
	}
	if err = tx.Commit(); err != nil {
		return fmt.Errorf("提交设密: %w", err)
	}
	return nil
}
