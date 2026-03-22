import type { Agent, AgentSideConnection, SessionConfigOption, SessionModeState } from '@agentclientprotocol/sdk'
import { v7 as uuidv7 } from 'uuid'
import type { BuiltInAgentConfig, InferenceParams } from './types'

type SessionState = {
  id: string
  currentModeId: string
  currentModelId: string
  abortController: AbortController | null
}

/**
 * Creates an ACP agent handler for the built-in Thunderbolt agent.
 * Wraps the existing AI inference logic behind the ACP protocol.
 *
 * @param config - Agent configuration including modes, models, and the inference function
 * @returns A handler function suitable for AgentSideConnection
 */
export const createBuiltInAgentHandler = (config: BuiltInAgentConfig) => {
  const { modes, models, runInference } = config

  return (conn: AgentSideConnection): Agent => {
    const sessions = new Map<string, SessionState>()

    const getDefaultModeId = () => {
      const defaultMode = modes.find((m) => m.isDefault === 1)
      return defaultMode?.id ?? modes[0]?.id ?? ''
    }

    const getDefaultModelId = () => models[0]?.id ?? ''

    const buildModeState = (currentModeId: string): SessionModeState => ({
      currentModeId,
      availableModes: modes.map((m) => ({
        id: m.id,
        name: m.label,
        description: m.systemPrompt ?? undefined,
      })),
    })

    const buildModelConfigOption = (currentModelId: string): SessionConfigOption => ({
      type: 'select' as const,
      id: 'model',
      name: 'Model',
      category: 'model',
      currentValue: currentModelId,
      options: models.map((m) => ({
        value: m.id,
        name: m.name,
      })),
    })

    return {
      initialize: async () => ({
        protocolVersion: 1,
        agentInfo: { name: 'thunderbolt-built-in', version: '1.0.0' },
        agentCapabilities: {},
      }),

      authenticate: async () => {},

      newSession: async () => {
        const sessionId = uuidv7()
        const currentModeId = getDefaultModeId()
        const currentModelId = getDefaultModelId()

        sessions.set(sessionId, {
          id: sessionId,
          currentModeId,
          currentModelId,
          abortController: null,
        })

        return {
          sessionId,
          modes: buildModeState(currentModeId),
          configOptions: [buildModelConfigOption(currentModelId)],
        }
      },

      prompt: async (params) => {
        const { sessionId, prompt } = params
        const session = sessions.get(sessionId)

        if (!session) {
          throw new Error(`Session ${sessionId} not found`)
        }

        const abortController = new AbortController()
        session.abortController = abortController

        // Convert ACP content blocks to messages
        const textContent = prompt
          .filter((b): b is { type: 'text'; text: string } => b.type === 'text')
          .map((b) => b.text)
          .join('')

        const currentMode = modes.find((m) => m.id === session.currentModeId)

        const inferenceParams: InferenceParams = {
          messages: [{ role: 'user', content: textContent }],
          modelId: session.currentModelId,
          modeSystemPrompt: currentMode?.systemPrompt ?? undefined,
          modeName: currentMode?.name ?? undefined,
          abortSignal: abortController.signal,
        }

        let stopReason: 'end_turn' | 'max_tokens' | 'cancelled' = 'end_turn'

        for await (const event of runInference(inferenceParams)) {
          if (abortController.signal.aborted) {
            stopReason = 'cancelled'
            break
          }

          switch (event.type) {
            case 'text-delta':
              await conn.sessionUpdate({
                sessionId,
                update: {
                  sessionUpdate: 'agent_message_chunk',
                  content: { type: 'text', text: event.text },
                },
              })
              break

            case 'reasoning':
              await conn.sessionUpdate({
                sessionId,
                update: {
                  sessionUpdate: 'agent_thought_chunk',
                  content: { type: 'text', text: event.text },
                },
              })
              break

            case 'tool-call':
              await conn.sessionUpdate({
                sessionId,
                update: {
                  sessionUpdate: 'tool_call',
                  toolCallId: event.toolCallId,
                  title: event.toolName,
                  kind: 'other',
                  status: 'in_progress',
                },
              })
              break

            case 'tool-result':
              await conn.sessionUpdate({
                sessionId,
                update: {
                  sessionUpdate: 'tool_call_update',
                  toolCallId: event.toolCallId,
                  status: 'completed',
                  content: [
                    {
                      type: 'content',
                      content: { type: 'text', text: event.result },
                    },
                  ],
                },
              })
              break

            case 'finish':
              stopReason = event.stopReason
              break
          }
        }

        session.abortController = null

        return { stopReason }
      },

      cancel: async (params) => {
        const session = sessions.get(params.sessionId)
        if (session?.abortController) {
          session.abortController.abort()
        }
      },

      setSessionMode: async (params) => {
        const session = sessions.get(params.sessionId)
        if (!session) {
          throw new Error(`Session ${params.sessionId} not found`)
        }

        session.currentModeId = params.modeId

        await conn.sessionUpdate({
          sessionId: params.sessionId,
          update: {
            sessionUpdate: 'current_mode_update',
            currentModeId: params.modeId,
          },
        })
      },

      setSessionConfigOption: async (params) => {
        const session = sessions.get(params.sessionId)
        if (!session) {
          throw new Error(`Session ${params.sessionId} not found`)
        }

        if (params.configId === 'model' && 'value' in params && typeof params.value === 'string') {
          session.currentModelId = params.value
        }

        return {
          configOptions: [buildModelConfigOption(session.currentModelId)],
        }
      },
    }
  }
}
