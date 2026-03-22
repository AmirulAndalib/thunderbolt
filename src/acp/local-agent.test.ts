import { describe, expect, mock, test, beforeEach } from 'bun:test'
import type { Agent } from '@/types'
import type { ClientSideConnection, SessionUpdate } from '@agentclientprotocol/sdk'
import {
  connectToLocalAgent,
  disconnectLocalAgent,
  type LocalAgentConnection,
  type LocalAgentDependencies,
} from './local-agent'

const createTestAgent = (overrides?: Partial<Agent>): Agent => ({
  id: 'agent-local-claude',
  name: 'Claude Code',
  type: 'local',
  transport: 'stdio',
  command: 'claude',
  args: '["--acp"]',
  url: null,
  authMethod: null,
  icon: 'terminal',
  isSystem: 1,
  enabled: 1,
  deletedAt: null,
  userId: null,
  defaultHash: null,
  ...overrides,
})

/**
 * Creates mock dependencies for the local agent connection.
 */
const createMockDeps = (): LocalAgentDependencies & {
  closeHandlers: Array<(code: number) => void>
  receivedUpdates: SessionUpdate[]
  mockConnection: ClientSideConnection
} => {
  const closeHandlers: Array<(code: number) => void> = []
  const receivedUpdates: SessionUpdate[] = []

  const mockConnection = {
    initialize: mock(() =>
      Promise.resolve({
        protocolVersion: 1,
        agentInfo: { name: 'claude-code', version: '1.0.0' },
        agentCapabilities: {},
      }),
    ),
    newSession: mock(() =>
      Promise.resolve({
        sessionId: 'session-123',
        modes: {
          currentModeId: 'code',
          availableModes: [{ id: 'code', name: 'Code' }],
        },
        configOptions: [],
      }),
    ),
    prompt: mock(() => Promise.resolve({ stopReason: 'end_turn' as const })),
    cancel: mock(() => Promise.resolve()),
    signal: new AbortController().signal,
    closed: new Promise<void>(() => {}),
  } as unknown as ClientSideConnection

  const deps: LocalAgentDependencies = {
    createStdioStream: mock((_opts: { command: string; args: string[] }) => ({
      stream: {
        readable: new ReadableStream(),
        writable: new WritableStream(),
      },
      process: {
        kill: mock(() => Promise.resolve()),
        onClose: mock((handler: (code: number) => void) => {
          closeHandlers.push(handler)
        }),
      },
    })),
    createClientConnection: mock(() => mockConnection),
    onSessionUpdate: mock((update: SessionUpdate) => {
      receivedUpdates.push(update)
    }),
  }

  return { ...deps, closeHandlers, receivedUpdates, mockConnection }
}

describe('connectToLocalAgent', () => {
  test('spawns agent process and creates ACP connection', async () => {
    const deps = createMockDeps()
    const agent = createTestAgent()

    const result = await connectToLocalAgent(agent, deps)

    expect(deps.createStdioStream).toHaveBeenCalledWith({
      command: 'claude',
      args: ['--acp'],
    })
    expect(deps.createClientConnection).toHaveBeenCalled()
    expect(result.connection).toBe(deps.mockConnection)
  })

  test('initializes ACP protocol on the connection', async () => {
    const deps = createMockDeps()
    const agent = createTestAgent()

    await connectToLocalAgent(agent, deps)

    expect(deps.mockConnection.initialize).toHaveBeenCalledWith({
      protocolVersion: 1,
      clientInfo: { name: 'thunderbolt', version: '1.0.0' },
    })
  })

  test('creates a new ACP session after initialization', async () => {
    const deps = createMockDeps()
    const agent = createTestAgent()

    const result = await connectToLocalAgent(agent, deps)

    expect(deps.mockConnection.newSession).toHaveBeenCalledWith({
      cwd: expect.any(String),
      mcpServers: [],
    })
    expect(result.sessionId).toBe('session-123')
  })

  test('returns session modes and config options from the agent', async () => {
    const deps = createMockDeps()
    const agent = createTestAgent()

    const result = await connectToLocalAgent(agent, deps)

    expect(result.modes).toEqual({
      currentModeId: 'code',
      availableModes: [{ id: 'code', name: 'Code' }],
    })
    expect(result.configOptions).toEqual([])
  })

  test('parses JSON args from agent config', async () => {
    const deps = createMockDeps()
    const agent = createTestAgent({ args: '["--acp", "--verbose"]' })

    await connectToLocalAgent(agent, deps)

    expect(deps.createStdioStream).toHaveBeenCalledWith({
      command: 'claude',
      args: ['--acp', '--verbose'],
    })
  })

  test('uses empty args when agent has no args', async () => {
    const deps = createMockDeps()
    const agent = createTestAgent({ args: null })

    await connectToLocalAgent(agent, deps)

    expect(deps.createStdioStream).toHaveBeenCalledWith({
      command: 'claude',
      args: [],
    })
  })

  test('throws when agent has no command', async () => {
    const deps = createMockDeps()
    const agent = createTestAgent({ command: null })

    await expect(connectToLocalAgent(agent, deps)).rejects.toThrow('Agent has no command configured')
  })

  test('provides process kill function for cleanup', async () => {
    const deps = createMockDeps()
    const agent = createTestAgent()

    const result = await connectToLocalAgent(agent, deps)

    expect(result.kill).toBeDefined()
    expect(typeof result.kill).toBe('function')
  })

  test('passes a default permission handler that cancels', async () => {
    const deps = createMockDeps()
    const agent = createTestAgent()

    await connectToLocalAgent(agent, deps)

    // Extract the permission handler passed to createClientConnection
    const createClientCall = (deps.createClientConnection as ReturnType<typeof mock>).mock.calls[0]
    const permissionHandler = createClientCall[2] as (params: unknown) => Promise<{ outcome: { outcome: string } }>

    const result = await permissionHandler({})
    expect(result).toEqual({ outcome: { outcome: 'cancelled' } })
  })
})

describe('disconnectLocalAgent', () => {
  test('kills the agent process', async () => {
    const deps = createMockDeps()
    const agent = createTestAgent()

    const localConn = await connectToLocalAgent(agent, deps)
    await disconnectLocalAgent(localConn)

    expect(localConn.kill).toHaveBeenCalled()
  })
})

describe('process exit handling', () => {
  test('registers a close handler on the spawned process', async () => {
    const deps = createMockDeps()
    const agent = createTestAgent()

    const result = await connectToLocalAgent(agent, deps)

    // The onClose should have been called to register a handler
    const mockProcess = (deps.createStdioStream as ReturnType<typeof mock>).mock.results[0].value.process
    expect(mockProcess.onClose).toHaveBeenCalled()
  })

  test('exposes onExit callback for consumers to handle process exit', async () => {
    const deps = createMockDeps()
    const agent = createTestAgent()

    const result = await connectToLocalAgent(agent, deps)

    expect(result.onExit).toBeDefined()

    const exitHandler = mock()
    result.onExit(exitHandler)

    // Simulate process exit
    deps.closeHandlers[0]?.(0)
    expect(exitHandler).toHaveBeenCalledWith(0)
  })

  test('handles non-zero exit codes', async () => {
    const deps = createMockDeps()
    const agent = createTestAgent()

    const result = await connectToLocalAgent(agent, deps)

    const exitHandler = mock()
    result.onExit(exitHandler)

    // Simulate crash
    deps.closeHandlers[0]?.(1)
    expect(exitHandler).toHaveBeenCalledWith(1)
  })
})
