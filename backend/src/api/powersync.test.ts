import type { Settings } from '@/config/settings'
import { createBetterAuthPlugin } from '@/auth/elysia-plugin'
import { session as sessionTable, user as userTable } from '@/db/auth-schema'
import { devicesTable, settingsTable } from '@/db/schema'
import { createTestDb } from '@/test-utils/db'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { Elysia } from 'elysia'
import { createPowerSyncRoutes } from './powersync'

const powersyncSettings: Settings = {
  fireworksApiKey: '',
  mistralApiKey: '',
  anthropicApiKey: '',
  exaApiKey: '',
  thunderboltInferenceUrl: '',
  thunderboltInferenceApiKey: '',
  monitoringToken: '',
  googleClientId: '',
  googleClientSecret: '',
  microsoftClientId: '',
  microsoftClientSecret: '',
  logLevel: 'INFO',
  port: 8000,
  posthogHost: '',
  posthogApiKey: '',
  corsOrigins: '',
  corsOriginRegex: '',
  corsAllowCredentials: true,
  corsAllowMethods: '',
  corsAllowHeaders: '',
  corsExposeHeaders: '',
  waitlistEnabled: false,
  powersyncUrl: 'https://powersync.example.com',
  powersyncJwtKid: 'test-kid',
  powersyncJwtSecret: 'test-jwt-secret-min-32-chars-long',
  powersyncTokenExpirySeconds: 3600,
}

