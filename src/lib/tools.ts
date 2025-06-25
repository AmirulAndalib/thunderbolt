import { getSetting } from '@/dal'
import * as tasksTools from '@/extensions/tasks/tools'
import { configs } from '@/integrations/google/tools'
import type { ToolConfig } from '@/types'
import { tool, type Tool } from 'ai'

export const getAvailableTools = async (): Promise<ToolConfig[]> => {
  const baseTools: ToolConfig[] = [...Object.values(tasksTools)]

  const googleEnabled = await getSetting('integrations_google_is_enabled')

  if (googleEnabled === 'true') {
    baseTools.push(...configs)
  }

  return baseTools
}

export const tools = [...Object.values(tasksTools)]

export const createTool = (config: ToolConfig) => {
  return tool({
    description: config.description,
    parameters: config.parameters,
    execute: config.execute,
  })
}

export const createToolset = (tools: ToolConfig[]) => {
  return {
    ...tools.reduce(
      (acc, tool) => {
        acc[tool.name] = createTool(tool)
        return acc
      },
      {} as Record<string, Tool>,
    ),
  }
}
