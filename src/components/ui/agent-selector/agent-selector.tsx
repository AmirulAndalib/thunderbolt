import { SearchableMenu, type SearchableMenuGroup, type SearchableMenuItem } from '@/components/ui/searchable-menu'
import { useHaptics } from '@/hooks/use-haptics'
import { cn } from '@/lib/utils'
import type { Agent } from '@/types'
import { Bot, ChevronDown, Terminal, Globe } from 'lucide-react'
import { useCallback, useMemo, type ReactNode } from 'react'

export type AgentSelectorProps = {
  agents: Agent[]
  selectedAgent: Agent | null
  onAgentChange: (agentId: string) => void
  side?: 'top' | 'bottom' | 'left' | 'right'
  align?: 'start' | 'center' | 'end'
}

type AgentItemData = {
  agent: Agent
}

const agentIconMap: Record<string, ReactNode> = {
  bot: <Bot className="size-4 text-muted-foreground" />,
  terminal: <Terminal className="size-4 text-muted-foreground" />,
  globe: <Globe className="size-4 text-muted-foreground" />,
}

const getAgentIcon = (iconName: string | null): ReactNode => {
  return agentIconMap[iconName ?? 'bot'] ?? <Bot className="size-4 text-muted-foreground" />
}

const agentTypeLabels: Record<string, string> = {
  'built-in': 'Built-in',
  local: 'Local',
  remote: 'Remote',
}

const toMenuItem = (agent: Agent): SearchableMenuItem<AgentItemData> => ({
  id: agent.id,
  label: agent.name,
  description: agentTypeLabels[agent.type] ?? agent.type,
  icon: getAgentIcon(agent.icon),
  data: { agent },
})

/**
 * Groups agents by type: Built-in, Local (auto-discovered), Remote (user-configured)
 */
export const categorizeAgents = (agents: Agent[]): SearchableMenuGroup<AgentItemData>[] => {
  const builtIn: SearchableMenuItem<AgentItemData>[] = []
  const local: SearchableMenuItem<AgentItemData>[] = []
  const remote: SearchableMenuItem<AgentItemData>[] = []

  for (const agent of agents) {
    const item = toMenuItem(agent)

    switch (agent.type) {
      case 'built-in':
        builtIn.push(item)
        break
      case 'local':
        local.push(item)
        break
      case 'remote':
        remote.push(item)
        break
    }
  }

  const groups: SearchableMenuGroup<AgentItemData>[] = []

  if (builtIn.length > 0) {
    groups.push({ id: 'built-in', items: builtIn })
  }
  if (local.length > 0) {
    groups.push({ id: 'local', label: 'Local Agents', items: local })
  }
  if (remote.length > 0) {
    groups.push({ id: 'remote', label: 'Remote Agents', items: remote })
  }

  return groups
}

export const AgentSelector = ({ agents, selectedAgent, onAgentChange, side, align }: AgentSelectorProps) => {
  const groupedItems = useMemo(() => categorizeAgents(agents), [agents])

  const renderTrigger = (selected: SearchableMenuItem<AgentItemData> | undefined, isOpen: boolean) => (
    <div
      className={cn(
        'flex items-center gap-2 px-3 h-[var(--touch-height-sm)] rounded-full cursor-pointer transition-colors text-[length:var(--font-size-body)]',
        isOpen ? 'bg-secondary' : 'hover:bg-secondary/50',
      )}
    >
      {selected?.icon ?? <Bot className="size-4 text-muted-foreground" />}
      <span className="font-medium">{selected?.label ?? 'Select Agent'}</span>
      <ChevronDown className={cn('size-3.5 text-muted-foreground transition-transform', isOpen && 'rotate-180')} />
    </div>
  )

  const renderItem = (item: SearchableMenuItem<AgentItemData>, isSelected: boolean) => (
    <div
      className={cn(
        'w-full flex items-center justify-between px-3 py-2 rounded-lg transition-colors text-left cursor-pointer',
        'hover:bg-accent/50',
        isSelected && 'bg-accent',
      )}
    >
      <div className="flex items-center gap-2 min-w-0">
        {item.icon}
        <span className="font-medium truncate">{item.label}</span>
      </div>
    </div>
  )

  const { triggerSelection } = useHaptics()
  const handleAgentChange = useCallback(
    (id: string) => {
      triggerSelection()
      onAgentChange(id)
    },
    [onAgentChange, triggerSelection],
  )

  return (
    <SearchableMenu
      items={groupedItems}
      value={selectedAgent?.id}
      onValueChange={handleAgentChange}
      searchable={agents.length > 10}
      searchPlaceholder="Search Agents"
      emptyMessage="No agents found"
      blurBackdrop
      trigger={renderTrigger}
      renderItem={renderItem}
      width={280}
      maxHeight={340}
      side={side}
      align={align}
    />
  )
}
