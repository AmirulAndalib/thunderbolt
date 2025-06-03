import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { experimental_createMCPClient } from 'ai'
import { createContext, ReactNode, useContext, useEffect, useRef, useState } from 'react'
import { TauriStreamableHTTPClientTransport } from './tauri-http-transport'

type MCPClient = Awaited<ReturnType<typeof experimental_createMCPClient>>

interface MCPServerConnection {
  id: string
  name: string
  url: string
  client: MCPClient | null
  isConnected: boolean
  error: Error | null
  enabled: boolean
}

interface MCPContextType {
  servers: MCPServerConnection[]
  getEnabledClients: () => MCPClient[]
  reconnectServer: (serverId: string) => Promise<void>
  addServer: (server: { id: string; name: string; url: string; enabled: boolean }) => Promise<void>
  removeServer: (serverId: string) => void
  updateServerStatus: (serverId: string, enabled: boolean) => void
}

const MCPContext = createContext<MCPContextType | undefined>(undefined)

export function MCPProvider({ children }: { children: ReactNode }) {
  const [servers, setServers] = useState<MCPServerConnection[]>([])
  const clientRefs = useRef<Map<string, MCPClient>>(new Map())

  const createClient = async (url: string): Promise<MCPClient> => {
    console.log('Creating MCP client for URL:', url)
    
    // Check if we need to use Tauri fetch for external URLs
    const urlObj = new URL(url)
    const isExternal = !['localhost', '127.0.0.1'].includes(urlObj.hostname)
    
    // Create transport with appropriate implementation
    const transportOptions = {
      requestInit: {
        headers: {
          Accept: 'application/json, text/event-stream',
        },
      },
    }
    
    // Use Tauri transport for external URLs to bypass CORS
    const transport = isExternal
      ? new TauriStreamableHTTPClientTransport(urlObj, transportOptions)
      : new StreamableHTTPClientTransport(urlObj, transportOptions)
    
    console.log(`Using ${isExternal ? 'Tauri' : 'standard'} transport for MCP client`)
    
    const mcpClient = await experimental_createMCPClient({
      transport,
    })
    return mcpClient
  }

  const connectServer = async (server: { id: string; name: string; url: string; enabled: boolean }) => {
    if (!server.enabled) {
      setServers((prev) => prev.map((s) => (s.id === server.id ? { ...s, client: null, isConnected: false, error: null, enabled: false } : s)))
      return
    }

    try {
      console.log('Connecting to MCP server:', server.name, server.url)
      const client = await createClient(server.url)

      clientRefs.current.set(server.id, client)

      setServers((prev) => prev.map((s) => (s.id === server.id ? { ...s, client, isConnected: true, error: null, enabled: true } : s)))

      console.log('MCP server connected successfully:', server.name)
    } catch (err) {
      console.error('Failed to connect to MCP server:', server.name, err)
      setServers((prev) => prev.map((s) => (s.id === server.id ? { ...s, client: null, isConnected: false, error: err as Error, enabled: server.enabled } : s)))
    }
  }

  const disconnectServer = (serverId: string) => {
    const client = clientRefs.current.get(serverId)
    if (client?.close) {
      try {
        client.close()
      } catch (error) {
        console.error('Error closing MCP client:', error)
      }
    }
    clientRefs.current.delete(serverId)
  }

  const addServer = async (server: { id: string; name: string; url: string; enabled: boolean }) => {
    // Add server to state first
    setServers((prev) => [
      ...prev,
      {
        ...server,
        client: null,
        isConnected: false,
        error: null,
      },
    ])

    // Then try to connect if enabled
    if (server.enabled) {
      await connectServer(server)
    }
  }

  const removeServer = (serverId: string) => {
    disconnectServer(serverId)
    setServers((prev) => prev.filter((s) => s.id !== serverId))
  }

  const updateServerStatus = (serverId: string, enabled: boolean) => {
    const server = servers.find((s) => s.id === serverId)
    if (!server) return

    if (enabled) {
      connectServer({ ...server, enabled })
    } else {
      disconnectServer(serverId)
      setServers((prev) => prev.map((s) => (s.id === serverId ? { ...s, client: null, isConnected: false, error: null, enabled: false } : s)))
    }
  }

  const reconnectServer = async (serverId: string) => {
    const server = servers.find((s) => s.id === serverId)
    if (!server) return

    console.log('Reconnecting MCP server:', server.name)
    disconnectServer(serverId)
    await connectServer(server)
  }

  const getEnabledClients = (): MCPClient[] => {
    return servers.filter((server) => server.enabled && server.isConnected && server.client).map((server) => server.client!)
  }

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      console.log('Cleaning up MCP connections')
      clientRefs.current.forEach((client, serverId) => {
        if (client?.close) {
          try {
            client.close()
          } catch (error) {
            console.error('Error closing MCP client:', serverId, error)
          }
        }
      })
      clientRefs.current.clear()
    }
  }, [])

  return (
    <MCPContext.Provider
      value={{
        servers,
        getEnabledClients,
        reconnectServer,
        addServer,
        removeServer,
        updateServerStatus,
      }}
    >
      {children}
    </MCPContext.Provider>
  )
}

export function useMCP() {
  const context = useContext(MCPContext)
  if (!context) {
    throw new Error('useMCP must be used within an MCPProvider')
  }
  return context
}

// Export the MCPClient type for use in other files
export type { MCPClient }
