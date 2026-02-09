import type { Auth } from '@/auth/elysia-plugin'
import type { Settings } from '@/config/settings'
import { session as sessionTable, user as userTable } from '@/db/auth-schema'
import type { db as DbType } from '@/db/client'
import { powersyncTablesByName } from '@/db/powersync-schema'
import { devicesTable } from '@/db/schema'
import { powersyncTableNames } from '@shared/powersync-tables'
import { jwt } from '@elysiajs/jwt'
import { and, eq, gt, sql } from 'drizzle-orm'
import { getTableColumns } from 'drizzle-orm'
import type { AnyPgTable } from 'drizzle-orm/pg-core'
import { Elysia, t } from 'elysia'

const validTables = new Set<string>(powersyncTableNames)

/**
 * Valid column names per PowerSync table (DB names), derived from the schema.
 * Used to reject unknown columns and prevent SQL injection.
 * This is a defense-in-depth measure alongside identifier escaping.
 */
const validColumnsByTableName: Record<string, Set<string>> = Object.fromEntries(
  (Object.entries(powersyncTablesByName) as [string, AnyPgTable][]).map(([tableName, table]) => [
    tableName,
    new Set(Object.values(getTableColumns(table)).map((col) => col.name)),
  ]),
)

/**
 * Escape a PostgreSQL identifier (table/column name) by doubling internal double quotes.
 * Prevents SQL injection when building dynamic SQL.
 */
const escapeIdentifier = (name: string): string => `"${name.replace(/"/g, '""')}"`

/**
 * PowerSync operation types from the upload queue
 */
type PowerSyncOperation = {
  op: 'PUT' | 'PATCH' | 'DELETE'
  type: string // table name
  id: string
  data?: Record<string, unknown>
}

/**
 * Escape a SQL string value to prevent injection
 */
const escapeValue = (value: unknown): string => {
  if (value === null || value === undefined) {
    return 'NULL'
  }
  if (typeof value === 'number') {
    return String(value)
  }
  if (typeof value === 'boolean') {
    return value ? 'TRUE' : 'FALSE'
  }
  // Escape single quotes by doubling them
  return `'${String(value).replace(/'/g, "''")}'`
}

/**
 * Apply a single PowerSync operation to the database using raw SQL.
 * The user_id is always set to the authenticated user to ensure data isolation.
 */
const applyOperation = async (op: PowerSyncOperation, userId: string, database: typeof DbType): Promise<void> => {
  if (!validTables.has(op.type)) {
    console.warn(`Unknown table: ${op.type}`)
    return
  }

  const validColumns = validColumnsByTableName[op.type]
  if (!validColumns) {
    return
  }

  const tableIdent = escapeIdentifier(op.type)

  switch (op.op) {
    case 'PUT': {
      // id and user_id are never taken from payload; always use op.id and session userId.
      const payload = { ...op.data } as Record<string, unknown>
      delete payload.id
      delete payload.user_id
      const rawData: Record<string, unknown> = { ...payload, id: op.id, user_id: userId }
      const allData: Record<string, unknown> = {}
      for (const k of Object.keys(rawData)) {
        if (validColumns.has(k)) {
          allData[k] = rawData[k]
        }
      }
      const columns = Object.keys(allData).map(escapeIdentifier).join(', ')
      const values = Object.values(allData).map(escapeValue).join(', ')

      // Never SET id or user_id from EXCLUDED; always restrict UPDATE to current user's row
      const updateColumns = Object.keys(allData).filter((k) => k !== 'id' && k !== 'user_id')
      const userWhere = `WHERE ${tableIdent}.${escapeIdentifier('user_id')} = ${escapeValue(userId)}`
      const updateClause =
        updateColumns.length > 0
          ? `DO UPDATE SET ${updateColumns.map((k) => `${escapeIdentifier(k)} = EXCLUDED.${escapeIdentifier(k)}`).join(', ')} ${userWhere}`
          : 'DO NOTHING'

      const query = `INSERT INTO ${tableIdent} (${columns}) VALUES (${values}) ON CONFLICT (id) ${updateClause}`

      await database.execute(sql.raw(query))

      break
    }
    case 'PATCH': {
      if (!op.data || Object.keys(op.data).length === 0) {
        console.warn('PATCH operation missing data')
        return
      }
      // Never SET id or user_id from payload; only update other columns.
      const patchPayload = { ...op.data } as Record<string, unknown>
      delete patchPayload.id
      delete patchPayload.user_id
      const setClauses = Object.entries(patchPayload)
        .filter(([key]) => validColumns.has(key))
        .map(([key, value]) => `${escapeIdentifier(key)} = ${escapeValue(value)}`)
        .join(', ')
      if (setClauses === '') {
        return
      }

      const query = `UPDATE ${tableIdent} SET ${setClauses} WHERE ${escapeIdentifier('id')} = ${escapeValue(op.id)} AND ${escapeIdentifier('user_id')} = ${escapeValue(userId)}`

      await database.execute(sql.raw(query))

      break
    }
    case 'DELETE': {
      const query = `DELETE FROM ${tableIdent} WHERE ${escapeIdentifier('id')} = ${escapeValue(op.id)} AND ${escapeIdentifier('user_id')} = ${escapeValue(userId)}`

      await database.execute(sql.raw(query))

      break
    }
  }
}

