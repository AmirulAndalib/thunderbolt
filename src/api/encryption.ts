import { getAuthToken, getDeviceId } from '@/lib/auth-token'
import { getDeviceDisplayName } from '@/lib/platform'
import ky from 'ky'

type RegisterDeviceResponse =
  | { status: 'TRUSTED'; envelope: string | null }
  | { status: 'APPROVAL_PENDING'; firstDevice: boolean }

type StoreEnvelopeResponse = {
  status: 'TRUSTED'
}

type FetchEnvelopeResponse = {
  status: string
  wrappedCK: string
}

type FetchCanaryResponse = {
  canaryIv: string
  canaryCtext: string
}

const buildHeaders = (): Record<string, string> => {
  const headers: Record<string, string> = {}
  const token = getAuthToken()
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  }
  const deviceId = getDeviceId()
  if (deviceId) {
    headers['X-Device-ID'] = deviceId
    headers['X-Device-Name'] = getDeviceDisplayName()
  }
  return headers
}

/** POST /devices — Register or identify a device. */
export const registerDevice = async (
  baseUrl: string,
  deviceId: string,
  publicKey: string,
  name: string,
): Promise<RegisterDeviceResponse> =>
  ky
    .post('devices', {
      prefixUrl: baseUrl,
      headers: buildHeaders(),
      json: { deviceId, publicKey, name },
      credentials: 'omit',
    })
    .json<RegisterDeviceResponse>()

/** POST /devices/:deviceId/envelope — Store envelope and mark device trusted. */
export const storeEnvelope = async (
  baseUrl: string,
  deviceId: string,
  wrappedCK: string,
  canary?: { canaryIv: string; canaryCtext: string },
): Promise<StoreEnvelopeResponse> =>
  ky
    .post(`devices/${encodeURIComponent(deviceId)}/envelope`, {
      prefixUrl: baseUrl,
      headers: buildHeaders(),
      json: { wrappedCK, ...canary },
      credentials: 'omit',
    })
    .json<StoreEnvelopeResponse>()

/** GET /devices/me/envelope — Fetch calling device's own envelope. */
export const fetchMyEnvelope = async (baseUrl: string): Promise<FetchEnvelopeResponse> =>
  ky
    .get('devices/me/envelope', {
      prefixUrl: baseUrl,
      headers: buildHeaders(),
      credentials: 'omit',
    })
    .json<FetchEnvelopeResponse>()

/** GET /encryption/canary — Fetch canary for recovery key verification. */
export const fetchCanary = async (baseUrl: string): Promise<FetchCanaryResponse> =>
  ky
    .get('encryption/canary', {
      prefixUrl: baseUrl,
      headers: buildHeaders(),
      credentials: 'omit',
    })
    .json<FetchCanaryResponse>()
