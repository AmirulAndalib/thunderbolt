import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { createTestDb } from '@/test-utils/db'
import { createWsTicket, consumeWsTicket } from '@/auth/ws-ticket'
import { agentsTable } from '@/db/powersync-schema'
import { user } from '@/db/auth-schema'
import { parseApiKey } from './routes'

let db: Awaited<ReturnType<typeof createTestDb>>['db']
let cleanup: () => Promise<void>

const testUserId = 'test-user-id'

const seedTestUser = async () => {
  await db.insert(user).values({
    id: testUserId,
    name: 'Test User',
    email: 'test@example.com',
    emailVerified: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  })
}

const seedTestAgent = async (overrides: Partial<typeof agentsTable.$inferInsert> = {}) => {
  const defaults = {
    id: 'agent-test-1',
    name: 'Test Agent',
    type: 'remote',
    transport: 'websocket',
    url: 'wss://agent.example.com/acp',
    isSystem: 0,
    enabled: 1,
    userId: testUserId,
  }
  await db.insert(agentsTable).values({ ...defaults, ...overrides })
}

beforeEach(async () => {
  const testDb = await createTestDb()
  db = testDb.db
  cleanup = testDb.cleanup
  await seedTestUser()
})

afterEach(async () => {
  await cleanup()
})

describe('parseApiKey', () => {
  it('extracts apiKey from valid JSON', () => {
    expect(parseApiKey('{"apiKey":"sk-test-123"}')).toBe('sk-test-123')
  })

  it('returns null for null input', () => {
    expect(parseApiKey(null)).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(parseApiKey('')).toBeNull()
  })

  it('returns null for invalid JSON', () => {
    expect(parseApiKey('not-json')).toBeNull()
  })

  it('returns null when apiKey is missing from JSON', () => {
    expect(parseApiKey('{"other":"value"}')).toBeNull()
  })
})

describe('agent-proxy route — DB lookup', () => {
  it('finds agent by id and userId', async () => {
    await seedTestAgent({ authMethod: '{"apiKey":"sk-secret"}' })

    const result = await db.select().from(agentsTable)
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe('agent-test-1')
    expect(result[0].url).toBe('wss://agent.example.com/acp')
    expect(result[0].authMethod).toBe('{"apiKey":"sk-secret"}')
    expect(result[0].userId).toBe(testUserId)
  })

  it('does not find agent for wrong userId', async () => {
    await seedTestAgent()

    const { and, eq } = await import('drizzle-orm')
    const result = await db
      .select()
      .from(agentsTable)
      .where(and(eq(agentsTable.id, 'agent-test-1'), eq(agentsTable.userId, 'wrong-user')))

    expect(result).toHaveLength(0)
  })

  it('does not find agent for wrong agentId', async () => {
    await seedTestAgent()

    const { and, eq } = await import('drizzle-orm')
    const result = await db
      .select()
      .from(agentsTable)
      .where(and(eq(agentsTable.id, 'wrong-agent'), eq(agentsTable.userId, testUserId)))

    expect(result).toHaveLength(0)
  })
})

describe('ws-ticket integration for agent-proxy', () => {
  it('creates and consumes a valid ticket', () => {
    const ticket = createWsTicket(testUserId)
    const result = consumeWsTicket(ticket)
    expect(result?.userId).toBe(testUserId)
  })

  it('rejects a consumed ticket on second use', () => {
    const ticket = createWsTicket(testUserId)
    consumeWsTicket(ticket)
    expect(consumeWsTicket(ticket)).toBeNull()
  })

  it('rejects an invalid ticket', () => {
    expect(consumeWsTicket('bogus-ticket')).toBeNull()
  })
})
