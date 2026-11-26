package auth

import (
	"database/sql"
	"errors"
	"strings"
	"time"

	"github.com/WXies-Team/Auth/internal/db"
)

// 风险登录（W9）：账号首次从一个没见过的 IP 登录时，
//
//	① 发一封提醒信（新 IP 或新设备任一命中；见 loginnotify.go）；
//	② 若配置中心 risk_new_ip_mfa=1（默认 1，显式 "0"/"off" 关闭）且账号开了
//	   两步验证，则**即使本机有可信设备令牌也要求过 2FA**——可信设备绑的是 UA，
//	   cookie 被整体搬走后 UA 可以伪造，IP 变化是独立的一道信号；
//	③ 审计仍只记 login.success 一行（detail 里有 IP），不新增事件名，避免管理台
//	   审计下拉漏项。
//
// 记忆表 login_ips 每用户最多留 40 个 IP（超出按最久未用淘汰）：家用/公司/移动
// 网络切换不会天天触发，长期不用的出口 IP 被淘汰后再出现只多一封提醒。
const (
	maxLoginIPsPerUser = 40
	// riskNewIPMFADefault 是「新 IP 强制 2FA」的缺省值：开启。关掉只需在配置
	// 中心把 risk_new_ip_mfa 设为 0 或 off。
	riskNewIPMFADefault = true
)

// observeLoginIP 记录一次成功密码校验看到的 IP，并返回它是不是该用户的新 IP。
// 空 IP（取不到来源的极端请求）不参与判定，恒按「不是新 IP」处理，避免所有人
// 都被当成新 IP 而反复要求 2FA。
func (s *Service) observeLoginIP(uid int64, ip string) (bool, error) {
	ip = strings.TrimSpace(ip)
	if uid <= 0 || ip == "" {
		return false, nil
	}
	var first int64
	err := s.pool.QueryRowContext(db.QueryCtx(),
		"SELECT first_seen_at FROM login_ips WHERE uid = ? AND ip = ?", uid, ip).Scan(&first)
	if err == nil {
		_, _ = s.pool.ExecContext(db.QueryCtx(),
			"UPDATE login_ips SET last_seen_at = ? WHERE uid = ? AND ip = ?", time.Now().UnixMilli(), uid, ip)
		return false, nil
	}
	if !errors.Is(err, sql.ErrNoRows) {
		return false, err
	}
	now := time.Now().UnixMilli()
	if _, err := s.pool.ExecContext(db.QueryCtx(),
		"INSERT IGNORE INTO login_ips (uid, ip, first_seen_at, last_seen_at) VALUES (?,?,?,?)",
		uid, ip, now, now); err != nil {
		return false, err
	}
	// 超出上限时淘汰最久未用的行。先数后删只在这条冷路径（新 IP）上跑。
	var n int
	if err := s.pool.QueryRowContext(db.QueryCtx(),
		"SELECT COUNT(*) FROM login_ips WHERE uid = ?", uid).Scan(&n); err == nil && n > maxLoginIPsPerUser {
		_, _ = s.pool.ExecContext(db.QueryCtx(),
			`DELETE FROM login_ips WHERE uid = ? AND ip NOT IN (
			   SELECT ip FROM (
			     SELECT ip FROM login_ips WHERE uid = ? ORDER BY last_seen_at DESC LIMIT ?
			   ) keep
			 )`, uid, uid, maxLoginIPsPerUser)
	}
	return true, nil
}

// riskNewIPMFA 读配置中心的开关；读不到按缺省开启。只认显式的关闭值。
func (s *Service) riskNewIPMFA() bool {
	if s.cfg == nil {
		return riskNewIPMFADefault
	}
	raw, err := s.cfg("risk_new_ip_mfa")
	if err != nil {
		return riskNewIPMFADefault
	}
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "0", "off", "false", "no":
		return false
	case "1", "on", "true", "yes":
		return true
	default:
		return riskNewIPMFADefault
	}
}
