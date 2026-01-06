import { getSettings } from '@/config/settings'

/**
 * Check if Promptfoo is properly configured and enabled
 * This is used to determine if the evaluation configs should be active
 */
export const isPromptfooConfigured = (): boolean => {
  const settings = getSettings()
  return settings.promptfooEnabled && !!settings.promptfooApiBaseUrl
}

/**
 * Get the Promptfoo API base URL for sharing results
 */
export const getPromptfooApiBaseUrl = (): string => {
  const settings = getSettings()
  return settings.promptfooApiBaseUrl
}
