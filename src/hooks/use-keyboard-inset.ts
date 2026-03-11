import { useEffect } from 'react'

/**
 * Tracks the visual viewport and sets CSS custom properties on `<html>`:
 * - `--vv-top`:  visual viewport offset (px) — how far iOS Safari has scrolled
 *                the layout viewport when the keyboard opens.
 * - `--kb`:      keyboard inset height (px).
 *
 * The header uses `--vv-top` via a CSS transform to float in place while iOS
 * natively scrolls everything else.
 */
export const useKeyboardInset = (): void => {
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return

    let rafId = 0
    let prevTop = vv.offsetTop
    let stableFrames = 0

    const apply = () => {
      const el = document.documentElement.style
      el.setProperty('--vv-top', `${vv.offsetTop}px`)
      el.setProperty('--kb', `${Math.max(0, window.innerHeight - vv.height - vv.offsetTop)}px`)
    }

    const poll = () => {
      apply()

      const changed = vv.offsetTop !== prevTop
      prevTop = vv.offsetTop

      stableFrames = changed ? 0 : stableFrames + 1

      if (stableFrames < 20) {
        rafId = requestAnimationFrame(poll)
      } else {
        rafId = 0
      }
    }

    const startPolling = () => {
      stableFrames = 0
      if (!rafId) {
        rafId = requestAnimationFrame(poll)
      }
    }

    apply()

    document.addEventListener('focusin', startPolling)
    document.addEventListener('focusout', startPolling)
    vv.addEventListener('resize', startPolling)
    vv.addEventListener('scroll', startPolling)

    return () => {
      document.removeEventListener('focusin', startPolling)
      document.removeEventListener('focusout', startPolling)
      vv.removeEventListener('resize', startPolling)
      vv.removeEventListener('scroll', startPolling)
      if (rafId) cancelAnimationFrame(rafId)
    }
  }, [])
}
