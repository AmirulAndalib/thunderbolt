/**
 * Offline Executor
 *
 * An executor for evaluating traces WITHOUT re-executing the model.
 * Used when you have production data (traces) and want to evaluate
 * the existing outputs.
 */

import { defineExecutor } from '../core'
import type { Trace } from '../core'

/**
 * Input type for offline executor
 * Contains the pre-existing output from a trace
 */
export type OfflineInput = {
  /** Original trace ID */
  traceId: string
  /** User's question/input */
  question: string
  /** Pre-existing output from the trace */
  existingOutput: {
    content: string
    toolCalls?: Array<{
      name: string
      arguments: string
      result?: string
    }>
  }
  /** Original latency from the trace */
  latencyMs: number
  /** Error from the original trace (if any) */
  error?: string
}

/**
 * Output type from offline executor
 * Compatible with QualityOutput so quality evaluators can be used
 */
export type OfflineOutput = {
  /** The answer/content from the trace */
  answer: string
  /** Tool calls from the trace */
  toolCalls: Array<{
    tool: string
    arguments: Record<string, unknown>
    result: string
    error?: string
  }>
  /** Number of turns (always 1 for traces) */
  turnCount: number
  /** Latency from the original trace */
  latencyMs: number
  /** Status - compatible with QualityOutput */
  status: 'completed' | 'max_turns' | 'timeout' | 'error'
  /** Error if present */
  error?: string
}

/**
 * Offline executor - returns pre-existing output instead of calling the model
 *
 * Use this when evaluating production traces where you already have
 * the model's output and don't want to re-execute.
 *
 * This executor preserves error state from the original trace, allowing
 * evaluators to assess failure patterns and error handling.
 */
export const offlineExecutor = defineExecutor<OfflineInput, OfflineOutput>({
  name: 'offline',
  description: 'Returns pre-existing output from traces (no model execution)',

  async execute(input) {
    // Parse tool call arguments if they're strings
    const toolCalls = (input.existingOutput.toolCalls || []).map((tc) => {
      const args = typeof tc.arguments === 'string' ? safeParseJSON(tc.arguments) : tc.arguments

      return {
        tool: tc.name,
        arguments: args as Record<string, unknown>,
        result: tc.result || '',
      }
    })

    // Determine status based on content and error state
    const hasContent = input.existingOutput.content.trim().length > 0
    const hasError = !!input.error
    const status: 'completed' | 'error' = hasError || !hasContent ? 'error' : 'completed'

    return {
      output: {
        answer: input.existingOutput.content,
        toolCalls,
        turnCount: 1,
        latencyMs: input.latencyMs,
        status,
        error: input.error,
      },
      latencyMs: input.latencyMs,
      error: input.error,
    }
  },
})

/** Safely parse JSON, returning empty object on failure */
const safeParseJSON = (str: string): unknown => {
  try {
    return JSON.parse(str)
  } catch {
    return {}
  }
}

/**
 * Convert a Trace to OfflineInput for use with offlineExecutor
 */
export const traceToOfflineInput = (trace: Trace): OfflineInput => ({
  traceId: trace.id,
  question: trace.input.question || trace.input.messages[trace.input.messages.length - 1]?.content || '',
  existingOutput: trace.output,
  latencyMs: trace.latencyMs,
})
