# Horatio 统一账号服务

`auth.horatio.cn` 后端：Go + MySQL 的邮箱账号服务，为热量日记、记账等应用提供
注册 / 登录（密码与邮箱验证码）/ 找回密码 / 修改密码 / 修改邮箱 / 注销与 JWT
会话签发。与两个日记服务自带的 `/auth/*` 端点**一一对应、JSON 字段完全一致**，
客户端切换只需改 base URL 并在登录请求加 `app` 字段。

## 端点

| 端点 | 说明 |
|---|---|
| `POST /auth/register` | 注册（验证码必填，注册即登录） |
| `POST /auth/send-code` | 发注册 / 找回密码 / 登录 / 登录两步验证验证码（purpose 白名单四值，可选 `app` 决定邮件品牌，缺省 = Auth） |
| `POST /auth/reset-password` | 验证码找回密码 |
| `POST /auth/login` | 密码登录 |
| `POST /auth/login-code` | 邮箱验证码登录 |
| `POST /auth/logout` | 登出（token_version+1，吊销全部会话） |
| `POST /auth/change-password` | 原密码改密 |
| `POST /auth/send-change-code` | 绑定邮箱发改密验证码 |
| `POST /auth/change-password-code` | 验证码改密 |
| `POST /auth/send-change-email-code` | 新邮箱发改绑验证码 |
| `POST /auth/change-email` | 改绑邮箱 |
| `POST /auth/delete` | 注销账号：先逐个调日记服务的注销钩子清业务数据，全成功才删本服务数据（钩子失败回 503 中止） |
| `GET /api/sessions` | 自己的已登录设备列表（按最近活跃倒序，`current` 标本机） |
| `DELETE /api/sessions/{id}` | 踢单台设备（只能踢自己的，别人的与不存在同回 404，幂等） |
| `POST /api/sessions/revoke-others` | 退出除本机外的全部设备（只动会话层，本机 token 照用） |
| `GET /api/profile` | 档案三件套（昵称/头像色/头像图），无行回默认值 `{nickname:"",avatarColor:0,avatarImage:null,updatedAt:0}` |
| `PUT /api/profile` | 全量替换三字段（服务端置 `updatedAt` 为毫秒）：昵称 trim 后 ≤64 字、头像为标准 base64 且解码后 ≤700KB（超限 413） |
| `POST /internal/verify` | 内部接口：日记服务的 withUID 中间件验 token + aud，回 `{uid,email,app}` |
| `POST /internal/users/ensure` | 内部接口：存量用户批量并入（`Bearer hook_token`，单批 ≤100 条，整批一个事务） |
| `GET /health` | 健康检查（碰数据库）；`mailConfigured` / `jwtConfigured` 自查位 |

### Web 管理台

页面壳（未登录访问控制台会 302 到登录页，后台页对非管理员 302 回概览）：

| 页面 | 说明 |
|---|---|
| `/web/login` | 密码 / 邮箱验证码 / 找回密码三个入口 + Passkey 登录（不支持则隐藏） |
| `/web/console` | 概览：安全评分、最近登录、三种登录方式状态 |
| `/web/console/sessions` | 已登录设备：踢单台、退出其它设备 |
| `/web/console/passkeys` | Passkey 列表：添加 / 改名 / 删除（保住「至少一种登录方式」） |
| `/web/console/security` | 两步验证：开启（二维码 + 手输）、恢复码余量、关闭 |
| `/web/console/account` | 资料、改密码（原密码 / 验证码两路）、改邮箱、登录提醒、数据导出、注销 |
| `/web/console/connections` | 已授权应用：查看 scope、撤销授权（同时吊销该应用会话） |
| `/web/console/activity` | 自己的安全活动时间线（登录、改密、凭证变更） |
| `/web/admin/*` | 管理后台：用户、项目访问、会话总览、审计、配置、AI 用量、系统状态 |

UI 源码在 `web/`（React 19 + Vite + Tailwind v4 + shadcn 风格组件），构建产物在
`internal/ui/dist/` 并由 `go:embed` 打进二进制；Go 只回 index.html 与静态资产。

Web 端点（**全部新增路径，老端点形状不变**；写操作需 `X-CSRF-Token`）：

