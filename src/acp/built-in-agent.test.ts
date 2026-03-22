import { describe, expect, test } from 'bun:test'
import { AgentSideConnection, ClientSideConnection, type SessionNotification } from '@agentclientprotocol/sdk'
import type { Mode, Model } from '@/types'
import { createInProcessStream } from './streams'
import { createBuiltInAgentHandler } from './built-in-agent'
import type { InferenceEvent, RunInference } from './types'

const testModes: Mode[] = [
  {
    id: 'mode-chat',
    name: 'chat',
    label: 'Chat',
    icon: 'message-square',
    systemPrompt: 'You are a chat assistant',
    isDefault: 1,
    order: 0,
    deletedAt: null,
    defaultHash: null,
    userId: null,
  },
  {
    id: 'mode-search',
    name: 'search',
    label: 'Search',
    icon: 'globe',
    systemPrompt: 'You are a search assistant',
    isDefault: 0,
    order: 1,
    deletedAt: null,
    defaultHash: null,
    userId: null,
  },
  {
    id: 'mode-research',
    name: 'research',
    label: 'Research',
    icon: 'microscope',
    systemPrompt: 'You are a research assistant',
    isDefault: 0,
    order: 2,
    deletedAt: null,
    defaultHash: null,
    userId: null,
  },
]

const testModels: Model[] = [
  {
    id: 'model-sonnet',
    name: 'Claude Sonnet',
    provider: 'anthropic',
    model: 'claude-sonnet-4-5-20250514',
    enabled: 1,
    toolUsage: 1,
    isConfidential: 0,
    startWithReasoning: 0,
    supportsParallelToolCalls: 1,
    vendor: null,
    apiKey: null,
    url: null,
    contextWindow: null,
    isSystem: null,
    defaultHash: null,
    deletedAt: null,
    userId: null,
    description: null,
  },
  {
    id: 'model-gpt',
    name: 'GPT-4o',
    provider: 'openai',
    model: 'gpt-4o',
    enabled: 1,
    toolUsage: 1,
    isConfidential: 0,
    startWithReasoning: 0,
    supportsParallelToolCalls: 1,
    vendor: null,
    apiKey: null,
    url: null,
    contextWindow: null,
    isSystem: null,
    defaultHash: null,
    deletedAt: null,
    userId: null,
    description: null,
  },
]

/**
 * Creates a mock inference function that yields the given events.
 */
const createMockInference = (events: InferenceEvent[]): RunInference => {
  return async function* (_params) {
    for (const event of events) {
      yield event
    }
  }
}

/**
 * Creates a connected client/agent test pair using the built-in agent handler.
 */
const createTestSetup = (options?: { events?: InferenceEvent[]; modes?: Mode[]; models?: Model[] }) => {
  const { clientStream, agentStream } = createInProcessStream()

  const events = options?.events ?? [
    { type: 'text-delta' as const, text: 'Hello!' },
    { type: 'finish' as const, stopReason: 'end_turn' as const },
  ]

  const modes = options?.modes ?? testModes
  const models = options?.models ?? testModels
  const mockInference = createMockInference(events)

  const agentHandler = createBuiltInAgentHandler({
    modes,
    models,
    runInference: mockInference,
  })

  const agentConn = new AgentSideConnection(agentHandler, agentStream)

  const receivedUpdates: SessionNotification[] = []

  const clientConn = new ClientSideConnection(
    () => ({
      sessionUpdate: async (params) => {
        receivedUpdates.push(params)
      },
      requestPermission: async () => ({ outcome: { outcome: 'cancelled' as const } }),
    }),
    clientStream,
  )

  return { clientConn, agentConn, receivedUpdates, mockInference }
}

