import { render, screen } from '@testing-library/react'
import { describe, expect, test } from 'bun:test'
import { TerminalBlock } from './terminal-block'

describe('TerminalBlock', () => {
  test('renders terminal header', () => {
    render(<TerminalBlock terminalId="term-1" />)

    expect(screen.getByText('Terminal')).toBeInTheDocument()
  })

  test('displays the terminal id', () => {
    render(<TerminalBlock terminalId="term-abc-123" />)

    expect(screen.getByText('Terminal term-abc-123')).toBeInTheDocument()
  })

  test('sets data-terminal-id attribute', () => {
    const { container } = render(<TerminalBlock terminalId="term-42" />)

    const el = container.querySelector('[data-terminal-id="term-42"]')
    expect(el).toBeTruthy()
  })
})
