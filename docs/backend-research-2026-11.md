# 后端权限 / 会话 / Passkey / IP 定位 研究记录（2026-11）

> 范围：`internal/auth`、`cmd/server`、`internal/geoip`、`internal/db` 的 2026-11
> 增量改造。每条结论都附可访问出处；代码里对应注释也落了一部分 URL，方便在
> review 时就地核对。

## 1. 根管理员标识：钉 uid，不钉邮箱/凭据

- 结论：根身份用**代码常量 uid 5939716**（`internal/auth.RootUID`）作权威锚点；
  `hs@horatio.cn` 只作「库里还没有该 uid 行」时的兜底解析，且兜底行必须
  `role=super`，否则 fail closed（防止「注册兜底邮箱」变成提权路径）。
- 出处：
  - Google Cloud《Super administrator account best practices》：破窗账号应唯一、
    受 MFA 保护、与日常账号分离。
    https://cloud.google.com/resource-manager/docs/super-admin-best-practices
  - CWE-798 禁止的是**硬编码凭据**（口令/密钥），不是主体 id：
    https://cwe.mitre.org/data/definitions/798.html
  - Google Workspace 管理员安全最佳实践（每个管理员独立账号、审计可归因）：
    https://knowledge.workspace.google.com/admin/users/security-best-practices-for-administrator-accounts
- 落地：`RootUID` 保留号（`randUserID` / `newUserID` 永不发出）、启动解析缓存
  `rootUID`、`/web/session.isRoot` 与后端同源、根才能授/收 `super`、任一 `super`
  都能授/收项目管理员（`admin_scopes`）。

## 2. 会话子系统：JWT + 服务端会话行的混合态

- 结论：保留 JWT 无状态验签 + `sessions` 行即时吊销的混合模式；补服务端强制的
  **绝对 90 天**与 web **空闲 7 天**超时，新增 web token 轮换 + 重用检测。
- 出处：
  - OWASP Session Management Cheat Sheet（idle / absolute / renewal timeout；
    logout 必须服务端失效；旧 ID 保留安全间隔）：
    https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html
  - OWASP ASVS 5.0 V7.2.4 / V7.3.1 / V7.3.2 / V7.4.1 / V7.4.5：
    https://github.com/OWASP/ASVS/blob/master/5.0/en/0x16-V7-Session-Management.md
  - Auth0 Refresh Token Rotation + Automatic Reuse Detection（旧 token 重用即吊销
    整个 token family）：
    https://auth0.com/docs/secure/tokens/refresh-token-rotation
- 落地：`absolute_expires_at` / `family_id` / `prev_token_hash` / `prev_csrf_hash` /
  `prev_valid_until`；`POST /web/session/refresh` 轮换；30 秒宽限窗；窗外旧 token
  出现 → 吊销 family + 审计（`session.kick` + `detail.reason=token_reuse`）；
  并发会话数保持不限（既有产品行为；改上限属 Ask-first 的会话策略变更）。
- 审计修正（2026-11 提交前）：轮换用**出示 token 的 hash** 做条件 UPDATE 的期望值
  （`RotateWebSession(sid, expectedHash)`）。原实现先 `SELECT ... FOR UPDATE` 再拿
  读到的 hash 当条件，并发时两个请求会先后成功、同一会话被发两枚新 token，客户端
  存错一枚就在宽限窗过后被判重放、整会话误吊销；顺带把「宽限窗里的旧 token 换一枚
  新的 90 天 token」这条洗白通道堵掉。
- 宽限窗取 30s（2026-11 提交前联网核对）：Okta 的 refresh rotation grace 默认
  30s、可调 0–60s；Auth0 的 Rotation Overlap Period 内不触发 reuse detection；
  Ory 更直接把 graceful rotation 称为 workaround——宽限期内同一 refresh token
  可以重复兑换，reuse detection 实质失效。30s 只保留并发请求与网络重试的容错，
  把「重放检测不可用」的窗口压到最小；再长（60s）只是放大重放窗口。
  出处：
  https://developer.okta.com/docs/guides/refresh-tokens/main
  https://auth0.com/docs/secure/tokens/refresh-tokens/configure-refresh-token-rotation
  https://www.ory.com/docs/hydra/guides/graceful-token-refresh
