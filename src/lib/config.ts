import { getSetting } from '@/dal'

/**
 * Get the default cloud URL from environment variables or fallback to localhost
 */
export const getDefaultCloudUrl = (): string => {
  return import.meta.env?.VITE_THUNDERBOLT_CLOUD_URL || 'http://localhost:8000'
}

/**
 * Get the cloud URL from settings or fallback to default
 */
export const getCloudUrl = async (): Promise<string> => {
  return (await getSetting('cloud_url', getDefaultCloudUrl()))!
}
