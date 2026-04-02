import type { SessionNotification } from '@agentclientprotocol/sdk'
import type { HaystackDocumentMeta, HaystackReferenceMeta, ThunderboltUIMessage, UIMessageMetadata } from '@/types'
import type { ToolUIPart } from 'ai'
import { v7 as uuidv7 } from 'uuid'
import { z } from 'zod'

export type SessionUpdate = SessionNotification['update']

type ToolCallState = {
  toolCallId: string
  toolName: string
  title?: string
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
  args: Record<string, unknown>
  result: unknown
}

const haystackReferenceSchema = z.object({
  position: z.number(),
  fileId: z.string(),
  fileName: z.string(),
  pageNumber: z.number().optional(),
})

const haystackMetaSchema = z.object({
  haystackReferences: z.array(haystackReferenceSchema).optional(),
  haystackDocuments: z
    .array(
      z.object({
        id: z.string(),
        content: z.string(),
        score: z.number(),
        file: z.object({ id: z.string(), name: z.string() }),
      }),
    )
    .optional(),
})

export const parseMeta = (
  meta: unknown,
): { haystackReferences?: HaystackReferenceMeta[]; haystackDocuments?: HaystackDocumentMeta[] } | null => {
  const result = haystackMetaSchema.safeParse(meta)
  if (!result.success) {
    console.warn('[message-accumulator] _meta did not match expected shape:', result.error.flatten())
    return null
  }
  return result.data
}

/**
 * Accumulates ACP streaming updates into a ThunderboltUIMessage.
 * Each prompt creates a new accumulator for the assistant response.
 */
export const createMessageAccumulator = (messageId?: string) => {
  const id = messageId ?? uuidv7()
  let textContent = ''
  let reasoningContent = ''
  const toolCalls = new Map<string, ToolCallState>()

  let haystackReferences: HaystackReferenceMeta[] | undefined
  let haystackDocuments: HaystackDocumentMeta[] | undefined

  const buildMessage = (): ThunderboltUIMessage => {
    const parts: ThunderboltUIMessage['parts'] = []

    // Add reasoning part if present
    if (reasoningContent.length > 0) {
      parts.push({
        type: 'reasoning',
        text: reasoningContent,
        providerMetadata: {},
      })
    }

    // Add tool call parts
    for (const tc of toolCalls.values()) {
      const base = {
        type: `tool-${tc.toolName}` as const,
        toolCallId: tc.toolCallId,
        title: tc.title,
      }
      const part: ToolUIPart =
        tc.status === 'completed'
          ? { ...base, state: 'output-available' as const, input: tc.args, output: tc.result }
          : tc.status === 'failed'
            ? {
                ...base,
                state: 'output-error' as const,
                input: tc.args,
                errorText: String(tc.result ?? 'Unknown error'),
              }
            : { ...base, state: 'input-available' as const, input: tc.args }
      parts.push(part)
    }

    // Add text part
    if (textContent.length > 0) {
      parts.push({
        type: 'text',
        text: textContent,
      })
    }

    // If no parts at all, add empty text
    if (parts.length === 0) {
      parts.push({ type: 'text', text: '' })
    }

    // Build metadata
    const metadata: UIMessageMetadata = {}
    if (haystackReferences) {
      metadata.haystackReferences = haystackReferences
    }
    if (haystackDocuments) {
      metadata.haystackDocuments = haystackDocuments
    }

    const message: ThunderboltUIMessage = {
      id,
      role: 'assistant',
      parts,
    }

    if (Object.keys(metadata).length > 0) {
      message.metadata = metadata
    }

    return message
  }

  const handleUpdate = (update: SessionUpdate): ThunderboltUIMessage => {
    switch (update.sessionUpdate) {
      case 'agent_message_chunk':
        if (update.content.type === 'text') {
          textContent += update.content.text
        }
        if (update._meta) {
          const meta = parseMeta(update._meta)
          if (meta?.haystackReferences) {
            haystackReferences = meta.haystackReferences
          }
          if (meta?.haystackDocuments) {
            haystackDocuments = meta.haystackDocuments
          }
        }
        break

      case 'agent_thought_chunk':
        if (update.content.type === 'text') {
          reasoningContent += update.content.text
        }
        break

      case 'tool_call':
        toolCalls.set(update.toolCallId, {
          toolCallId: update.toolCallId,
          toolName: update.title,
          title: update.title,
          status: (update.status as ToolCallState['status']) ?? 'pending',
          args: {},
          result: undefined,
        })
        break

      case 'tool_call_update': {
        const existing = toolCalls.get(update.toolCallId)
        if (existing) {
          existing.status = (update.status as ToolCallState['status']) ?? existing.status

          if (update.content && update.content.length > 0) {
            const resultText = update.content
              .filter(
                (c): c is { type: 'content'; content: { type: 'text'; text: string } } =>
                  c.type === 'content' && c.content.type === 'text',
              )
              .map((c) => c.content.text)
              .join('\n')
            existing.result = resultText
          }
        }
        break
      }
    }

    return buildMessage()
  }

  return {
    handleUpdate,
    buildMessage,
    setHaystackDocuments(docs: HaystackDocumentMeta[]) {
      haystackDocuments = docs
    },
    setHaystackReferences(refs: HaystackReferenceMeta[]) {
      haystackReferences = refs
    },
    get id() {
      return id
    },
    get hasContent() {
      return textContent.length > 0 || reasoningContent.length > 0 || toolCalls.size > 0
    },
  }
}

export type MessageAccumulator = ReturnType<typeof createMessageAccumulator>
