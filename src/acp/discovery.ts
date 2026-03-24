import { isAgentAvailableOnPlatform } from '@/lib/platform'
import { isAgentAvailable } from '@/acp/stdio-stream'
import { localAgentCandidates, hashAgent } from '@/defaults/agents'
import { agentsTable } from '@/db/tables'
import { eq, inArray } from 'drizzle-orm'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import type { Agent } from '@/types'
import type { RemoteAgentDescriptor } from '@shared/agent-types'

/**
 * Upsert agents into the DB, inserting new ones and updating changed ones.
 * Compares by hash to avoid unnecessary writes.
 */
const upsertAgents = async (db: AnyDrizzleDatabase, agents: Agent[]): Promise<void> => {
  if (agents.length === 0) {
    return
  }

  const existingRows = await db
    .select()
    .from(agentsTable)
    .where(
      inArray(
        agentsTable.id,
        agents.map((a) => a.id),
      ),
    )
  const existingById = new Map(existingRows.map((r) => [r.id, r]))

  await Promise.all(
    agents.map((agent) => {
      const agentHash = hashAgent(agent)
      const existing = existingById.get(agent.id)

      if (!existing) {
        return db.insert(agentsTable).values({ ...agent, defaultHash: agentHash })
      }
      if (existing.defaultHash !== agentHash) {
        return db
          .update(agentsTable)
          .set({ ...agent, defaultHash: agentHash })
          .where(eq(agentsTable.id, agent.id))
      }
    }),
  )
}

/**
 * Discover local CLI agents available on this machine and upsert them into the DB.
 * Only runs on Tauri desktop — returns immediately on web/mobile.
 */
export const discoverAndSeedLocalAgents = async (db: AnyDrizzleDatabase): Promise<Agent[]> => {
  if (!isAgentAvailableOnPlatform('local')) {
    return []
  }

  const { createTauriSpawner } = await import('@/acp/tauri-spawner')
  const spawner = createTauriSpawner()

  const candidatesWithCommand = localAgentCandidates.filter((c) => c.command)
  const existenceResults = await Promise.all(candidatesWithCommand.map((c) => isAgentAvailable(spawner, c.command!)))

  const discovered = candidatesWithCommand.filter((_, i) => existenceResults[i])
  await upsertAgents(db, discovered)
  return discovered
}

const fetchRemoteAgentDescriptors = async (cloudUrl: string): Promise<RemoteAgentDescriptor[]> => {
  try {
    const response = await fetch(`${cloudUrl}/agents`)
    if (!response.ok) {
      return []
    }
    const data = (await response.json()) as { data?: RemoteAgentDescriptor[] }
    return data.data ?? []
  } catch {
    return []
  }
}

export const discoverAndSeedRemoteAgents = async (db: AnyDrizzleDatabase, cloudUrl: string): Promise<Agent[]> => {
  const descriptors = await fetchRemoteAgentDescriptors(cloudUrl)
  if (descriptors.length === 0) {
    return []
  }

  const agents: Agent[] = descriptors.map((d) => ({
    ...d,
    command: null,
    args: null,
    authMethod: null,
    deletedAt: null,
    defaultHash: null,
    userId: null,
  }))

  await upsertAgents(db, agents)
  return agents
}
