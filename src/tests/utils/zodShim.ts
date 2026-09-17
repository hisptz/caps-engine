// Vitest+Bun interop shim.
// In this environment, `import { z } from "zod"` can be undefined, while the default import works.
// We keep application code unchanged by aliasing `zod` to this module in `vitest.config.ts`.

import zodDefault, * as zodNs from "zod/v4";

export const z: typeof import("zod/v4").z =
  (zodNs as unknown as { z?: typeof import("zod/v4").z }).z ?? (zodDefault as never);

export * from "zod/v4";
export default zodDefault;
