import { vi } from "vitest";

type BunStubs = Partial<Record<"write" | "file" | "sleep", (...args: never[]) => unknown>>;

export function stubBun(stubs: BunStubs): void {
  if (!process.versions.bun) {
    vi.stubGlobal("Bun", stubs);
    return;
  }
  for (const [name, impl] of Object.entries(stubs)) {
    vi.spyOn(Bun, name as "write").mockImplementation(impl as never);
  }
}
