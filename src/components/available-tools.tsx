import { Check, Square } from 'lucide-react'
import React from 'react'

import { cn } from '@/lib/utils'

/**
 * Helper type describing a single tool to be surfaced in the AvailableTools
 * component.
 */
export type ToolItem = {
  /**
   * Tool name (unique identifier and primary label).
   */
  name: string
  /**
   * Optional descriptive text that will be rendered under the name.
   */
  description?: string
  /**
   * Indicates if the tool is active/selected for the current context. Defaults
   * to `true`.
   */
  enabled?: boolean
}

export interface AvailableToolsProps {
  /**
   * Collection of tools to display.
   */
  tools: ToolItem[]
  /**
   * Optional class names forwarded to the wrapper element.
   */
  className?: string
}

/**
 * Reusable UI fragment that lists available tools and offers consistent visual
 * presentation across different settings pages.
 */
export const AvailableTools: React.FC<AvailableToolsProps> = ({ tools, className }) => {
  return (
    <div className={cn('space-y-4', className)}>
      <div className="flex items-center gap-2">
        <div className="text-sm font-medium text-foreground">Available Tools</div>
        <div className="text-xs text-muted-foreground bg-muted px-2 py-1 rounded-full">
          {tools.length} tool{tools.length !== 1 ? 's' : ''}
        </div>
      </div>

      <div className="grid gap-3">
        {tools.map((tool) => (
          <div key={tool.name} className="flex items-start gap-3">
            {(tool.enabled ?? true) ? (
              <Check className="h-4 w-4 text-primary flex-shrink-0 mt-1" />
            ) : (
              <Square className="h-4 w-4 text-muted-foreground flex-shrink-0 mt-1" />
            )}
            <div className="flex-1">
              <span className="text-sm font-normal leading-none">{tool.name}</span>
              {tool.description && <p className="text-xs text-muted-foreground mt-0.5">{tool.description}</p>}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
