/**
 * Per-target-host global rate limiter for the custom-model proxy.
 *
 * Uses RateLimiterMemory (in-process, single-instance correct).
 *
 * IMPORTANT: This limiter is in-memory only. If the backend ever scales to
 * multiple instances, this counter becomes per-instance, silently allowing
 * N× the intended rate. At that point, migrate to RateLimiterPostgres
 * (Postgres is deployed). Under NO circumstances should a multi-instance
 * deploy ship with RateLimiterMemory for the per-host counter.
 *
 * See PROPOSAL-001-APPROVED.md — multi-instance migration tracked as a
 * follow-up issue; not a Wave 1 blocker.
 */
import { RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible'

/** Parsed host rate-limit config (defaults may be overridden per-call for tests). */
export type PerHostRateLimitConfig = {
  /** Max requests per window across all users targeting the same host. */
  points: number
  /** Window in seconds. */
  duration: number
}

const DEFAULT_POINTS = parseInt(process.env.CUSTOM_PROXY_RATE_LIMIT_PER_HOST_PER_MIN ?? '1000', 10)

// Module-level singleton; replaced in tests by injecting a config.
let limiter: RateLimiterMemory = new RateLimiterMemory({
  keyPrefix: 'custom-proxy-host',
  points: DEFAULT_POINTS,
  duration: 60,
})

/**
 * Replace the per-host limiter with a new instance (test isolation only).
 * Call this before each test that exercises rate limits.
 */
export const resetPerHostLimiter = (config?: PerHostRateLimitConfig): void => {
  limiter = new RateLimiterMemory({
    keyPrefix: 'custom-proxy-host',
    points: config?.points ?? DEFAULT_POINTS,
    duration: config?.duration ?? 60,
  })
}

/**
 * Consume one point for the given target host.
 *
 * Returns `{ ok: true }` when allowed.
 * Returns `{ ok: false, retryAfterMs }` when the per-host limit is exceeded.
 */
export const checkPerHostRateLimit = async (
  targetHost: string,
): Promise<{ ok: boolean; retryAfterMs?: number }> => {
  try {
    await limiter.consume(targetHost)
    return { ok: true }
  } catch (err: unknown) {
    if (err instanceof RateLimiterRes) {
      return { ok: false, retryAfterMs: err.msBeforeNext }
    }
    throw err
  }
}
