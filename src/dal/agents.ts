import { and, desc, eq, isNull } from 'drizzle-orm'
import type { AnyDrizzleDatabase } from '../db/database-interface'
import { agentsTable } from '../db/tables'
import { clearNullableColumns, nowIso } from '../lib/utils'
import type { Agent } from '@/types'
import { getSettings } from './settings'

export const getAllAgents = async (db: AnyDrizzleDatabase): Promise<Agent[]> => {
  const results = await db
    .select()
    .from(agentsTable)
    .where(isNull(agentsTable.deletedAt))
    .orderBy(desc(agentsTable.isSystem), agentsTable.name)

  return results as Agent[]
}

export const getEnabledAgents = async (db: AnyDrizzleDatabase): Promise<Agent[]> => {
  const results = await db
    .select()
    .from(agentsTable)
    .where(and(eq(agentsTable.enabled, 1), isNull(agentsTable.deletedAt)))
    .orderBy(desc(agentsTable.isSystem), agentsTable.name)

  return results as Agent[]
}

export const getAgent = async (db: AnyDrizzleDatabase, id: string): Promise<Agent | null> => {
  const agent = await db
    .select()
    .from(agentsTable)
    .where(and(eq(agentsTable.id, id), isNull(agentsTable.deletedAt)))
    .get()

  return agent ? (agent as Agent) : null
}

export const getSystemAgent = async (db: AnyDrizzleDatabase): Promise<Agent | null> => {
  const agent = await db
    .select()
    .from(agentsTable)
    .where(and(eq(agentsTable.isSystem, 1), isNull(agentsTable.deletedAt)))
    .orderBy(agentsTable.name)
    .get()

  return agent ? (agent as Agent) : null
}

/**
 * Falls back to the system agent if the selected agent is missing or disabled.
 */
export const getSelectedAgent = async (db: AnyDrizzleDatabase): Promise<Agent> => {
  const settings = await getSettings(db, { selected_agent: String })
  const selectedAgentId = settings.selectedAgent

  if (selectedAgentId) {
    const agent = await getAgent(db, selectedAgentId)
    if (agent && agent.enabled) {
      return agent
    }
  }

  const systemAgent = await getSystemAgent(db)

  if (!systemAgent) {
    throw new Error('No system agent found')
  }

  return systemAgent
}

export const createAgent = async (
  db: AnyDrizzleDatabase,
  data: Partial<Agent> & Pick<Agent, 'id' | 'name' | 'type' | 'transport'>,
): Promise<void> => {
  await db.insert(agentsTable).values(data)
}

/** Preserves defaultHash to avoid overwriting modification tracking */
export const updateAgent = async (db: AnyDrizzleDatabase, id: string, updates: Partial<Agent>): Promise<void> => {
  const { defaultHash, ...updateFields } = updates as Partial<Agent> & { defaultHash?: string }
  await db.update(agentsTable).set(updateFields).where(eq(agentsTable.id, id))
}

export const deleteAgent = async (db: AnyDrizzleDatabase, id: string): Promise<void> => {
  await db
    .update(agentsTable)
    .set({ ...clearNullableColumns(agentsTable), deletedAt: nowIso() })
    .where(and(eq(agentsTable.id, id), isNull(agentsTable.deletedAt)))
}
