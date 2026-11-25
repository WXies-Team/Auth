package auth

import (
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/WXies-Team/Auth/internal/db"
)

// W2 分级授权的口径（作者定稿 + 业界 scoped-RBAC 精简版）：
//
//	super    平台管理员：管所有 app/网页——角色授予、全局配置中心、注销用户、跨 app 全部数据；
//	app-admin 按 app 授权：只管**该 app 范围内**的数据（会话踢出 / AI 用量 / 相关审计），
//	           不能碰用户目录、角色、注销、全局配置、跨 app 数据。
//
//	有效 app-admin = role='admin' 且持有 ≥1 条 admin_scopes 行（无行 = 无权限，
//	页面只见空态说明）；role='super' 绕过 scope 全量通行。一人管多个项目 = 多行叠加。
//	授予规则按业界「只能授予低于自己」：app-admin 的授予/回收任一 super 都可做
//	（POST /admin/roles/{uid}/scope），super 角色本身的授予/回收只认根 su
//	（见 admin.go 的 RootSuperEmail / AdminSetRole）；app-admin 无任何授予权
//	（新端点全部 super-only，路由层把闸）。
//	scope 解析每请求查库（每请求两行成本可接受，与「撤销当场生效」同款理由，
//	不做进程缓存——token_version 从不缓存的同一条规矩）。
const (
	// adminRoleSuper 是平台管理员（users.role 的第三个值；VARCHAR(16) 值域演进，
	// 无 DDL——列宽与类型不变，纯值域扩展）。
	adminRoleSuper = "super"
)

// IsAdminRole 判定「进得了管理后台」：admin 与 super 都算。
// 与 internal/ui 的 IsAdminRole 同口径（模板层放行的按钮，数据层一定挡得住），
// 两处值域由 TestIsAdminRole / ui 的 TestTopbarAccountAndAdminEntry 分别钉住。
func IsAdminRole(role string) bool { return role == adminRoleAdmin || role == adminRoleSuper }

// IsSuperRole 判定平台管理员（绕过 scope、可授予角色）。
func IsSuperRole(role string) bool { return role == adminRoleSuper }

// roleRank 是角色的能力等级（user < admin < super）：授权判定的唯一排序来源。
// 「只能授予低于/等于自己的角色」由它表达——super 能授 admin/user、admin 只能
// 收自己的项目 scope、user 什么都不能授；root 是 super 中的一个**身份**而非更高
// 的 role 值（root 的额外能力 = 授/收 super，见 AdminSetRole）。
func roleRank(role string) int {
	switch role {
	case adminRoleSuper:
		return 2
	case adminRoleAdmin:
		return 1
	default:
		return 0
	}
}

// roleAssignAllowed 是「谁能把谁改成什么角色」的**纯函数**（可无库测试，能力矩阵
// 逐格钉在 capability_test.go）：
//
//	user            → 谁都不能改（路由 requireSuper + 这里双重拒绝）
//	admin(app-admin) → 谁都不能改（项目管理员只管项目数据，不碰平台角色）
//	super(非根)     → 只能改 user / admin；碰 super（授予或回收）一律拒
//	root(super + uid) → user / admin / super 全可改
//
// 「不能授予高于自己」由 roleRank 表达；root 是**同一 role 上的额外身份**，不是
// 第四个 role 值。target==actor 的自指变更由 AdminSetRole 在更前面拒绝。
func roleAssignAllowed(actorRole string, actorIsRoot bool, currentRole, newRole string) error {
	if !IsSuperRole(actorRole) {
		return permissionDenied("只有平台管理员可以调整角色，请联系平台管理员操作")
	}
	// 涉 super 的调整（升到 super 或从 super 降下）只认根管理员。
	if newRole == adminRoleSuper || IsSuperRole(currentRole) {
		if !actorIsRoot {
			return permissionDenied("只有根管理员可以授予或取消 super 角色")
		}
	}
	// 非根管理员只能授予严格低于自己的角色（super 授 admin/user 合法；
	// admin 已在上面的 IsSuperRole 分支被拒，这里再兜一层防未来角色值扩展）。
	if !actorIsRoot && roleRank(newRole) >= roleRank(actorRole) {
		return permissionDenied("不能授予不低于自己的角色，请联系根管理员操作")
	}
	return nil
}

// scopeGrantAllowed 是「谁能授予/回收项目管理员」的纯函数：
// 任一平台管理员（super，含 root）都可以；app-admin 与普通用户都不行。
// 目标是 super 时由 AdminSetScope 先拒绝（super 已覆盖全部项目，授 scope 无意义）。
func scopeGrantAllowed(actorRole string) error {
	if !IsSuperRole(actorRole) {
		return permissionDenied("只有平台管理员可以授予或回收项目权限，请联系平台管理员开通")
	}
	return nil
}

// AdminScopes 查一个 uid 的 app 授权清单（app-admin 的数据过滤范围）。
// super 的调用方不该走到这里（路由层已按 role 分流）；查错上报、查无回空切片。
func (s *Service) AdminScopes(uid int64) ([]string, error) {
	rows, err := s.pool.QueryContext(db.QueryCtx(),
		"SELECT app FROM admin_scopes WHERE uid = ? ORDER BY app", uid)
	if err != nil {
		return nil, fmt.Errorf("查应用授权: %w", err)
	}
	defer func() { _ = rows.Close() }()
	out := make([]string, 0, 2)
	for rows.Next() {
		var app string
		if err := rows.Scan(&app); err != nil {
			return nil, fmt.Errorf("读授权行: %w", err)
		}
		out = append(out, app)
	}
	if err := rows.Err(); err != nil {
		return nil, fmt.Errorf("遍历授权行: %w", err)
	}
	return out, nil
}

