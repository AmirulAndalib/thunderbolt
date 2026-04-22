/**
 * Authorization header and credential redaction utilities.
 *
 * Scrubs sensitive fields from structured log objects before they are
 * emitted to pino, PostHog, or Sentry. Used by custom-model-proxy routes
 * to ensure upstreamAuth / apiKey / Authorization never reach any log sink.
 */

const REDACTED = '***REDACTED***'

/** Fields to redact, checked case-insensitively at any depth. */
const SENSITIVE_KEYS = new Set(['authorization', 'upstreamauth', 'apikey', 'api_key', 'x-api-key'])

/**
 * Deep-clone a plain object, replacing sensitive fields with REDACTED.
 *
 * Only handles plain objects and arrays — does not recurse into class instances.
 * Safe to call on arbitrary log payloads before passing to pino/PostHog/Sentry.
 */
export const redactAuthorization = (obj: unknown): unknown => {
  if (Array.isArray(obj)) {
    return obj.map(redactAuthorization)
  }

  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.has(key.toLowerCase())) {
        result[key] = REDACTED
      } else {
        result[key] = redactAuthorization(value)
      }
    }
    return result
  }

  return obj
}

/**
 * Build a pino serializer that redacts Authorization from all log records.
 *
 * Usage:
 *   pino({ serializers: buildPinoSerializers() })
 */
export const buildPinoSerializers = (): Record<string, (value: unknown) => unknown> => ({
  req: (req: unknown) => redactAuthorization(req),
  res: (res: unknown) => redactAuthorization(res),
})
