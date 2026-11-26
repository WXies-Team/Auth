// Package db 负责连接池与建表。
package db

import (
	"database/sql"
	"embed"
	"fmt"
	"log/slog"
	"os"
	"strings"
	"time"

	_ "github.com/go-sql-driver/mysql"
)

//go:embed schema.sql
var schemaFS embed.FS

// Open 建连接池并 ping 通。
//
// DSN 形如 `auth:<pass>@tcp(127.0.0.1:3306)/auth?charset=utf8mb4&parseTime=true&loc=Local`，
// 用户名与密码内嵌其中。时间戳列都是 BIGINT，parseTime/loc 只影响 DATETIME 类型的列
// （本库没有），保留是为了 DSN 示例与常见模板一致。
func Open(dsn string) (*sql.DB, error) {
	return openDSN(dsn)
}

// OpenWithRetry 在给定时长内反复尝试连接，**覆盖 MySQL 冷启动**。
//
// 起因（热量日记服务实踩的生产事故）：MySQL 重启花了约 9 秒，而 Go 启动时
// Ping 失败就退出——只试几次 supervisor 的 startretries 就耗尽、状态变 FATAL；
// 更糟的是 MySQL 恢复后进程已不在、**不会自己回来**，只能人工 start。
// 所以这里不立刻退出而是等到 deadline：进程一直存活，supervisor 判定启动成功，
// MySQL 一就绪就自动对外服务。
func OpenWithRetry(dsn string, wait time.Duration) (*sql.DB, error) {
	deadline := time.Now().Add(wait)
	var lastErr error
	for attempt := 1; ; attempt++ {
		pool, err := openDSN(dsn)
		if err == nil {
			if attempt > 1 {
				slog.Info("数据库已就绪", "attempts", attempt)
			}
			return pool, nil
		}
		lastErr = err
		remaining := time.Until(deadline)
		if remaining <= 0 {
			return nil, fmt.Errorf("等待 %s 后仍连不上数据库: %w", wait, lastErr)
		}
		// 2 秒一次：覆盖 MySQL 冷启（实测约 9 秒），也不会太密刷日志
		sleep := 2 * time.Second
		if sleep > remaining {
			sleep = remaining
		}
		slog.Warn("数据库未就绪，重试中", "attempt", attempt, "还有", remaining.Round(time.Second).String())
		time.Sleep(sleep)
	}
}

// FromEnv 从环境变量读连接串，**只认 MYSQL_DSN**。
// 缺失即报错退出：supervisord 拉不起来 → /health 失败，能立刻看出配置没跟上。
func FromEnv() (string, error) {
	dsn := strings.TrimSpace(os.Getenv("MYSQL_DSN"))
	if dsn == "" {
		return "", fmt.Errorf("缺少 MYSQL_DSN（环境变量），检查 supervisord 的 environment")
	}
	slog.Info("数据库连接串", "source", "MYSQL_DSN")
	return dsn, nil
}

func openDSN(dsn string) (*sql.DB, error) {
	pool, err := sql.Open("mysql", dsn)
	if err != nil {
		return nil, fmt.Errorf("打开连接池: %w", err)
	}
	// 连接池 8 → 24（P0，2026-11-17）：8 条时一条慢查询（行锁等待、OTP 发码的
	// GET_LOCK 持锁占连接）就能把池占满 → 全站 503，极端时 /health 的 ping 也拿
	// 不到连接、部署健康检查误触发自动回滚。24 取笔记建议的 16~32 中段：配合
	// ctx.go 的查询超时（普通 5s / 事务 30s），慢查询最多占住 24 条里的若干条
	// 且到点释放，/health 还有余量。空闲连接由 ConnMaxIdleTime 60s 收回，
	// 不会长期占着 MySQL 的 max_connections。
	pool.SetMaxOpenConns(24)
	pool.SetMaxIdleConns(24)
	pool.SetConnMaxLifetime(time.Hour)
	pool.SetConnMaxIdleTime(60 * time.Second)

	if err := pool.Ping(); err != nil {
		_ = pool.Close()
		return nil, fmt.Errorf("连接数据库: %w", err)
	}
	return pool, nil
}