describe('PowerSync API', () => {
  let app: Elysia
  let db: Awaited<ReturnType<typeof createTestDb>>['db']
  let cleanup: () => Promise<void>

  beforeEach(async () => {
    const testEnv = await createTestDb()
    db = testEnv.db
    cleanup = testEnv.cleanup
    const { auth } = createBetterAuthPlugin(db)
    app = new Elysia().use(createPowerSyncRoutes(auth, powersyncSettings, db)) as unknown as Elysia
  })

  afterEach(async () => {
    await cleanup()
  })

  describe('GET /powersync/token', () => {
    it('returns 401 when no session and no Bearer token', async () => {
      const response = await app.handle(new Request('http://localhost/powersync/token'))
      expect(response.status).toBe(401)
      const data = await response.json()
      expect(data).toEqual({ error: 'Unauthorized' })
    })

    it('returns 401 when Bearer token does not match any session', async () => {
      const response = await app.handle(
        new Request('http://localhost/powersync/token', {
          headers: { Authorization: 'Bearer invalid-token' },
        }),
      )
      expect(response.status).toBe(401)
      const data = await response.json()
      expect(data).toEqual({ error: 'Unauthorized' })
    })

    it('returns 403 when device is revoked', async () => {
      const userId = 'user-revoked-device'
      const now = new Date()
      const expiresAt = new Date(now.getTime() + 3600 * 1000)

      await db.insert(userTable).values({
        id: userId,
        name: 'Revoked Device User',
        email: 'revoked-powersync@example.com',
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })

      await db.insert(sessionTable).values({
        id: 'session-revoked',
        expiresAt,
        token: 'bearer-revoked-device',
        createdAt: now,
        updatedAt: now,
        userId,
      })

      const revokedAt = Math.floor(Date.now() / 1000)
      await db.insert(devicesTable).values({
        id: 'revoked-device-id',
        userId,
        name: 'Revoked Device',
        lastSeen: revokedAt - 60,
        createdAt: revokedAt - 120,
        revokedAt,
      })

      const response = await app.handle(
        new Request('http://localhost/powersync/token', {
          headers: {
            Authorization: 'Bearer bearer-revoked-device',
            'x-device-id': 'revoked-device-id',
          },
        }),
      )
      expect(response.status).toBe(403)
      const data = await response.json()
      expect(data).toEqual({ code: 'DEVICE_DISCONNECTED' })
    })

    it('returns token and powerSyncUrl when authenticated via session', async () => {
      const userId = 'user-powersync-token'
      const now = new Date()
      const expiresAt = new Date(now.getTime() + 3600 * 1000)

      await db.insert(userTable).values({
        id: userId,
        name: 'PowerSync User',
        email: 'powersync-token@example.com',
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })

      await db.insert(sessionTable).values({
        id: 'session-powersync-token',
        expiresAt,
        token: 'bearer-powersync-valid',
        createdAt: now,
        updatedAt: now,
        userId,
      })

      const response = await app.handle(
        new Request('http://localhost/powersync/token', {
          headers: { Authorization: 'Bearer bearer-powersync-valid' },
        }),
      )
      expect(response.status).toBe(200)
      const data = (await response.json()) as { token: string; expiresAt: string; powerSyncUrl: string }
      expect(data.token).toBeDefined()
      expect(typeof data.token).toBe('string')
      expect(data.expiresAt).toBeDefined()
      expect(data.powerSyncUrl).toBe('https://powersync.example.com')
    })

    it('upserts device when x-device-id and x-device-name are provided', async () => {
      const userId = 'user-device-upsert'
      const now = new Date()
      const expiresAt = new Date(now.getTime() + 3600 * 1000)

      await db.insert(userTable).values({
        id: userId,
        name: 'Device User',
        email: 'device-powersync@example.com',
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })

      await db.insert(sessionTable).values({
        id: 'session-device-upsert',
        expiresAt,
        token: 'bearer-device-upsert',
        createdAt: now,
        updatedAt: now,
        userId,
      })

      const response = await app.handle(
        new Request('http://localhost/powersync/token', {
          headers: {
            Authorization: 'Bearer bearer-device-upsert',
            'x-device-id': 'device-123',
            'x-device-name': 'My Phone',
          },
        }),
      )
      expect(response.status).toBe(200)

      const devices = await db.select().from(devicesTable).where(eq(devicesTable.id, 'device-123'))
      expect(devices).toHaveLength(1)
      expect(devices[0]?.userId).toBe(userId)
      expect(devices[0]?.name).toBe('My Phone')
    })
  })

  describe('PUT /powersync/upload', () => {
    it('returns 401 when not authenticated', async () => {
      const response = await app.handle(
        new Request('http://localhost/powersync/upload', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ operations: [] }),
        }),
      )
      expect(response.status).toBe(401)
      const data = await response.json()
      expect(data).toEqual({ error: 'Unauthorized' })
    })

    it('returns 422 when body schema is invalid (operations not an array)', async () => {
      const userId = 'user-upload-validation'
      const now = new Date()
      const expiresAt = new Date(now.getTime() + 3600 * 1000)

      await db.insert(userTable).values({
        id: userId,
        name: 'Upload User',
        email: 'upload-validation@example.com',
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })

      await db.insert(sessionTable).values({
        id: 'session-upload-validation',
        expiresAt,
        token: 'bearer-upload-validation',
        createdAt: now,
        updatedAt: now,
        userId,
      })

      const response = await app.handle(
        new Request('http://localhost/powersync/upload', {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer bearer-upload-validation',
          },
          body: JSON.stringify({ operations: 'not-an-array' }),
        }),
      )
      expect(response.status).toBe(422)
    })

    it('returns 200 and applies PUT operation to settings', async () => {
      const userId = 'user-upload-put'
      const now = new Date()
      const expiresAt = new Date(now.getTime() + 3600 * 1000)

      await db.insert(userTable).values({
        id: userId,
        name: 'Upload Put User',
        email: 'upload-put@example.com',
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })

      await db.insert(sessionTable).values({
        id: 'session-upload-put',
        expiresAt,
        token: 'bearer-upload-put',
        createdAt: now,
        updatedAt: now,
        userId,
      })

      const response = await app.handle(
        new Request('http://localhost/powersync/upload', {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer bearer-upload-put',
          },
          body: JSON.stringify({
            operations: [
              {
                op: 'PUT' as const,
                type: 'settings',
                id: 'test_setting_key',
                data: { value: 'test_value' },
              },
            ],
          }),
        }),
      )
      expect(response.status).toBe(200)
      const data = (await response.json()) as { success: boolean }
      expect(data.success).toBe(true)

      const rows = await db.select().from(settingsTable).where(eq(settingsTable.key, 'test_setting_key'))
      expect(rows).toHaveLength(1)
      expect(rows[0]?.value).toBe('test_value')
      expect(rows[0]?.userId).toBe(userId)
    })

    it('returns 200 and applies PATCH operation', async () => {
      const userId = 'user-upload-patch'
      const now = new Date()
      const expiresAt = new Date(now.getTime() + 3600 * 1000)

      await db.insert(userTable).values({
        id: userId,
        name: 'Upload Patch User',
        email: 'upload-patch@example.com',
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })

      await db.insert(sessionTable).values({
        id: 'session-upload-patch',
        expiresAt,
        token: 'bearer-upload-patch',
        createdAt: now,
        updatedAt: now,
        userId,
      })

      await db.insert(settingsTable).values({
        key: 'patch_setting',
        value: 'initial',
        userId,
      })

      const response = await app.handle(
        new Request('http://localhost/powersync/upload', {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer bearer-upload-patch',
          },
          body: JSON.stringify({
            operations: [
              {
                op: 'PATCH' as const,
                type: 'settings',
                id: 'patch_setting',
                data: { value: 'updated_value' },
              },
            ],
          }),
        }),
      )
      expect(response.status).toBe(200)

      const rows = await db.select().from(settingsTable).where(eq(settingsTable.key, 'patch_setting'))
      expect(rows).toHaveLength(1)
      expect(rows[0]?.value).toBe('updated_value')
    })

    it('returns 200 and applies DELETE operation', async () => {
      const userId = 'user-upload-delete'
      const now = new Date()
      const expiresAt = new Date(now.getTime() + 3600 * 1000)

      await db.insert(userTable).values({
        id: userId,
        name: 'Upload Delete User',
        email: 'upload-delete@example.com',
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })

      await db.insert(sessionTable).values({
        id: 'session-upload-delete',
        expiresAt,
        token: 'bearer-upload-delete',
        createdAt: now,
        updatedAt: now,
        userId,
      })

      await db.insert(settingsTable).values({
        key: 'to_delete',
        value: 'x',
        userId,
      })

      const response = await app.handle(
        new Request('http://localhost/powersync/upload', {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer bearer-upload-delete',
          },
          body: JSON.stringify({
            operations: [{ op: 'DELETE' as const, type: 'settings', id: 'to_delete' }],
          }),
        }),
      )
      expect(response.status).toBe(200)

      const rows = await db.select().from(settingsTable).where(eq(settingsTable.key, 'to_delete'))
      expect(rows).toHaveLength(0)
    })

    it('returns 200 with empty operations array', async () => {
      const userId = 'user-upload-empty'
      const now = new Date()
      const expiresAt = new Date(now.getTime() + 3600 * 1000)

      await db.insert(userTable).values({
        id: userId,
        name: 'Empty Ops User',
        email: 'upload-empty@example.com',
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      })

      await db.insert(sessionTable).values({
        id: 'session-upload-empty',
        expiresAt,
        token: 'bearer-upload-empty',
        createdAt: now,
        updatedAt: now,
        userId,
      })

      const response = await app.handle(
        new Request('http://localhost/powersync/upload', {
          method: 'PUT',
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer bearer-upload-empty',
          },
          body: JSON.stringify({ operations: [] }),
        }),
      )
      expect(response.status).toBe(200)
      const data = (await response.json()) as { success: boolean }
      expect(data.success).toBe(true)
    })
  })
})

describe('PowerSync API (not configured)', () => {
  it('GET /powersync/token returns 404 when PowerSync is not configured', async () => {
    const testEnv = await createTestDb()
    const { auth } = createBetterAuthPlugin(testEnv.db)
    const noPowersyncSettings: Settings = {
      ...powersyncSettings,
      powersyncJwtSecret: '',
      powersyncUrl: '',
    }
    const app = new Elysia().use(createPowerSyncRoutes(auth, noPowersyncSettings, testEnv.db)) as unknown as Elysia

    const response = await app.handle(new Request('http://localhost/powersync/token'))
    expect(response.status).toBe(404)

    await testEnv.cleanup()
  })
})
