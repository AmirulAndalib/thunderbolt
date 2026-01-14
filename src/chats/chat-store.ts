import { getChatMessages, updateSettings } from '@/dal'
import { type MCPClient } from '@/lib/mcp-provider'
import { trackEvent } from '@/lib/posthog'
import { convertDbChatMessageToUIMessage } from '@/lib/utils'
import type { AutomationRun, ChatThread, Model, SaveMessagesFunction, ThunderboltUIMessage } from '@/types'
import { create } from 'zustand'
import type { Chat } from '@ai-sdk/react'
import { useShallow } from 'zustand/react/shallow'
import { createChatInstance } from './chat-instance'

type ChatSession = {
  chatInstance: Chat<ThunderboltUIMessage>
  chatThread: ChatThread | null
  id: string
  selectedModel: Model
  triggerData: AutomationRun | null
}

type ChatStoreState = {
  currentSessionId: string | null
  mcpClients: MCPClient[]
  models: Model[]
  sessions: Map<string, ChatSession>
}

type ChatStoreActions = {
  createSession(session: ChatSession): void
  /**
   * Recreates a chat session's Chat instance with fresh messages from the database.
   * Skips if the session doesn't exist or is currently streaming.
   * Used by the sync service to refresh sessions when new messages arrive.
   * @param id - The chat thread ID
   * @param saveMessages - The saveMessages function to use for the new instance
   */
  recreateSession(id: string, saveMessages: SaveMessagesFunction): Promise<void>
  setCurrentSessionId(id: string): void
  setMcpClients(mcpClients: MCPClient[]): void
  setModels(models: Model[]): void
  setSelectedModel(id: string, modelId: string | null): void
  updateSession(id: string, session: Partial<Omit<ChatSession, 'id'>>): void
}

type ChatStore = ChatStoreState & ChatStoreActions

const initialState: ChatStoreState = {
  currentSessionId: null,
  mcpClients: [],
  models: [],
  sessions: new Map(),
}

export const useChatStore = create<ChatStore>()((set, get) => ({
  ...initialState,
  createSession: (session) => {
    const { sessions } = get()

    const nextSessions = new Map(sessions)

    if (nextSessions.has(session.id)) {
      throw new Error('Session already exists')
    }

    nextSessions.set(session.id, session)

    set({ sessions: nextSessions })
  },

  recreateSession: async (id, saveMessages) => {
    const { sessions } = get()
    const session = sessions.get(id)

    // Skip if session doesn't exist
    if (!session) return

    // Skip if session is currently streaming
    if (session.chatInstance.status === 'streaming') return

    // Fetch fresh messages from the database
    const freshMessages = await getChatMessages(id)

    // Create a new Chat instance with the fresh messages
    const newChatInstance = createChatInstance(
      id,
      freshMessages.map(convertDbChatMessageToUIMessage) as ThunderboltUIMessage[],
      saveMessages,
    )

    // Update the session with the new instance
    const nextSessions = new Map(get().sessions)
    nextSessions.set(id, { ...session, chatInstance: newChatInstance })
    set({ sessions: nextSessions })
  },

  setCurrentSessionId: (id) => {
    set({ currentSessionId: id })
  },

  setMcpClients: (mcpClients) => {
    set({ mcpClients })
  },

  setModels: (models) => {
    set({ models })
  },

  setSelectedModel: async (id, modelId) => {
    const { models, sessions } = get()

    const model = models.find((m) => m.id === modelId)

    if (!model) {
      throw new Error('Model not found')
    }

    const session = sessions.get(id)

    if (!session) {
      throw new Error('No session found')
    }

    const nextSessions = new Map(sessions)
    nextSessions.set(id, { ...session, selectedModel: model })

    set({ sessions: nextSessions })

    updateSettings({ selected_model: model.id })

    trackEvent('model_select', { model: model.id })
  },

  updateSession: (id, session) => {
    const { sessions } = get()

    const existingSession = sessions.get(id)

    if (!existingSession) {
      throw new Error('No session found')
    }

    const nextSessions = new Map(sessions)
    nextSessions.set(id, { ...existingSession, ...session })
    set({ sessions: nextSessions })
  },
}))

/**
 * Returns the current chat session, throwing if none exists.
 *
 * Use this hook in components/hooks that fundamentally require an active session to function
 * (e.g., chat UI, message handlers). The throw ensures these components never render in an
 * invalid state.
 *
 * For components where a session is optional and they can still function without one
 * (e.g., Header, ChatListItem, useHandleIntegrationCompletion), access the store directly
 * with optional chaining: `state.sessions.get(state.currentSessionId ?? '')?.someProperty`
 */
export const useCurrentChatSession = () => {
  const session = useChatStore(useShallow((state) => state.sessions.get(state.currentSessionId ?? '')))

  if (!session) {
    throw new Error('No chat session found')
  }

  return session
}
