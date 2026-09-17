# Community files vs source (this repo)

| Source change                                                         | Update                                                                  |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `package.json` scripts                                                | `README.md`, `docs/GETTING_STARTED.md`, `CONTRIBUTING.md`, PR checklist |
| `Makefile`                                                            | GETTING_STARTED + README command tables                                 |
| `docker-compose*.yml`, `Dockerfile`                                   | GETTING_STARTED ports/services; README Compose/GHCR                     |
| `.env.example`, `src/shared/schemas/env.ts`                           | env tables; SECURITY.md if new secret classes                           |
| `src/services/api/index.ts`, `worker/worker.ts`, `scheduler/index.ts` | README overview; SECURITY scope; bug_report components                  |
| `src/services/worker/constants/handlers.ts`                           | CONTRIBUTING handler-key note; `CONVENTIONS.md`                         |
| `prisma/**`                                                           | GETTING_STARTED tree; seed/migrate commands                             |
| `.github/workflows/*.yml`                                             | CONTRIBUTING CI; GETTING_STARTED quality                                |
| `.husky/*`, `.releaserc.json`                                         | CONTRIBUTING commits/releases                                           |
| New top-level dirs in the GETTING_STARTED tree                        | `docs/GETTING_STARTED.md`                                               |
