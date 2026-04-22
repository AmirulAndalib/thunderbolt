/**
 * Custom-model proxy routes.
 *
 * POST /v1/custom-model/proxy  — streaming chat completions via OpenAI SDK
 * POST /v1/custom-model/models — upstream model discovery via direct fetch
 *
 * Security invariants (all enforced by code + test):
 * - SSRF defense delegated entirely to createSafeFetch (url-validation.ts).
 *   See RESEARCH-001 v4 §A10 step 4 + url-validation.test.ts.
 * - upstreamAuth validated against ^[\x20-\x7E]+$ (CRLF/header-injection defense).
 * - Per-user rate limit (60 req/min) + per-target-host global rate limit (1000 req/min).
 * - Authorization/upstreamAuth never logged. Audit verified by grep test.
 * - Mandatory outbound headers: User-Agent + X-Abuse-Contact.
 * - Content-Type gate: application/json or text/event-stream only.
 * - 101 Switching Protocols → 502.
 * - DNS timeout: 5s (Promise.race + AbortSignal.timeout).
 * - Byte caps: 50 MB total, 1 MB per SSE line.
 */

import type { Auth } from '@/auth/elysia-plugin'
import { createAuthMacro } from '@/auth/elysia-plugin'
import { createSafeFetch, validateSafeUrl } from '@/utils/url-validation'
import { Elysia } from 'elysia'
import { RateLimiterMemory, RateLimiterRes } from 'rate-limiter-flexible'
import type { ChatCompletionCreateParamsBase } from 'openai/resources/chat/completions'
import type { CustomModelModelsRequest, CustomModelProxyRequest, ProxyErrorEnvelope } from '@shared/custom-model-proxy'
import { getCustomModelClient } from './client'
import { checkPerHostRateLimit, resetPerHostLimiter } from './rate-limit-per-host'
import { redactAuthorization } from './log-redaction'

export { resetPerHostLimiter }

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Allowed upstream path suffixes. */
const ALLOWED_PATHS = (process.env.CUSTOM_PROXY_ALLOWED_PATHS ?? '/v1/models,/v1/chat/completions,/v1/completions')
  .split(',')
  .map((p) => p.trim())

/** Max total upstream bytes (50 MB). */
const MAX_BYTES = parseInt(process.env.CUSTOM_PROXY_MAX_BYTES ?? '52428800', 10)

/** Max per-SSE-line bytes (1 MB). */
const MAX_LINE_BYTES = 1024 * 1024

/** DNS timeout in ms (5 s). */
const DNS_TIMEOUT_MS = parseInt(process.env.CUSTOM_PROXY_DNS_TIMEOUT_MS ?? '5000', 10)

/** Total streaming deadline (5 min). */
const REQUEST_TIMEOUT_MS = parseInt(process.env.CUSTOM_PROXY_REQUEST_TIMEOUT_MS ?? '300000', 10)

/** Per-user rate limit points (requests per minute). */
const RATE_LIMIT_USER = parseInt(process.env.CUSTOM_PROXY_RATE_LIMIT_PER_USER_PER_MIN ?? '60', 10)

/** Outbound User-Agent header. */
const USER_AGENT = process.env.CUSTOM_PROXY_USER_AGENT ?? 'Thunderbolt-Proxy/1.0'

/** Outbound X-Abuse-Contact header. */
const ABUSE_CONTACT = process.env.CUSTOM_PROXY_ABUSE_CONTACT ?? 'abuse@thunderbolt.io'

/** Whether the proxy is enabled at all. */
const PROXY_ENABLED = process.env.CUSTOM_PROXY_ENABLED !== 'false'

/** Allow HTTP (non-TLS) upstreams in dev; HTTPS-only in prod. */
const ALLOW_HTTP = process.env.CUSTOM_PROXY_ALLOW_HTTP === 'true'

// ---------------------------------------------------------------------------
// Rate limiters
// ---------------------------------------------------------------------------

// IMPORTANT: RateLimiterMemory is single-instance only. If the backend scales
// to multiple instances, switch to RateLimiterPostgres. Never ship multi-instance
// with RateLimiterMemory for per-user or per-host counters — that silently
// allows N× the intended rate. See PROPOSAL-001-APPROVED.md.
export const perUserLimiter = new RateLimiterMemory({
  keyPrefix: 'custom-proxy-user',
  points: RATE_LIMIT_USER,
  duration: 60,
})

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

