# AGENTS.md — auth

Go+MySQL unified account service behind `auth.horatio.cn` (register/login, email codes, TOTP/Passkeys, JWT sessions, admin web console) for the two diary apps; pushing `main` runs `build.yml` (build + test) and, on Go changes, `deploy-server.yml` (redeploy on self-hosted runner).

## Precedence

Nearest `AGENTS.md` wins over the global file; an explicit user instruction wins over both. When docs and code disagree, follow the existing code and report the inconsistency. Global rules live in `~/.config/opencode/AGENTS.md` (do not restate them here).

## Commands

| Purpose | Command (from CI/README) |
| --- | --- |
| Build | `go build ./...` |
| Tests (CI gate) | `go test ./...` (DB tests skip without `TEST_MYSQL_DSN`) |
| One test | `go test ./... -run <Name>` |
| Vet | `go vet ./...` (README; not in CI) |
| Package (deploy entry) | `ci/build-server.sh` → `dist/server.tar`; deploys with `ci/deploy-server.sh dist/server.tar` |
| Local run | copy `.env.example` → `.env`, set `MYSQL_DSN`, `JWT_SECRET` and `TOTP_ENC_KEY`; listen `127.0.0.1:8868` (nginx TLS in front) |

Required before finishing: `go build ./...` and `go test ./...`. `JWT_SECRET` and `TOTP_ENC_KEY` must each be ≥32 bytes or the server refuses to start; losing `TOTP_ENC_KEY` invalidates every bound TOTP (see README config table).

## Boundaries

**Always**
- The `app` field on login/register/send-code is the JWT `aud`, whitelisted to `calorie-diary`/`expense-diary`; never accept arbitrary apps.
- `/internal/*` is loopback/trusted-network only (403 otherwise); deploy config through `app_config` (10s cache), never hardcoded secrets.
- Keep auth limit/error copy in sync with both diary clients — cross-repo tests pin the wording.

**Ask first**
- Flipping `totp_enforce_apps` (the only switch that changes old-client behavior), adding config keys, or changing MFA/session policy.
- Adding dependencies or editing `.github/workflows/`.

**Never**
- Commit real secrets or `.env`; ship a JWT/TOTP key under 32 bytes; expose `/internal/*` through nginx.
- Change endpoint JSON shapes without updating both diary clients. On account deletion, call each diary hook and honor the 7-day grace (see SISTER-REPOS).

## Pointers

- Endpoint, web-console and `app_config` config tables, local commands, deploy target: `README.md`.
- Shared account/release/copy rules (this is a sister repo): `~/.config/opencode/docs/SISTER-REPOS.md`; onboarding: `~/.config/opencode/docs/AUTH-ONBOARDING.md`.
- Web UI research: `docs/ui-research-2026-10.md`; admin bootstrap is documented in the README config section.
