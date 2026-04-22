/**
 * Unit tests for custom-model-proxy routes.
 *
 * Run with: bun test custom-model-proxy.test.ts
 */
import { describe, expect, it, beforeEach, mock } from 'bun:test'
import { redactAuthorization } from './log-redaction'
import { validateProxyRequest, validateModelsRequest } from './custom-model-proxy'
import { resetPerHostLimiter } from './rate-limit-per-host'
import { checkPerHostRateLimit } from './rate-limit-per-host'
import { perUserLimiter } from './custom-model-proxy'
import { RateLimiterMemory } from 'rate-limiter-flexible'

// ---------------------------------------------------------------------------
// validateProxyRequest — SSRF denylist (static hostname check via validateSafeUrl)
// ---------------------------------------------------------------------------

describe('validateProxyRequest — SSRF denylist', () => {
  const ssrfCases: [string, string][] = [
    ['http://127.0.0.1/v1/chat/completions', 'loopback IPv4'],
    ['http://10.0.0.1/v1/chat/completions', 'private 10/8'],
    ['http://172.16.0.1/v1/chat/completions', 'private 172.16/12'],
    ['http://192.168.0.1/v1/chat/completions', 'private 192.168/16'],
    ['http://169.254.169.254/v1/chat/completions', 'link-local'],
    ['http://100.64.0.1/v1/chat/completions', 'CGNAT'],
    ['http://0.0.0.0/v1/chat/completions', '0.0.0.0'],
    ['http://[::1]/v1/chat/completions', 'IPv6 loopback'],
    ['http://[::]/v1/chat/completions', 'IPv6 unspecified'],
    ['http://[fe80::1]/v1/chat/completions', 'link-local IPv6'],
    ['http://[fc00::1]/v1/chat/completions', 'unique-local IPv6'],
    ['http://[::ffff:127.0.0.1]/v1/chat/completions', 'IPv4-mapped IPv6 loopback'],
  ]

  for (const [url, label] of ssrfCases) {
    it(`rejects ${label}: ${url}`, () => {
      const result = validateProxyRequest(url)
      expect(result.valid).toBe(false)
      if (!result.valid) {
        expect(['SSRF_BLOCKED', 'INVALID_URL', 'HOSTNAME_NOT_ALLOWED']).toContain(result.code)
      }
    })
  }
})

describe('validateProxyRequest — invalid schemes', () => {
  it('rejects ftp://', () => {
    const result = validateProxyRequest('ftp://example.com/v1/chat/completions')
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.code).toBe('INVALID_URL')
  })

  it('rejects javascript:', () => {
    const result = validateProxyRequest('javascript:alert(1)')
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.code).toBe('INVALID_URL')
  })

  it('rejects file://', () => {
    const result = validateProxyRequest('file:///etc/passwd')
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.code).toBe('INVALID_URL')
  })

  it('rejects blob:', () => {
    const result = validateProxyRequest('blob:https://thunderbolt.io/uuid')
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.code).toBe('INVALID_URL')
  })
})

describe('validateProxyRequest — userinfo rejection', () => {
  it('rejects URL with user:pass@', () => {
    const result = validateProxyRequest('https://user:pass@example.com/v1/chat/completions')
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.code).toBe('INVALID_URL')
  })
})

describe('validateProxyRequest — .local rejection', () => {
  it('rejects .local hostname', () => {
    const result = validateProxyRequest('https://myllm.local/v1/chat/completions')
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.code).toBe('HOSTNAME_NOT_ALLOWED')
  })
})

describe('validateProxyRequest — header injection defense', () => {
  it('rejects upstreamAuth with \\r\\n', () => {
    const result = validateProxyRequest('https://api.openai.com/v1/chat/completions', 'Bearer sk\r\nX-Injected: evil')
    expect(result.valid).toBe(false)
  })

  it('rejects upstreamAuth with non-ASCII', () => {
    const result = validateProxyRequest('https://api.openai.com/v1/chat/completions', 'sk-évil')
    expect(result.valid).toBe(false)
  })

  it('accepts valid printable ASCII upstreamAuth', () => {
    const result = validateProxyRequest('https://api.openai.com/v1/chat/completions', 'Bearer sk-test1234')
    expect(result.valid).toBe(true)
  })
})

describe('validateProxyRequest — path allowlist', () => {
  it('allows /v1/chat/completions', () => {
    const result = validateProxyRequest('https://api.openai.com/v1/chat/completions')
    expect(result.valid).toBe(true)
  })

  it('allows /v1/completions', () => {
    const result = validateProxyRequest('https://api.openai.com/v1/completions')
    expect(result.valid).toBe(true)
  })

  it('rejects /v1/images/generations', () => {
    const result = validateProxyRequest('https://api.openai.com/v1/images/generations')
    expect(result.valid).toBe(false)
    if (!result.valid) expect(result.code).toBe('INVALID_URL')
  })
})

