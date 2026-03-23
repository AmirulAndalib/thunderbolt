import { setupTestDatabase, teardownTestDatabase, resetTestDatabase } from '@/dal/test-utils'
import { getCurrentSession, resetStore, createMockAcpClient } from '@/test-utils/chat-store-mocks'
import { createQueryTestWrapper } from '@/test-utils/react-query'
import { act, cleanup, renderHook } from '@testing-library/react'
import { getClock } from '@/testing-library'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test'
import { getDb } from '@/db/database'
import { agentsTable, modelsTable, modesTable } from '@/db/tables'
import { v7 as uuidv7 } from 'uuid'
import { createChatThread } from '@/dal/chat-threads'
import { getModel } from '@/dal/models'
import { createElement, type ReactNode } from 'react'
import { BrowserRouter } from 'react-router'
import { MCPProvider } from '@/lib/mcp-provider'

// Mock ensureAcpConnection — must be before useHydrateChatStore import
const mockEnsureAcpConnection = mock((_sessionId: string) => Promise.resolve(createMockAcpClient()))

mock.module('./create-acp-session', () => {
  // Inline a minimal createAcpSession for built-in agents.
  // Avoid importing use-acp-chat here to prevent circular deps with the mocked module.
  const { createInProcessStreams } = require('@/acp/streams')
  const { createBuiltInAgent } = require('@/acp/built-in-agent')
  const { createAcpClient } = require('@/acp/client')
  const { AgentSideConnection } = require('@agentclientprotocol/sdk')
  const chatStore = require('./chat-store')

  return {
    createAcpSession: async ({
      chatId,
      agent,
      modes,
      models,
      selectedModeId,
      selectedModelId,
    }: {
      chatId: string
      agent: { type: string }
      modes: unknown[]
      models: unknown[]
      selectedModeId: string
      selectedModelId: string
      mcpClients: unknown[]
    }) => {
      if (agent.type !== 'built-in') {
        throw new Error(`Test mock only supports built-in agents, got: ${agent.type}`)
      }
      const { clientStream, agentStream } = createInProcessStreams()
      const agentHandler = createBuiltInAgent({
        getModes: () => modes,
        getModels: () => models,
        getSelectedModeId: () => {
          const session = chatStore.useChatStore.getState().sessions.get(chatId)
          return session?.currentModeId ?? selectedModeId
        },
        getSelectedModelId: () => {
          const session = chatStore.useChatStore.getState().sessions.get(chatId)
          return session?.selectedModel?.id ?? selectedModelId
        },
        onModeChange: () => {},
        onModelChange: () => {},
        runPrompt: async () => {},
      })
      const acpClient = createAcpClient({
        stream: clientStream,
        onSessionUpdate: () => {},
      })
      new AgentSideConnection(agentHandler, agentStream)
      await acpClient.initialize()
      const sessionState = await acpClient.createSession()
      return { acpClient, sessionState }
    },
    ensureAcpConnection: (sessionId: string) => mockEnsureAcpConnection(sessionId),
  }
})

import { useHydrateChatStore } from './use-hydrate-chat-store'

const createDefaultMode = async () => {
  const db = getDb()
  await db.insert(modesTable).values({
    id: 'mode-chat',
    name: 'chat',
    label: 'Chat',
    icon: 'message-square',
    systemPrompt: null,
    isDefault: 1,
    order: 0,
    deletedAt: null,
    defaultHash: null,
  })
}

const createSystemModel = async () => {
  const db = getDb()
  const modelId = uuidv7()
  await db.insert(modelsTable).values({
    id: modelId,
    provider: 'thunderbolt',
    name: 'System Model',
    model: 'gpt-oss-120b',
    isSystem: 1,
    enabled: 1,
    isConfidential: 0,
    contextWindow: 131072,
    toolUsage: 1,
    startWithReasoning: 0,
    deletedAt: null,
    url: null,
    defaultHash: null,
  })
  return modelId
}

const createDefaultAgent = async () => {
  const db = getDb()
  await db.insert(agentsTable).values({
    id: 'agent-built-in',
    name: 'Thunderbolt',
    type: 'built-in',
    transport: 'in-process',
    isSystem: 1,
    enabled: 1,
    deletedAt: null,
  })
}

const createLocalAgent = async () => {
  const db = getDb()
  const agentId = 'agent-local'
  await db.insert(agentsTable).values({
    id: agentId,
    name: 'Claude Code',
    type: 'local',
    transport: 'stdio',
    command: 'claude',
    isSystem: 1,
    enabled: 1,
    deletedAt: null,
  })
  return agentId
}

const createRemoteAgent = async () => {
  const db = getDb()
  const agentId = 'agent-remote'
  await db.insert(agentsTable).values({
    id: agentId,
    name: 'Remote Agent',
    type: 'remote',
    transport: 'websocket',
    url: 'wss://example.com/agent',
    isSystem: 0,
    enabled: 1,
    deletedAt: null,
  })
  return agentId
}

