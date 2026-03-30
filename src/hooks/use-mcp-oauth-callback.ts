import { useDatabase } from '@/contexts'
import { createCredentialStore } from '@/lib/mcp-auth'
import { getMcpOAuthState, clearMcpOAuthState } from '@/lib/mcp-auth/mcp-oauth-state'
import { isLocalMcpServer } from '@/lib/mcp-utils'
import { useMCP } from '@/lib/mcp-provider'
import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router'

type McpOAuthCallbackData = {
  code?: string
  state?: string
  error?: string
}

/**
 * Creates a fetch function that routes through the CORS proxy when needed.
 * Cross-origin requests (including localhost with different ports) require the proxy.
 */
const createOAuthFetch = async (serverUrl: string) => {
  if (isLocalMcpServer(serverUrl)) {
    const url = new URL(serverUrl)
    if (url.port === window.location.port || (!url.port && window.location.port === '')) {
      return undefined
    }
  }

  const cloudUrl = import.meta.env.VITE_THUNDERBOLT_CLOUD_URL ?? 'http://localhost:8000/v1'
  const { createProxiedFetch } = await import('@/lib/mcp-transports/proxied-fetch')
  return createProxiedFetch(cloudUrl)
}

/**
 * Handles the MCP OAuth callback on the MCP servers page.
 * Same pattern as useOAuthConnect.processCallback + the integrations page useEffect.
 *
 * Detects location.state.mcpOauth, exchanges the authorization code for tokens
 * using the MCP SDK's exchangeAuthorization, stores in credential store, and reconnects.
 */
export const useMcpOAuthCallback = () => {
  const db = useDatabase()
  const location = useLocation()
  const navigate = useNavigate()
  const { reconnectServer } = useMCP()
  const credentialStoreRef = useRef(createCredentialStore(db))

  const [isProcessingOAuth, setIsProcessingOAuth] = useState(() => {
    const mcpOauth = (location.state as { mcpOauth?: unknown } | null)?.mcpOauth
    return !!mcpOauth
  })
  const [oauthError, setOauthError] = useState<string | null>(null)

  useEffect(() => {
    const mcpOauth = (location.state as { mcpOauth?: McpOAuthCallbackData } | null)?.mcpOauth
    if (!mcpOauth) return

    const handleCallback = async () => {
      setIsProcessingOAuth(true)
      setOauthError(null)

      try {
        if (mcpOauth.error) {
          throw new Error(mcpOauth.error)
        }

        if (!mcpOauth.code) {
          throw new Error('No authorization code received')
        }

        // Read persisted OAuth state from settings
        const oauthState = await getMcpOAuthState()
        if (!oauthState.serverId || !oauthState.serverUrl || !oauthState.codeVerifier) {
          throw new Error('OAuth state not found — the authorization flow may have expired')
        }

        // Route through CORS proxy when needed (cross-origin requests)
        const fetchFn = await createOAuthFetch(oauthState.serverUrl)

        // Exchange authorization code for tokens using the MCP SDK
        const { discoverOAuthMetadata, exchangeAuthorization } = await import(
          '@modelcontextprotocol/sdk/client/auth.js'
        )

        const metadata = await discoverOAuthMetadata(oauthState.serverUrl, {}, fetchFn)
        if (!metadata) {
          throw new Error('Could not discover OAuth metadata from the MCP server')
        }

        const clientInfo = oauthState.clientInfo ? JSON.parse(oauthState.clientInfo) : undefined

        const tokens = await exchangeAuthorization(oauthState.serverUrl, {
          metadata,
          clientInformation: clientInfo,
          authorizationCode: mcpOauth.code,
          codeVerifier: oauthState.codeVerifier,
          redirectUri: oauthState.redirectUrl || oauthState.serverUrl,
          fetchFn,
        })

        // Store tokens in credential store (encrypted)
        await credentialStoreRef.current.save(oauthState.serverId, {
          type: 'oauth',
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          expiresAt: tokens.expires_in ? new Date(Date.now() + tokens.expires_in * 1000).toISOString() : undefined,
          tokenType: tokens.token_type ?? 'bearer',
          scope: tokens.scope,
        })

        // Clear OAuth state from settings
        await clearMcpOAuthState()

        // Reconnect the server — tokens are now in the credential store
        await reconnectServer(oauthState.serverId)
      } catch (err) {
        const message = err instanceof Error ? err.message : 'OAuth authorization failed'
        console.error('MCP OAuth callback error:', message)
        setOauthError(message)
        await clearMcpOAuthState()
      } finally {
        setIsProcessingOAuth(false)
        navigate('.', { replace: true, state: null })
      }
    }

    handleCallback()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state])

  return { isProcessingOAuth, oauthError }
}
