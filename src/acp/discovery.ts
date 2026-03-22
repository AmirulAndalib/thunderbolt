import type { Agent } from '@/types'

/**
 * Known CLI agents that can be auto-discovered on desktop.
 * Each entry maps a command name to its agent metadata.
 */
export const knownCliAgents = [
  {
    command: 'claude',
    name: 'Claude Code',
    icon: 'terminal',
    args: '["--acp"]',
  },
  {
    command: 'codex',
    name: 'Codex',
    icon: 'terminal',
    args: '["--acp"]',
  },
  {
    command: 'goose',
    name: 'Goose',
    icon: 'terminal',
    args: '["--acp"]',
  },
] as const

/**
 * Function signature for checking if a command exists on the system.
 * Abstracted so it can be mocked in tests and implemented via Tauri shell in production.
 */
export type CommandExistsChecker = (command: string) => Promise<boolean>

/**
 * Discovers installed CLI agents by checking known commands against the system PATH.
 * Returns Agent objects for each detected CLI tool.
 *
 * @param commandExists - Function that checks if a command is available on the system
 * @returns Array of discovered agents (empty if none found or not on desktop)
 */
export const discoverLocalAgents = async (commandExists: CommandExistsChecker): Promise<Agent[]> => {
  const agents: Agent[] = []

  await Promise.all(
    knownCliAgents.map(async (known) => {
      const exists = await commandExists(known.command)
      if (!exists) {
        return
      }

      agents.push({
        id: `agent-local-${known.command}`,
        name: known.name,
        type: 'local',
        transport: 'stdio',
        command: known.command,
        args: known.args,
        url: null,
        authMethod: null,
        icon: known.icon,
        isSystem: 1,
        enabled: 1,
        deletedAt: null,
        userId: null,
        defaultHash: null,
      })
    }),
  )

  return agents
}
