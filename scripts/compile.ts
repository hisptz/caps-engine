import { mkdir } from "node:fs/promises";

const SERVICES = {
  api: {
    entry: "src/services/api/index.ts",
    outfile: ".build/caps-api",
  },
  worker: {
    entry: "src/services/worker/worker.ts",
    outfile: ".build/caps-worker",
  },
  scheduler: {
    entry: "src/services/scheduler/index.ts",
    outfile: ".build/caps-scheduler",
  },
} as const;

type ServiceName = keyof typeof SERVICES;

const ARCH_TO_BUN_TARGET: Record<string, string> = {
  amd64: "bun-linux-x64",
  arm64: "bun-linux-arm64",
  x64: "bun-linux-x64",
};

function isServiceName(value: string): value is ServiceName {
  return Object.hasOwn(SERVICES, value);
}

function resolveBunTarget(): string | undefined {
  const explicit = process.env.BUN_COMPILE_TARGET;
  if (explicit) {
    return explicit;
  }

  const targetArch = process.env.TARGETARCH;
  if (!targetArch) {
    return undefined;
  }

  const mapped = ARCH_TO_BUN_TARGET[targetArch];
  if (!mapped) {
    throw new Error(`Unsupported TARGETARCH: ${targetArch}`);
  }
  return mapped;
}

async function run(command: string[]): Promise<void> {
  const proc = Bun.spawn(command, { stdout: "inherit", stderr: "inherit" });
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`Command failed (${exitCode}): ${command.join(" ")}`);
  }
}

async function compile(service: ServiceName): Promise<void> {
  const spec = SERVICES[service];
  const bunTarget = resolveBunTarget();
  await mkdir(".build", { recursive: true });

  console.info(`Compiling ${service}${bunTarget ? ` for ${bunTarget}` : " for host"}...`);

  const args = ["bun", "build", "--compile", "--minify", spec.entry, "--outfile", spec.outfile];
  if (bunTarget) {
    args.push("--target", bunTarget);
  }
  await run(args);
}

const serviceArg = process.argv[2];
if (!serviceArg || !isServiceName(serviceArg)) {
  const names = Object.keys(SERVICES).join(", ");
  throw new Error(`Usage: bun run scripts/compile.ts <${names}>`);
}

await compile(serviceArg);
console.info("Done!");
