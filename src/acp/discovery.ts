import { isTauri, isDesktop } from '@/lib/platform'
import { localAgentCandidates, hashAgent } from '@/defaults/agents'
import { agentsTable } from '@/db/tables'
import { eq, inArray } from 'drizzle-orm'
import type { AnyDrizzleDatabase } from '@/db/database-interface'
import type { Agent } from '@/types'

/**
 * Check if a command exists on the system PATH using Tauri shell.
 * Returns null on web or if the command is not found.
 */
const commandExists = async (command: string): Promise<boolean> => {
  if (!isTauri()) {
    return false
  }

  try {
    const { Command } = await import('@tauri-apps/plugin-shell')
    const cmd = Command.create('which', [command])
    const output = await cmd.execute()
    return output.code === 0
  } catch {
    return false
  }
}

/**
 * Discover local CLI agents available on this machine and upsert them into the DB.
 * Only runs on Tauri desktop — returns immediately on web/mobile.
 */
export const discoverAndSeedLocalAgents = async (db: AnyDrizzleDatabase): Promise<Agent[]> => {
  if (!isTauri() || !isDesktop()) {
    return []
  }

  // Check all candidates in parallel
  const candidatesWithCommand = localAgentCandidates.filter((c) => c.command)
  const existenceResults = await Promise.all(candidatesWithCommand.map((c) => commandExists(c.command!)))

  const discovered = candidatesWithCommand.filter((_, i) => existenceResults[i])
  if (discovered.length === 0) {
    return []
  }

  // Batch-fetch existing rows for all discovered agents
  const existingRows = await db
    .select()
    .from(agentsTable)
    .where(
      inArray(
        agentsTable.id,
        discovered.map((c) => c.id),
      ),
    )
  const existingById = new Map(existingRows.map((r) => [r.id, r]))

  for (const candidate of discovered) {
    const candidateHash = hashAgent(candidate)
    const existing = existingById.get(candidate.id)

    if (!existing) {
      await db.insert(agentsTable).values({ ...candidate, defaultHash: candidateHash })
    } else if (existing.defaultHash !== candidateHash) {
      await db
        .update(agentsTable)
        .set({ ...candidate, defaultHash: candidateHash })
        .where(eq(agentsTable.id, candidate.id))
    }
  }

  return discovered
}
