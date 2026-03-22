import type { Mode, Model } from '@/types'
import type {
  ClientSideConnection,
  SessionConfigOption,
  SessionModeState,
  SessionUpdate,
  Stream,
} from '@agentclientprotocol/sdk'

export type AgentType = 'built-in' | 'local' | 'remote'
export type TransportType = 'in-process' | 'stdio' | 'websocket'

export type AgentConfig = {
  id: string
  name: string
  type: AgentType
  transport: TransportType
}

export type InProcessStreamPair = {
  clientStream: Stream
  agentStream: Stream
}

/**
 * Events emitted by the inference engine during streaming.
 * Used as the interface between the built-in agent and the AI layer.
 */
export type InferenceEvent =
  | { type: 'text-delta'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; args: Record<string, unknown> }
  | { type: 'tool-result'; toolCallId: string; result: string }
  | { type: 'finish'; stopReason: 'end_turn' | 'max_tokens' | 'cancelled' }

/**
 * Function signature for the inference engine.
 * The built-in agent calls this to run AI inference.
 * Returns an async iterable of events that the agent converts to ACP session updates.
 */
export type RunInference = (params: InferenceParams) => AsyncIterable<InferenceEvent>

export type InferenceParams = {
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
  modelId: string
  modeSystemPrompt?: string
  modeName?: string
  abortSignal?: AbortSignal
}

export type BuiltInAgentConfig = {
  modes: Mode[]
  models: Model[]
  runInference: RunInference
}

export type SessionUpdateHandler = (update: SessionUpdate) => void

export type AcpClientOptions = {
  stream: Stream
  onSessionUpdate: SessionUpdateHandler
}

export type AcpSessionInfo = {
  sessionId: string
  modes: SessionModeState | null
  configOptions: SessionConfigOption[] | null
  connection: ClientSideConnection
}