- 索引漂移：新库由 `schema.sql` 自带 `idx_sessions_abs`，老库只补了列没有索引；
  `EnsureSchema` 现在按 `extraIndexes` 幂等补它（`ALGORITHM=INPLACE, LOCK=NONE`），
  探测走 `information_schema.statistics`，并发撞 Duplicate key name 视为成功。
  online DDL 允许并发 DML，但初始化/提交阶段仍要短暂排他 MDL——长事务会让 DDL
  等待，并让后续查询排队，部署窗口仍需确认没有长事务。回滚 SQL 见 `extraIndexes`
  注释（先 DROP INDEX，再按依赖倒序 DROP 列）。
  出处：
  https://mariadb.com/docs/server/reference/sql-statements/data-definition/alter/alter-table
  https://mariadb.com/docs/server/server-usage/storage-engines/innodb/innodb-online-ddl/innodb-online-ddl-operations-with-the-nocopy-alter-algorithm
  https://dev.mysql.com/doc/refman/8.4/en/innodb-online-ddl-operations.html
  https://dev.mysql.com/doc/refman/26.7/en/innodb-online-ddl-limitations.html
- 迁移/回滚：`internal/db/db.go` 的 `extraColumns` 注释里有逐列回滚 SQL；应用层
  对 `absolute_expires_at=0` 的存量行按 `created_at+90d` 兜底，不出现永不过期。

## 3. Passkey：单次 challenge、精确 origin、错误分级

- 结论：challenge 300 秒硬上限、客户端 180 秒新鲜度（跨端约束写进常量注释）；
  取走即删；origin 精确 allowlist；计数器只告警不硬拒；注册 finish 不读已有凭证。
- 出处：
  - OWASP Passkey Security Cheat Sheet（challenge ≥16B、单次、短期、绑定上下文；
    origin 精确匹配；计数器只当风险信号）：
    https://cheatsheetseries.owasp.org/cheatsheets/Passkey_Security_Cheat_Sheet.html
  - W3C WebAuthn Level 3（2026-08-25 REC）：
    https://www.w3.org/TR/2026/REC-webauthn-3-20260825
  - web.dev discoverable credentials（allowCredentials 留空）：
    https://web.dev/articles/webauthn-discoverable-credentials
- 落地：`normalizeOpaqueOrigins` 校验 `android:apk-key-hash:` 清单（两个 App 各至少
  一条，最多 8 条；写错整批降级为仅网页端）；`passkeyFinishError` 把 origin /
  challenge / 其它验证失败拆成不同 message + `reason`；`ListPasskeys` 去掉 N+1；
  `/webauthn/*` 加 IP 外层 + uid 内层限流。
- 新配置键：未引入。`webauthn_opaque_origins` 单键 + 逗号分隔已能表达
  debug/release 两条通道；按 App 分键或读 `assetlinks.json` 属配置面变更，待拍板。

## 4. IP 定位：离线优先，IPv6 按 /64 前缀

- 结论：保留 ip2region 离线 xdb（不外发 IP），IPv6 以 /64 为缓存键；IPv4-mapped
  与 NAT64 还原成 v4；查不到就空串不渲染。
- 出处：
  - ip2region README（xdb v3 支持 IPv6；自带 `ipv6_source` 更新不规律，精度要求高
    应换商用离线数据）：
    https://github.com/lionsoul2014/ip2region
  - APNIC《IPv6 prefix lengths》（/48、/56、/64 的实际分布）：
    https://blog.apnic.net/2024/04/25/ipv6-prefix-lengths/
  - RFC 8805（geofeed 以**前缀**发布位置、最长前缀匹配）：
    https://datatracker.ietf.org/doc/rfc8805
  - RFC 8981（IPv6 隐私地址轮换主机位）：
    https://datatracker.ietf.org/doc/html/rfc8981
  - MaxMind 精度说明（IPv6 / 移动网络 city 级明显弱于 IPv4；地理库不是精确到户）：
    https://support.maxmind.com/knowledge-base/articles/maxmind-geolocation-accuracy
  - 免费库许可对比（MaxMind GeoLite2 / DB-IP Lite / IP2Location LITE 均为
    CC BY-SA 或带署名义务）：
    https://www.pistack.xyz/posts/2026-04-23-self-hosted-geoip-databases-maxmind-ip2location-dbip-guide-2026
- 不换库的理由：本仓刻意离线 + 随二进制内嵌；换 MaxMind/DB-IP 会新增账号、许可
  署名/再分发义务与数据文件更新流程，收益主要是海外 city 精度（会话页只展示
  省市，且空值不渲染），不足以抵消运维与隐私面变化。作为后续选项保留。

