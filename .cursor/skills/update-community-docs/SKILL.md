---
name: update-community-docs
description: >-
  Keeps this repo’s open-source community files in sync with source. Use after
  changing package.json scripts, Makefile, Compose, Dockerfile, .env.example,
  env.ts, CI workflows, entry points, handlers, or directory layout; and when
  the user mentions README, CONTRIBUTING, SECURITY, GETTING_STARTED, or GitHub
  issue/PR templates.
---

# Update community docs (caps)

After a source change that affects how people install, run, test, or contribute, patch community files in this repo in the **same turn**.

Read [file-map.md](file-map.md).

## Files

`README.md`, `docs/GETTING_STARTED.md`, `CONTRIBUTING.md`, `SECURITY.md`, `.github/PULL_REQUEST_TEMPLATE.md`, `.github/ISSUE_TEMPLATE/*.yml`. Touch `CODE_OF_CONDUCT.md` only for contact/name changes. **Do not modify LICENSE.**

## Workflow

1. Map the diff via [file-map.md](file-map.md).
2. Edit in place; keep headings; patch facts only (commands, env names, tree, CI, images, remotes).
3. If unknown, `<!-- TODO: … -->` — do not invent env vars absent from `.env.example` / `src/shared/schemas/env.ts` / Compose. Contact is info@hisptanzania.org; owner is HISP Tanzania; do not rewrite LICENSE.
4. Mention updated files in the summary (or why none changed).

## Rules

- Truth: `package.json`, `Makefile`, CI YAML, Compose, `env.ts`, `.env.example`.
- Org/repo from `git remote` (default `hisptz/caps-engine`).
- Contact: info@hisptanzania.org. CODEOWNERS: `@hisptz` + that email.
- Keep Conventional Commits and PRs to `main` unless `.releaserc.json` / Husky change.