// EnsureSchema 逐条执行 schema.sql（**只用 CREATE TABLE IF NOT EXISTS**，对已存在的表是 no-op）。
//
// 必须**逐条执行**：MySQL 驱动默认 multiStatements=false，整份文件丢给一次 Exec 会语法错。
// 也**不能**简单按 `;` 拆——将来若默认值里出现分号就会拆错，所以逐行拼到行尾分号为止，
// 并跳过 `--` 注释行。
func EnsureSchema(pool *sql.DB) error {
	raw, err := schemaFS.ReadFile("schema.sql")
	if err != nil {
		return fmt.Errorf("读 schema.sql: %w", err)
	}

	var stmts []string
	var cur []string
	for _, line := range strings.Split(string(raw), "\n") {
		trimmed := strings.TrimSpace(line)
		if len(cur) == 0 && (trimmed == "" || strings.HasPrefix(trimmed, "--")) {
			continue
		}
		cur = append(cur, line)
		if strings.HasSuffix(trimmed, ";") {
			stmts = append(stmts, strings.Join(cur, "\n"))
			cur = nil
		}
	}
	if rest := strings.Join(cur, "\n"); strings.TrimSpace(strings.TrimPrefix(rest, "--")) != "" {
		stmts = append(stmts, rest) // 末尾没写分号的兜底
	}

	for i, stmt := range stmts {
		// 启动期 DDL 豁免查询超时（见 ctx.go 的分类）：建表/补列本身可能慢，
		// 且启动阶段没有在途流量可被拖累——这里卡住只会让部署等出明确报错。
		if _, err := pool.Exec(stmt); err != nil {
			return fmt.Errorf("执行第 %d 条建表语句失败: %w\n语句: %s", i+1, err, truncate(stmt, 160))
		}
	}
	// 列变更单独走探测式补列：MySQL 的 ADD COLUMN 没有 IF NOT EXISTS，直接写进
	// schema.sql 会让第二次启动撞 Duplicate column 而拒启。探测用 information_schema
	//（读元数据，不加表锁），列已存在即整条 no-op。
	for _, c := range extraColumns {
		if err := ensureColumn(pool, c.table, c.column, c.ddl); err != nil {
			return err
		}
	}
	for _, idx := range extraIndexes {
		if err := ensureIndex(pool, idx.table, idx.index, idx.ddl); err != nil {
			return err
		}
	}
	slog.Info("schema ensured", "statements", len(stmts), "columns", len(extraColumns), "indexes", len(extraIndexes))
	return nil
}

// columnDef 是一条「老库补列」的 DDL。table/column 只为探测与报错定位，ddl 才是执行体。
type columnDef struct {
	table, column, ddl string
}

// SchemaVersion 是当前 schema 的版本标记（人工递增）：系统状态页显示它，
// 部署后一眼能看出「库结构是否跟上了这次发布」。只做展示，不做迁移判定——
// 真迁移仍是 EnsureSchema 的幂等补列/补索引。
const SchemaVersion = "2026-11-26-w12"