## 5. 安全收尾（2026-11 审计）

- 已落地：统一安全响应头（`X-Content-Type-Options` / `X-Frame-Options` /
  严格 CSP：`default-src`/`script-src 'self'` + 注销撤销页按请求 nonce /
  `Referrer-Policy` / `Permissions-Policy` / 条件 HSTS）；
  403 `reason` 分级（policy / permission / mfa_required，Passkey 另用 400/404 的
  origin|challenge|verification|ceremony_expired）；限流桶键按 `auth.RateKey` 归一
  （IPv6 → /64，换主机位不再换新预算）；Passkey 错误分级；根身份保护侧按锚点
  fail closed；`newUserID` 保留根 uid；`ensureColumn` / `ensureIndex` 并发幂等；
  会话轮换重用检测。未绑 MFA 的管理后台入口单列 `mfa_required`：它属于「用户还要
  自己完成第二步」，不是 OIDC/Okta 意义上的策略拒绝（policy = 找管理员改策略）。
- 出处：
  - OWASP HTTP Headers Cheat Sheet：
    https://cheatsheetseries.owasp.org/cheatsheets/HTTP_Headers_Cheat_Sheet.html
  - OWASP ASVS 5.0 V7（会话）/ V6（认证）：
    https://github.com/OWASP/ASVS/blob/master/5.0/en/0x16-V7-Session-Management.md
  - OIDC Core 1.0 `interaction_required`（需要用户介入，不是拒绝授权）：
    https://openid.net/specs/openid-connect-core-1_0.html#AuthError
  - RFC 9470 `insufficient_user_authentication`（第二步未完成）：
    https://www.rfc-editor.org/rfc/rfc9470.html
  - Okta `E0000058` factor required vs `E0000057` policy deny：
    https://developer.okta.com/docs/reference/error-codes
  - Microsoft Entra `interaction_required`：
    https://learn.microsoft.com/en-us/entra/identity-platform/reference-error-codes
- 仍待拍板（未擅自改协议/策略）：
  1. 按筛选批量撤销会话：影响面可到全站，需确认 UI 二次确认与上限；现有
     `GET /admin/sessions` + `DELETE /admin/sessions/{id}`（≤100/批）已能完成。
  2. 403 错误页分级透传：服务端已回 `reason`（含本次新增的 `mfa_required`）；
     `internal/ui` 的展示位由 UI 批次接线，本次未改 UI 文件，未知 reason 由前端
     按文案回退成普通报错，不会错标成「策略拒绝」。
  3. 管理后台「非管理员 / 未绑 MFA」的路由级拒绝目前只落结构化 Warn 日志；
     新增审计事件名需要同步 `admin-audit.html` 下拉（UI 批次），待一并做。
     MFA 那条现在回 `mfa_required`，日志仍记 `reason=mfa_required`。
  4. OAuth 回跳地址目前允许 `http://`（精确登记）；RFC 9700/ASVS 建议除环回外
     只收 https，收紧会破坏已登记客户端，待拍板。
  5. **部署前必须核对** `SELECT id, email, role FROM users WHERE id = 5939716`：
     该号是随机 uid 号段内的保留号，上线前可能已被某个存量账号占用。若这行不是
     根账号（`hs@horatio.cn`）且 role 恰为 `super`，新版会把根身份解析到它身上；
     若它 role 不是 super，邮箱兜底仍然生效，但这行此后会被当作「根账号」保护。
     两种都要在发布前处理掉（改号或清行），属数据操作，不写进代码常量。
  6. **风险接受（不写代码）**：`/internal/verify` 不加共享 token/header。前提有三：
     服务默认 `BIND_ADDR=127.0.0.1:8868`，nginx 只反代公开路径、`/internal/*`
     公网 404，且本机不可信进程不能绑定 8868。能在本机占住 8868 的进程已具备
     主机级权限，加一个静态 header 只是把秘密多放一处，挡不住它；真正的边界是
     环回监听 + 反代路径隔离，而不是应用内的共享密钥。复核条件：任一前提变化
     （`BIND_ADDR` 改非环回、nginx 暴露 `/internal/*`、本机不可信进程可绑 8868）
     即重新评估，改为共享 header + 网络层 ACL/mTLS。
     出处：
     https://www.cloudspress.com/localhost-dangers-how-cors-csrf-and-dns-rebinding-expose-local-services
     https://www.slingacademy.com/article/nginx-how-to-accept-only-local-requests
