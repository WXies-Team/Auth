# AGENTS.md — auth

Go+MySQL unified account service behind `auth.horatio.cn` (register/login, email codes, TOTP/Passkeys, JWT sessions, admin web console) for the two diary apps; pushing `main` runs `build.yml` (build + test) and, on Go paths, `deploy-server.yml` (redeploy on the self-hosted runner).

## Commands

| Purpose | Command |
| --- | --- |
| Build | `go build ./...` |
| Tests (CI gate) | `go test ./...` (DB tests skip without `TEST_MYSQL_DSN`) |
| One test | `go test ./... -run <Name>` |
| Vet | `go vet ./...` (README; not in CI) |
| Package / deploy | `ci/build-server.sh` → `dist/server.tar`; `ci/deploy-server.sh dist/server.tar` |
| Local run | copy `.env.example` → `.env`, set `MYSQL_DSN`, `JWT_SECRET`, `TOTP_ENC_KEY`; listen `127.0.0.1:8868` (nginx TLS in front) |

Before finishing: `go build ./...` and `go test ./...`. `JWT_SECRET` and `TOTP_ENC_KEY` must each be ≥32 bytes or the server refuses to start; losing `TOTP_ENC_KEY` invalidates every bound TOTP (recovery codes only).

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

### Ask first
- Flipping `totp_enforce_apps` (the only switch that changes old-client behavior), adding config keys, or changing MFA/session policy.
- Adding dependencies or editing `.github/workflows/`.

### Never
- Commit real secrets or `.env`; ship a JWT/TOTP key under 32 bytes — generate ≥32 random bytes.
- Expose `/internal/*` through nginx — keep `BIND_ADDR` at `127.0.0.1`.
- Change endpoint JSON shapes without updating both diary clients.

## Output

Chinese, lead with the conclusion. Keep instruction files in English.
