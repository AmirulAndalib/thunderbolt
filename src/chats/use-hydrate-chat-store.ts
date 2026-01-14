import {
  getAvailableModels,
  getChatMessages,
  getChatThread,
  getDefaultModelForThread,
  getSettings,
  getTriggerPromptForThread,
} from '@/dal'
import { useMCP } from '@/lib/mcp-provider'
import { convertDbChatMessageToUIMessage } from '@/lib/utils'
import type { ThunderboltUIMessage } from '@/types'
import { useState } from 'react'
import { useChatStore } from './chat-store'
import { createChatInstance } from './chat-instance'
import { useSaveMessages } from './use-save-messages'

type UseHydrateChatStoreParams = {
  id: string
}

export const useHydrateChatStore = ({ id }: UseHydrateChatStoreParams) => {
  const [isReady, setIsReady] = useState(false)

  const { getEnabledClients } = useMCP()
  const { createSaveMessages } = useSaveMessages()

  const saveMessages = createSaveMessages()

  const hydrateChatStore = async () => {
    const { createSession, sessions, setCurrentSessionId, setMcpClients, setModels } = useChatStore.getState()

    // If the session already exists, set the current session id and update the mcp clients and models
    if (sessions.has(id)) {
      setCurrentSessionId(id)

      const [models, mcpClients] = await Promise.all([getAvailableModels(), getEnabledClients()])

      setMcpClients(mcpClients)
      setModels(models)

      setIsReady(true)

      return
    }

    // If the session does not exist, create it below
    const settings = await getSettings({ selected_model: String })

    const [defaultModel, chatThread, initialMessages, models, triggerData, mcpClients] = await Promise.all([
      getDefaultModelForThread(id, settings.selectedModel ?? undefined),
      getChatThread(id),
      getChatMessages(id),
      getAvailableModels(),
      getTriggerPromptForThread(id),
      getEnabledClients(),
    ])

    const chatInstance = createChatInstance(
      id,
      initialMessages.map(convertDbChatMessageToUIMessage) as ThunderboltUIMessage[],
      saveMessages,
    )

    createSession({
      chatInstance,
      chatThread,
      id,
      selectedModel: defaultModel,
      triggerData,
    })

    setCurrentSessionId(id)

    setMcpClients(mcpClients)
    setModels(models)

    setIsReady(true)
  }

  return { hydrateChatStore, isReady, saveMessages }
}
