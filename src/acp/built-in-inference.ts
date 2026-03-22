import type { RunInference } from './types'

/**
 * Creates the inference function for the built-in agent.
 *
 * Phase 1: Returns a placeholder that yields a no-op finish event.
 * The actual chat flow still uses Chat + DefaultChatTransport (via aiFetchStreamingResponse).
 * Future phases will wire this to the real AI inference pipeline, at which point
 * the Chat class will be replaced entirely by ACP-driven message management.
 */
export const createBuiltInInference = (): RunInference => {
  return async function* (_params) {
    // Phase 1: The built-in agent's inference is not yet wired to the real AI pipeline.
    // The existing Chat + DefaultChatTransport handles actual inference.
    // This placeholder ensures the ACP connection is established and functional.
    yield { type: 'finish' as const, stopReason: 'end_turn' as const }
  }
}
