import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, mock, test } from 'bun:test'
import type { PermissionOption, RequestPermissionRequest, ToolCallUpdate } from '@agentclientprotocol/sdk'
import { PermissionDialog } from '@/components/chat/permission-dialog'

const createTestToolCall = (overrides?: Partial<ToolCallUpdate>): ToolCallUpdate => ({
  toolCallId: 'tc-1',
  title: 'Edit file',
  kind: 'edit',
  status: 'in_progress',
  ...overrides,
})

const createTestOptions = (): PermissionOption[] => [
  { optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' },
  { optionId: 'allow-always', name: 'Allow always', kind: 'allow_always' },
  { optionId: 'reject', name: 'Reject', kind: 'reject_once' },
]

const createTestRequest = (overrides?: Partial<RequestPermissionRequest>): RequestPermissionRequest => ({
  sessionId: 'session-1',
  toolCall: createTestToolCall(),
  options: createTestOptions(),
  ...overrides,
})

describe('PermissionDialog', () => {
  test('renders the tool call title', () => {
    const onSelect = mock()
    render(<PermissionDialog request={createTestRequest()} onSelect={onSelect} />)

    expect(screen.getByText('Edit file')).toBeInTheDocument()
  })

  test('renders all permission options as buttons', () => {
    const onSelect = mock()
    render(<PermissionDialog request={createTestRequest()} onSelect={onSelect} />)

    expect(screen.getByText('Allow once')).toBeInTheDocument()
    expect(screen.getByText('Allow always')).toBeInTheDocument()
    expect(screen.getByText('Reject')).toBeInTheDocument()
  })

  test('calls onSelect with the selected option id', () => {
    const onSelect = mock()
    render(<PermissionDialog request={createTestRequest()} onSelect={onSelect} />)

    fireEvent.click(screen.getByText('Allow once'))
    expect(onSelect).toHaveBeenCalledWith('allow-once')
  })

  test('calls onSelect with different option ids', () => {
    const onSelect = mock()
    render(<PermissionDialog request={createTestRequest()} onSelect={onSelect} />)

    fireEvent.click(screen.getByText('Reject'))
    expect(onSelect).toHaveBeenCalledWith('reject')
  })

  test('renders tool kind information', () => {
    const onSelect = mock()
    const request = createTestRequest({
      toolCall: createTestToolCall({ kind: 'execute', title: 'Run command' }),
    })
    render(<PermissionDialog request={request} onSelect={onSelect} />)

    expect(screen.getByText('Run command')).toBeInTheDocument()
  })

  test('renders diff content when tool call has diff', () => {
    const onSelect = mock()
    const request = createTestRequest({
      toolCall: createTestToolCall({
        title: 'Edit src/main.ts',
        kind: 'edit',
        content: [
          {
            type: 'diff',
            path: 'src/main.ts',
            oldText: 'const a = 1',
            newText: 'const a = 2',
          },
        ],
      }),
    })
    render(<PermissionDialog request={request} onSelect={onSelect} />)

    expect(screen.getByText('src/main.ts')).toBeInTheDocument()
  })

  test('renders locations when present', () => {
    const onSelect = mock()
    const request = createTestRequest({
      toolCall: createTestToolCall({
        locations: [{ uri: 'file:///src/main.ts' }],
      }),
    })
    render(<PermissionDialog request={request} onSelect={onSelect} />)

    expect(screen.getByText(/src\/main.ts/)).toBeInTheDocument()
  })

  test('renders reject_always option', () => {
    const onSelect = mock()
    const options: PermissionOption[] = [
      { optionId: 'allow-always', name: 'Allow always', kind: 'allow_always' },
      { optionId: 'reject-always', name: 'Reject always', kind: 'reject_always' },
    ]
    render(<PermissionDialog request={createTestRequest({ options })} onSelect={onSelect} />)

    expect(screen.getByText('Reject always')).toBeInTheDocument()
    fireEvent.click(screen.getByText('Reject always'))
    expect(onSelect).toHaveBeenCalledWith('reject-always')
  })

  test('uses default icon when no kind specified', () => {
    const onSelect = mock()
    const request = createTestRequest({
      toolCall: createTestToolCall({ kind: undefined }),
    })
    render(<PermissionDialog request={request} onSelect={onSelect} />)

    // Should still render without error
    expect(screen.getByText('Edit file')).toBeInTheDocument()
  })
})
