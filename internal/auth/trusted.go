package auth

import (
	"database/sql"
	"errors"
	"fmt"
	"time"

	"github.com/WXies-Team/Auth/internal/db"
)

// TrustedDeviceCookieName 是「信任此设备」cookie 名。__Host- 前缀要求 Secure +
// Path=/，与网页会话 cookie 同款；它不能替代会话，只用于跳过下一次 2FA。
const TrustedDeviceCookieName = "__Host-auth_trusted"

const trustedDeviceTTL = 30 * 24 * time.Hour

// TrustedDevice 是安全页「可信设备」列表的一行。
type TrustedDevice struct {
	ID         int64  `json:"id"`
	Label      string `json:"label"`
	CreatedAt  int64  `json:"createdAt"`
	LastUsedAt int64  `json:"lastUsedAt"`
	ExpiresAt  int64  `json:"expiresAt"`
	Current    bool   `json:"current"`
}

// TrustDevice 在 2FA 成功且用户勾选「信任此设备」后签发一枚 30 天令牌。
// 令牌明文只在这一次回执里出现，库里只存 sha256；UA 绑定降低 cookie 被搬走后
// 直接复用的概率（换浏览器/换设备即失效）。
func (s *Service) TrustDevice(uid int64, meta SessionMeta) (string, time.Time, error) {
	token, err := randomToken(32)
	if err != nil {
		return "", time.Time{}, err
	}
	id, err := jsSafeID()
	if err != nil {
		return "", time.Time{}, err
	}
	now := time.Now()
	exp := now.Add(trustedDeviceTTL)
	if _, err := s.pool.ExecContext(db.QueryCtx(),
		`INSERT INTO trusted_devices (id, uid, token_hash, ua_hash, label, created_at, expires_at, last_used_at)
		 VALUES (?,?,?,?,?,?,?,?)`,
		id, uid, sha256Hex(token), sha256Hex(meta.UserAgent), shortDevice(meta.UserAgent),
		now.UnixMilli(), exp.UnixMilli(), now.UnixMilli()); err != nil {
		return "", time.Time{}, fmt.Errorf("记录可信设备: %w", err)
	}
	return token, exp, nil
}

// CheckTrustedDevice 校验 uid + token + UA 三者一致且未过期；命中时刷新 last_used_at。
// 只用于「跳过 2FA」，不构成登录凭据——调用方仍必须先验过密码。
func (s *Service) CheckTrustedDevice(uid int64, token, ua string) bool {
	if token == "" {
		return false
	}
	var (
		id        int64
		expiresAt int64
		uaHash    string
	)
	err := s.pool.QueryRowContext(db.QueryCtx(),
		"SELECT id, expires_at, ua_hash FROM trusted_devices WHERE uid = ? AND token_hash = ?",
		uid, sha256Hex(token)).Scan(&id, &expiresAt, &uaHash)
	if errors.Is(err, sql.ErrNoRows) {
		return false
	}
	if err != nil {
		return false
	}
	if time.Now().UnixMilli() > expiresAt || uaHash != sha256Hex(ua) {
		return false
	}
	_, _ = s.pool.ExecContext(db.QueryCtx(),
		"UPDATE trusted_devices SET last_used_at = ? WHERE id = ?", time.Now().UnixMilli(), id)
	return true
}

func (s *Service) ListTrustedDevices(uid int64, currentToken string) ([]TrustedDevice, error) {
	_, _ = s.pool.ExecContext(db.QueryCtx(),
		"DELETE FROM trusted_devices WHERE uid = ? AND expires_at <= ?", uid, time.Now().UnixMilli())
	rows, err := s.pool.QueryContext(db.QueryCtx(),
		`SELECT id, label, created_at, last_used_at, expires_at, token_hash
		 FROM trusted_devices WHERE uid = ? AND expires_at > ? ORDER BY last_used_at DESC, id DESC`,
		uid, time.Now().UnixMilli())
	if err != nil {
		return nil, fmt.Errorf("查可信设备: %w", err)
	}
	defer func() { _ = rows.Close() }()
	currentHash := sha256Hex(currentToken)
	out := make([]TrustedDevice, 0, 4)
	for rows.Next() {
		var it TrustedDevice
		var hash string
		if err := rows.Scan(&it.ID, &it.Label, &it.CreatedAt, &it.LastUsedAt, &it.ExpiresAt, &hash); err != nil {
			return nil, fmt.Errorf("读可信设备: %w", err)
		}
		it.Current = currentToken != "" && hash == currentHash
		out = append(out, it)
	}
	return out, rows.Err()
}

func (s *Service) RevokeTrustedDevice(uid, id int64) error {
	res, err := s.pool.ExecContext(db.QueryCtx(),
		"DELETE FROM trusted_devices WHERE id = ? AND uid = ?", id, uid)
	if err != nil {
		return fmt.Errorf("删除可信设备: %w", err)
	}
	if n, _ := res.RowsAffected(); n == 0 {
		return &HTTPError{Code: 404, Message: "该可信设备不存在，请刷新后重试"}
	}
	return nil
}

// RevokeAllTrustedDevices 是改密/重置 MFA/管理员踢人时的收口：信任不能跨过
// 凭据变更继续有效。
func (s *Service) RevokeAllTrustedDevices(uid int64) {
	_, _ = s.pool.ExecContext(db.QueryCtx(), "DELETE FROM trusted_devices WHERE uid = ?", uid)
}