| 端点 | 说明 |
|---|---|
| `POST /web/login/password` | 密码登录；已开两步验证时回 `{status:"2fa_required",loginToken,methods}` |
| `POST /web/login/email-code` | 邮箱验证码登录（不叠两步验证） |
| `POST /web/login/totp` | 两步验证第二步：`{loginToken}` + TOTP 码 / 恢复码 / 邮箱验证码（`emailCode`，可选）→ `{token,email}` |
| `POST /web/session` | 当前身份：`{uid,email,role,csrfToken,totpEnabled,passkeyCount,passwordSet,isRoot}`（`isRoot` 与后端 `RootUID` 同源，UI 不再硬编码 uid） |
| `POST /web/session/refresh` | 轮换本会话 token（cookie 会话；旧 token 保留 60 秒宽限窗，窗外出现即判重放并吊销整个轮换家族） |
| `POST /web/reauth` | 重新验证（密码 / TOTP 码 / 恢复码），刷 2 小时强认证窗（敏感操作成功即滑动续期） |
| `POST /web/logout` | 登出本行会话，回 `Clear-Site-Data` 并清 cookie |
| `POST /webauthn/register/options`、`/finish` | Passkey 注册仪式（finish 需 2 小时内强认证） |
| `POST /webauthn/login/options`、`/finish` | discoverable Passkey 登录，回执与 `AuthResponse` 同形 |
| `GET /api/passkeys`、`PATCH`/`DELETE /api/passkeys/{id}` | Passkey 列表 / 改名 / 删除 |
| `GET /api/totp` | 两步验证状态 `{enabled,createdAt}` |
| `POST /api/totp/setup`、`/enable`、`/disable`、`/regenerate-recovery-codes` | 先验后启的绑定流程与恢复码管理 |
| `GET /admin/users`、`GET/PATCH /admin/users/{uid}`、`POST /admin/users/{uid}/revoke-sessions` | 后台用户查询（可选 `role=` / `banned=` 过滤）、角色变更、整户踢出会话 |
| `GET /admin/sessions`、`DELETE /admin/sessions/{id}` | 全站会话总览（含 `apps` / `regions` 汇总）与吊销 |
| `GET /admin/audit` | 审计查询（action / actor / target / 时间区间，倒序分页） |
| `GET /admin/projects` | 项目列表：`members`（登录放行名单）+ `admins`（该项目管理员，来自 `admin_scopes`） |
| `GET /admin/projects/{app}/candidates?query=&limit=&offset=` | 项目成员选择器：按项目鉴权分页列出/筛选已注册用户（uid/email/role，`total` + 每页最多 200），不暴露全站目录 |
| `GET /admin/config`、`PUT /admin/config/{key}` | 配置中心：白名单键，secret 只回末 4 位 |
| `GET /admin/ai-usage?days=30` | AI 用量与四档限额（空表如实为空） |
| `GET /api/connected-apps`、`DELETE /api/connected-apps/{app}` | 已授权应用与撤销（撤销同时吊销该应用会话） |
| `GET /api/security-log?limit=&offset=` | 自己的安全活动（actor 或 target 命中本 uid） |
| `POST /api/account/export` | 导出账号数据（JSON；需 2 小时内强认证） |
| `POST /admin/users/{uid}/mfa-reset` | 管理员重置 TOTP + Passkey 并吊销会话（super） |
| `GET /admin/status` | 系统状态：版本、运行时长、DB 延迟、邮件/WebAuthn 自检、计数 |
| `GET /web/invite/info?token=`、`POST /web/invite` | SPA 邀请信息 / 接受邀请（JSON，旧表单 POST 仍兼容） |
| `GET /web/setup-password/info?token=`、`POST /web/setup-password` | SPA 一次性设密信息 / 提交（JSON，旧表单 POST 仍兼容） |
| `GET /oauth/authorize?format=json` | 授权确认页数据（tx / 应用名 / 回跳域 / scope） |

登录态是 `__Host-auth_web` cookie（HttpOnly + Secure + SameSite=Lax，库里只存 sha256），
配套一枚可读的 CSRF cookie——**所有非 GET 的 cookie 请求必须带 `X-CSRF-Token`**；
`/admin/*` 只收 cookie、逐请求现查角色、要求已绑 MFA 且 2 小时内强认证过。
Bearer（日记 App）照旧走 `/auth/*`，三条凭据路互不串用。

登录 / 注册 / 验证码登录的请求体带 `app`（`CalorieDiary` / `ExpenseDiary` 白名单），
作为 JWT 的 aud——下游服务只接受为自己应用签发的 token。`send-code` 的 `app` 可选、
只决定这封验证码邮件的品牌（不进 token）：不传即中性品牌 Auth，传了必须在白名单。

三条登录路与改密换发都会建一条登录会话，token 的 `sid` 指向它；`/internal/verify` 与
`/auth/*` 都要求会话健在（被踢的设备当场 401）。**无 `sid` 的旧 token 已全部作废**，
切换到会话表后客户端需重新登录一次。

`/internal/*` 只放行环回与受信内网来源（其余 403），不经 nginx 暴露。

## 本地命令

