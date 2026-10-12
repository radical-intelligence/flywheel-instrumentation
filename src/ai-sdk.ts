/**
 * The AI SDK stream recorder for the request timeline. It reads the stream
 * part names of AI SDK 5 and imports nothing from `ai`.
 */
import type { Timeline } from './timeline.js'

/** The part of an AI SDK stream part that the timeline reads. */
export interface StreamPartLike {
  type: string
  id?: string
  toolName?: string
}

/**
 * Mark the first chunk, the first text, reasoning start and end, the tool
 * input window of each tool, and the last token. Call once per stream part.
 * `toolNames` maps each tool call ID to its tool name for the stream.
 */
export function recordStreamPart(tl: Timeline, part: StreamPartLike, toolNames: Map<string, string>): void {
  // `start` and `start-step` come from the SDK, not the provider.
  if (part.type !== 'start' && part.type !== 'start-step') tl.mark('chat.firstChunk')
  switch (part.type) {
    case 'text-delta':
      tl.mark('chat.firstText')
      tl.markLast('chat.lastToken')
      break
    case 'reasoning-start':
      tl.mark('chat.reasoning.start')
      break
    case 'reasoning-delta':
      tl.markLast('chat.lastToken')
      break
    case 'reasoning-end':
      tl.markLast('chat.reasoning.end')
      break
    case 'tool-input-start': {
      const name = part.toolName ?? 'unknown'
      toolNames.set(part.id ?? '', name)
      tl.mark(`chat.tool.${name}.inputStart`)
      break
    }
    case 'tool-input-delta':
      tl.markLast('chat.lastToken')
      break
    case 'tool-input-end': {
      const name = toolNames.get(part.id ?? '') ?? 'unknown'
      tl.markLast(`chat.tool.${name}.inputEnd`)
      break
    }
  }
}
