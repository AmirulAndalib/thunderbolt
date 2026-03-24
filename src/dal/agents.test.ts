import { getDb } from '@/db/database'
import { agentsTable, settingsTable } from '@/db/tables'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test'
import { v7 as uuidv7 } from 'uuid'
import { getAllAgents, getAvailableAgents, getAgent, getSelectedAgent } from './agents'
import { resetTestDatabase, setupTestDatabase, teardownTestDatabase } from './test-utils'

beforeAll(async () => {
  await setupTestDatabase()
})

afterAll(async () => {
  await teardownTestDatabase()
})

describe('Agents DAL', () => {
  beforeEach(async () => {
    await resetTestDatabase()
  })

  describe('getAllAgents', () => {
    it('should return empty array when no agents exist', async () => {
      const agents = await getAllAgents(getDb())
      expect(agents).toEqual([])
    })

    it('should return all agents excluding soft-deleted', async () => {
      const db = getDb()
      await db.insert(agentsTable).values([
        { id: uuidv7(), name: 'Agent 1', type: 'built-in', transport: 'in-process', isSystem: 1 },
        { id: uuidv7(), name: 'Agent 2', type: 'local', transport: 'stdio' },
        { id: uuidv7(), name: 'Deleted', type: 'remote', transport: 'websocket', deletedAt: new Date().toISOString() },
      ])

      const agents = await getAllAgents(getDb())
      expect(agents).toHaveLength(2)
    })

    it('should sort system agents first', async () => {
      const db = getDb()
      await db.insert(agentsTable).values([
        { id: uuidv7(), name: 'Custom Agent', type: 'remote', transport: 'websocket', isSystem: 0 },
        { id: uuidv7(), name: 'Built-in', type: 'built-in', transport: 'in-process', isSystem: 1 },
      ])

      const agents = await getAllAgents(getDb())
      expect(agents[0].name).toBe('Built-in')
      expect(agents[1].name).toBe('Custom Agent')
    })
  })

  describe('getAvailableAgents', () => {
    it('should return only enabled agents', async () => {
      const db = getDb()
      await db.insert(agentsTable).values([
        { id: uuidv7(), name: 'Enabled', type: 'built-in', transport: 'in-process', enabled: 1 },
        { id: uuidv7(), name: 'Disabled', type: 'local', transport: 'stdio', enabled: 0 },
      ])

      const agents = await getAvailableAgents(getDb())
      expect(agents).toHaveLength(1)
      expect(agents[0].name).toBe('Enabled')
    })
  })

  describe('getAgent', () => {
    it('should return agent by id', async () => {
      const db = getDb()
      const id = uuidv7()
      await db.insert(agentsTable).values({ id, name: 'My Agent', type: 'remote', transport: 'websocket' })

      const agent = await getAgent(getDb(), id)
      expect(agent).toBeDefined()
      expect(agent!.name).toBe('My Agent')
    })

    it('should return undefined for non-existent id', async () => {
      const agent = await getAgent(getDb(), 'nonexistent')
      expect(agent).toBeUndefined()
    })

    it('should not return soft-deleted agents', async () => {
      const db = getDb()
      const id = uuidv7()
      await db
        .insert(agentsTable)
        .values({ id, name: 'Deleted', type: 'local', transport: 'stdio', deletedAt: new Date().toISOString() })

      const agent = await getAgent(getDb(), id)
      expect(agent).toBeUndefined()
    })
  })

  describe('getSelectedAgent', () => {
    it('should return built-in agent when no selection exists', async () => {
      const db = getDb()
      await db
        .insert(agentsTable)
        .values({ id: 'agent-built-in', name: 'Thunderbolt', type: 'built-in', transport: 'in-process', isSystem: 1 })

      const agent = await getSelectedAgent(getDb())
      expect(agent).not.toBeNull()
      expect(agent!.name).toBe('Thunderbolt')
      expect(agent!.type).toBe('built-in')
    })

    it('should return selected agent from settings', async () => {
      const db = getDb()
      const agentId = uuidv7()
      await db.insert(agentsTable).values([
        { id: 'agent-built-in', name: 'Thunderbolt', type: 'built-in', transport: 'in-process', isSystem: 1 },
        { id: agentId, name: 'Claude Code', type: 'local', transport: 'stdio' },
      ])
      await db.insert(settingsTable).values({ key: 'selected_agent', value: agentId })

      const agent = await getSelectedAgent(getDb())
      expect(agent).not.toBeNull()
      expect(agent!.name).toBe('Claude Code')
    })

    it('should fall back to built-in when selected agent is deleted', async () => {
      const db = getDb()
      const agentId = uuidv7()
      await db.insert(agentsTable).values([
        { id: 'agent-built-in', name: 'Thunderbolt', type: 'built-in', transport: 'in-process', isSystem: 1 },
        {
          id: agentId,
          name: 'Deleted Agent',
          type: 'remote',
          transport: 'websocket',
          deletedAt: new Date().toISOString(),
        },
      ])
      await db.insert(settingsTable).values({ key: 'selected_agent', value: agentId })

      const agent = await getSelectedAgent(getDb())
      expect(agent).not.toBeNull()
      expect(agent!.name).toBe('Thunderbolt')
    })
  })
})