```bash
cd web && npm ci && npm run build   # 构建前端到 internal/ui/dist
go build ./...                      # 编译（需要先有 internal/ui/dist/index.html）
go test ./...                       # 测试（DB 相关用例需要 TEST_MYSQL_DSN，缺省自动 Skip）
cd web && npm test                  # 前端单测
cd web && npm run e2e               # Playwright + axe（mock API）
go vet ./...          # 静态检查
ci/build-server.sh    # 测试 + 打包 dist/server.tar（CI 部署用的同一入口）
```

## 配置

| 来源 | 键 | 说明 |
|---|---|---|
| 环境变量 | `BIND_ADDR` | 监听地址，默认 `127.0.0.1:8868`（对外走 nginx TLS 反代） |
| 环境变量 | `MYSQL_DSN` | MySQL 连接串，密码绝不入库（模板见 `.env.example`） |
| 环境变量 | `JWT_SECRET` | HS256 密钥，**少于 32 字节拒启** |
| 环境变量 | `TOTP_ENC_KEY` | TOTP secret 的 AES-256-GCM 密钥，**少于 32 字节拒启**；丢失 = 已绑用户的两步验证全部作废（只剩恢复码），要单独备份 |
| `app_config` 表 | `mail_smtp_host` / `mail_smtp_port` / `mail_smtp_user` / `mail_smtp_pass` | 阿里企业邮箱 SMTP 发信凭据（**唯一发信路径**，四键齐才可发信；`host=smtp.qiye.aliyun.com`、`port=465`（SSL）、账户名与发件人 = 完整地址 `support@horatio.cn`、密码填三方客户端安全密码），部署时人工灌，改库 10 秒内热生效 |
| `app_config` 表 | `hook_token` | 注销钩子与 `/internal/users/ensure` 共用的 Bearer，与日记侧共享；没配则并入端点一律 401 |
| `app_config` 表 | `hook_calorie_diary` / `hook_expense_diary` | 各 App 的 `/internal/delete-user` 地址；**键缺失 = 注销时跳过该 App**（只在测试/开发态成立），改库 10 秒内热生效 |
| `app_config` 表 | `webauthn_opaque_origins`（可选） | 逗号分隔的 `android:apk-key-hash:<签名证书指纹>`；**两个 App 各至少一条**（debug/release 可并行，最多 8 条）。精确串匹配，写错只让对应 App 的原生仪式被拒；格式非法时整批降级为「仅网页端」并记启动日志，不拒启 |
| `app_config` 表 | `totp_enforce_apps`（可选） | 逗号分隔的 App 名单，**默认空 = 零影响**；名单内的 App 在用户开了两步验证后走 `/auth/login` 会回 401「请升级应用后使用新版登录」——老客户端唯一的行为开关，翻它是作者的显式动作 |
| `app_config` 表 | `ai_rate_per_minute` / `ai_concurrency` / `ai_daily_per_user` / `ai_daily_global` | AI 限额看板读这四键（缺省 20 / 8 / 500 / 5000，与日记侧 quota.go 同名同义） |

**管理员自举与根管理员**：`users.role` 默认 `user`，首个管理员部署时手工执行一次
`UPDATE users SET role = 'admin' WHERE email = '<你的邮箱>';`（也进审计的正常路径）。
后台要求该账号先绑两步验证或 Passkey，之后每次管理操作都要 2 小时内强认证过
（管理操作成功即重置这 2 小时计时器）。

**根平台管理员按 uid 钉死**：`internal/auth.RootUID = 5939716`（当前对应
`hs@horatio.cn`；邮箱常量 `RootSuperEmail` 只在库里还没有该 uid 行时兜底解析）。
只有根管理员能任命/回收 `super`（平台管理员）；**所有** `super` 都能任命/回收项目
管理员（`admin_scopes`）；app-admin 无任何授予权；任何人不能改自己的角色、不能授予
不低于自己的角色。`/web/session` 的 `isRoot` 是这套判定的唯一对外出口。

**会话寿命**：所有会话有服务端强制的 90 天绝对到期（`expiresAt`）；web 会话另有
7 天空闲闸（`idleExpiresAt`）。改密/找回密码/封禁/踢人当场吊销对应会话；旧 token
在 `/web/session/refresh` 轮换后只保留 60 秒宽限窗，窗外重用会吊销整个家族。

## 部署

GitHub Actions（self-hosted runner）→ `ci/deploy-server.sh`：上传 tar、原子切换
`current` symlink、supervisord 重启 `auth:*`、`/health` 检查失败自动回滚。
部署去向 `/www/wwwroot/auth.horatio.cn/server`（Actions secret `SERVER_BASE_DIR`），
进程监听 `127.0.0.1:8868`，由同机 nginx 对外提供 `https://auth.horatio.cn`。