// AdminSetScope 授予（grant）或回收（revoke）一个 app-admin 的应用授权。
//
// 授予隐含把 role 提为 admin（scope 行是有效性的来源，role 是门槛——两者都要在位）；
// 回收到 0 行时把 role 降回 user：**定案是降**——role='admin' 零 scope 是无权限的
// 空壳，留着只会让角色目录里长期挂着「admin 但什么都不管」的误导态，降回 user
// 让角色与实际权限一致（重新授予时再自动提回来，无信息损失）。
// 目标是 super 时拒（super 绕过 scope 全量通行，授予无意义只会造出误导性摘要）。
func (s *Service) AdminSetScope(actor Caller, targetUID int64, app string, grant bool) (err error) {
	action := AuditRoleRevoke
	if grant {
		action = AuditRoleGrant
	}
	defer func() {
		s.Audit(AuditEvent{
			Action: action, OK: err == nil, ActorUID: uidPtr(actor.UID),
			ActorEmail: maskEmail(actor.Email), TargetUID: uidPtr(targetUID), Meta: actor.Meta,
			Detail: withDenyReason(map[string]string{"app": app}, err),
		})
	}()
	if !allowedApps[app] {
		return badRequest("未知项目，请重新选择后重试")
	}
	// 业务层二次收口（路由 requireSuper 之外）：授予/回收项目权限**只属于平台
	// 管理员**，且不能给自己授（自指提升一律拒，避免「自己给自己开项目」绕过
	// 另一位管理员）。角色每请求现查，撤销资格当场生效。
	var actorRole string
	if err := s.pool.QueryRowContext(db.QueryCtx(),
		"SELECT role FROM users WHERE id = ?", actor.UID).Scan(&actorRole); err != nil {
		if errors.Is(err, sql.ErrNoRows) {
			return unauthorized("登录已过期，请重新登录")
		}
		return fmt.Errorf("查操作者角色: %w", err)
	}
	if err := scopeGrantAllowed(actorRole); err != nil {
		return err
	}
	var role string
	scanErr := s.pool.QueryRowContext(db.QueryCtx(),
		"SELECT role FROM users WHERE id = ?", targetUID).Scan(&role)
	if errors.Is(scanErr, sql.ErrNoRows) {
		return &HTTPError{Code: 404, Message: "该用户不存在，请刷新用户列表后重试"}
	}
	if scanErr != nil {
		return fmt.Errorf("查目标用户: %w", scanErr)
	}
	if IsSuperRole(role) {
		return badRequest("平台管理员的权限覆盖全部项目，无需按项目授权")
	}
	if targetUID == actor.UID {
		return badRequest("不能给自己授予项目权限，请让另一位平台管理员操作")
	}

	tx, err := s.pool.BeginTx(db.SlowCtx(), nil)
	if err != nil {
		return fmt.Errorf("开事务: %w", err)
	}
	defer func() { _ = tx.Rollback() }()
	if grant {
		if _, err := tx.ExecContext(db.QueryCtx(),
			"INSERT IGNORE INTO admin_scopes (uid, app, granted_by, granted_at) VALUES (?,?,?,?)",
			targetUID, app, actor.UID, time.Now().UnixMilli()); err != nil {
			return fmt.Errorf("授予应用: %w", err)
		}
		if role == adminRoleUser {
			if _, err := tx.ExecContext(db.QueryCtx(),
				"UPDATE users SET role = ? WHERE id = ?", adminRoleAdmin, targetUID); err != nil {
				return fmt.Errorf("提升为管理员: %w", err)
			}
		}
	} else {
		if _, err := tx.ExecContext(db.QueryCtx(),
			"DELETE FROM admin_scopes WHERE uid = ? AND app = ?", targetUID, app); err != nil {
			return fmt.Errorf("回收应用: %w", err)
		}
		var rest int
		if err := tx.QueryRowContext(db.QueryCtx(),
			"SELECT COUNT(*) FROM admin_scopes WHERE uid = ?", targetUID).Scan(&rest); err != nil {
			return fmt.Errorf("数剩余授权: %w", err)
		}
		if rest == 0 && role == adminRoleAdmin {
			if _, err := tx.ExecContext(db.QueryCtx(),
				"UPDATE users SET role = ? WHERE id = ?", adminRoleUser, targetUID); err != nil {
				return fmt.Errorf("降回普通用户: %w", err)
			}
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("提交授权变更: %w", err)
	}
	return nil
}

// placeholders 生成 n 个 SQL 占位符（"?,?,?"）。调用方保证 n > 0（循环拼 IN 条件
// 的位置都是 len(apps) > 0 的分支）。
func placeholders(n int) string {
	return strings.TrimSuffix(strings.Repeat("?,", n), ",")
}

// containsStr 是 []string 的线性查找（清单个位数，建 map 纯属浪费）。
func containsStr(list []string, v string) bool {
	for _, s := range list {
		if s == v {
			return true
		}
	}
	return false
}