describe('built-in agent', () => {
  describe('initialize', () => {
    test('returns protocol version 1', async () => {
      const { clientConn } = createTestSetup()

      const response = await clientConn.initialize({ protocolVersion: 1 })

      expect(response.protocolVersion).toBe(1)
    })

    test('returns agent info', async () => {
      const { clientConn } = createTestSetup()

      const response = await clientConn.initialize({ protocolVersion: 1 })

      expect(response.agentInfo).toMatchObject({
        name: 'thunderbolt-built-in',
        version: '1.0.0',
      })
    })
  })

  describe('newSession', () => {
    test('returns a session ID', async () => {
      const { clientConn } = createTestSetup()

      await clientConn.initialize({ protocolVersion: 1 })
      const session = await clientConn.newSession({ cwd: '/test', mcpServers: [] })

      expect(session.sessionId).toBeTruthy()
      expect(typeof session.sessionId).toBe('string')
    })

    test('declares modes from config', async () => {
      const { clientConn } = createTestSetup()

      await clientConn.initialize({ protocolVersion: 1 })
      const session = await clientConn.newSession({ cwd: '/test', mcpServers: [] })

      expect(session.modes).toBeTruthy()
      expect(session.modes!.availableModes).toHaveLength(3)
      expect(session.modes!.availableModes.map((m) => m.id)).toEqual(['mode-chat', 'mode-search', 'mode-research'])
      expect(session.modes!.availableModes.map((m) => m.name)).toEqual(['Chat', 'Search', 'Research'])
      expect(session.modes!.currentModeId).toBe('mode-chat')
    })

    test('declares models as config options', async () => {
      const { clientConn } = createTestSetup()

      await clientConn.initialize({ protocolVersion: 1 })
      const session = await clientConn.newSession({ cwd: '/test', mcpServers: [] })

      expect(session.configOptions).toBeTruthy()

      const modelOption = session.configOptions!.find((o) => o.category === 'model')
      expect(modelOption).toBeTruthy()
      expect(modelOption!.id).toBe('model')
      expect(modelOption!.name).toBe('Model')
      expect(modelOption!.type).toBe('select')

      if (modelOption!.type === 'select') {
        const selectOption = modelOption as unknown as {
          type: 'select'
          options: Array<{ value: string; name: string }>
        }
        expect(selectOption.options).toHaveLength(2)
      }
    })

    test('sets default mode to first mode with isDefault=1', async () => {
      const customModes: Mode[] = [
        { ...testModes[0], isDefault: 0 },
        { ...testModes[1], isDefault: 1 },
        { ...testModes[2], isDefault: 0 },
      ]

      const { clientConn } = createTestSetup({ modes: customModes })

      await clientConn.initialize({ protocolVersion: 1 })
      const session = await clientConn.newSession({ cwd: '/test', mcpServers: [] })

      expect(session.modes!.currentModeId).toBe('mode-search')
    })

    test('returns unique session IDs for multiple sessions', async () => {
      const { clientConn } = createTestSetup()

      await clientConn.initialize({ protocolVersion: 1 })
      const session1 = await clientConn.newSession({ cwd: '/test', mcpServers: [] })
      const session2 = await clientConn.newSession({ cwd: '/test', mcpServers: [] })

      expect(session1.sessionId).not.toBe(session2.sessionId)
    })
  })

  describe('prompt', () => {
    test('streaming text arrives as agent_message_chunk updates', async () => {
      const events: InferenceEvent[] = [
        { type: 'text-delta', text: 'Hello' },
        { type: 'text-delta', text: ' world' },
        { type: 'text-delta', text: '!' },
        { type: 'finish', stopReason: 'end_turn' },
      ]

      const { clientConn, receivedUpdates } = createTestSetup({ events })

      await clientConn.initialize({ protocolVersion: 1 })
      await clientConn.newSession({ cwd: '/test', mcpServers: [] })

      const response = await clientConn.prompt({
        sessionId: (await clientConn.newSession({ cwd: '/test', mcpServers: [] })).sessionId,
        prompt: [{ type: 'text', text: 'Say hello' }],
      })

      expect(response.stopReason).toBe('end_turn')

      // Filter for agent_message_chunk updates from the last prompt
      const textChunks = receivedUpdates
        .filter((u) => u.update.sessionUpdate === 'agent_message_chunk')
        .map((u) => {
          const chunk = u.update as { content: { type: 'text'; text: string } }
          return chunk.content.text
        })

      expect(textChunks).toEqual(['Hello', ' world', '!'])
    })

    test('tool calls reported as tool_call events', async () => {
      const events: InferenceEvent[] = [
        {
          type: 'tool-call',
          toolCallId: 'tc-1',
          toolName: 'web_search',
          args: { query: 'weather today' },
        },
        { type: 'finish', stopReason: 'end_turn' },
      ]

      const { clientConn, receivedUpdates } = createTestSetup({ events })

      await clientConn.initialize({ protocolVersion: 1 })
      const session = await clientConn.newSession({ cwd: '/test', mcpServers: [] })

      await clientConn.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'Search for weather' }],
      })

      const toolCalls = receivedUpdates.filter((u) => u.update.sessionUpdate === 'tool_call')

      expect(toolCalls).toHaveLength(1)
      expect(toolCalls[0].update).toMatchObject({
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-1',
        title: 'web_search',
        status: 'in_progress',
      })
    })

    test('tool results reported as tool_call_update events', async () => {
      const events: InferenceEvent[] = [
        {
          type: 'tool-call',
          toolCallId: 'tc-1',
          toolName: 'web_search',
          args: { query: 'weather' },
        },
        {
          type: 'tool-result',
          toolCallId: 'tc-1',
          result: 'Sunny, 72°F',
        },
        { type: 'finish', stopReason: 'end_turn' },
      ]

      const { clientConn, receivedUpdates } = createTestSetup({ events })

      await clientConn.initialize({ protocolVersion: 1 })
      const session = await clientConn.newSession({ cwd: '/test', mcpServers: [] })

      await clientConn.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'Search for weather' }],
      })

      const toolUpdates = receivedUpdates.filter((u) => u.update.sessionUpdate === 'tool_call_update')

      expect(toolUpdates).toHaveLength(1)
      expect(toolUpdates[0].update).toMatchObject({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-1',
        status: 'completed',
        content: [
          {
            type: 'content',
            content: { type: 'text', text: 'Sunny, 72°F' },
          },
        ],
      })
    })

    test('reasoning arrives as agent_thought_chunk updates', async () => {
      const events: InferenceEvent[] = [
        { type: 'reasoning', text: 'Let me think...' },
        { type: 'text-delta', text: 'The answer is 42.' },
        { type: 'finish', stopReason: 'end_turn' },
      ]

      const { clientConn, receivedUpdates } = createTestSetup({ events })

      await clientConn.initialize({ protocolVersion: 1 })
      const session = await clientConn.newSession({ cwd: '/test', mcpServers: [] })

      await clientConn.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'What is the meaning of life?' }],
      })

      const thoughts = receivedUpdates.filter((u) => u.update.sessionUpdate === 'agent_thought_chunk')

      expect(thoughts).toHaveLength(1)
      expect(thoughts[0].update).toMatchObject({
        sessionUpdate: 'agent_thought_chunk',
        content: { type: 'text', text: 'Let me think...' },
      })
    })

    test('returns cancelled stop reason when inference is cancelled', async () => {
      const events: InferenceEvent[] = [
        { type: 'text-delta', text: 'Starting...' },
        { type: 'finish', stopReason: 'cancelled' },
      ]

      const { clientConn } = createTestSetup({ events })

      await clientConn.initialize({ protocolVersion: 1 })
      const session = await clientConn.newSession({ cwd: '/test', mcpServers: [] })

      const response = await clientConn.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'Hello' }],
      })

      expect(response.stopReason).toBe('cancelled')
    })

    test('returns max_tokens stop reason', async () => {
      const events: InferenceEvent[] = [
        { type: 'text-delta', text: 'Long text...' },
        { type: 'finish', stopReason: 'max_tokens' },
      ]

      const { clientConn } = createTestSetup({ events })

      await clientConn.initialize({ protocolVersion: 1 })
      const session = await clientConn.newSession({ cwd: '/test', mcpServers: [] })

      const response = await clientConn.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'Write a very long essay' }],
      })

      expect(response.stopReason).toBe('max_tokens')
    })
  })

  describe('cancel', () => {
    test('cancel sends abort signal to running inference', async () => {
      let receivedAbortSignal: AbortSignal | undefined

      const slowInference: RunInference = async function* (params) {
        receivedAbortSignal = params.abortSignal
        // Wait until cancelled using a promise that resolves on abort
        await new Promise<void>((resolve) => {
          if (params.abortSignal?.aborted) {
            resolve()
            return
          }
          params.abortSignal?.addEventListener('abort', () => resolve())
        })
        yield { type: 'finish', stopReason: 'cancelled' }
      }

      const { clientStream, agentStream } = createInProcessStream()

      const agentHandler = createBuiltInAgentHandler({
        modes: testModes,
        models: testModels,
        runInference: slowInference,
      })

      new AgentSideConnection(agentHandler, agentStream)

      const clientConn = new ClientSideConnection(
        () => ({
          sessionUpdate: async () => {},
          requestPermission: async () => ({ outcome: { outcome: 'cancelled' as const } }),
        }),
        clientStream,
      )

      await clientConn.initialize({ protocolVersion: 1 })
      const session = await clientConn.newSession({ cwd: '/test', mcpServers: [] })

      // Start prompt (don't await - it will block until cancelled)
      const promptPromise = clientConn.prompt({
        sessionId: session.sessionId,
        prompt: [{ type: 'text', text: 'Hello' }],
      })

      // Use queueMicrotask to allow the prompt to start processing
      // This works even with fake timers since microtasks are not faked
      await Promise.resolve()
      await Promise.resolve()

      // Cancel the prompt
      await clientConn.cancel({ sessionId: session.sessionId })

      const response = await promptPromise

      expect(response.stopReason).toBe('cancelled')
      expect(receivedAbortSignal?.aborted).toBe(true)
    })
  })

  describe('setSessionMode', () => {
    test('changes the current mode', async () => {
      const { clientConn, receivedUpdates } = createTestSetup()

      await clientConn.initialize({ protocolVersion: 1 })
      const session = await clientConn.newSession({ cwd: '/test', mcpServers: [] })

      expect(session.modes!.currentModeId).toBe('mode-chat')

      await clientConn.setSessionMode({
        sessionId: session.sessionId,
        modeId: 'mode-search',
      })

      // The agent should send a current_mode_update notification
      const modeUpdates = receivedUpdates.filter((u) => u.update.sessionUpdate === 'current_mode_update')
      expect(modeUpdates).toHaveLength(1)
    })

    test('rejects setSessionMode for invalid session', async () => {
      const { clientConn } = createTestSetup()

      await clientConn.initialize({ protocolVersion: 1 })

      await expect(
        clientConn.setSessionMode({
          sessionId: 'nonexistent-session',
          modeId: 'mode-chat',
        }),
      ).rejects.toThrow()
    })
  })

  describe('setSessionConfigOption', () => {
    test('updates model selection', async () => {
      const { clientConn } = createTestSetup()

      await clientConn.initialize({ protocolVersion: 1 })
      const session = await clientConn.newSession({ cwd: '/test', mcpServers: [] })

      const response = await clientConn.setSessionConfigOption({
        sessionId: session.sessionId,
        configId: 'model',
        value: 'model-gpt',
      } as Parameters<typeof clientConn.setSessionConfigOption>[0])

      expect(response.configOptions).toBeTruthy()
      expect(response.configOptions).toHaveLength(1)

      const modelOption = response.configOptions![0]
      expect(modelOption.id).toBe('model')
      if (modelOption.type === 'select') {
        expect(modelOption.currentValue).toBe('model-gpt')
      }
    })

    test('rejects for invalid session', async () => {
      const { clientConn } = createTestSetup()

      await clientConn.initialize({ protocolVersion: 1 })

      await expect(
        clientConn.setSessionConfigOption({
          sessionId: 'nonexistent',
          configId: 'model',
          value: 'model-gpt',
        } as Parameters<typeof clientConn.setSessionConfigOption>[0]),
      ).rejects.toThrow()
    })
  })

  describe('error handling', () => {
    test('prompt rejects for invalid session ID', async () => {
      const { clientConn } = createTestSetup()

      await clientConn.initialize({ protocolVersion: 1 })

      await expect(
        clientConn.prompt({
          sessionId: 'nonexistent-session',
          prompt: [{ type: 'text', text: 'Hello' }],
        }),
      ).rejects.toThrow()
    })
  })
})
