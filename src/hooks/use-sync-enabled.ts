/**
 * Hook for managing the sync enabled state
 * Persists the value in localStorage
 */

import { useCallback, useSyncExternalStore } from 'react'

const STORAGE_KEY = 'thunderbolt_sync_enabled'

/**
 * Get the current sync enabled state from localStorage
 * Defaults to false (sync disabled until user logs in and enables it)
 */
const getSyncEnabled = (): boolean => {
  const stored = localStorage.getItem(STORAGE_KEY)
  // Default to false if not set - sync requires authentication
  if (stored === null) return false
  return stored === 'true'
}

/**
 * Subscribe to localStorage changes for the sync enabled key
 */
const subscribe = (callback: () => void): (() => void) => {
  const handleStorage = (event: StorageEvent) => {
    if (event.key === STORAGE_KEY) {
      callback()
    }
  }

  // Also listen for custom events for same-tab updates
  const handleCustom = () => callback()

  window.addEventListener('storage', handleStorage)
  window.addEventListener('thunderbolt-sync-enabled-change', handleCustom)

  return () => {
    window.removeEventListener('storage', handleStorage)
    window.removeEventListener('thunderbolt-sync-enabled-change', handleCustom)
  }
}

/**
 * Hook for managing sync enabled state with localStorage persistence
 * Uses useSyncExternalStore for reliable state synchronization
 */
export const useSyncEnabled = () => {
  const isEnabled = useSyncExternalStore(subscribe, getSyncEnabled, getSyncEnabled)

  const setEnabled = useCallback((enabled: boolean) => {
    localStorage.setItem(STORAGE_KEY, String(enabled))
    // Dispatch custom event for same-tab updates
    window.dispatchEvent(new CustomEvent('thunderbolt-sync-enabled-change'))
  }, [])

  const toggle = useCallback(() => {
    setEnabled(!getSyncEnabled())
  }, [setEnabled])

  return {
    isEnabled,
    setEnabled,
    toggle,
  }
}

/**
 * Get the sync enabled state synchronously (for non-React code)
 * Useful for app initialization
 */
export const isSyncEnabled = (): boolean => getSyncEnabled()