// extraColumns 是 schema.sql 之外的列变更（同一批新增，一次补齐）。
var extraColumns = []columnDef{
	{"users", "role",
		"ALTER TABLE users ADD COLUMN role VARCHAR(16) NOT NULL DEFAULT 'user'"},
	// UNIQUE 建在列上：web cookie 的 sha256 命中查询按唯一键走，且 DB 层兜住
	//「同一 token 落两行」的实现错误（生成端再随机也挡不住）。
	{"sessions", "web_token_hash",
		"ALTER TABLE sessions ADD COLUMN web_token_hash CHAR(64) NULL, ADD UNIQUE KEY uq_sessions_web_token (web_token_hash)"},
	{"sessions", "web_csrf_hash",
		"ALTER TABLE sessions ADD COLUMN web_csrf_hash CHAR(64) NULL"},
	{"sessions", "reauth_at",
		"ALTER TABLE sessions ADD COLUMN reauth_at BIGINT NULL"},
	// 两步登录中间态要记住第一步声明的目标应用（C 批）：第二步 /web/login/totp 读它
	// 决定发 web 会话还是业务 JWT。DEFAULT 'web' 让存量行与 web 流程共用一个取值。
	{"login_states", "app",
		"ALTER TABLE login_states ADD COLUMN app VARCHAR(32) NOT NULL DEFAULT 'web'"},
	// W3 注销七天宽限：0=正常，非0=注销申请时刻毫秒（到期由清扫 goroutine 执行）。
	{"users", "pending_delete_at",
		"ALTER TABLE users ADD COLUMN pending_delete_at BIGINT NOT NULL DEFAULT 0"},
	// W4 强制改密：管理员重置时按 forceChange 置 1，自助改密清 0；
	// 登录回执按它回填 mustChangePassword。
	{"users", "password_must_change",
		"ALTER TABLE users ADD COLUMN password_must_change TINYINT NOT NULL DEFAULT 0"},
	// W1 新设备登录提醒：默认开（1），GET/PUT /api/profile 的 loginNotify 读写；
	// 登录成功建会话后按它决定是否发提醒信（见 internal/auth 的 loginnotify）。
	{"users", "login_notify",
		"ALTER TABLE users ADD COLUMN login_notify TINYINT NOT NULL DEFAULT 1"},
	// 项目级策略（P1）：强制 MFA、允许邮箱域名、会话绝对天数。0/空 = 不额外限制。
	{"project_policy", "mfa_required",
		"ALTER TABLE project_policy ADD COLUMN mfa_required TINYINT NOT NULL DEFAULT 0"},
	{"project_policy", "allowed_domains",
		"ALTER TABLE project_policy ADD COLUMN allowed_domains VARCHAR(1024) NOT NULL DEFAULT ''"},
	{"project_policy", "session_days",
		"ALTER TABLE project_policy ADD COLUMN session_days INT NOT NULL DEFAULT 0"},
	// FX5：验证码行记发码时的账号归属。0=匿名发码（register/reset/login/login_2fa/
	// delete），非0=登录态发码（change/email_change）。验码按 uid 归属校验、
	// 管理员换邮按 uid 烧在途改邮码（防覆盖竞态）。索引跟列一起建（与
	// sessions.web_token_hash 同款「列+索引一条 DDL」）。
	{"otp_codes", "uid",
		"ALTER TABLE otp_codes ADD COLUMN uid BIGINT NOT NULL DEFAULT 0, ADD KEY idx_otp_uid (uid, purpose)"},
	// AI 用量记 token（2026-11-17 记账补层）：consume 由日记服务带上本次
	// prompt/completion token，两列与 count 同一条 UPSERT 累加（见 internal/ai 的
	// bumpCount）。历史行没有 token 数据，按 0 起算——看板口径只对新增行报 token。
	{"ai_usage", "prompt_tokens",
		"ALTER TABLE ai_usage ADD COLUMN prompt_tokens INT NOT NULL DEFAULT 0"},
	{"ai_usage", "completion_tokens",
		"ALTER TABLE ai_usage ADD COLUMN completion_tokens INT NOT NULL DEFAULT 0"},
	// ---- 会话子系统重写（2026-11）新增列。逐列一条 DDL：ensureColumn 按列探测，
	// 多列绑一条 DDL 时「第一列已存在」会让后面的列永远补不上。
	//
	// absolute_expires_at：会话绝对过期时刻（毫秒）。0 = 补列前的存量行，判定时按
	// created_at + 90 天兜底（sessionAbsoluteExpiry），不是永不过期。
	{"sessions", "absolute_expires_at",
		"ALTER TABLE sessions ADD COLUMN absolute_expires_at BIGINT NOT NULL DEFAULT 0"},
	// family_id：轮换家族的锚点（新建会话 = 自己的 id；轮换只换 token 不换 family）。
	// 0 = 存量行，按 id 视作自己的家族（sessionFamilyID）。
	{"sessions", "family_id",
		"ALTER TABLE sessions ADD COLUMN family_id BIGINT NOT NULL DEFAULT 0"},
	// rotated_at：本行 token 最后一次轮换时刻（毫秒）；0 = 从未轮换。
	{"sessions", "rotated_at",
		"ALTER TABLE sessions ADD COLUMN rotated_at BIGINT NOT NULL DEFAULT 0"},
	// prev_token_hash / prev_csrf_hash / prev_valid_until：轮换前的旧 token 与它的
	// 短暂宽限窗。旧 token 过期后再出现 = 重放信号（见 RotateWebSession）。
	{"sessions", "prev_token_hash",
		"ALTER TABLE sessions ADD COLUMN prev_token_hash CHAR(64) NULL, ADD UNIQUE KEY uq_sessions_prev_token (prev_token_hash)"},
	{"sessions", "prev_csrf_hash",
		"ALTER TABLE sessions ADD COLUMN prev_csrf_hash CHAR(64) NULL"},
	{"sessions", "prev_valid_until",
		"ALTER TABLE sessions ADD COLUMN prev_valid_until BIGINT NOT NULL DEFAULT 0"},
	// impersonator_uid：管理员模拟会话的发起人（0 = 正常会话）。回滚：
	//   ALTER TABLE sessions DROP COLUMN impersonator_uid;
	{"sessions", "impersonator_uid",
		"ALTER TABLE sessions ADD COLUMN impersonator_uid BIGINT NOT NULL DEFAULT 0"},
	// 回滚（按依赖倒序；生产回滚前先停进程，避免新旧二进制对缺列各自解释）：
	//   ALTER TABLE sessions DROP INDEX uq_sessions_prev_token;
	//   ALTER TABLE sessions DROP COLUMN prev_valid_until, DROP COLUMN prev_csrf_hash,
	//     DROP COLUMN prev_token_hash, DROP COLUMN rotated_at, DROP COLUMN family_id,
	//     DROP COLUMN absolute_expires_at;
	// 回滚不删数据（会话行本就是短生命周期数据）；旧二进制不读新列，行为回到
	// 「created_at/last_seen_at 推算超时」的既有口径。
}

