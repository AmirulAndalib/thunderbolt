/**
 * Hook for managing the WebSocket-based sync service lifecycle and status
 */

import { useChatStore } from '@/chats/chat-store'
import { useSaveMessages } from '@/chats/use-save-messages'
import { getSyncService, initSyncService, type SyncStatus } from '@/db/sync-service'
import { DatabaseSingleton } from '@/db/singleton'
import { useSettings } from '@/hooks/use-settings'
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * Mapping from database table names to React Query keys that should be invalidated
 * when that table changes from a sync operation
 */
const TABLE_TO_QUERY_KEYS: Record<string, string[][]> = {
  models: [['models']],
  tasks: [['tasks']],
  prompts: [['prompts'], ['triggers']],
  settings: [['settings']],
  chat_threads: [['chatThreads']],
  chat_messages: [['chatThreads']], // Messages affect thread display
  mcp_servers: [['mcp-servers']],
  triggers: [['triggers']],
}

/**
 * Convert HTTP URL to WebSocket URL
 * http://localhost:8000/v1 -> ws://localhost:8000/v1/sync/ws
 * https://api.example.com/v1 -> wss://api.example.com/v1/sync/ws
 */
const httpToWsUrl = (httpUrl: string): string => {
  const url = new URL(httpUrl)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.pathname = url.pathname.replace(/\/$/, '') + '/sync/ws'
  return url.toString()
}

export type UseSyncServiceResult = {
  /** Current sync status */
  status: SyncStatus
  /** Whether sync is supported (cr-sqlite database) */
  isSupported: boolean
  /** Whether the sync service is running */
  isRunning: boolean
  /** Force an immediate sync */
  forceSync: () => Promise<void>
  /** Start the sync service */
  start: () => void
  /** Stop the sync service */
  stop: () => void
  /** Last error if status is 'error' */
  lastError: Error | null
  /** Required migration version if status is 'version_mismatch' */
  requiredVersion: string | null
}

/**
 * Hook for managing the WebSocket sync service
 * Automatically initializes and starts the sync service when the app is ready
 */
export const useSyncService = (): UseSyncServiceResult => {
  const { cloudUrl } = useSettings({ cloud_url: 'http://localhost:8000/v1' })
  const queryClient = useQueryClient()
  const { createSaveMessages } = useSaveMessages()
  const [status, setStatus] = useState<SyncStatus>('idle')
  const [isRunning, setIsRunning] = useState(false)
  const [lastError, setLastError] = useState<Error | null>(null)
  const [requiredVersion, setRequiredVersion] = useState<string | null>(null)

  const isSupported = DatabaseSingleton.instance.isInitialized && DatabaseSingleton.instance.supportsSyncing

  // Use ref to avoid recreating callbacks when createSaveMessages changes
  const createSaveMessagesRef = useRef(createSaveMessages)
  createSaveMessagesRef.current = createSaveMessages

  /**
   * Invalidate React Query caches for tables that have changed
   */
  const invalidateQueriesForTables = useCallback(
    (tables: string[]) => {
      // Collect all query keys that need to be invalidated
      const queryKeysToInvalidate = new Set<string>()

      for (const table of tables) {
        const queryKeys = TABLE_TO_QUERY_KEYS[table]
        if (queryKeys) {
          for (const key of queryKeys) {
            queryKeysToInvalidate.add(JSON.stringify(key))
          }
        }
      }

      // Invalidate each unique query key
      for (const keyJson of queryKeysToInvalidate) {
        const queryKey = JSON.parse(keyJson) as string[]
        queryClient.invalidateQueries({ queryKey })
      }
    },
    [queryClient],
  )

  /**
   * Recreate chat sessions that have received new messages from sync
   * Uses ref to always get the latest createSaveMessages without causing re-renders
   */
  const recreateChatSessions = useCallback((chatThreadIds: string[]) => {
    const { recreateSession } = useChatStore.getState()
    const saveMessages = createSaveMessagesRef.current()
    for (const threadId of chatThreadIds) {
      recreateSession(threadId, saveMessages)
    }
  }, [])

  // Initialize and start sync service
  useEffect(() => {
    if (!isSupported || !cloudUrl.value) {
      return
    }

    const wsUrl = httpToWsUrl(cloudUrl.value)

    const service = initSyncService({
      wsUrl,
      onStatusChange: (newStatus) => {
        setStatus(newStatus)
      },
      onError: (error) => {
        setLastError(error)
      },
      onTablesChanged: (tables) => {
        // Invalidate React Query caches for changed tables
        invalidateQueriesForTables(tables)
      },
      onVersionMismatch: (version) => {
        setRequiredVersion(version)
      },
      onChatSessionsChanged: (chatThreadIds) => {
        // Recreate chat sessions that have new messages from sync
        recreateChatSessions(chatThreadIds)
      },
    })

    service.start()
    setIsRunning(true)

    return () => {
      service.stop()
      setIsRunning(false)
    }
  }, [isSupported, cloudUrl.value, invalidateQueriesForTables, recreateChatSessions])

  const forceSync = useCallback(async () => {
    const service = getSyncService()
    if (service) {
      await service.forceSync()
    }
  }, [])

  const start = useCallback(() => {
    const service = getSyncService()
    if (service) {
      service.start()
      setIsRunning(true)
    }
  }, [])

  const stop = useCallback(() => {
    const service = getSyncService()
    if (service) {
      service.stop()
      setIsRunning(false)
    }
  }, [])

  return {
    status,
    isSupported,
    isRunning,
    forceSync,
    start,
    stop,
    lastError,
    requiredVersion,
  }
}
