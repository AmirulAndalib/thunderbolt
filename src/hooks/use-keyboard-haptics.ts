import { useCallback, type KeyboardEvent } from 'react'
import { useHaptics } from './use-haptics'

/**
 * Returns an `onKeyDown` handler that triggers a soft impact haptic on every keystroke.
 * Designed for text inputs on mobile — no-ops on desktop or when haptics are disabled.
 */
export const useKeyboardHaptics = () => {
  const { triggerImpact } = useHaptics()

  const onKeyDown = useCallback(
    (_e: KeyboardEvent<HTMLTextAreaElement | HTMLInputElement>) => {
      triggerImpact('soft')
    },
    [triggerImpact],
  )

  return { onKeyDown }
}
