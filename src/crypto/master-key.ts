import { keyStorage } from './key-storage'
import { exportKeyBytes, importKeyBytes } from './primitives'
import { fromBase64, toBase64 } from './utils'

const storageKeys = {
  encKey: 'thunderbolt_enc_key',
  encSalt: 'thunderbolt_enc_salt',
  encVersion: 'thunderbolt_enc_version',
  keyState: 'thunderbolt_key_state',
} as const

export const keyStates = {
  NO_KEY: 'NO_KEY',
  KEY_PRESENT: 'KEY_PRESENT',
  KEY_LOCKED: 'KEY_LOCKED',
} as const

export type KeyState = (typeof keyStates)[keyof typeof keyStates]

let _cachedKey: CryptoKey | null = null

/**
 * Load the master key from storage and import it into SubtleCrypto.
 * Caches the imported CryptoKey for the session.
 */
export const getMasterKey = async (): Promise<CryptoKey | null> => {
  if (_cachedKey) {
    return _cachedKey
  }

  const b64 = keyStorage.get(storageKeys.encKey)
  if (!b64) {
    return null
  }

  const keyBytes = fromBase64(b64)
  _cachedKey = await importKeyBytes(keyBytes, true)
  return _cachedKey
}

/**
 * Persist a new master key. Accepts raw bytes.
 * Clears the session cache — forces re-import on next getMasterKey() call.
 */
export const setMasterKey = async (keyBytes: Uint8Array): Promise<void> => {
  keyStorage.set(storageKeys.encKey, toBase64(keyBytes))
  keyStorage.set(storageKeys.encVersion, 'v1')
  keyStorage.set(storageKeys.keyState, keyStates.KEY_PRESENT)
  _cachedKey = null
}

/** Persist the PBKDF2 salt alongside the master key. */
export const setSalt = (salt: Uint8Array): void => {
  keyStorage.set(storageKeys.encSalt, toBase64(salt))
}

/** Retrieve the stored PBKDF2 salt, or null if none. */
export const getSalt = (): Uint8Array | null => {
  const b64 = keyStorage.get(storageKeys.encSalt)
  return b64 ? fromBase64(b64) : null
}

/** Remove the master key from storage and clear the session cache. */
export const clearMasterKey = (): void => {
  keyStorage.clear()
  _cachedKey = null
}

/**
 * Synchronous check — returns true for both KEY_PRESENT and KEY_LOCKED.
 * Returns false only for NO_KEY.
 */
export const hasMasterKey = (): boolean => {
  const state = keyStorage.get(storageKeys.keyState)
  return state === keyStates.KEY_PRESENT || state === keyStates.KEY_LOCKED
}

/** Returns the current key state. Synchronous — reads from localStorage. */
export const getKeyState = (): KeyState => {
  const state = keyStorage.get(storageKeys.keyState)
  if (state === keyStates.KEY_PRESENT) {
    return keyStates.KEY_PRESENT
  }
  if (state === keyStates.KEY_LOCKED) {
    return keyStates.KEY_LOCKED
  }
  return keyStates.NO_KEY
}

/**
 * Called on every app startup before rendering any UI.
 * - "READY" — key is present and usable
 * - "NO_KEY" — no key set up
 * - "REQUIRES_UNLOCK" — KEY_LOCKED state (Phase 3)
 */
export const getStartupAction = (): 'READY' | 'NO_KEY' | 'REQUIRES_UNLOCK' => {
  const state = getKeyState()
  if (state === keyStates.KEY_PRESENT) {
    return 'READY'
  }
  if (state === keyStates.KEY_LOCKED) {
    return 'REQUIRES_UNLOCK'
  }
  return 'NO_KEY'
}

/**
 * Export the current master key as raw bytes.
 * Returns null if no key is available.
 */
export const exportMasterKeyBytes = async (): Promise<Uint8Array | null> => {
  const key = await getMasterKey()
  if (!key) {
    return null
  }
  return exportKeyBytes(key)
}

/** Clear the in-memory session cache only (for testing). */
export const _clearCache = (): void => {
  _cachedKey = null
}
