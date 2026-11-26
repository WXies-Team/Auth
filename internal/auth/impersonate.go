package auth

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/WXies-Team/Auth/internal/db"
)

// 管理员模拟登录（W8，2026-11 定案）：平台管理员排障时以目标用户视角**只读**
// 浏览控制台，不拿目标密码、不触发目标 MFA、不产生目标账号的登录提醒。
//
// 四道硬边界（缺一不可）：
//
//	① 只有 role='super' 能发起；目标不能是 super/root（防横向提权与互相模拟）；
//	② 会话独立 cookie（__Host-auth_imp），**不覆盖管理员自己的 web 会话**——
//	   关掉模拟标签页即可回到原身份，不需要重新登录；
//	③ 绝对 15 分钟到期，且**只读**：除「退出模拟」与登出外，非 GET 请求全部 403
//	   （禁改密/改邮/绑解 MFA/Passkey/踢人/注销/管理端点）；
//	④ 起止都写审计（action=admin.impersonate，detail.reason 必填）。
//
// 只读边界在 withUID 统一执行（cmd/server/main.go），而不是逐个端点记得加闸——
// 漏一个端点就是一个提权口子。
const (
	// ImpersonationCookieName 是模拟会话的独立 cookie。__Host- 前缀要求 Secure +
	// Path=/，与网页会话同款。
	ImpersonationCookieName = "__Host-auth_imp"
	// ImpersonationTTL 是模拟会话的绝对寿命：排障足够，泄露窗口压到最小。
	ImpersonationTTL = 15 * time.Minute
	// impersonationMinReason / MaxReason 是必填理由的长度（按 rune 计）。
	impersonationMinReason = 4
	impersonationMaxReason = 200
)

// StartImpersonation 校验并签发一条只读模拟会话。回执带目标邮箱供前端横幅显示。
// 目标账号的密码、MFA、可信设备一概不参与——这是管理员凭自己的权限发起的查看，
// 不是登录目标账号。
func (s *Service) StartImpersonation(actorUID, targetUID int64, reason, actorEmail string, meta SessionMeta) (*WebSession, string, error) {
	reason = strings.TrimSpace(reason)
	if utf8.RuneCountInString(reason) < impersonationMinReason {
		return nil, "", badRequest("请填写模拟原因（至少 4 个字），会写入审计")
	}
	if utf8.RuneCountInString(reason) > impersonationMaxReason {
		return nil, "", badRequest("模拟原因过长，请控制在 200 字以内")
	}
	if actorUID <= 0 || targetUID <= 0 || actorUID == targetUID {
		return nil, "", badRequest("不能模拟自己，请选择其它账号")
	}
	actorRole, err := s.SessionRole(actorUID)
	if err != nil {
		return nil, "", err
	}
	if !IsSuperRole(actorRole) {
		return nil, "", permissionDenied("只有平台管理员可以模拟用户查看，请联系平台管理员操作")
	}
	var (
		email         string
		role          string
		pendingDelete int64
	)
	err = s.pool.QueryRowContext(db.QueryCtx(),
		"SELECT email, role, pending_delete_at FROM users WHERE id = ?", targetUID).
		Scan(&email, &role, &pendingDelete)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, "", &HTTPError{Code: 404, Message: "该用户不存在，请刷新后重试"}
	}
	if err != nil {
		return nil, "", fmt.Errorf("查模拟目标: %w", err)
	}
	if IsSuperRole(role) {
		return nil, "", permissionDenied("平台管理员账号不能被模拟，避免横向提权")
	}
	if pendingDelete != 0 {
		return nil, "", badRequest("该账号正在注销宽限期，不能模拟；如需协助请先撤销注销申请")
	}

	token, err := randomToken(webTokenBytes)
	if err != nil {
		return nil, "", err
	}
	csrf, err := randomToken(webTokenBytes)
	if err != nil {
		return nil, "", err
	}
	now := time.Now()
	exp := now.Add(ImpersonationTTL)
	sid, err := jsSafeID()
	if err != nil {
		return nil, "", err
	}
	ua := meta.uaWithCH()
	// app='web'：模拟会话出现在目标设备的网页会话列表里（可被目标踢掉，也可被
	// 管理员自己退出）；impersonator_uid 标记来源，ValidWebSession 读它。
	if _, err := s.pool.ExecContext(db.QueryCtx(),
		`INSERT INTO sessions (id, user_id, app, device, ip, user_agent, created_at, last_seen_at,
		                       web_token_hash, web_csrf_hash, absolute_expires_at, family_id, impersonator_uid)
		 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		sid, targetUID, webAppLabel, truncateRunes(shortDevice(ua), 191),
		meta.IP, truncateRunes(ua, 512), now.UnixMilli(), now.UnixMilli(),
		sha256Hex(token), sha256Hex(csrf), exp.UnixMilli(), sid, actorUID); err != nil {
		return nil, "", fmt.Errorf("建模拟会话: %w", err)
	}
	_ = s.MarkReauth(sid)
	s.Audit(AuditEvent{
		Action: AuditAdminImpersonate, OK: true,
		ActorUID: uidPtr(actorUID), TargetUID: uidPtr(targetUID), ActorEmail: maskEmail(actorEmail),
		Meta: meta, Detail: map[string]string{"reason": reason, "action": "start"},
	})
	return &WebSession{SID: sid, Token: token, CSRFToken: csrf, ExpiresAt: exp}, email, nil
}

// StopImpersonation 结束模拟：吊销模拟会话行并写审计。普通会话调用是 no-op
// （不报错——前端可能在退出后重试一次）。
func (s *Service) StopImpersonation(c WebCaller) {
	if c.ImpersonatorUID <= 0 {
		return
	}
	if _, err := s.pool.ExecContext(db.QueryCtx(),
		"UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL",
		time.Now().UnixMilli(), c.SID); err != nil {
		return
	}
	s.Audit(AuditEvent{
		Action: AuditAdminImpersonate, OK: true,
		ActorUID: uidPtr(c.ImpersonatorUID), TargetUID: uidPtr(c.UID),
		Meta: c.Meta, Detail: map[string]string{"action": "stop"},
	})
}

// ImpersonatorEmail 给横幅取发起人邮箱（模拟会话才有）。
func (s *Service) ImpersonatorEmail(uid int64) string {
	if uid <= 0 {
		return ""
	}
	var email string
	_ = s.pool.QueryRowContext(db.QueryCtx(), "SELECT email FROM users WHERE id = ?", uid).Scan(&email)
	return email
}
