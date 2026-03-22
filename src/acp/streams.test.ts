import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { AgentSideConnection, ClientSideConnection } from '@agentclientprotocol/sdk'
import { createInProcessStream } from './streams'
import type { InProcessStreamPair } from './types'

/**
 * Helper to create a connected client/agent pair for testing.
 * Returns the connections and a cleanup function.
 */
const createTestPair = (agentHandlers?: Partial<Parameters<typeof AgentSideConnection>[0]>) => {
  const { clientStream, agentStream } = createInProcessStream()

  const receivedUpdates: unknown[] = []
  let agentConnection: AgentSideConnection

  const defaultAgent = (conn: AgentSideConnection) => ({
    initialize: async () => ({ protocolVersion: 1 as const }),
    newSession: async () => ({ sessionId: 'test-session' }),
    prompt: async () => ({ stopReason: 'end_turn' as const }),
    cancel: async () => {},
    authenticate: async () => {},
  })

  agentConnection = new AgentSideConnection(
    (conn) => ({
      ...defaultAgent(conn),
      ...(agentHandlers ? agentHandlers(conn) : {}),
    }),
    agentStream,
  )

  const clientConn = new ClientSideConnection(
    () => ({
      sessionUpdate: async (params) => {
        receivedUpdates.push(params)
      },
      requestPermission: async () => ({ outcome: 'cancelled' as const }),
    }),
    clientStream,
  )

  return { clientConn, agentConnection, receivedUpdates, clientStream, agentStream }
}

describe('createInProcessStream', () => {
  test('returns client and agent stream objects with readable and writable', () => {
    const { clientStream, agentStream } = createInProcessStream()

    expect(clientStream.readable).toBeInstanceOf(ReadableStream)
    expect(clientStream.writable).toBeInstanceOf(WritableStream)
    expect(agentStream.readable).toBeInstanceOf(ReadableStream)
    expect(agentStream.writable).toBeInstanceOf(WritableStream)
  })

  test('client and agent streams are distinct objects', () => {
    const { clientStream, agentStream } = createInProcessStream()

    expect(clientStream.readable).not.toBe(agentStream.readable)
    expect(clientStream.writable).not.toBe(agentStream.writable)
  })

  test('messages flow from client to agent via JSON-RPC', async () => {
    const { clientStream, agentStream } = createInProcessStream()

    const receivedParams: unknown[] = []

    new AgentSideConnection(
      () => ({
        initialize: async (params) => {
          receivedParams.push(params)
          return { protocolVersion: 1 }
        },
        newSession: async () => ({ sessionId: 'test' }),
        prompt: async () => ({ stopReason: 'end_turn' as const }),
        cancel: async () => {},
        authenticate: async () => {},
      }),
      agentStream,
    )

    const clientConn = new ClientSideConnection(
      () => ({
        sessionUpdate: async () => {},
        requestPermission: async () => ({ outcome: 'cancelled' as const }),
      }),
      clientStream,
    )

    const response = await clientConn.initialize({
      protocolVersion: 1,
      clientInfo: { name: 'test-client', version: '1.0' },
    })

    expect(response.protocolVersion).toBe(1)
    expect(receivedParams).toHaveLength(1)
    expect(receivedParams[0]).toMatchObject({
      protocolVersion: 1,
      clientInfo: { name: 'test-client', version: '1.0' },
    })
  })

  test('messages flow from agent to client via session updates', async () => {
    const { clientStream, agentStream } = createInProcessStream()

    const receivedUpdates: unknown[] = []

    new AgentSideConnection(
      (conn) => ({
        initialize: async () => ({ protocolVersion: 1 }),
        newSession: async () => ({ sessionId: 'test-session' }),
        prompt: async (params) => {
          await conn.sessionUpdate({
            sessionId: params.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'Hello from agent!' },
            },
          })
          return { stopReason: 'end_turn' as const }
        },
        cancel: async () => {},
        authenticate: async () => {},
      }),
      agentStream,
    )

    const clientConn = new ClientSideConnection(
      () => ({
        sessionUpdate: async (params) => {
          receivedUpdates.push(params)
        },
        requestPermission: async () => ({ outcome: 'cancelled' as const }),
      }),
      clientStream,
    )

    await clientConn.initialize({ protocolVersion: 1 })
    await clientConn.newSession({ cwd: '/test', mcpServers: [] })

    await clientConn.prompt({
      sessionId: 'test-session',
      prompt: [{ type: 'text', text: 'Hello' }],
    })

    expect(receivedUpdates).toHaveLength(1)
    expect(receivedUpdates[0]).toMatchObject({
      sessionId: 'test-session',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Hello from agent!' },
      },
    })
  })

  test('bidirectional communication works with multiple chunks', async () => {
    const { clientStream, agentStream } = createInProcessStream()

    const agentReceivedPrompts: string[] = []
    const clientReceivedChunks: string[] = []

    new AgentSideConnection(
      (conn) => ({
        initialize: async () => ({ protocolVersion: 1 }),
        newSession: async () => ({ sessionId: 'session-1' }),
        prompt: async (params) => {
          const text = params.prompt
            .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
            .map((b) => b.text)
            .join('')
          agentReceivedPrompts.push(text)

          await conn.sessionUpdate({
            sessionId: params.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'chunk-1' },
            },
          })
          await conn.sessionUpdate({
            sessionId: params.sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: 'chunk-2' },
            },
          })

          return { stopReason: 'end_turn' as const }
        },
        cancel: async () => {},
        authenticate: async () => {},
      }),
      agentStream,
    )

    const clientConn = new ClientSideConnection(
      () => ({
        sessionUpdate: async (params) => {
          if (params.update.sessionUpdate === 'agent_message_chunk') {
            const chunk = params.update as { content: { type: 'text'; text: string } }
            clientReceivedChunks.push(chunk.content.text)
          }
        },
        requestPermission: async () => ({ outcome: 'cancelled' as const }),
      }),
      clientStream,
    )

    await clientConn.initialize({ protocolVersion: 1 })
    await clientConn.newSession({ cwd: '/', mcpServers: [] })

    const response = await clientConn.prompt({
      sessionId: 'session-1',
      prompt: [{ type: 'text', text: 'What is 2+2?' }],
    })

    expect(response.stopReason).toBe('end_turn')
    expect(agentReceivedPrompts).toEqual(['What is 2+2?'])
    expect(clientReceivedChunks).toEqual(['chunk-1', 'chunk-2'])
  })
})
