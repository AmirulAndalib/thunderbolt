import type { PermissionOption, RequestPermissionRequest, ToolCallContent } from '@agentclientprotocol/sdk'
import { FileEdit, Play, Shield, ShieldOff } from 'lucide-react'
import { DiffBlock } from './diff-block'

type PermissionDialogProps = {
  request: RequestPermissionRequest
  onSelect: (optionId: string) => void
}

const getPermissionIcon = (kind: PermissionOption['kind']) => {
  switch (kind) {
    case 'allow_once':
    case 'allow_always':
      return Shield
    case 'reject_once':
    case 'reject_always':
      return ShieldOff
  }
}

const getPermissionVariant = (kind: PermissionOption['kind']) => {
  switch (kind) {
    case 'allow_once':
    case 'allow_always':
      return 'bg-primary text-primary-foreground hover:bg-primary/90'
    case 'reject_once':
    case 'reject_always':
      return 'bg-destructive text-destructive-foreground hover:bg-destructive/90'
  }
}

const getToolKindIcon = (kind?: string) => {
  switch (kind) {
    case 'edit':
    case 'delete':
    case 'move':
      return FileEdit
    case 'execute':
      return Play
    default:
      return Shield
  }
}

const extractFilePath = (uri: string): string => uri.replace('file://', '')

/**
 * Permission request dialog shown when an ACP agent needs user authorization
 * for a sensitive operation. Displays tool call details and permission options.
 */
export const PermissionDialog = ({ request, onSelect }: PermissionDialogProps) => {
  const { toolCall, options } = request
  const ToolIcon = getToolKindIcon(toolCall.kind)

  const diffContent = toolCall.content?.find((c): c is ToolCallContent & { type: 'diff' } => c.type === 'diff')

  return (
    <div className="rounded-xl border bg-card p-4 shadow-sm space-y-3">
      <div className="flex items-center gap-2">
        <ToolIcon className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium">{toolCall.title}</span>
      </div>

      {toolCall.locations && toolCall.locations.length > 0 && (
        <div className="text-xs text-muted-foreground space-y-0.5">
          {toolCall.locations.map((loc, i) => (
            <div key={i} className="font-mono truncate">
              {extractFilePath(loc.uri)}
            </div>
          ))}
        </div>
      )}

      {diffContent && (
        <DiffBlock path={diffContent.path} oldText={diffContent.oldText ?? undefined} newText={diffContent.newText} />
      )}

      <div className="flex gap-2 pt-1">
        {options.map((option) => {
          const Icon = getPermissionIcon(option.kind)
          return (
            <button
              key={option.optionId}
              onClick={() => onSelect(option.optionId)}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${getPermissionVariant(option.kind)}`}
            >
              <Icon className="h-3 w-3" />
              {option.name}
            </button>
          )
        })}
      </div>
    </div>
  )
}