const createTestThread = async (modelId: string, title = 'Test Thread', agentId?: string) => {
  const model = await getModel(getDb(), modelId)
  if (!model) {
    throw new Error('Test setup failed')
  }
  const threadId = uuidv7()
  await createChatThread(
    getDb(),
    {
      id: threadId,
      title,
      contextSize: null,
      triggeredBy: null,
      wasTriggeredByAutomation: 0,
      agentId: agentId ?? null,
    },
    model,
  )
  return threadId
}

const TestWrapper = ({ children }: { children: ReactNode }) => {
  const queryWrapper = createQueryTestWrapper()
  return createElement(
    BrowserRouter,
    null,
    createElement(queryWrapper, null, createElement(MCPProvider, null, children)),
  )
}

describe('eager ACP connection', () => {
  beforeAll(async () => {
    await setupTestDatabase()
  })

  afterAll(async () => {
    await teardownTestDatabase()
  })

  beforeEach(async () => {
    resetStore()
    await resetTestDatabase()
    await createDefaultMode()
    await createSystemModel()
    await createDefaultAgent()
    mockEnsureAcpConnection.mockReset()
    mockEnsureAcpConnection.mockImplementation(() => Promise.resolve(createMockAcpClient()))
  })

  afterEach(async () => {
    cleanup()
    resetStore()
    await resetTestDatabase()
  })

  it('should NOT call ensureAcpConnection for built-in agents', async () => {
    const systemModelId = await createSystemModel()
    const threadId = await createTestThread(systemModelId, 'Built-in Test')

    const { result } = renderHook(() => useHydrateChatStore({ id: threadId, isNew: false }), {
      wrapper: TestWrapper,
    })

    await act(async () => {
      await result.current.hydrateChatStore()
    })

    const session = getCurrentSession()
    expect(session?.agentConfig.type).toBe('built-in')
    expect(session?.acpClient).toBeDefined()
    expect(mockEnsureAcpConnection).not.toHaveBeenCalled()
  })

  it('should call ensureAcpConnection for remote agent', async () => {
    const systemModelId = await createSystemModel()
    const remoteAgentId = await createRemoteAgent()
    const threadId = await createTestThread(systemModelId, 'Remote Agent Test', remoteAgentId)

    const { result } = renderHook(() => useHydrateChatStore({ id: threadId, isNew: false }), {
      wrapper: TestWrapper,
    })

    await act(async () => {
      await result.current.hydrateChatStore()
    })

    // Allow fire-and-forget promise to settle (fake timers are active)
    await act(async () => {
      await getClock().runAllAsync()
    })

    const session = getCurrentSession()
    expect(session?.agentConfig.type).toBe('remote')
    expect(mockEnsureAcpConnection).toHaveBeenCalledWith(threadId)
  })

  it('should NOT call ensureAcpConnection for local agent on web (unavailable)', async () => {
    // On web, isAgentAvailableOnPlatform('local') returns false by default
    const systemModelId = await createSystemModel()
    const localAgentId = await createLocalAgent()
    const threadId = await createTestThread(systemModelId, 'Web Local Agent Test', localAgentId)

    const { result } = renderHook(() => useHydrateChatStore({ id: threadId, isNew: false }), {
      wrapper: TestWrapper,
    })

    await act(async () => {
      await result.current.hydrateChatStore()
    })

    const session = getCurrentSession()
    expect(session?.isAgentAvailable).toBe(false)
    expect(mockEnsureAcpConnection).not.toHaveBeenCalled()
  })

  it('should set status to error when eager connection fails', async () => {
    mockEnsureAcpConnection.mockImplementation(() => Promise.reject(new Error('Connection timeout')))

    const systemModelId = await createSystemModel()
    const remoteAgentId = await createRemoteAgent()
    const threadId = await createTestThread(systemModelId, 'Error Test', remoteAgentId)

    const { result } = renderHook(() => useHydrateChatStore({ id: threadId, isNew: false }), {
      wrapper: TestWrapper,
    })

    await act(async () => {
      await result.current.hydrateChatStore()
    })

    // Allow fire-and-forget promise to settle (fake timers are active)
    await act(async () => {
      await getClock().runAllAsync()
    })

    const session = getCurrentSession()
    expect(session?.status).toBe('error')
    expect(session?.error?.message).toBe('Connection timeout')
  })

  it('should set status to ready when eager connection succeeds', async () => {
    const systemModelId = await createSystemModel()
    const remoteAgentId = await createRemoteAgent()
    const threadId = await createTestThread(systemModelId, 'Success Test', remoteAgentId)

    const { result } = renderHook(() => useHydrateChatStore({ id: threadId, isNew: false }), {
      wrapper: TestWrapper,
    })

    await act(async () => {
      await result.current.hydrateChatStore()
    })

    // Allow fire-and-forget promise to settle (fake timers are active)
    await act(async () => {
      await getClock().runAllAsync()
    })

    const session = getCurrentSession()
    expect(session?.status).toBe('ready')
  })
})
