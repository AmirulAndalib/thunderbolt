import { useEffect, useState } from 'react'
import { Eye, Table2 } from 'lucide-react'
import { cn } from '@/lib/utils'
import type { DbObject, SqliteExplorerAdapter } from './types'

type ObjectListProps = {
  adapter: SqliteExplorerAdapter
  objects: DbObject[]
  selectedObject: string | null
  onSelect: (name: string) => void
}

export const ObjectList = ({ adapter, objects, selectedObject, onSelect }: ObjectListProps) => {
  const [rowCounts, setRowCounts] = useState<Map<string, number>>(new Map())

  useEffect(() => {
    const loadCounts = async () => {
      const counts = new Map<string, number>()
      for (const obj of objects) {
        try {
          counts.set(obj.name, await adapter.getRowCount(obj.name))
        } catch {
          counts.set(obj.name, -1)
        }
      }
      setRowCounts(counts)
    }
    if (objects.length > 0) loadCounts()
  }, [adapter, objects])

  const tables = objects.filter((o) => o.type === 'table')
  const views = objects.filter((o) => o.type === 'view')

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      {tables.length > 0 && (
        <ObjectGroup
          label="Tables"
          objects={tables}
          selectedObject={selectedObject}
          rowCounts={rowCounts}
          onSelect={onSelect}
        />
      )}
      {views.length > 0 && (
        <ObjectGroup
          label="Views"
          objects={views}
          selectedObject={selectedObject}
          rowCounts={rowCounts}
          onSelect={onSelect}
        />
      )}
      {objects.length === 0 && <div className="text-muted-foreground p-4 text-sm">No tables or views found</div>}
    </div>
  )
}

type ObjectGroupProps = {
  label: string
  objects: DbObject[]
  selectedObject: string | null
  rowCounts: Map<string, number>
  onSelect: (name: string) => void
}

const ObjectGroup = ({ label, objects, selectedObject, rowCounts, onSelect }: ObjectGroupProps) => (
  <div className="flex flex-col">
    <div className="text-muted-foreground px-3 py-2 text-xs font-semibold uppercase tracking-wider">{label}</div>
    {objects.map((obj) => {
      const count = rowCounts.get(obj.name)
      const isSelected = obj.name === selectedObject

      return (
        <button
          key={obj.name}
          type="button"
          onClick={() => onSelect(obj.name)}
          className={cn(
            'flex items-center gap-2 px-3 py-1.5 text-left text-sm transition-colors',
            'hover:bg-muted/50',
            isSelected && 'bg-muted font-medium',
          )}
        >
          {obj.type === 'table' ? (
            <Table2 className="text-muted-foreground size-3.5 shrink-0" />
          ) : (
            <Eye className="text-muted-foreground size-3.5 shrink-0" />
          )}
          <span className="min-w-0 truncate">{obj.name}</span>
          {count != null && count >= 0 && (
            <span className="text-muted-foreground ml-auto shrink-0 text-xs">{count}</span>
          )}
        </button>
      )
    })}
  </div>
)
