package auth

import (
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/WXies-Team/Auth/internal/db"
	"github.com/go-sql-driver/mysql"
)

// 自助注册（W11）：**默认关闭**，产品口径仍是邀请制；配置中心
// allow_self_register=1 才开放 Web 台的「创建账号」入口。
//
// 开启后的流程与邀请建号一致度最大化：邮箱验证码（PurposeRegister，60s 冷却 /
// 每日限额 / 错 5 次作废）→ 设密码（本地强度 + 泄露库校验）→ 同事务落用户行
// 与 web 会话行 → 直接进控制台。不自动开 2FA，不做邮箱枚举差异化——
// SendCode 的既有口径原样复用。
const selfRegisterConfigKey = "allow_self_register"

// SelfRegisterEnabled 供登录页决定是否显示「创建账号」入口。
// 未注入配置（单测/未接线）按关闭处理，与「邀请制」的产品默认一致。
func (s *Service) SelfRegisterEnabled() bool {
	if s.cfg == nil {
		return false
	}
	raw, err := s.cfg(selfRegisterConfigKey)
	if err != nil {
		return false
	}
	switch strings.ToLower(strings.TrimSpace(raw)) {
	case "1", "on", "true", "yes":
		return true
	default:
		return false
	}
}

// RegisterWeb 是 Web 自助注册：验证码 + 密码 → 用户行 + web 会话（同批提交）。
// 返回的 WebSession 由路由层签 cookie；App 注册仍走 /auth/register，两条路互不影响。
func (s *Service) RegisterWeb(rawEmail, password, code string, meta SessionMeta) (ws *WebSession, email string, err error) {
	var uid int64
	defer func() {
		s.Audit(AuditEvent{
			Action: AuditRegister, OK: err == nil, ActorUID: uidPtr(uid),
			ActorEmail: maskEmail(normalizeEmail(rawEmail)), Meta: meta,
			Detail: map[string]string{"app": "web", "method": "self_register"},
		})
	}()
	if !s.SelfRegisterEnabled() {
		return nil, "", permissionDenied("当前未开放自助注册，请联系管理员获取邀请")
	}
	email = normalizeEmail(rawEmail)
	if err := validateEmail(email); err != nil {
		return nil, "", err
	}
	if err := validatePassword(password); err != nil {
		return nil, "", err
	}
	if err := s.rejectBreached(password); err != nil {
		return nil, "", err
	}
	exists, err := s.userExists(email)
	if err != nil {
		return nil, "", err
	}
	if exists {
		return nil, "", badRequest("该邮箱已注册，请直接登录")
	}
	if err := s.otps.verify(0, PurposeRegister, email, code); err != nil {
		return nil, "", err
	}
	hashed, err := hash(password)
	if err != nil {
		return nil, "", err
	}

	ctx := db.SlowCtx()
	tx, err := s.pool.BeginTx(ctx, nil)
	if err != nil {
		return nil, "", fmt.Errorf("开事务: %w", err)
	}
	defer func() { _ = tx.Rollback() }()

	uid, err = newUserID(randUserID, func(id int64) error {
		_, e := tx.ExecContext(ctx,
			"INSERT INTO users (id, email, password_hash, created_at, token_version) VALUES (?, ?, ?, ?, 1)",
			id, email, hashed, time.Now().UnixMilli())
		return e
	})
	if err != nil {
		var me *mysql.MySQLError
		if errors.As(err, &me) && me.Number == 1062 {
			return nil, "", badRequest("该邮箱已注册，请直接登录")
		}
		return nil, "", fmt.Errorf("创建用户: %w", err)
	}
	ws, err = s.createWebSessionOn(tx, uid, meta)
	if err != nil {
		return nil, "", err
	}
	if err := tx.Commit(); err != nil {
		return nil, "", fmt.Errorf("提交注册: %w", err)
	}
	return ws, email, nil
}
