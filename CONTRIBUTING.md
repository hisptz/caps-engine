# Contributing to CAPS

Thanks for helping improve the Climate Automation & Prediction Scheduler. This repository is the **backend** (API, worker, scheduler). The DHIS2 operator app lives in [`hisptz/caps-app`](https://github.com/hisptz/caps-app).

## Code of conduct

Participation is governed by [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md).

## How we work

1. Search [existing issues](https://github.com/hisptz/caps-engine/issues) before opening a new one.
2. Use the issue templates (bug / feature). Security reports go through [SECURITY.md](./SECURITY.md), not a public issue.
3. Fork (or branch from `main`), implement, and open a pull request using [`.github/PULL_REQUEST_TEMPLATE.md`](./.github/PULL_REQUEST_TEMPLATE.md).
4. Target **`main`**. Releases are cut from `main` by semantic-release.

## Development setup

Follow [docs/GETTING_STARTED.md](./docs/GETTING_STARTED.md) for install, env vars, and the directory map.

Quick path:

```bash
cp .env.example .env
# Fill POSTGRES_* / RABBITMQ_* / climate URLs if you are not using the .env.example defaults
make up          # Postgres, RabbitMQ, migrate, api, workers, scheduler
bun install
bun run db:generate
bun run dev:api        # host hot-reload against published ports
bun run dev:worker
bun run dev:scheduler
```

Hot reload is **not** available inside the distroless Docker images. Iterate with the `dev:*` scripts on the host.

## Commands we actually run

| Task                         | Command                                            |
| ---------------------------- | -------------------------------------------------- |
| Install                      | `bun install`                                      |
| Prisma client                | `bun run db:generate`                              |
| Dev API / worker / scheduler | `bun run dev:api` / `dev:worker` / `dev:scheduler` |
| Lint                         | `bun run lint` (`bun run lint:fix` to apply)       |
| Format                       | `bun run format` / `bun run format:check`          |
| Typecheck                    | `bun run typecheck`                                |
| Tests (Vitest)               | `bun run test` or `make test`                      |
| Coverage                     | `bun run test:coverage`                            |
| Seed example pipelines       | `bun run db:seed`                                  |
| Full Docker stack            | `make up` / `make down` / `make logs`              |

CI on pull requests to `main` runs lint, Prettier check, typecheck, and `bun run test:coverage` (see `.github/workflows/ci.yml`).

Tests need Postgres. `make test` sets `DATABASE_URL` from `DATABASE_URL_TEST` (see `.env.example`). Create `caps_test` first (`make db-shell` then `CREATE DATABASE caps_test;`).

## Commit messages

Use [Conventional Commits](https://www.conventionalcommits.org/). semantic-release on `main` maps types to versions:

- `feat:` — minor
- `fix:` — patch
- `feat!:` / `BREAKING CHANGE:` — major
- `chore:`, `docs:`, `test:`, `refactor:`, `ci:` — no release unless configured otherwise

Examples: `fix(worker): ack step results once`, `feat(api): list dead letters`.

Pre-commit (Husky) runs lint-staged (ESLint + Prettier on staged TypeScript; Prettier on json/md/yml).

There is **no** commitlint hook in this repo; CI does not reject non-conventional messages, but releases depend on them.

## Pull requests

- Keep PRs focused; one concern per PR when possible.
- Include tests for handler, queue, or API behavior you change (`src/tests/unit` / `src/tests/integration`).
- Do not commit `.env`, secrets, or real DHIS2 credentials. `.env.example` stays placeholder-only.
- Do not change `LICENSE` (BSD 3-Clause).
- Handler keys in `src/services/worker/constants/handlers.ts` must stay in sync with worker folders and any frontend forms that reference them. See [CONVENTIONS.md](./CONVENTIONS.md).

## Questions

Use [GitHub issues](https://github.com/hisptz/caps-engine/issues) for bugs and features. For security, follow [SECURITY.md](./SECURITY.md). Other questions: [info@hisptanzania.org](mailto:info@hisptanzania.org).
