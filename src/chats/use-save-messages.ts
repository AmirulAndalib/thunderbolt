import { saveMessagesWithContextUpdate } from '@/dal'
import { getOrCreateChatThread, updateChatThread } from '@/dal/chat-threads'
import { generateTitle } from '@/lib/title-generator'
import type { SaveMessagesFunction, ThunderboltUIMessage } from '@/types'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router'
import { useChatStore } from './chat-store'

/**
 * Hook that returns a saveMessages function factory.
 * The returned function creates SaveMessagesFunction instances that handle:
 * - Saving messages to the database
 * - Invalidating context size queries
 * - Generating chat titles for new threads
 * - Navigating to the chat URL for new sessions
 *
 * This hook is used by both useHydrateChatStore and useSyncService to ensure
 * consistent message saving behavior across different chat instance creation scenarios.
 */
export const useSaveMessages = () => {
  const navigate = useNavigate()
  const queryClient = useQueryClient()

  const updateThreadTitle = async (messages: ThunderboltUIMessage[], threadId: string) => {
    const firstUserMessage = messages.find((msg) => msg.role === 'user')
    if (!firstUserMessage) return

    const textContent = firstUserMessage.parts
      ?.filter((part) => part.type === 'text')
      .map((part) => (part.type === 'text' ? part.text : ''))
      .join(' ')

    if (!textContent) return

    const title = await generateTitle(textContent)
    await updateChatThread(threadId, { title })

    // Also invalidate chat threads to update the sidebar
    queryClient.invalidateQueries({ queryKey: ['chatThreads'] })
  }

  /**
   * Creates a SaveMessagesFunction for a specific chat session.
   * The function handles all message persistence and related side effects.
   */
  const createSaveMessages = (): SaveMessagesFunction => {
    return async ({ id, messages }) => {
      const { sessions, updateSession } = useChatStore.getState()

      const session = sessions.get(id)

      if (!session) throw new Error('No session found')

      // Fetch thread info to check if we need to generate a title
      const thread = await getOrCreateChatThread(id, session.selectedModel.id)

      // Save messages and update context size using DAL
      await saveMessagesWithContextUpdate(id, messages)

      // Invalidate context size query to trigger re-fetch
      queryClient.invalidateQueries({ queryKey: ['contextSize', id] })

      // Generate title in background if needed
      if (thread?.title === 'New Chat') {
        updateThreadTitle(messages, id)
      }

      if (!session.chatThread) {
        updateSession(id, { chatThread: thread })
        navigate(`/chats/${id}`, { relative: 'path' })
      }
    }
  }

  return { createSaveMessages }
}
