# HTTP Data Pull (example plugin)

Pulls data values from your own system over HTTP and imports them into staging. It is the
reference for writing a CAPS plugin: copy this folder to start a new one.

## What it does

1. Calls your system through a **connected route** on staging, so the system's address and
   credentials live on staging, not in CAPS:
   `GET <route>/<endpoint>?dataElement=…&period=…`
2. Keeps the values for the chosen data elements and periods.
3. Writes them to a file and hands it to the next step, **DHIS2 Data Upload**, which imports
   them into staging.

A pipeline using it has two steps: **HTTP Data Pull → DHIS2 Data Upload**.

Your endpoint must answer in DHIS2's data value shape:

```json
{
  "dataValues": [
    { "dataElement": "fbfJHSPpUQD", "period": "202610", "orgUnit": "DiszpKrYNg8", "value": "12" }
  ]
}
```

`categoryOptionCombo` and `attributeOptionCombo` are optional. Values in another shape, or for
data elements and periods that were not asked for, are left out and counted as `skipped`.

## Switching it on

1. In staging DHIS2, create a route whose code starts with `caps-src-` and whose URL points at
   your system, ending in `/**` (e.g. `https://my-system.org/api/**`).
   - From caps-app (Settings › Connected instances) the URL becomes `<address>/api/**`, with a
     token or username/password. The step's **Endpoint** is then relative to `<address>/api/`:
     `data-values` calls `<address>/api/data-values`. The screen's **Test** button checks for
     DHIS2, so it fails for other systems; the step itself works.
   - For another URL layout or other credentials, create the route in DHIS2 itself
     (`POST /api/routes`).
2. In the deployment's `.env`: `CAPS_PLUGINS=http-data-pull`, then restart CAPS.
3. In caps-app, add an **HTTP Data Pull** step, then a **DHIS2 Data Upload** step.

## The files

| File                | What it holds                                                   | Read by          |
| ------------------- | --------------------------------------------------------------- | ---------------- |
| `plugin.ts`         | Key, name, description, tags, result fields, settings, `load()` | API, worker, app |
| `schemas/config.ts` | The settings (Zod). The app draws the form from it              | API, worker, app |
| `index.ts`          | `execute()`: the work the step does                             | Worker only      |

The plugin is listed with one line in `src/plugins/index.ts`.

## Writing your own plugin from this one

- **Key**: kebab-case and unique (`ewars-pull`). It is saved on every step, so never rename it.
- **Settings form**: every field in `schemas/config.ts` becomes an input. `.meta()` with a
  `title` and `description` sets its label and help text. `capsField(schema, "dataElement")`
  (or `orgUnits`, `period`, `connectedInstance`, `userGroups`) shows the DHIS2 picker. Reuse
  `pullPeriodSchema` and `orgUnitConfigSchema` for periods and org units.
- **Another response shape**: change `toDataValues()` in `index.ts`; the rest stays.
- **Sending to another DHIS2 instance** instead of staging: call
  `sendDataValues(ctx, { routeCode, dataValues })` (`src/services/worker/utils/sendDataValues.ts`).
  It posts in chunks through the instance's route, adds up DHIS2's import counts, fails on a
  rejected import and logs conflicts, so a step can pull, prepare and send without staging.
- **Errors**: throw an `Error` for something that may pass on a retry (network, timeouts).
  Throw `StepPermanentError` when retrying cannot help (bad settings, no data).
- **Result**: what `execute()` returns is stored on the step run and passed to the next step.
  List the numbers in `outputs` in `plugin.ts` so connector conditions can branch on them.
- **Logs and tasks**: `ctx.log()` and `ctx.tasks.startTask()` show up under the step's run in
  caps-app.
