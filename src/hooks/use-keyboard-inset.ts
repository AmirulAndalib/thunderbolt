import { useEffect } from 'react'

/**
 * Keeps CSS custom properties in sync with the visual viewport so `#root`
 * can stay pinned above the software keyboard on mobile.
 *
 * Sets on `<html>`:
 * - `--vv-top`:    visual viewport scroll offset (px)
 * - `--vv-height`: visual viewport height (px)
 * - `--kb`:        keyboard inset height (px)
 *
 * Starts `requestAnimationFrame` polling on `focusin` (before the keyboard
 * animation begins) so the values track every frame from the start.
 */
export const useKeyboardInset = (): void => {
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return

    let rafId = 0
    let prevTop = vv.offsetTop
    let prevHeight = vv.height
    let stableFrames = 0

    const apply = () => {
      const el = document.documentElement.style
      el.setProperty('--vv-top', `${vv.offsetTop}px`)
      el.setProperty('--vv-height', `${vv.height}px`)
      el.setProperty('--kb', `${Math.max(0, window.innerHeight - vv.height - vv.offsetTop)}px`)
    }

    const poll = () => {
      apply()

      const topChanged = vv.offsetTop !== prevTop
      const heightChanged = vv.height !== prevHeight
      prevTop = vv.offsetTop
      prevHeight = vv.height

      if (topChanged || heightChanged) {
        stableFrames = 0
      } else {
        stableFrames++
      }

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

    // Start polling on focusin — fires BEFORE the keyboard animation starts
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
