import { Elysia } from "elysia";

export interface LoggerOptions {
  /** @default true */
  colors?: boolean;
  /** @default false */
  logHeaders?: boolean;
  /** @default false */
  logQuery?: boolean;
  /**
   * ⚠️ Clones and consumes the request body stream to log it. Debugging only.
   * @default false
   */
  logBody?: boolean;
  formatter?: (info: LogInfo) => string;
  logFn?: (message: string) => void;
  skip?: string | RegExp | ((request: Request) => boolean);
}

export interface LogInfo {
  method: string;
  url: string;
  path: string;
  status: number;
  duration: number;
  timestamp: string;
  headers?: Record<string, string>;
  query?: string;
  body?: unknown;
}

const colors = {
  reset: "\x1b[0m",
  bright: "\x1b[1m",
  dim: "\x1b[2m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
  white: "\x1b[37m",
  gray: "\x1b[90m",
};

function defaultFormatter(info: LogInfo): string {
  const parts = [
    `[${info.timestamp}]`,
    info.method,
    info.path,
    `${info.status}`,
    `${info.duration}ms`,
  ];
  if (info.query) {
    parts.push(info.query);
  }
  return parts.join(" ");
}

function colorize(info: LogInfo, message: string): string {
  let methodColor = colors.white;
  switch (info.method) {
    case "GET":
      methodColor = colors.green;
      break;
    case "POST":
      methodColor = colors.cyan;
      break;
    case "PUT":
      methodColor = colors.yellow;
      break;
    case "PATCH":
      methodColor = colors.magenta;
      break;
    case "DELETE":
      methodColor = colors.red;
      break;
    case "OPTIONS":
      methodColor = colors.gray;
      break;
  }

  let statusColor = colors.green;
  if (info.status >= 500) {
    statusColor = colors.red + colors.bright;
  } else if (info.status >= 400) {
    statusColor = colors.yellow;
  } else if (info.status >= 300) {
    statusColor = colors.cyan;
  }

  const parts = message.split(" ");
  const colorized: string[] = [];
  for (const part of parts) {
    if (part.startsWith("[") && part.endsWith("]")) {
      colorized.push(colors.gray + part + colors.reset);
    } else if (part === info.method) {
      colorized.push(methodColor + colors.bright + part + colors.reset);
    } else if (part === info.status.toString()) {
      colorized.push(statusColor + part + colors.reset);
    } else if (part.endsWith("ms")) {
      colorized.push(colors.dim + part + colors.reset);
    } else {
      colorized.push(part);
    }
  }
  return colorized.join(" ");
}

/** Request/response logger, ported from ecosystem/middleware/logger with the same options/behavior. */
export function requestLogger(options: LoggerOptions = {}) {
  const {
    colors: useColors = true,
    logHeaders = false,
    logQuery = false,
    logBody = false,
    formatter = defaultFormatter,
    logFn = console.log,
    skip,
  } = options;

  const startTimes = new WeakMap<Request, number>();

  function shouldSkip(request: Request): boolean {
    if (!skip) return false;
    if (typeof skip === "string") return request.url.includes(skip);
    if (skip instanceof RegExp) return skip.test(request.url);
    return skip(request);
  }

  return new Elysia({ name: "request-logger" })
    .onRequest(({ request }) => {
      if (shouldSkip(request)) return;
      const now =
        typeof Bun !== "undefined" && Bun.nanoseconds ? Bun.nanoseconds() : Date.now() * 1_000_000;
      startTimes.set(request, now);
    })
    .onAfterResponse({ as: "global" }, async ({ request, set }) => {
      const startTime = startTimes.get(request);
      if (startTime === undefined) return;
      startTimes.delete(request);

      const endTime =
        typeof Bun !== "undefined" && Bun.nanoseconds ? Bun.nanoseconds() : Date.now() * 1_000_000;
      const duration = Math.round((endTime - startTime) / 1_000_000);
      const status = typeof set.status === "number" ? set.status : 200;
      const timestamp = new Date().toISOString();
      const url = new URL(request.url);

      const logInfo: LogInfo = {
        method: request.method,
        url: request.url,
        path: url.pathname,
        status,
        duration,
        timestamp,
      };

      if (logQuery && url.search) {
        logInfo.query = url.search;
      }
      if (logHeaders) {
        logInfo.headers = Object.fromEntries(request.headers.entries());
      }
      if (logBody && ["POST", "PUT", "PATCH"].includes(request.method)) {
        try {
          const contentType = request.headers.get("content-type");
          if (contentType?.includes("application/json")) {
            logInfo.body = await request.clone().json();
          }
        } catch {
          // ignore body-parsing errors, logging only
        }
      }

      const message = formatter(logInfo);
      logFn(useColors ? colorize(logInfo, message) : message);
    });
}