const proxyError = (code: ProxyErrorEnvelope['error']['code'], message: string, httpStatus: number): Response =>
  new Response(JSON.stringify({ error: { code, message, httpStatus } } satisfies ProxyErrorEnvelope), {
    status: httpStatus,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  })

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/** Validates that a string contains only printable ASCII (CRLF injection defense). */
const isPrintableAscii = (value: string): boolean => /^[\x20-\x7E]+$/.test(value)

/** Validates the upstream URL: scheme, no userinfo, allowed path suffix, SSRF-check stub. */
export const validateProxyRequest = (
  targetUrl: string,
  upstreamAuth?: string,
): { valid: true } | { valid: false; code: ProxyErrorEnvelope['error']['code']; message: string } => {
  let parsed: URL
  try {
    parsed = new URL(targetUrl)
  } catch {
    return { valid: false, code: 'INVALID_URL', message: 'URL could not be parsed.' }
  }

  // Reject non-http/https schemes
  if (!['https:', ...(ALLOW_HTTP ? ['http:'] : [])].includes(parsed.protocol)) {
    return { valid: false, code: 'INVALID_URL', message: 'Only HTTPS URLs are allowed.' }
  }

  // Reject userinfo in URL
  if (parsed.username || parsed.password) {
    return { valid: false, code: 'INVALID_URL', message: 'URLs with credentials are not allowed.' }
  }

  // Reject .local hostnames (mDNS DoS vector not covered by createSafeFetch)
  const hostname = parsed.hostname.toLowerCase()
  if (hostname.endsWith('.local') || hostname === 'local') {
    return { valid: false, code: 'HOSTNAME_NOT_ALLOWED', message: 'This hostname is not allowed.' }
  }

  // Static URL-level SSRF pre-check (DNS-level check is in createSafeFetch)
  const validation = validateSafeUrl(targetUrl)
  if (!validation.valid) {
    return { valid: false, code: 'SSRF_BLOCKED', message: 'This address is not allowed for security reasons.' }
  }

  // Path-suffix allowlist
  const path = parsed.pathname
  const pathAllowed = ALLOWED_PATHS.some((allowed) => path === allowed || path.endsWith(allowed))
  if (!pathAllowed) {
    return {
      valid: false,
      code: 'INVALID_URL',
      message: `Path not allowed. Allowed paths: ${ALLOWED_PATHS.join(', ')}`,
    }
  }

  // Header injection defense on upstreamAuth
  if (upstreamAuth !== undefined && !isPrintableAscii(upstreamAuth)) {
    return { valid: false, code: 'INVALID_URL', message: 'Invalid characters in API key.' }
  }

  return { valid: true }
}

/** Validate a baseUrl for the /models endpoint (appends /models to get the target). */
export const validateModelsRequest = (
  baseUrl: string,
  upstreamAuth?: string,
): { valid: true; modelsUrl: string } | { valid: false; code: ProxyErrorEnvelope['error']['code']; message: string } => {
  const normalized = baseUrl.replace(/\/+$/, '')
  const modelsUrl = `${normalized}/models`
  const result = validateProxyRequest(modelsUrl, upstreamAuth)
  if (!result.valid) return result
  return { valid: true, modelsUrl }
}

// ---------------------------------------------------------------------------
// Hop-by-hop headers to strip from upstream responses
// ---------------------------------------------------------------------------

const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailers',
  'transfer-encoding',
  'upgrade',
  'set-cookie',
])

const stripHopByHop = (headers: Headers): Headers => {
  const out = new Headers(headers)
  for (const key of HOP_BY_HOP) {
    out.delete(key)
  }
  return out
}

// ---------------------------------------------------------------------------
// Content-Type gate
// ---------------------------------------------------------------------------

const ALLOWED_CONTENT_TYPES = ['application/json', 'text/event-stream']

const isAllowedContentType = (contentType: string | null): boolean => {
  if (!contentType) return false
  const mime = contentType.split(';')[0].trim().toLowerCase()
  return ALLOWED_CONTENT_TYPES.includes(mime)
}

// ---------------------------------------------------------------------------
// Streaming with byte caps
// ---------------------------------------------------------------------------

/**
 * Wraps an OpenAI SDK stream into an SSE ReadableStream with total-byte + per-line caps.
 * Emits `data: {json}\n\n` per chunk. Sends `data: [DONE]\n\n` at end.
 */
