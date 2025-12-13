import type { HttpClient } from '@/contexts'
import { getSettings } from '@/dal'
import type { PowerSyncConfig } from '@/db/powersync-connector'
import { DatabaseSingleton } from '@/db/singleton'
import { createHandleError } from '@/lib/error-utils'
import { createAppDir, resetAppDir } from '@/lib/fs'
import { getDatabasePath, getDatabaseType } from '@/lib/platform'
import { initPosthog, trackError } from '@/lib/posthog'
import { reconcileDefaults } from '@/lib/reconcile-defaults'
import { parseSideviewParam } from '@/lib/sideview-url'
import { TrayManager } from '@/lib/tray'
import type { InitData } from '@/types'
import type { HandleError, HandleResult } from '@/types/handle-errors'
import type { TrayIcon } from '@tauri-apps/api/tray'
import type { Window } from '@tauri-apps/api/window'
import ky from 'ky'
import type { PostHog } from 'posthog-js'
import { useCallback, useEffect, useState } from 'react'

// Hardcoded user ID for POC (will be replaced with real auth later)
const POWERSYNC_USER_ID = 'dev-user-001'

const getPowerSyncConfig = (): PowerSyncConfig => ({
  powersyncUrl: import.meta.env.VITE_POWERSYNC_URL || 'http://localhost:8080',
  backendUrl: import.meta.env.VITE_THUNDERBOLT_CLOUD_URL || 'http://localhost:8000/v1',
  userId: POWERSYNC_USER_ID,
})

const createAppDirectory = async (): Promise<string> => {
  return await createAppDir()
}

const initializeDatabase = async (appDirPath: string): Promise<void> => {
  const databaseType = await getDatabaseType()
  const dbPath = await getDatabasePath(databaseType, appDirPath)

  await DatabaseSingleton.instance.initialize({
    type: databaseType,
    path: dbPath,
    powersyncConfig: getPowerSyncConfig(),
  })
}

const initializeTray = async (): Promise<{ tray: TrayIcon | undefined; window: Window | undefined }> => {
  return await TrayManager.initIfSupported()
}

const initializePostHog = async (httpClient?: HttpClient): Promise<PostHog | null> => {
  const result = await initPosthog(httpClient)
  return result.success ? result.data : null
}

const executeInitializationSteps = async (httpClient?: HttpClient): Promise<HandleResult<InitData>> => {
  // Step 1: App directory creation
  let appDirPath: string
  try {
    appDirPath = await createAppDirectory()
  } catch (error) {
    console.error('Failed to create app directory:', error)
    const appDirError = createHandleError('APP_DIR_CREATION_FAILED', 'Failed to create app directory', error)
    trackError(appDirError, { initialization_step: 'app_directory' })
    return {
      success: false,
      error: appDirError,
    }
  }

  // Step 2: Database initialization (PowerSync manages its own schema, no migrations needed)
  try {
    await initializeDatabase(appDirPath)
  } catch (error) {
    console.error('Failed to initialize database:', error)
    const dbError = createHandleError('DATABASE_INIT_FAILED', 'Failed to initialize database', error)
    trackError(dbError, { initialization_step: 'database_init' })
    return {
      success: false,
      error: dbError,
    }
  }

  // Step 3: Reconcile default settings
  try {
    await reconcileDefaults(DatabaseSingleton.instance.db)
  } catch (error) {
    console.error('Failed to reconcile default settings:', error)
    const reconcileError = createHandleError('RECONCILE_DEFAULTS_FAILED', 'Failed to reconcile default settings', error)
    trackError(reconcileError, { initialization_step: 'reconcile_defaults' })
    return {
      success: false,
      error: reconcileError,
    }
  }

  // Step 4: HTTP client initialization (use provided client or create one)
  let client: HttpClient
  if (httpClient) {
    client = httpClient
  } else {
    try {
      const { cloudUrl } = await getSettings({ cloud_url: 'http://localhost:8000/v1' })
      client = ky.create({ prefixUrl: cloudUrl })
    } catch (error) {
      console.error('Failed to initialize HTTP client:', error)
      const httpClientError = createHandleError('HTTP_CLIENT_INIT_FAILED', 'Failed to initialize HTTP client', error)
      trackError(httpClientError, { initialization_step: 'http_client' })
      return {
        success: false,
        error: httpClientError,
      }
    }
  }

  // Step 6: Tray initialization (non-critical)
  let tray: { tray: TrayIcon | undefined; window: Window | undefined } = { tray: undefined, window: undefined }
  try {
    tray = await initializeTray()
  } catch (error) {
    console.warn('Failed to initialize tray, continuing without tray support:', error)
    const trayError = createHandleError('TRAY_INIT_FAILED', 'Failed to initialize tray', error)
    trackError(trayError, { initialization_step: 'tray' })
  }

  // Step 7: PostHog initialization (non-critical)
  let posthogClient: PostHog | null = null
  try {
    posthogClient = await initializePostHog(client)
  } catch (error) {
    console.warn('Unexpected error during PostHog initialization:', error)
  }

  const url = new URL(window.location.href)
  const { type: sideviewType, id: sideviewId } = parseSideviewParam(url)

  return {
    success: true,
    data: {
      sideviewType,
      sideviewId,
      posthogClient,
      httpClient: client,
      ...tray,
    },
  }
}

/**
 * Hook for managing app initialization
 * @param httpClient - Optional HTTP client (primarily for testing)
 */
export const useAppInitialization = (httpClient?: HttpClient) => {
  const [initData, setInitData] = useState<InitData>()
  const [initError, setInitError] = useState<HandleError>()
  const [isInitializing, setIsInitializing] = useState(true)

  const initialize = useCallback(async () => {
    setIsInitializing(true)
    try {
      const result = await executeInitializationSteps(httpClient)
      if (result.success) {
        setInitData(result.data)
        setInitError(undefined)
      } else {
        setInitError(result.error)
      }
    } finally {
      setIsInitializing(false)
    }
  }, [httpClient])

  const retry = useCallback(async () => {
    await initialize()
  }, [initialize])

  const clearDatabase = useCallback(async () => {
    setIsInitializing(true)
    try {
      await resetAppDir()
      await initialize()
    } finally {
      setIsInitializing(false)
    }
  }, [initialize])

  useEffect(() => {
    initialize()
  }, [initialize])

  return {
    initData,
    initError,
    isInitializing,
    retry,
    clearDatabase,
  }
}
