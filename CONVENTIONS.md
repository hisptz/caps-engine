# Handler and queue conventions

CAPS step logic is plugins. Register every handler in `src/services/worker/constants/handlers.ts` (`Handlers` enum + `HANDLERS` map). Re-export implementations from `src/services/worker/services/handlers/index.ts`.

## Folder layout

One directory per handler under `src/services/worker/services/handlers/`, camelCase matching the enum member (`climateOpenEoCreate`, `predictionTrigger`, …). Shared Zod for a family can live in a sibling folder (for example `climateOpenEo/schemas/`).

Typical files:

```
handlers/<name>/
  index.ts          # class implementing StepHandler
  utils/            # optional
```

`index.ts` must export a `StepHandler` with `execute(ctx: StepContext)`.

## Zod config and context

In the `HANDLERS` map, `schemas.config` is the step’s static `handlerConfig`; `schemas.context` is data the handler reads from shared pipeline context. The API catalog (`src/shared/handlers/catalog.ts`) turns those Zod objects into JSON Schema for the frontend.

**Empty `schemas: {}` is OK** when the step has no operator-facing config and no extra context keys (poll/download/upload handlers often look like this). Do not add dummy objects.

## Queue names

`queueName` must be `step.<handler-key>` where `<handler-key>` is the `Handlers` enum string (`step.climate-openeo-create`). Topology (`src/services/worker/services/monitor/topology.ts`) asserts every `HANDLERS` queue plus pipeline/outbox/DLX names from `constants/monitor.ts`. Do not invent a queue that is not in the map.

## Frontend

Handler keys in the DHIS2 app forms must match the enum strings. Changing a key is breaking for saved pipelines.

## Further reading

Worker types: `src/services/worker/types/service.ts`. Contributor workflow: [CONTRIBUTING.md](./CONTRIBUTING.md).
