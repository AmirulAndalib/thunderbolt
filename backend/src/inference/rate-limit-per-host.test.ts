/**
 * Unit tests for the per-host rate limiter helper.
 */
import { describe, expect, it, beforeEach } from 'bun:test'
import { checkPerHostRateLimit, resetPerHostLimiter } from './rate-limit-per-host'

describe('per-host rate limiter', () => {
  beforeEach(() => {
    resetPerHostLimiter({ points: 5, duration: 60 })
  })

  it('returns ok:true within the limit', async () => {
    const result = await checkPerHostRateLimit('allowed.example.com')
    expect(result.ok).toBe(true)
  })

  it('returns ok:false with retryAfterMs on exceed', async () => {
    for (let i = 0; i < 5; i++) {
      await checkPerHostRateLimit('exceed.example.com')
    }
    const result = await checkPerHostRateLimit('exceed.example.com')
    expect(result.ok).toBe(false)
    expect(result.retryAfterMs).toBeGreaterThan(0)
  })

  it('is keyed per host', async () => {
    for (let i = 0; i < 5; i++) {
      await checkPerHostRateLimit('full-host.example.com')
    }
    const otherResult = await checkPerHostRateLimit('different-host.example.com')
    expect(otherResult.ok).toBe(true)
  })
})