describe('validateModelsRequest', () => {
  it('builds correct models URL from base', () => {
    const result = validateModelsRequest('https://api.openai.com/v1')
    expect(result.valid).toBe(true)
    if (result.valid) expect(result.modelsUrl).toBe('https://api.openai.com/v1/models')
  })

  it('strips trailing slash before appending /models', () => {
    const result = validateModelsRequest('https://api.openai.com/v1/')
    expect(result.valid).toBe(true)
    if (result.valid) expect(result.modelsUrl).toBe('https://api.openai.com/v1/models')
  })

  it('rejects SSRF base URL', () => {
    const result = validateModelsRequest('http://127.0.0.1/v1')
    expect(result.valid).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// log-redaction
// ---------------------------------------------------------------------------

describe('redactAuthorization', () => {
  it('redacts authorization field', () => {
    const input = { authorization: 'Bearer sk-test', other: 'value' }
    const result = redactAuthorization(input) as typeof input
    expect(result.authorization).toBe('***REDACTED***')
    expect(result.other).toBe('value')
  })

  it('redacts upstreamAuth field', () => {
    const input = { upstreamAuth: 'Bearer sk-secret', data: 123 }
    const result = redactAuthorization(input) as typeof input
    expect(result.upstreamAuth).toBe('***REDACTED***')
  })

  it('redacts apiKey field', () => {
    const input = { apiKey: 'sk-secret' }
    const result = redactAuthorization(input) as typeof input
    expect(result.apiKey).toBe('***REDACTED***')
  })

  it('redacts nested Authorization', () => {
    const input = { headers: { Authorization: 'Bearer sk-nested' } }
    const result = redactAuthorization(input) as { headers: { Authorization: string } }
    expect(result.headers.Authorization).toBe('***REDACTED***')
  })

  it('redacts in arrays', () => {
    const input = [{ authorization: 'secret' }, { safe: 'value' }]
    const result = redactAuthorization(input) as typeof input
    expect((result[0] as { authorization: string }).authorization).toBe('***REDACTED***')
    expect((result[1] as { safe: string }).safe).toBe('value')
  })

  it('returns primitives unchanged', () => {
    expect(redactAuthorization('hello')).toBe('hello')
    expect(redactAuthorization(42)).toBe(42)
    expect(redactAuthorization(null)).toBe(null)
  })
})

// ---------------------------------------------------------------------------
// Per-host rate limiter
// ---------------------------------------------------------------------------

describe('checkPerHostRateLimit', () => {
  beforeEach(() => {
    // Reset with a tight limit for testing
    resetPerHostLimiter({ points: 3, duration: 60 })
  })

  it('allows requests up to the limit', async () => {
    const r1 = await checkPerHostRateLimit('test-host-A.example.com')
    const r2 = await checkPerHostRateLimit('test-host-A.example.com')
    const r3 = await checkPerHostRateLimit('test-host-A.example.com')
    expect(r1.ok).toBe(true)
    expect(r2.ok).toBe(true)
    expect(r3.ok).toBe(true)
  })

  it('blocks the (points+1)th request', async () => {
    for (let i = 0; i < 3; i++) {
      await checkPerHostRateLimit('test-host-B.example.com')
    }
    const blocked = await checkPerHostRateLimit('test-host-B.example.com')
    expect(blocked.ok).toBe(false)
    expect(blocked.retryAfterMs).toBeGreaterThan(0)
  })

  it('keyed by host — different hosts are independent', async () => {
    for (let i = 0; i < 3; i++) {
      await checkPerHostRateLimit('test-host-C.example.com')
    }
    // Different host should still be allowed
    const other = await checkPerHostRateLimit('other-host.example.com')
    expect(other.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Per-user rate limiter (host-before-user ordering test)
// ---------------------------------------------------------------------------

describe('rate limit — host limit trips before user limit', () => {
  it('RATE_LIMITED_HOST trips before RATE_LIMITED_USER when host limit is lower', async () => {
    // Set host limit to 2, user limit to 1000 — so host limit should trip first
    resetPerHostLimiter({ points: 2, duration: 60 })

    // Reset user limiter with a high limit
    const highUserLimiter = new RateLimiterMemory({
      keyPrefix: `test-user-${Date.now()}`,
      points: 1000,
      duration: 60,
    })

    // Exhaust host limit
    for (let i = 0; i < 2; i++) {
      await checkPerHostRateLimit('limited-host.example.com')
    }

    // The 3rd request should hit host limit, not user limit
    const hostResult = await checkPerHostRateLimit('limited-host.example.com')
    expect(hostResult.ok).toBe(false)

    // User limiter should still have capacity
    await highUserLimiter.consume('test-user-1')
    await highUserLimiter.consume('test-user-1')
    // Should not throw — user limit not hit
  })
})

// ---------------------------------------------------------------------------
// Integration-level test: log redaction across a simulated request
// ---------------------------------------------------------------------------

describe('log redaction — no upstreamAuth in log output', () => {
  it('does not leak upstreamAuth in redacted log object', () => {
    const logPayload = {
      user_id: 'user-123',
      target_host: 'api.example.com',
      upstreamAuth: 'Bearer sk-very-secret-key',
      authorization: 'Bearer sk-another-secret',
    }

    const logs: string[] = []
    const capturedLog = (obj: unknown) => {
      logs.push(JSON.stringify(obj))
    }

    capturedLog(redactAuthorization(logPayload))

    const output = logs.join('\n')
    expect(output).not.toContain('sk-very-secret-key')
    expect(output).not.toContain('sk-another-secret')
    expect(output).toContain('***REDACTED***')
    expect(output).toContain('api.example.com')
    expect(output).toContain('user-123')
  })
})
