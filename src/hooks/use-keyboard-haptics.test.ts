import '@/testing-library'
import { describe, expect, mock, test } from 'bun:test'
import { renderHook } from '@testing-library/react'

const triggerImpact = mock(() => {})

mock.module('@/hooks/use-haptics', () => ({
  useHaptics: () => ({
    triggerSelection: () => {},
    triggerImpact,
    triggerNotification: () => {},
  }),
  HapticsProvider: ({ children }: { children: unknown }) => children,
}))

const { useKeyboardHaptics } = await import('./use-keyboard-haptics')

describe('useKeyboardHaptics', () => {
  test('returns an onKeyDown handler', () => {
    const { result } = renderHook(() => useKeyboardHaptics())
    expect(typeof result.current.onKeyDown).toBe('function')
  })

  test('triggers soft impact haptic on keydown', () => {
    const { result } = renderHook(() => useKeyboardHaptics())
    const fakeEvent = { key: 'a' } as React.KeyboardEvent<HTMLTextAreaElement>

    result.current.onKeyDown(fakeEvent)

    expect(triggerImpact).toHaveBeenCalledWith('soft')
  })
})