/**
 * PowerSync API routes for JWT token generation and data sync.
 *
 * GET /token: Issues a PowerSync JWT so the client can connect. Two auth paths:
 * - Session (cookie/header): user from derive; we check device revoked, upsert device, then issue token.
 * - Bearer token only (credential refresh): resolve session → user; 410 if user deleted, else issue new JWT and return 200.
 * Status codes: 410 = account deleted, 403 = device revoked (client should reset); 401 = no/invalid Bearer token.
 *
 * PUT /upload: Applies batched CRUD from PowerSync; requires authenticated user.
 *
 * Returns an empty Elysia instance if PowerSync is not configured.
 */
export const createPowerSyncRoutes = (auth: Auth, settings: Settings, database: typeof DbType): Elysia => {
  if (!settings.powersyncJwtSecret) {
    console.warn('PowerSync is not configured, skipping PowerSync routes')
    return new Elysia({ prefix: '/powersync' })
  }

  return new Elysia({ prefix: '/powersync' })
    .use(
      jwt({
        name: 'powersyncJwt',
        secret: settings.powersyncJwtSecret,
        exp: `${settings.powersyncTokenExpirySeconds}s`,
        aud: 'powersync',
        kid: settings.powersyncJwtKid,
      }),
    )
    .derive(async ({ request }) => {
      const session = await auth.api.getSession({ headers: request.headers })
      return { user: session?.user ?? null }
    })
    .get('/token', async ({ powersyncJwt, request, set, user }) => {
      if (!settings.powersyncUrl || !settings.powersyncJwtSecret) {
        set.status = 503
        return { error: 'PowerSync is not configured' }
      }

      // Path 1: Authenticated via session. Issue PowerSync JWT; check device revoked, then upsert device.
      if (user) {
        const deviceId = request.headers.get('x-device-id')
        if (deviceId) {
          const deviceRow = await database
            .select({ revokedAt: devicesTable.revokedAt })
            .from(devicesTable)
            .where(and(eq(devicesTable.id, deviceId), eq(devicesTable.userId, user.id)))
            .limit(1)
            .then((rows) => rows[0])
          if (deviceRow?.revokedAt != null) {
            set.status = 403
            return { code: 'DEVICE_DISCONNECTED' }
          }
        }

        const token = await powersyncJwt.sign({
          sub: user.id,
          user_id: user.id,
        })
        const expiresAt = new Date(Date.now() + settings.powersyncTokenExpirySeconds * 1000).toISOString()

        const deviceName = request.headers.get('x-device-name')
        const isDeviceNameValid = deviceName && deviceName.length > 0 && deviceName.length <= 100

        if (deviceId && isDeviceNameValid) {
          const now = Math.floor(Date.now() / 1000)
          await database
            .insert(devicesTable)
            // Upsert device for Settings > Devices list and last-seen; synced via PowerSync.
            .values({
              id: deviceId,
              userId: user.id,
              name: deviceName,
              lastSeen: now,
              createdAt: now,
            })
            .onConflictDoUpdate({
              target: devicesTable.id,
              set: { lastSeen: now, name: deviceName },
              where: eq(devicesTable.userId, user.id),
            })
        }

        return { token, expiresAt, powerSyncUrl: settings.powersyncUrl }
      }

      // Path 2: No session; Bearer token only. Resolve session → user; 410 if user deleted (e.g. account deleted elsewhere).
      const authHeader = request.headers.get('authorization')
      const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7).trim() : null
      if (!bearerToken) {
        set.status = 401
        return { error: 'Unauthorized' }
      }

      const sessionRow = await database
        .select({ userId: sessionTable.userId })
        .from(sessionTable)
        .where(and(eq(sessionTable.token, bearerToken), gt(sessionTable.expiresAt, new Date())))
        .limit(1)
        .then((rows) => rows[0])
      if (!sessionRow) {
        set.status = 401
        return { error: 'Unauthorized' }
      }

      const userRow = await database
        .select({ id: userTable.id })
        .from(userTable)
        .where(eq(userTable.id, sessionRow.userId))
        .limit(1)
        .then((rows) => rows[0])
      if (!userRow) {
        set.status = 410
        return { code: 'ACCOUNT_DELETED' }
      }

      // Token refresh: valid Bearer + user exists → issue new PowerSync JWT (same as Path 1).
      const userId = sessionRow.userId
      const deviceId = request.headers.get('x-device-id')
      if (deviceId) {
        const deviceRow = await database
          .select({ revokedAt: devicesTable.revokedAt })
          .from(devicesTable)
          .where(and(eq(devicesTable.id, deviceId), eq(devicesTable.userId, userId)))
          .limit(1)
          .then((rows) => rows[0])
        if (deviceRow?.revokedAt != null) {
          set.status = 403
          return { code: 'DEVICE_DISCONNECTED' }
        }
      }

      const token = await powersyncJwt.sign({
        sub: userId,
        user_id: userId,
      })
      const expiresAt = new Date(Date.now() + settings.powersyncTokenExpirySeconds * 1000).toISOString()

      const deviceName = request.headers.get('x-device-name')
      const isDeviceNameValid = deviceName && deviceName.length > 0 && deviceName.length <= 100
      if (deviceId && isDeviceNameValid) {
        const now = Math.floor(Date.now() / 1000)
        await database
          .insert(devicesTable)
          .values({
            id: deviceId,
            userId,
            name: deviceName,
            lastSeen: now,
            createdAt: now,
          })
          .onConflictDoUpdate({
            target: devicesTable.id,
            set: { lastSeen: now, name: deviceName },
            where: eq(devicesTable.userId, userId),
          })
      }

      return { token, expiresAt, powerSyncUrl: settings.powersyncUrl }
    })
    .put(
      '/upload',
      async ({ body, set, user }) => {
        // Requires authenticated user; applies batched CRUD from PowerSync.
        if (!user) {
          set.status = 401
          return { error: 'Unauthorized' }
        }
        const operations = body.operations as PowerSyncOperation[]

        if (!Array.isArray(operations)) {
          set.status = 400
          return { error: 'Invalid request: operations must be an array' }
        }

        // Process operations sequentially to maintain order
        for (const op of operations) {
          try {
            await applyOperation(op, user.id, database)
          } catch (error) {
            console.error(`Failed to apply operation:`, op, error)
            // Continue processing other operations
            // PowerSync recommends returning 2xx even for validation errors
          }
        }

        return { success: true }
      },
      {
        body: t.Object({
          operations: t.Array(
            t.Object({
              op: t.Union([t.Literal('PUT'), t.Literal('PATCH'), t.Literal('DELETE')]),
              type: t.String(),
              id: t.String(),
              data: t.Optional(t.Record(t.String(), t.Unknown())),
            }),
          ),
        }),
      },
    )
}
