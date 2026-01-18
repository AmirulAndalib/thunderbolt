/**
 * WebSocket-based sync service for cr-sqlite database synchronization
 * Provides real-time change streaming between devices via persistent WebSocket connection
 */

import { getAuthToken } from '@/lib/auth-token'
import type { CRSQLChange } from './crsqlite-worker'
import { getLatestMigrationVersion } from './migrate'
import { DatabaseSingleton } from './singleton'

const SYNC_SERVER_VERSION_KEY = 'thunderbolt_server_version'
const SITE_ID_KEY = 'thunderbolt_site_id'
const SYNC_VERSION_KEY = 'thunderbolt_sync_version'

/**
 * Serialized change format for network transport
 * Uses base64 for binary data (pk, site_id)
 */
export type SerializedChange = {
  table: string
  pk: string // base64 encoded
  cid: string
  val: unknown
  col_version: string // bigint as string
  db_version: string // bigint as string
  site_id: string // base64 encoded
  cl: number
  seq: number
}

/**
 * WebSocket message types
 */
type WSMessage =
  | { type: 'auth'; siteId: string; migrationVersion?: string; token?: string }
  | { type: 'push'; changes: SerializedChange[]; dbVersion: string }
  | { type: 'pull'; since: string }

type WSResponse =
  | { type: 'auth_success'; serverVersion: string }
  | { type: 'auth_error'; error: string }
  | { type: 'push_success'; serverVersion: string }
  | { type: 'push_error'; error: string }
  | { type: 'changes'; changes: SerializedChange[]; serverVersion: string }
  | { type: 'version_mismatch'; requiredVersion: string }

export type SyncStatus = 'idle' | 'connecting' | 'connected' | 'syncing' | 'error' | 'offline' | 'version_mismatch'

export type SyncServiceOptions = {
  /** WebSocket URL (e.g., ws://localhost:3000/v1/sync/ws) */
  wsUrl: string
  onStatusChange?: (status: SyncStatus) => void
  onError?: (error: Error) => void
  /** Called when tables have been updated from remote changes */
  onTablesChanged?: (tables: string[]) => void
  /** Called when a version mismatch is detected (client needs upgrade) */
  onVersionMismatch?: (requiredVersion: string) => void
  /** Called when chat sessions have been updated from remote changes */
  onChatSessionsChanged?: (chatThreadIds: string[]) => void
}

/**
 * Encode Uint8Array to base64 string
 */
const encodeBase64 = (data: Uint8Array): string => {
  const bytes = Array.from(data)
  return btoa(String.fromCharCode(...bytes))
}

/**
 * Decode base64 string to Uint8Array
 */