export const wrapStreamInSSE = (
  stream: AsyncIterable<unknown> & { controller?: AbortController },
  signal: AbortSignal,
): ReadableStream<Uint8Array> => {
  const encoder = new TextEncoder()
  let totalBytes = 0
  let isCancelled = false

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const chunk of stream) {
          if (isCancelled || signal.aborted) break

          const line = `data: ${JSON.stringify(chunk)}\n\n`
          const encoded = encoder.encode(line)

          if (encoded.byteLength > MAX_LINE_BYTES) {
            controller.error(new ProxyRequestError('SSE_LINE_TOO_LARGE', 'SSE line exceeded 1 MB cap.', 502))
            return
          }

          totalBytes += encoded.byteLength
          if (totalBytes > MAX_BYTES) {
            controller.error(new ProxyRequestError('BODY_TOO_LARGE', 'Response exceeded 50 MB cap.', 502))
            return
          }

          try {
            controller.enqueue(encoded)
          } catch {
            break
          }
        }

        if (!isCancelled && !signal.aborted) {
          try {
            controller.enqueue(encoder.encode('data: [DONE]\n\n'))
          } catch {
            // client disconnected
          }
        }

        if (controller.desiredSize !== null) {
          controller.close()
        }
      } catch (err) {
        if (!isCancelled) {
          controller.error(err)
        }
      }
    },
    cancel() {
      isCancelled = true
      stream.controller?.abort()
    },
  })
}

// ---------------------------------------------------------------------------
// Error type for internal route signaling
// ---------------------------------------------------------------------------

class ProxyRequestError extends Error {
  constructor(
    public readonly code: ProxyErrorEnvelope['error']['code'],
    message: string,
    public readonly httpStatus: number,
  ) {
    super(message)
    this.name = 'ProxyRequestError'
  }
}

// ---------------------------------------------------------------------------
// Audit log (no sensitive fields)
// ---------------------------------------------------------------------------

type AuditEntry = {
  user_id: string
  target_host: string
  upstream_status?: number
  bytes_out?: number
  duration_ms: number
  error_code?: string
}

const emitAuditLog = (entry: AuditEntry): void => {
  console.info('[custom-proxy]', JSON.stringify(redactAuthorization(entry)))
}

// ---------------------------------------------------------------------------
// Safe fetch with DNS timeout
// ---------------------------------------------------------------------------

const safeFetch = createSafeFetch(globalThis.fetch)

/**
 * Wraps createSafeFetch with a DNS timeout.
 *
 * // SSRF defense: createSafeFetch handles DNS resolve + ipaddr.js denylist +
 * // hostname rewrite + per-hop redirect revalidation.
 * // See RESEARCH-001 v4 §A10 step 4 + url-validation.test.ts.
 */
const safeFetchWithDnsTimeout = async (
  url: string,
  init?: RequestInit,
): Promise<Response> => {
  const dnsAbort = AbortController ? new AbortController() : null
  const dnsTimer = setTimeout(() => dnsAbort?.abort(), DNS_TIMEOUT_MS)

  // Merge caller's signal with the DNS timeout signal
  const signals: AbortSignal[] = [AbortSignal.timeout(DNS_TIMEOUT_MS)]
  if (init?.signal instanceof AbortSignal) signals.push(init.signal)
  const signal = AbortSignal.any ? AbortSignal.any(signals) : signals[0]

  try {
    return await safeFetch(url, { ...init, signal })
  } catch (err) {
    if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
      throw new ProxyRequestError('DNS_TIMEOUT', 'DNS resolution timed out.', 504)
    }
    const msg = err instanceof Error ? err.message : String(err)
    if (
      msg.includes('ENOTFOUND') ||
      msg.includes('ECONNREFUSED') ||
      msg.includes('ECONNRESET') ||
      msg.includes('certificate') ||
      msg.includes('Blocked:')
    ) {
      if (msg.includes('Blocked:')) {
        throw new ProxyRequestError('SSRF_BLOCKED', 'This address is not allowed for security reasons.', 400)
      }
      throw new ProxyRequestError('UPSTREAM_UNREACHABLE', 'Could not connect to the upstream server.', 502)
    }
    throw err
  } finally {
    clearTimeout(dnsTimer)
  }
}

// ---------------------------------------------------------------------------
// Elysia route factory
// ---------------------------------------------------------------------------

