/**
 * Unit tests for log-redaction.ts
 */
import { describe, expect, it } from 'bun:test'
import { redactAuthorization, buildPinoSerializers } from './log-redaction'

describe('redactAuthorization', () => {
  it('redacts authorization (lowercase)', () => {
    const result = redactAuthorization({ authorization: 'Bearer sk-test' }) as Record<string, unknown>
    expect(result.authorization).toBe('***REDACTED***')
  })

  it('redacts Authorization (Title-case)', () => {
    const result = redactAuthorization({ Authorization: 'Bearer sk-test' }) as Record<string, unknown>
    expect(result.Authorization).toBe('***REDACTED***')
  })

  it('redacts upstreamAuth', () => {
    const result = redactAuthorization({ upstreamAuth: 'sk-test' }) as Record<string, unknown>
    expect(result.upstreamAuth).toBe('***REDACTED***')
  })

  it('redacts apiKey', () => {
    const result = redactAuthorization({ apiKey: 'sk-test' }) as Record<string, unknown>
    expect(result.apiKey).toBe('***REDACTED***')
  })

  it('redacts api_key', () => {
    const result = redactAuthorization({ api_key: 'sk-test' }) as Record<string, unknown>
    expect(result.api_key).toBe('***REDACTED***')
  })

  it('redacts x-api-key', () => {
    const result = redactAuthorization({ 'x-api-key': 'sk-test' }) as Record<string, unknown>
    expect(result['x-api-key']).toBe('***REDACTED***')
  })

  it('does not modify safe keys', () => {
    const result = redactAuthorization({ target_host: 'api.openai.com', user_id: 'u-123' }) as Record<string, unknown>
    expect(result.target_host).toBe('api.openai.com')
    expect(result.user_id).toBe('u-123')
  })

  it('handles deeply nested objects', () => {
    const input = { a: { b: { authorization: 'secret' } } }
    const result = redactAuthorization(input) as typeof input
    expect(result.a.b.authorization).toBe('***REDACTED***')
  })

  it('handles arrays', () => {
    const input = [{ authorization: 'secret' }, { safe: 'value' }]
    const result = redactAuthorization(input) as typeof input
    expect((result[0] as Record<string, unknown>).authorization).toBe('***REDACTED***')
    expect((result[1] as Record<string, unknown>).safe).toBe('value')
  })

  it('passes through primitives', () => {
    expect(redactAuthorization(42)).toBe(42)
    expect(redactAuthorization('text')).toBe('text')
    expect(redactAuthorization(null)).toBe(null)
    expect(redactAuthorization(undefined)).toBe(undefined)
    expect(redactAuthorization(true)).toBe(true)
  })
})

describe('buildPinoSerializers', () => {
  it('returns req and res serializers', () => {
    const serializers = buildPinoSerializers()
    expect(typeof serializers.req).toBe('function')
    expect(typeof serializers.res).toBe('function')
  })

  it('req serializer redacts authorization', () => {
    const serializers = buildPinoSerializers()
    const redacted = serializers.req({ headers: { authorization: 'Bearer sk-test' } }) as Record<string, unknown>
    const headers = redacted.headers as Record<string, unknown>
    expect(headers.authorization).toBe('***REDACTED***')
  })
})
