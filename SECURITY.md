# Security policy

## Supported versions

We accept reports against the latest release on [`main`](https://github.com/hisptz/caps-engine/releases) and against current `main`. Older tags are not patched unless we explicitly say so in a GitHub Security Advisory.

## Reporting a vulnerability

**Do not** open a public issue for security problems.

Please report through **GitHub Private Vulnerability Reporting**:

[https://github.com/hisptz/caps-engine/security/advisories/new](https://github.com/hisptz/caps-engine/security/advisories/new)

If that form is unavailable, email **[info@hisptanzania.org](mailto:info@hisptanzania.org)** (HISP Tanzania).

Include:

- Affected component (API, worker, scheduler, image tag, or commit)
- Impact (auth bypass, injection, secret leak, privilege, DoS)
- Reproduction that does **not** include live production credentials
- Whether you have a patch

We will acknowledge receipt when we can, and we will tell you whether we accept the report, decline it, or need more detail. Please give us a reasonable window before any public disclosure.

## What is in scope

- The CAPS API, worker, and scheduler in this repository
- Published images `ghcr.io/hisptz/caps-engine/{api,worker,scheduler,migrate}`
- Default Compose wiring that could leak credentials if copied into production

## What is out of scope

- DHIS2 core, CHAP, or climate/openEO services you connect to
- Misconfiguration of your own Postgres, RabbitMQ, or DHIS2 Route
- The frontend app ([`hisptz/caps-app`](https://github.com/hisptz/caps-app)) — report there instead

## Secrets in this repo

`.env.example` uses local development placeholders (including DHIS2 `admin` / `district`, which are DHIS2’s well-known demo pair). Never reuse those values in production. Rotate anything that was ever committed for real environments. Before making the repository public, review `prisma/seed.ts` and git history for partner-specific identifiers.
