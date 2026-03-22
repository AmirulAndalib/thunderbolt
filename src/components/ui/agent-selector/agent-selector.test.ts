import { describe, expect, test } from 'bun:test'
import { categorizeAgents } from './agent-selector'
import type { Agent } from '@/types'

const makeAgent = (overrides: Partial<Agent> & { id: string; name: string }): Agent =>
  ({
    type: 'built-in',
    transport: 'in-process',
    enabled: 1,
    isSystem: 1,
    command: null,
    args: null,
    url: null,
    authMethod: null,
    icon: 'bot',
    deletedAt: null,
    userId: null,
    defaultHash: null,
    ...overrides,
  }) as Agent

const builtInAgent = makeAgent({ id: 'agent-built-in', name: 'Built-in', type: 'built-in', icon: 'bot' })
const localAgent = makeAgent({
  id: 'agent-local-claude',
  name: 'Claude Code',
  type: 'local',
  transport: 'stdio',
  icon: 'terminal',
  command: 'claude',
})
const remoteAgent = makeAgent({
  id: 'agent-remote-1',
  name: 'Haystack',
  type: 'remote',
  transport: 'websocket',
  icon: 'globe',
  url: 'wss://haystack.example.com',
})

describe('categorizeAgents', () => {
  test('empty agents returns empty groups', () => {
    const groups = categorizeAgents([])
    expect(groups).toHaveLength(0)
  })

  test('single built-in agent creates one group without label', () => {
    const groups = categorizeAgents([builtInAgent])
    expect(groups).toHaveLength(1)
    expect(groups[0].id).toBe('built-in')
    expect(groups[0].label).toBeUndefined()
    expect(groups[0].items).toHaveLength(1)
    expect(groups[0].items[0].id).toBe('agent-built-in')
    expect(groups[0].items[0].label).toBe('Built-in')
  })

  test('local agents are grouped under "Local Agents"', () => {
    const groups = categorizeAgents([localAgent])
    expect(groups).toHaveLength(1)
    expect(groups[0].id).toBe('local')
    expect(groups[0].label).toBe('Local Agents')
    expect(groups[0].items).toHaveLength(1)
    expect(groups[0].items[0].id).toBe('agent-local-claude')
  })

  test('remote agents are grouped under "Remote Agents"', () => {
    const groups = categorizeAgents([remoteAgent])
    expect(groups).toHaveLength(1)
    expect(groups[0].id).toBe('remote')
    expect(groups[0].label).toBe('Remote Agents')
    expect(groups[0].items).toHaveLength(1)
    expect(groups[0].items[0].id).toBe('agent-remote-1')
  })

  test('agents of all types are grouped correctly', () => {
    const groups = categorizeAgents([builtInAgent, localAgent, remoteAgent])
    expect(groups).toHaveLength(3)
    expect(groups[0].id).toBe('built-in')
    expect(groups[1].id).toBe('local')
    expect(groups[2].id).toBe('remote')
  })

  test('items have description matching type label', () => {
    const groups = categorizeAgents([builtInAgent, localAgent, remoteAgent])
    const builtInItem = groups[0].items[0]
    const localItem = groups[1].items[0]
    const remoteItem = groups[2].items[0]

    expect(builtInItem.description).toBe('Built-in')
    expect(localItem.description).toBe('Local')
    expect(remoteItem.description).toBe('Remote')
  })

  test('items have icons', () => {
    const groups = categorizeAgents([builtInAgent, localAgent])
    expect(groups[0].items[0].icon).toBeDefined()
    expect(groups[1].items[0].icon).toBeDefined()
  })

  test('multiple local agents are in the same group', () => {
    const codexAgent = makeAgent({
      id: 'agent-local-codex',
      name: 'Codex',
      type: 'local',
      transport: 'stdio',
      command: 'codex',
    })
    const groups = categorizeAgents([localAgent, codexAgent])
    expect(groups).toHaveLength(1)
    expect(groups[0].id).toBe('local')
    expect(groups[0].items).toHaveLength(2)
  })

  test('groups preserve order: built-in, local, remote', () => {
    // Pass in reverse order to verify categorization, not insertion order
    const groups = categorizeAgents([remoteAgent, localAgent, builtInAgent])
    expect(groups[0].id).toBe('built-in')
    expect(groups[1].id).toBe('local')
    expect(groups[2].id).toBe('remote')
  })
})