const decodeBase64 = (base64: string): Uint8Array => {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

/**
 * Serialize a CRSQLChange for network transport
 */
const serializeChange = (change: CRSQLChange): SerializedChange => ({
  table: change.table,
  pk: encodeBase64(change.pk),
  cid: change.cid,
  val: change.val,
  col_version: change.col_version.toString(),
  db_version: change.db_version.toString(),
  site_id: encodeBase64(change.site_id),
  cl: change.cl,
  seq: change.seq,
})

/**
 * Deserialize a network change to CRSQLChange
 */
const deserializeChange = (serialized: SerializedChange): CRSQLChange => ({
  table: serialized.table,
  pk: decodeBase64(serialized.pk),
  cid: serialized.cid,
  val: serialized.val,
  col_version: BigInt(serialized.col_version),
  db_version: BigInt(serialized.db_version),
  site_id: decodeBase64(serialized.site_id),
  cl: serialized.cl,
  seq: serialized.seq,
})

export class SyncService {
  private wsUrl: string
  private ws: WebSocket | null = null
  private status: SyncStatus = 'idle'
  private onStatusChange?: (status: SyncStatus) => void
  private onError?: (error: Error) => void
  private onTablesChanged?: (tables: string[]) => void
  private onVersionMismatch?: (requiredVersion: string) => void
  private onChatSessionsChanged?: (chatThreadIds: string[]) => void
  private _requiredVersion: string | null = null
  private _isOnline: boolean
  private reconnectAttempts = 0
  private maxReconnectAttempts = 10
  private reconnectTimeoutId: ReturnType<typeof setTimeout> | null = null
  private isRunning = false
  private pendingChanges: CRSQLChange[] = []
  private isPushingChanges = false
  private dbChangeListener: (() => void) | null = null
  private lastPushedVersion = 0n

  private handleOnline = () => this.handleNetworkChange(true)
  private handleOffline = () => this.handleNetworkChange(false)

  constructor(options: SyncServiceOptions) {
    this._isOnline = typeof navigator !== 'undefined' ? navigator.onLine : true
    this.wsUrl = options.wsUrl
    this.onStatusChange = options.onStatusChange
    this.onError = options.onError
    this.onTablesChanged = options.onTablesChanged
    this.onVersionMismatch = options.onVersionMismatch
    this.onChatSessionsChanged = options.onChatSessionsChanged
  }

  get requiredVersion(): string | null {
    return this._requiredVersion
  }

  get isOnline(): boolean {
    return this._isOnline
  }

  private setStatus(status: SyncStatus): void {
    if (this.status !== status) {
      this.status = status
      this.onStatusChange?.(status)
    }
  }

  private handleNetworkChange(isOnline: boolean): void {
    const wasOffline = !this._isOnline
    this._isOnline = isOnline

    if (!isOnline) {
      this.setStatus('offline')
      this.disconnect()
    } else if (wasOffline && this.isRunning) {
      this.setStatus('idle')
      this.connect()
    }
  }

  private getServerVersion(): bigint {
    const stored = localStorage.getItem(SYNC_SERVER_VERSION_KEY)
    return stored ? BigInt(stored) : 0n
  }

  private setServerVersion(version: bigint): void {
    localStorage.setItem(SYNC_SERVER_VERSION_KEY, version.toString())
  }

  private getLastSyncedVersion(): bigint {
    const stored = localStorage.getItem(SYNC_VERSION_KEY)
    return stored ? BigInt(stored) : 0n
  }

  private setLastSyncedVersion(version: bigint): void {
    localStorage.setItem(SYNC_VERSION_KEY, version.toString())
  }

  async getSiteId(): Promise<string> {
    const storedSiteId = localStorage.getItem(SITE_ID_KEY)
    if (storedSiteId) {
      return storedSiteId
    }

    const db = DatabaseSingleton.instance.syncableDatabase
    const siteId = await db.getSiteId()
    localStorage.setItem(SITE_ID_KEY, siteId)
    return siteId
  }

  private async connect(): Promise<void> {
    if (!DatabaseSingleton.instance.supportsSyncing) {
      return
    }

    if (this.ws?.readyState === WebSocket.OPEN || this.ws?.readyState === WebSocket.CONNECTING) {
      return
    }

    if (!this._isOnline) {
      this.setStatus('offline')
      return
    }

    this.setStatus('connecting')

    try {
      this.ws = new WebSocket(this.wsUrl)

      this.ws.onopen = async () => {
        console.info('WebSocket connected, authenticating...')
        this.reconnectAttempts = 0

        // Authenticate with bearer token
        const siteId = await this.getSiteId()
        const migrationVersion = getLatestMigrationVersion()
        const token = getAuthToken()

        this.send({
          type: 'auth',
          siteId,
          migrationVersion,
          token: token ?? undefined,
        })
      }

      this.ws.onmessage = async (event) => {
        try {
          const response = JSON.parse(event.data) as WSResponse
          await this.handleMessage(response)
        } catch (error) {
          console.error('Failed to parse WebSocket message:', error)
        }
      }

      this.ws.onerror = (event) => {
        console.error('WebSocket error:', event)
        this.setStatus('error')
        this.onError?.(new Error('WebSocket connection error'))
      }

      this.ws.onclose = () => {
        console.info('WebSocket closed')
        this.ws = null

        if (this.isRunning && this._isOnline && this.status !== 'version_mismatch') {
          this.scheduleReconnect()
        }
      }
    } catch (error) {
      console.error('Failed to connect WebSocket:', error)
      this.setStatus('error')
      this.onError?.(error instanceof Error ? error : new Error(String(error)))
      this.scheduleReconnect()
    }
  }

  private async handleMessage(response: WSResponse): Promise<void> {
    switch (response.type) {
      case 'auth_success': {
        console.info('WebSocket authenticated, server version:', response.serverVersion)
        this.setStatus('connected')
        this.setServerVersion(BigInt(response.serverVersion))

        // Request any changes we might have missed while offline
        const serverVersion = this.getServerVersion()
        this.send({ type: 'pull', since: serverVersion.toString() })

        // Set up database change listener for real-time push
        await this.setupDbChangeListener()

        // Push any pending local changes
        await this.pushLocalChanges()
        break
      }

      case 'auth_error': {
        console.error('WebSocket auth error:', response.error)
        this.setStatus('error')
        this.onError?.(new Error(response.error))
        this.disconnect()
        break
      }

      case 'push_success': {
        console.info('Push successful, server version:', response.serverVersion)
        this.setServerVersion(BigInt(response.serverVersion))
        this.setLastSyncedVersion(this.lastPushedVersion)
        this.isPushingChanges = false

        // Push any pending changes that accumulated during the push
        if (this.pendingChanges.length > 0) {
          await this.pushLocalChanges()
        } else {
          this.setStatus('connected')
        }
        break
      }

      case 'push_error': {
        console.error('Push error:', response.error)
        this.isPushingChanges = false
        this.setStatus('error')
        this.onError?.(new Error(response.error))
        break
      }

      case 'changes': {
        console.info(`Received ${response.changes.length} changes from server`)

        if (response.changes.length > 0) {
          const changes = response.changes.map(deserializeChange)
          await this.applyRemoteChanges(changes)

          // Extract unique table names
          const affectedTables = [...new Set(response.changes.map((c) => c.table))]
          this.onTablesChanged?.(affectedTables)

          // Extract chat thread IDs from chat_messages changes
          const affectedChatThreadIds = [
            ...new Set(
              response.changes
                .filter((c) => c.table === 'chat_messages' && c.cid === 'chat_thread_id' && typeof c.val === 'string')
                .map((c) => c.val as string),
            ),
          ]

          if (affectedChatThreadIds.length > 0) {
            this.onChatSessionsChanged?.(affectedChatThreadIds)
          }
        }

        this.setServerVersion(BigInt(response.serverVersion))
        break
      }

      case 'version_mismatch': {
        console.warn('Version mismatch, required:', response.requiredVersion)
        this._requiredVersion = response.requiredVersion
        this.setStatus('version_mismatch')
        this.onVersionMismatch?.(response.requiredVersion)
        this.stop()
        break
      }
    }
  }

  private send(message: WSMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message))
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimeoutId) {
      clearTimeout(this.reconnectTimeoutId)
    }

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('Max reconnect attempts reached')
      this.setStatus('error')
      return
    }

    // Exponential backoff: 1s, 2s, 4s, 8s, 16s, 32s (capped at 32s)
    const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 32000)
    this.reconnectAttempts++

    console.info(`Scheduling reconnect attempt ${this.reconnectAttempts} in ${delay}ms`)

    this.reconnectTimeoutId = setTimeout(() => {
      this.connect()
    }, delay)
  }

  private disconnect(): void {
    if (this.reconnectTimeoutId) {
      clearTimeout(this.reconnectTimeoutId)
      this.reconnectTimeoutId = null
    }

    if (this.ws) {
      this.ws.onclose = null // Prevent reconnect on intentional close
      this.ws.close()
      this.ws = null
    }

    this.removeDbChangeListener()
  }

  private async setupDbChangeListener(): Promise<void> {
    const db = DatabaseSingleton.instance.syncableDatabase

    // Subscribe to change notifications in the worker
    await db.subscribeToChanges()

    // Set up listener that triggers when any table changes
    // This uses @vlcn.io/rx-tbl under the hood for reactive updates
    const unsubscribe = db.onTablesChanged(() => {
      if (this.ws?.readyState === WebSocket.OPEN && !this.isPushingChanges) {
        this.pushLocalChanges()
      }
    })

    this.dbChangeListener = () => {
      unsubscribe()
      db.unsubscribeFromChanges().catch(console.error)
    }
  }

  private removeDbChangeListener(): void {
    if (this.dbChangeListener) {
      this.dbChangeListener()
      this.dbChangeListener = null
    }
  }

  private async pushLocalChanges(): Promise<void> {
    if (!DatabaseSingleton.instance.supportsSyncing) {
      return
    }

    if (this.isPushingChanges) {
      return
    }

    if (this.ws?.readyState !== WebSocket.OPEN) {
      return
    }

    try {
      const db = DatabaseSingleton.instance.syncableDatabase
      const lastSyncedVersion = this.getLastSyncedVersion()
      const { changes, dbVersion } = await db.getChanges(lastSyncedVersion)

      if (changes.length === 0) {
        return
      }

      this.isPushingChanges = true
      this.setStatus('syncing')
      this.lastPushedVersion = dbVersion

      const serializedChanges = changes.map(serializeChange)

      this.send({
        type: 'push',
        changes: serializedChanges,
        dbVersion: dbVersion.toString(),
      })

      console.info(`Pushing ${changes.length} local changes`)
    } catch (error) {
      console.error('Failed to push local changes:', error)
      this.isPushingChanges = false
      this.setStatus('error')
      this.onError?.(error instanceof Error ? error : new Error(String(error)))
    }
  }

  private async applyRemoteChanges(changes: CRSQLChange[]): Promise<void> {
    if (changes.length === 0) {
      return
    }

    const db = DatabaseSingleton.instance.syncableDatabase
    await db.applyChanges(changes)
  }

  /**
   * Start the sync service
   */
  start(): void {
    if (this.isRunning) {
      return
    }

    this.isRunning = true

    // Listen for network status changes
    if (typeof window !== 'undefined') {
      window.addEventListener('online', this.handleOnline)
      window.addEventListener('offline', this.handleOffline)
    }

    // Update online status
    if (typeof navigator !== 'undefined') {
      this._isOnline = navigator.onLine
    }

    // Connect WebSocket
    this.connect()

    console.info('WebSocket sync service started')
  }

  /**
   * Stop the sync service
   */
  stop(): void {
    this.isRunning = false

    // Remove network status listeners
    if (typeof window !== 'undefined') {
      window.removeEventListener('online', this.handleOnline)
      window.removeEventListener('offline', this.handleOffline)
    }

    this.disconnect()
    console.info('WebSocket sync service stopped')
  }

  /**
   * Get current sync status
   */
  getStatus(): SyncStatus {
    return this.status
  }

  /**
   * Force an immediate sync (push + pull)
   */
  async forceSync(): Promise<void> {
    if (this.ws?.readyState !== WebSocket.OPEN) {
      await this.connect()
      return
    }

    await this.pushLocalChanges()

    const serverVersion = this.getServerVersion()
    this.send({ type: 'pull', since: serverVersion.toString() })
  }
}

// Singleton instance
let syncServiceInstance: SyncService | null = null

/**
 * Initialize the sync service singleton
 */
export const initSyncService = (options: SyncServiceOptions): SyncService => {
  if (syncServiceInstance) {
    syncServiceInstance.stop()
  }
  syncServiceInstance = new SyncService(options)
  return syncServiceInstance
}

/**
 * Get the sync service singleton
 */
export const getSyncService = (): SyncService | null => {
  return syncServiceInstance
}
