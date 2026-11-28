# AGENTS.md — auth

Go+MySQL unified account service behind `auth.horatio.cn` (register/login, email codes, TOTP/Passkeys, JWT sessions, admin web console) for the two diary apps; pushing `main` runs `build.yml` (build + test) and, on Go paths, `deploy-server.yml` (redeploy on the self-hosted runner).

## Commands

| Purpose | Command |
| --- | --- |
| Build | `go build ./...` |
| Web build | `cd web && npm ci && npm run build`（产物进 `internal/ui/dist`，随二进制嵌入） |
| Web tests | `cd web && npm test`；`cd web && npm run e2e`（Playwright + axe，mock API，不依赖 MySQL） |
| Tests (CI gate) | `go test ./...` (DB tests skip without `TEST_MYSQL_DSN`) |
| One test | `go test ./... -run <Name>` |
| Vet | `go vet ./...` (README; not in CI) |
| Package / deploy | `ci/build-server.sh` → `dist/server.tar`; `ci/deploy-server.sh dist/server.tar` |
| Local run | copy `.env.example` → `.env`, set `MYSQL_DSN`, `JWT_SECRET`, `TOTP_ENC_KEY`; listen `127.0.0.1:8868` (nginx TLS in front) |

Before finishing: `JWT_SECRET` and `TOTP_ENC_KEY` must each be ≥32 bytes or the server refuses to start; losing `TOTP_ENC_KEY` invalidates every bound TOTP (recovery codes only). The commands themselves are the Definition of done below.

## Context loading

| Task | Read |
| --- | --- |
| Endpoints, web console, `app_config` config tables, local commands, deploy target | `README.md` |
| Shared account/release/copy rules (sister repo) | `~/.config/opencode/docs/sister-repos.md`; onboarding: `~/.config/opencode/docs/auth-onboarding.md` |
| Web UI research | `docs/ui-research-2026-10.md` |
| Global rules | `~/.config/opencode/AGENTS.md` |

## Boundaries

### Always
- The `app` field on login/register/send-code is the JWT `aud`, whitelisted to `CalorieDiary`/`ExpenseDiary` via `allowedApps` in `internal/auth/auth.go`; add new apps there and in the downstream services.
- `/internal/*` is loopback/trusted-network only (403 otherwise); deploy config through `app_config` (10s cache), never hardcoded secrets.
- On account deletion, call each diary hook and honor the 7-day grace (see sister-repos); a failing hook returns 503 and aborts.
- 间距只用 4/8/12/16/24/32：卡片内边距 16（`sm` 起 24）、页面区块间距 24、表格单元格 `px-4 py-3`、列表行 `px-4 py-4 sm:px-6`；字号只有 12/14/16/18/20/24，正文 14/20；窄屏控件高 40、抽屉导航行 44。
- OAuth 文案：应用名一律裸写（不加「」）；返回按钮写应用名（`返回 奇奇岛护照`），拿不到应用名才退到域名、再没有就 `返回 Auth 控制台`；名称与域名并列时写成 `名称（域名）`（域名只在授权说明里出现）。
- 动效只有一套 token（`web/src/index.css` 的 `--motion-*` / `--ease-*`）；页面切换只做入场，不做新旧交叉淡入；窄屏（<640px）弹窗是从底部滑入的弹层。改数值时短链项目同步（它按同一份取值）。

### Ask first
- Flipping `totp_enforce_apps` (the only switch that changes old-client behavior), adding config keys, or changing MFA/session policy.
- Adding dependencies or editing `.github/workflows/`.

### Never
- Commit real secrets or `.env`; ship a JWT/TOTP key under 32 bytes — generate ≥32 random bytes.
- Expose `/internal/*` through nginx — keep `BIND_ADDR` at `127.0.0.1`.
- Change endpoint JSON shapes without updating both diary clients.

## Definition of done

`go build ./...`, `go vet ./...` and `go test ./...` pass locally; endpoint JSON changes ship together with both diary clients; no `.env`/real secrets in the diff.