// indexDef 是一条「老库补索引」的 DDL。table/index 只用于探测与报错定位。
type indexDef struct {
	table, index, ddl string
}

// extraIndexes 只补 schema.sql 已定义但存量库可能漂移的索引。
// ALGORITHM=INPLACE + LOCK=NONE 让建索引期间并发 DML 继续跑（MariaDB/MySQL
// 的 online DDL；初始化与提交阶段仍有短暂排他 MDL，长事务会让它等待）。
var extraIndexes = []indexDef{
	// 绝对到期扫描走这个索引；补列只加列不加索引，老库会缺它。
	{"sessions", "idx_sessions_abs",
		"ALTER TABLE sessions ADD INDEX idx_sessions_abs (absolute_expires_at), ALGORITHM=INPLACE, LOCK=NONE"},
	// 已授权应用按 uid 列（SPA 的 connections 页）；新表在 schema.sql 已带，
	// 老库这条幂等补齐。回滚：ALTER TABLE oauth_consents DROP INDEX idx_oauth_consents_uid;
	{"oauth_consents", "idx_oauth_consents_uid",
		"ALTER TABLE oauth_consents ADD INDEX idx_oauth_consents_uid (uid, last_used_at), ALGORITHM=INPLACE, LOCK=NONE"},
}

// ensureIndex 幂等地补一个索引：先查 information_schema.statistics，没有才执行 DDL。
// 并发启动时两个实例可能同时探测到缺失，后到者撞 1061 Duplicate key name；
// 重新探测确认已存在就按成功处理，不吞掉其它 DDL 错误。
func ensureIndex(pool *sql.DB, table, index, ddl string) error {
	var found int
	probe := "SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = ? AND index_name = ?"
	if err := pool.QueryRow(probe, table, index).Scan(&found); err != nil {
		return fmt.Errorf("探测 %s.%s 索引: %w", table, index, err)
	}
	if found > 0 {
		return nil
	}
	if _, err := pool.Exec(ddl); err != nil {
		var n int
		if perr := pool.QueryRow(probe, table, index).Scan(&n); perr == nil && n > 0 {
			return nil
		}
		return fmt.Errorf("补 %s.%s 索引: %w", table, index, err)
	}
	slog.Info("补索引完成", "table", table, "index", index)
	return nil
}

// ensureColumn 幂等地补一列：先查 information_schema，没有才执行 DDL。
// 启动期探测，与 EnsureSchema 同属豁免类（无 ctx 超时，见上面的说明）。
func ensureColumn(pool *sql.DB, table, column, ddl string) error {
	var found int
	err := pool.QueryRow(
		"SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?",
		table, column).Scan(&found)
	if err != nil {
		return fmt.Errorf("探测 %s.%s 列: %w", table, column, err)
	}
	if found > 0 {
		return nil
	}
	if _, err := pool.Exec(ddl); err != nil {
		// 并发启动（或两个测试进程共用测试库）时两个实例可能同时探测到「列不存在」
		// 再同时 ALTER：后到者拿 1060 Duplicate column。补列是幂等意图，重新探测
		// 一次——列已存在就按成功处理；否则才是真错误（不是把所有 DDL 错误吞掉）。
		var n int
		if perr := pool.QueryRow(
			"SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?",
			table, column).Scan(&n); perr == nil && n > 0 {
			return nil
		}
		return fmt.Errorf("补 %s.%s 列: %w", table, column, err)
	}
	slog.Info("补列完成", "table", table, "column", column)
	return nil
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}
