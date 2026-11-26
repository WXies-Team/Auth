package auth

import (
	"database/sql"
	"errors"
	"fmt"
	"regexp"
	"strings"
	"time"

	"github.com/WXies-Team/Auth/internal/db"
)

// AdminProjectPolicy 是 POST /admin/projects/{app}/policy 的入参。
type AdminProjectPolicy struct {
	MFARequired    bool     `json:"mfaRequired"`
	AllowedDomains []string `json:"allowedDomains"`
	SessionDays    int      `json:"sessionDays"`
}

var domainRe = regexp.MustCompile(`^[a-z0-9]([a-z0-9.-]{0,251}[a-z0-9])?\.[a-z]{2,63}$`)

func splitDomains(raw string) []string {
	if strings.TrimSpace(raw) == "" {
		return []string{}
	}
	parts := strings.Split(raw, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p = strings.TrimSpace(strings.ToLower(p)); p != "" {
			out = append(out, p)
		}
	}
	return out
}

func normalizeDomains(in []string) (string, error) {
	if len(in) > 20 {
		return "", badRequest("允许域名最多 20 个，请精简后重试")
	}
	seen := map[string]bool{}
	out := make([]string, 0, len(in))
	for _, raw := range in {
		d := strings.TrimSpace(strings.ToLower(raw))
		d = strings.TrimPrefix(d, "@")
		if d == "" || seen[d] {
			continue
		}
		if !domainRe.MatchString(d) {
			return "", badRequest("邮箱域名格式不正确：" + raw)
		}
		seen[d] = true
		out = append(out, d)
	}
	return strings.Join(out, ","), nil
}

// projectPolicy 读项目策略；无行 = 全默认（不限制）。
func (s *Service) projectPolicy(app string) (mfa bool, domains string, days int, err error) {
	var m int
	err = s.pool.QueryRowContext(db.QueryCtx(),
		"SELECT mfa_required, allowed_domains, session_days FROM project_policy WHERE app = ?", app).
		Scan(&m, &domains, &days)
	if errors.Is(err, sql.ErrNoRows) {
		return false, "", 0, nil
	}
	if err != nil {
		return false, "", 0, fmt.Errorf("查项目策略: %w", err)
	}
	return m == 1, domains, days, nil
}

// domainAllowed 允许精确域名及其子域（example.com 命中 a.example.com），
// 与 Keycloak 的 exact/wildcard 口径同向，但只提供一种更直观的写法。
func domainAllowed(email, raw string) bool {
	at := strings.LastIndex(email, "@")
	if at < 0 || at == len(email)-1 {
		return false
	}
	host := strings.ToLower(email[at+1:])
	for _, d := range splitDomains(raw) {
		if host == d || strings.HasSuffix(host, "."+d) {
			return true
		}
	}
	return false
}

// denyIfProjectPolicy 是项目级策略闸：先查策略，再判 MFA 与邮箱域。
// 只在 app 非空时生效；web 控制台不受单个项目策略约束。
func (s *Service) denyIfProjectPolicy(uid int64, app string) error {
	if app == "" {
		return nil
	}
	mfa, domains, _, err := s.projectPolicy(app)
	if err != nil {
		return &HTTPError{Code: 503, Message: "服务暂时不可用，请稍后重试"}
	}
	if mfa {
		has, err := s.HasMFA(uid)
		if err != nil {
			return &HTTPError{Code: 503, Message: "服务暂时不可用，请稍后重试"}
		}
		if !has {
			return policyDenied("该项目要求先绑定两步验证或 Passkey，请到「两步验证」页绑定后再试")
		}
	}
	if strings.TrimSpace(domains) != "" {
		var email string
		if err := s.pool.QueryRowContext(db.QueryCtx(),
			"SELECT email FROM users WHERE id = ?", uid).Scan(&email); err != nil {
			return &HTTPError{Code: 503, Message: "服务暂时不可用，请稍后重试"}
		}
		if !domainAllowed(email, domains) {
			return policyDenied("你的邮箱域名不在该项目允许范围内，请联系项目管理员")
		}
	}
	return nil
}

// sessionDaysForApp 回项目配置的绝对会话天数；0 = 走默认 90 天，超过 90 按 90 收口
// （JWT 的 exp 也是 90 天，会话不能比 token 活得更久）。
func (s *Service) sessionDaysForApp(app string) int {
	if app == "" || app == "web" {
		return 0
	}
	_, _, days, err := s.projectPolicy(app)
	if err != nil || days <= 0 {
		return 0
	}
	if days > 90 {
		return 90
	}
	return days
}

// AdminSetProjectPolicy 写项目级策略（super 或该项目 app-admin）。restricted
// 由独立端点维护，这里只动三列，避免两个开关互相覆盖。
func (s *Service) AdminSetProjectPolicy(actor Caller, scope AdminScope, app string, in AdminProjectPolicy) (err error) {
	defer func() {
		s.Audit(AuditEvent{
			Action: AuditProjectPolicy, OK: err == nil, ActorUID: uidPtr(actor.UID),
			ActorEmail: maskEmail(actor.Email), Meta: actor.Meta,
			Detail: withDenyReason(map[string]string{
				"app": app, "mfa": boolWord(in.MFARequired),
				"sessionDays": fmt.Sprint(in.SessionDays),
			}, err),
		})
	}()
	if !allowedApps[app] {
		return badRequest("未知项目，请重新选择后重试")
	}
	if err := adminTargetScope(scope, app); err != nil {
		return err
	}
	if in.SessionDays < 0 || in.SessionDays > 90 {
		return badRequest("会话天数只能是 0（默认 90 天）或 1–90，请重新填写")
	}
	domains, err := normalizeDomains(in.AllowedDomains)
	if err != nil {
		return err
	}
	mfa := 0
	if in.MFARequired {
		mfa = 1
	}
	if _, err = s.pool.ExecContext(db.QueryCtx(),
		`INSERT INTO project_policy (app, mfa_required, allowed_domains, session_days, updated_by, updated_at)
		 VALUES (?,?,?,?,?,?)
		 ON DUPLICATE KEY UPDATE mfa_required = VALUES(mfa_required),
		                         allowed_domains = VALUES(allowed_domains),
		                         session_days = VALUES(session_days),
		                         updated_by = VALUES(updated_by), updated_at = VALUES(updated_at)`,
		app, mfa, domains, in.SessionDays, actor.UID, time.Now().UnixMilli()); err != nil {
		return fmt.Errorf("写项目策略: %w", err)
	}
	return nil
}
