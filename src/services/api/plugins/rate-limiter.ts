import { Elysia } from "elysia";

export interface RateLimiterOptions {
  /** @default 60000 (1 minute) */
  windowMs?: number;
  /** @default 100 */
  maxRequests?: number;
  keyGenerator?: (request: Request) => string;
  /** @default false */
  skipFailedRequests?: boolean;
  /** @default false */
  skipSuccessfulRequests?: boolean;
}

interface RateLimitRecord {
  count: number;
  resetTime: number;
}

function hashKey(key: string): string {
  if (typeof Bun !== "undefined" && Bun.CryptoHasher) {
    try {
      const hasher = new Bun.CryptoHasher("sha256");
      hasher.update(key);
      return hasher.digest("hex").slice(0, 16);
    } catch {
      // fall through to the plain hash below
    }
  }
  let hash = 0;
  for (let i = 0; i < key.length; i++) {
    const char = key.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return hash.toString(36);
}

function defaultKeyGenerator(request: Request): string {
  const forwarded = request.headers.get("X-Forwarded-For");
  if (forwarded) {
    const ip = forwarded.split(",")[0]?.trim();
    return hashKey(ip ?? "unknown");
  }
  const realIp = request.headers.get("X-Real-IP");
  if (realIp) {
    return hashKey(realIp);
  }
  return "unknown";
}

/** In-memory fixed-window rate limiter, ported from ecosystem/middleware/rate-limiter. Not viable across multiple instances. */
export function rateLimiter(options: RateLimiterOptions = {}) {
  const {
    windowMs = 60000,
    maxRequests = 100,
    keyGenerator = defaultKeyGenerator,
    skipFailedRequests = false,
    skipSuccessfulRequests = false,
  } = options;

  const store = new Map<string, RateLimitRecord>();
  const recordByRequest = new WeakMap<Request, RateLimitRecord>();

  const cleanupInterval = setInterval(() => {
    const now = Date.now();
    for (const [key, record] of store.entries()) {
      if (now > record.resetTime) {
        store.delete(key);
      }
    }
  }, 60000);
  if (typeof process !== "undefined" && process.on) {
    try {
      process.on("exit", () => clearInterval(cleanupInterval));
    } catch {
      // ignore if process.on is unavailable in this runtime
    }
  }

  return new Elysia({ name: "rate-limiter" })
    .onRequest(({ request, set }) => {
      const key = keyGenerator(request);
      const now = Date.now();

      let record = store.get(key);
      if (!record || now > record.resetTime) {
        record = { count: 0, resetTime: now + windowMs };
        store.set(key, record);
      }
      record.count++;
      recordByRequest.set(request, record);

      if (record.count > maxRequests) {
        set.status = 429;
        set.headers["X-RateLimit-Limit"] = maxRequests.toString();
        set.headers["X-RateLimit-Remaining"] = "0";
        set.headers["X-RateLimit-Reset"] = Math.ceil(record.resetTime / 1000).toString();
        set.headers["Retry-After"] = Math.ceil((record.resetTime - now) / 1000).toString();
        return {
          error: "Too Many Requests",
          message: "You have exceeded the rate limit. Please try again later.",
        };
      }

      return undefined;
    })
    .onAfterHandle({ as: "global" }, ({ request, set }) => applyRateLimitHeaders(request, set))
    .onError({ as: "global" }, ({ request, set }) => {
      applyRateLimitHeaders(request, set);
      return undefined;
    });

  function applyRateLimitHeaders(
    request: Request,
    set: { status?: number | string; headers: Record<string, string | number> }
  ): void {
    const record = recordByRequest.get(request);
    if (!record) return;
    recordByRequest.delete(request);

    const status = typeof set.status === "number" ? set.status : 200;
    const shouldSkip =
      (skipFailedRequests && status >= 400) ||
      (skipSuccessfulRequests && status >= 200 && status < 300);
    if (shouldSkip) {
      record.count--;
    }

    set.headers["X-RateLimit-Limit"] = maxRequests.toString();
    set.headers["X-RateLimit-Remaining"] = Math.max(0, maxRequests - record.count).toString();
    set.headers["X-RateLimit-Reset"] = Math.ceil(record.resetTime / 1000).toString();
  }
}
