import { getSetting } from '@/dal'
import type { ToolConfig } from '@/types'
import ky from 'ky'
import { z } from 'zod'

/**
 * Schemas
 */
export const listThreadsSchema = z.object({
  maxResults: z.number().optional().describe('Maximum number of threads to return'),
  pageToken: z.string().optional().describe('Page token to retrieve a specific page of results'),
  q: z.string().optional().describe('Only return threads matching the specified query'),
  labelIds: z
    .array(z.string())
    .optional()
    .describe('Only return threads with labels that match all of the specified label IDs'),
  includeSpamTrash: z.boolean().optional().describe('Include threads from SPAM and TRASH in the results'),
  includeBodyHtml: z.boolean().optional().describe('Whether to include the parsed HTML in the return for each body'),
})

export const getThreadSchema = z.object({
  id: z.string().describe('The ID of the thread to retrieve'),
  includeBodyHtml: z.boolean().optional().describe('Whether to include the parsed HTML in the return for each body'),
})

export type ListThreadsParams = z.infer<typeof listThreadsSchema>
export type GetThreadParams = z.infer<typeof getThreadSchema>

// ---------------------------------------------------------------------------
// Google Mail API minimal types
// ---------------------------------------------------------------------------

type GoogleThreadStub = {
  id: string
  snippet?: string
  historyId?: string
}

export type GoogleListThreadsResponse = {
  threads?: GoogleThreadStub[]
  nextPageToken?: string
  resultSizeEstimate?: number
}

type GoogleMessagePayload = {
  mimeType?: string
  body?: { data?: string }
  parts?: GoogleMessagePayload[]
}

type GoogleMessage = {
  id?: string
  payload?: GoogleMessagePayload
  [key: string]: unknown
}

export type GoogleThreadResponse = {
  id?: string
  messages?: GoogleMessage[]
  [key: string]: unknown
}

/**
 * Internal helpers
 */
const getGoogleCredentials = async () => {
  const credentialsStr = await getSetting('integrations_google_credentials')
  if (!credentialsStr) throw new Error('Google integration not connected')

  try {
    return JSON.parse(credentialsStr)
  } catch {
    throw new Error('Invalid Google credentials')
  }
}

/** Refresh access token if needed */
const ensureValidToken = async (credentials: { access_token: string; refresh_token: string; expires_at?: number }) => {
  const now = Date.now()
  if (credentials.expires_at && credentials.expires_at < now) {
    if (!credentials.refresh_token) throw new Error('Access token expired and no refresh token available')

    const { refreshAccessToken } = await import('@/lib/auth')
    const newTokens = await refreshAccessToken('google', credentials.refresh_token)
    const updated = {
      ...credentials,
      access_token: newTokens.access_token,
      expires_at: Date.now() + newTokens.expires_in * 1000,
    }

    const { updateSetting } = await import('@/dal')
    await updateSetting('integrations_google_credentials', JSON.stringify(updated))

    return newTokens.access_token
  }

  return credentials.access_token
}

/**
 * Public API
 */
export const listThreads = async (params: ListThreadsParams) => {
  const credentials = await getGoogleCredentials()
  const accessToken = await ensureValidToken(credentials)

  const searchParams = new URLSearchParams()
  if (params.maxResults) searchParams.set('maxResults', params.maxResults.toString())
  if (params.pageToken) searchParams.set('pageToken', params.pageToken)
  if (params.q) searchParams.set('q', params.q)
  if (params.labelIds?.length) params.labelIds.forEach((id) => searchParams.append('labelIds', id))
  if (params.includeSpamTrash !== undefined) searchParams.set('includeSpamTrash', String(params.includeSpamTrash))

  const response = await ky
    .get('https://www.googleapis.com/gmail/v1/users/me/threads', {
      searchParams,
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    .json<GoogleListThreadsResponse>()

  if (params.includeBodyHtml && response.threads) {
    const threadsWithDetails = await Promise.all(
      response.threads.map((thread) => getThread({ id: thread.id, includeBodyHtml: true })),
    )
    return { ...response, threads: threadsWithDetails }
  }

  return response
}

export const getThread = async (params: GetThreadParams) => {
  const credentials = await getGoogleCredentials()
  const accessToken = await ensureValidToken(credentials)

  const response = await ky
    .get(`https://www.googleapis.com/gmail/v1/users/me/threads/${params.id}`, {
      headers: { Authorization: `Bearer ${accessToken}` },
    })
    .json<GoogleThreadResponse>()

  if (params.includeBodyHtml && response.messages) {
    response.messages = response.messages.map((m) => {
      const processed = { ...m } as GoogleMessage & { bodyHtml?: string | null; bodyText?: string | null }
      if (m.payload) {
        processed.bodyHtml = extractBody(m.payload, 'text/html')
        processed.bodyText = extractBody(m.payload, 'text/plain')
      }
      return processed
    })
  }

  return response as GoogleThreadResponse & {
    messages?: (GoogleMessage & { bodyHtml?: string | null; bodyText?: string | null })[]
  }
}

/** Recursively extract part body */
const extractBody = (
  payload: { mimeType?: string; body?: { data?: string }; parts?: any[] },
  type: string,
): string | null => {
  if (payload.mimeType === type && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf-8')
  }
  if (payload.parts) {
    for (const p of payload.parts) {
      const body = extractBody(p, type)
      if (body) return body
    }
  }
  return null
}

export const configs: ToolConfig[] = [
  {
    name: 'google_list_threads',
    description: 'List Google threads with optional filtering',
    verb: 'Listing Google threads',
    parameters: listThreadsSchema,
    execute: listThreads,
  },
  {
    name: 'google_get_thread',
    description: 'Get a specific Google thread by ID',
    verb: 'Getting Google thread',
    parameters: getThreadSchema,
    execute: getThread,
  },
]
