import { hashValues } from '@/lib/utils'
import type { Agent } from '@/types'

/**
 * Compute hash of user-editable fields for an agent
 * Includes deletedAt to treat soft-delete as a user configuration choice
 */
export const hashAgent = (agent: Agent): string => {
  return hashValues([
    agent.name,
    agent.type,
    agent.transport,
    agent.command,
    agent.args,
    agent.url,
    agent.authMethod,
    agent.icon,
    agent.isSystem,
    agent.enabled,
    agent.deletedAt,
  ])
}

/**
 * Default built-in agent shipped with the application.
 * Uses in-process transport — runs in the same JS context.
 */
export const defaultAgentBuiltIn: Agent = {
  id: 'agent-built-in',
  name: 'Built-in',
  type: 'built-in',
  transport: 'in-process',
  command: null,
  args: null,
  url: null,
  authMethod: null,
  icon: 'bot',
  isSystem: 1,
  enabled: 1,
  deletedAt: null,
  userId: null,
  defaultHash: null,
}

export const defaultAgents: ReadonlyArray<Agent> = [defaultAgentBuiltIn] as const
