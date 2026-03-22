import type { ToolKind } from '@agentclientprotocol/sdk'
import { describe, expect, test } from 'bun:test'
import { getToolKindDisplayName, getToolKindIcon, getToolKindLoadingMessage } from './tool-metadata'

describe('getToolKindIcon', () => {
  test('returns icon for each known ToolKind', () => {
    const kinds: ToolKind[] = ['read', 'search', 'fetch', 'edit', 'delete', 'move', 'execute', 'think']
    for (const kind of kinds) {
      expect(getToolKindIcon(kind)).toBeTruthy()
    }
  })

  test('returns null for other/switch_mode kinds', () => {
    expect(getToolKindIcon('other')).toBeNull()
    expect(getToolKindIcon('switch_mode')).toBeNull()
  })
})

describe('getToolKindDisplayName', () => {
  test('returns title when provided', () => {
    expect(getToolKindDisplayName('edit', 'Edit file')).toBe('Edit file')
  })

  test('returns default name for each kind', () => {
    expect(getToolKindDisplayName('read')).toBe('Reading')
    expect(getToolKindDisplayName('search')).toBe('Searching')
    expect(getToolKindDisplayName('fetch')).toBe('Fetching')
    expect(getToolKindDisplayName('edit')).toBe('Editing')
    expect(getToolKindDisplayName('delete')).toBe('Deleting')
    expect(getToolKindDisplayName('move')).toBe('Moving')
    expect(getToolKindDisplayName('execute')).toBe('Executing')
    expect(getToolKindDisplayName('think')).toBe('Thinking')
    expect(getToolKindDisplayName('switch_mode')).toBe('Switching mode')
    expect(getToolKindDisplayName('other')).toBe('Processing')
  })
})

describe('getToolKindLoadingMessage', () => {
  test('returns title with ellipsis when provided', () => {
    expect(getToolKindLoadingMessage('edit', 'Editing main.ts')).toBe('Editing main.ts...')
  })

  test('returns default loading message for kind', () => {
    expect(getToolKindLoadingMessage('search')).toBe('Searching...')
  })
})