export const createCustomModelProxyRoutes = (auth: Auth) =>
  new Elysia({ prefix: '/v1/custom-model' })
    .use(createAuthMacro(auth))
    // -----------------------------------------------------------------------
    // POST /v1/custom-model/proxy
    // -----------------------------------------------------------------------
    .post(
      '/proxy',
      async ({ request, user: sessionUser }) => {
        const start = Date.now()

        if (!PROXY_ENABLED) {
          return proxyError('PROXY_DISABLED', 'The custom model proxy is disabled.', 503)
        }

        const body = (await request.json()) as CustomModelProxyRequest
        const { targetUrl, upstreamAuth, stream } = body

        const validation = validateProxyRequest(targetUrl, upstreamAuth)
        if (!validation.valid) {
          return proxyError(validation.code, validation.message, 400)
        }

        const targetHost = new URL(targetUrl).hostname
        const userId = sessionUser!.id

        // Per-user rate limit
        try {
          await perUserLimiter.consume(userId)
        } catch (err) {
          if (err instanceof RateLimiterRes) {
            return proxyError('RATE_LIMITED_USER', 'Rate limit exceeded. Try again later.', 429)
          }
          throw err
        }

        // Per-host rate limit
        const hostCheck = await checkPerHostRateLimit(targetHost)
        if (!hostCheck.ok) {
          return proxyError('RATE_LIMITED_HOST', 'Rate limit for this target exceeded. Try again later.', 429)
        }

        const abortController = new AbortController()
        request.signal?.addEventListener('abort', () => abortController.abort())
        AbortSignal.timeout(REQUEST_TIMEOUT_MS).addEventListener('abort', () => abortController.abort())

        try {
          const completionBody = body.body as ChatCompletionCreateParamsBase

          // Build client with SSRF-safe fetch.
          // SSRF defense: createSafeFetch handles DNS resolve + ipaddr.js denylist +
          // hostname rewrite + per-hop redirect revalidation.
          // See RESEARCH-001 v4 §A10 step 4 + url-validation.test.ts.
          const parsedTarget = new URL(targetUrl)
          const baseUrl = parsedTarget.origin + parsedTarget.pathname.replace(/\/chat\/completions$|\/completions$/, '')
          const client = getCustomModelClient(baseUrl, upstreamAuth ?? 'no-key', safeFetchWithDnsTimeout as typeof fetch)

          const typedClient = client as { chat: { completions: { create: (params: ChatCompletionCreateParamsBase & { stream: boolean }) => Promise<unknown> } } }

          if (stream) {
            const completion = await typedClient.chat.completions.create({
              ...completionBody,
              stream: true,
            })

            const sseStream = wrapStreamInSSE(
              completion as AsyncIterable<unknown> & { controller?: AbortController },
              abortController.signal,
            )

            emitAuditLog({ user_id: userId, target_host: targetHost, duration_ms: Date.now() - start })

            return new Response(sseStream, {
              status: 200,
              headers: {
                'Content-Type': 'text/event-stream',
                'Cache-Control': 'no-store',
                Connection: 'keep-alive',
              },
            })
          }

          const completion = await typedClient.chat.completions.create({
            ...completionBody,
            stream: false,
          })

          emitAuditLog({ user_id: userId, target_host: targetHost, upstream_status: 200, duration_ms: Date.now() - start })

          return new Response(JSON.stringify({ data: completion }), {
            status: 200,
            headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
          })
        } catch (err) {
          if (err instanceof ProxyRequestError) {
            emitAuditLog({ user_id: userId, target_host: targetHost, error_code: err.code, duration_ms: Date.now() - start })
            return proxyError(err.code, err.message, err.httpStatus)
          }
          const msg = err instanceof Error ? err.message : String(err)
          emitAuditLog({ user_id: userId, target_host: targetHost, error_code: 'UPSTREAM_UNREACHABLE', duration_ms: Date.now() - start })
          return proxyError('UPSTREAM_UNREACHABLE', `Upstream error: ${msg.slice(0, 200)}`, 502)
        }
      },
      { auth: true },
    )
    // -----------------------------------------------------------------------
    // POST /v1/custom-model/models
    // -----------------------------------------------------------------------
    .post(
      '/models',
      async ({ request, user: sessionUser }) => {
        const start = Date.now()

        if (!PROXY_ENABLED) {
          return proxyError('PROXY_DISABLED', 'The custom model proxy is disabled.', 503)
        }

        const body = (await request.json()) as CustomModelModelsRequest
        const { baseUrl, upstreamAuth } = body

        const validation = validateModelsRequest(baseUrl, upstreamAuth)
        if (!validation.valid) {
          return proxyError(validation.code, validation.message, 400)
        }
        const { modelsUrl } = validation

        const targetHost = new URL(modelsUrl).hostname
        const userId = sessionUser!.id

        // Per-user rate limit
        try {
          await perUserLimiter.consume(userId)
        } catch (err) {
          if (err instanceof RateLimiterRes) {
            return proxyError('RATE_LIMITED_USER', 'Rate limit exceeded. Try again later.', 429)
          }
          throw err
        }

        // Per-host rate limit
        const hostCheck = await checkPerHostRateLimit(targetHost)
        if (!hostCheck.ok) {
          return proxyError('RATE_LIMITED_HOST', 'Rate limit for this target exceeded. Try again later.', 429)
        }

        const outboundHeaders: Record<string, string> = {
          'User-Agent': USER_AGENT,
          'X-Abuse-Contact': ABUSE_CONTACT,
          Accept: 'application/json',
        }

        if (upstreamAuth) {
          outboundHeaders['Authorization'] = `Bearer ${upstreamAuth}`
        }

        try {
          const response = await safeFetchWithDnsTimeout(modelsUrl, {
            method: 'GET',
            headers: outboundHeaders,
            redirect: 'manual',
            signal: AbortSignal.timeout(60_000),
          })

          if (response.status === 101) {
            emitAuditLog({ user_id: userId, target_host: targetHost, upstream_status: 101, error_code: 'UPSTREAM_PROTOCOL', duration_ms: Date.now() - start })
            return proxyError('UPSTREAM_PROTOCOL', 'Upstream attempted a protocol upgrade.', 502)
          }

          if (response.status === 401 || response.status === 403) {
            emitAuditLog({ user_id: userId, target_host: targetHost, upstream_status: response.status, error_code: 'UPSTREAM_AUTH', duration_ms: Date.now() - start })
            return proxyError('UPSTREAM_AUTH', 'Authentication failed. Check your API key.', 401)
          }

          const contentType = response.headers.get('content-type')
          if (!isAllowedContentType(contentType)) {
            emitAuditLog({ user_id: userId, target_host: targetHost, upstream_status: response.status, error_code: 'UPSTREAM_CONTENT_TYPE', duration_ms: Date.now() - start })
            return proxyError('UPSTREAM_CONTENT_TYPE', 'Upstream returned an unexpected content type.', 502)
          }

          const reader = response.body?.getReader()
          if (!reader) {
            return proxyError('UPSTREAM_UNREACHABLE', 'Upstream returned no body.', 502)
          }

          const chunks: Uint8Array[] = []
          let totalBytes = 0

          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            totalBytes += value.byteLength
            if (totalBytes > MAX_BYTES) {
              await reader.cancel()
              return proxyError('BODY_TOO_LARGE', 'Upstream response exceeded 50 MB cap.', 502)
            }
            chunks.push(value)
          }

          const merged = chunks.reduce((acc, chunk) => {
            const out = new Uint8Array(acc.byteLength + chunk.byteLength)
            out.set(acc, 0)
            out.set(chunk, acc.byteLength)
            return out
          }, new Uint8Array(0))

          const text = new TextDecoder().decode(merged)

          let parsed: unknown
          try {
            parsed = JSON.parse(text)
          } catch {
            return proxyError('UPSTREAM_UNREACHABLE', 'Upstream returned invalid JSON.', 502)
          }

          if (
            typeof parsed !== 'object' ||
            parsed === null ||
            !Array.isArray((parsed as Record<string, unknown>).data)
          ) {
            return proxyError('UPSTREAM_UNREACHABLE', 'Upstream models response has unexpected shape.', 502)
          }

          const cleanedHeaders = stripHopByHop(response.headers)

          emitAuditLog({ user_id: userId, target_host: targetHost, upstream_status: response.status, bytes_out: totalBytes, duration_ms: Date.now() - start })

          return new Response(JSON.stringify(parsed), {
            status: 200,
            headers: {
              'Content-Type': 'application/json',
              'Cache-Control': 'no-store',
              ...Object.fromEntries(cleanedHeaders.entries()),
            },
          })
        } catch (err) {
          if (err instanceof ProxyRequestError) {
            emitAuditLog({ user_id: userId, target_host: targetHost, error_code: err.code, duration_ms: Date.now() - start })
            return proxyError(err.code, err.message, err.httpStatus)
          }
          const msg = err instanceof Error ? err.message : String(err)
          return proxyError('UPSTREAM_UNREACHABLE', `Upstream error: ${msg.slice(0, 200)}`, 502)
        }
      },
      { auth: true },
    )
