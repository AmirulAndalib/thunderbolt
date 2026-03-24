import { Elysia } from 'elysia'
import { getSettings, getHaystackPipelines, getEnabledAgentIds } from '@/config/settings'
import { createHaystackProvider } from './haystack-provider'
import type { AgentProvider } from './types'

/** Swaps http(s) → ws(s) and keeps the host + /v1 prefix. */
const getWsBaseUrl = (requestUrl: string): string => {
  const url = new URL(requestUrl)
  const wsProtocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  return `${wsProtocol}//${url.host}/v1`
}

export const createAgentsRoutes = () => {
  const settings = getSettings()
  const pipelines = getHaystackPipelines(settings)
  const enabledIds = getEnabledAgentIds(settings)

  const router = new Elysia({ prefix: '/agents' })

  router.get('/', ({ request }) => {
    const wsBaseUrl = getWsBaseUrl(request.url)

    const providers: AgentProvider[] = [...(pipelines.length > 0 ? [createHaystackProvider(pipelines, wsBaseUrl)] : [])]

    const allAgents = providers.flatMap((p) => p.getAgents())
    const agents = enabledIds ? allAgents.filter((a) => enabledIds.includes(a.id)) : allAgents

    return { data: agents }
  })

  return router
}
