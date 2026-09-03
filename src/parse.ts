import fs from 'node:fs'
import type { EventType, TraceEvent } from './types.js'

/**
 * Log parsing — turns heterogeneous agent logs into the normalized event
 * stream. Two tiers:
 *
 * 1. `parseJsonl` — generic: reads any JSONL where lines carry recognizable
 *    fields (ts/time/timestamp, type/event/kind, tokens/token_usage, ...).
 * 2. `normalizeObject` — per-provider adapters mapped from their native log
 *    shapes (Anthropic-style usage, OpenAI-style usage, Claude Code session
 *    jsonl, OpenAI agents SDK traces).
 */

const KNOWN_TYPES: EventType[] = ['llm_call', 'tool_call', 'tool_result', 'system', 'error']

const TYPE_ALIASES: Record<string, EventType> = {
  llm_call: 'llm_call', llm: 'llm_call', model_call: 'llm_call', completion: 'llm_call', assistant: 'llm_call', response: 'llm_call',
  tool_call: 'tool_call', tool_use: 'tool_call', function_call: 'tool_call', tool: 'tool_call',
  tool_result: 'tool_result', tool_output: 'tool_result', function_result: 'tool_result', observation: 'tool_result',
  system: 'system', lifecycle: 'system', init: 'system', user: 'system', message: 'system',
  error: 'error', exception: 'error', failure: 'error',
}

function pick(obj: Record<string, unknown>, keys: string[]): unknown {
  for (const k of keys) {
    const v = k.split('.').reduce<unknown>((acc, part) => (acc != null && typeof acc === 'object' ? (acc as Record<string, unknown>)[part] : undefined), obj)
    if (v != null) return v
  }
  return undefined
}

function toIso(ts: unknown): string {
  if (ts == null) return new Date().toISOString()
  if (typeof ts === 'number') {
    const ms = ts < 1e12 ? ts * 1000 : ts // epoch seconds vs ms
    return new Date(ms).toISOString()
  }
  const s = String(ts)
  const d = Date.parse(s)
  return Number.isNaN(d) ? new Date().toISOString() : new Date(d).toISOString()
}

/** Extract token counts from any of the common usage shapes. */
function tokens(obj: Record<string, unknown>): { tokensIn?: number; tokensOut?: number } {
  const usage = pick(obj, ['usage', 'token_usage', 'tokens', 'metrics']) as Record<string, unknown> | undefined
  const src = (usage && typeof usage === 'object' ? usage : obj) as Record<string, unknown>
  const tin = pick(src, ['input_tokens', 'prompt_tokens', 'tokens_in', 'inputTokens', 'in'])
  const tout = pick(src, ['output_tokens', 'completion_tokens', 'tokens_out', 'outputTokens', 'out'])
  return {
    tokensIn: typeof tin === 'number' ? tin : undefined,
    tokensOut: typeof tout === 'number' ? tout : undefined,
  }
}

/**
 * Trajectory/span format — a single JSON doc with a top-level `spans` array
 * and a `startedAt` anchor. Each span is a call (llm or tool) with relative
 * `startMs`/`endMs`, `tokens.{in,out}` and a `status`. Tools emit BOTH a
 * tool_call and a tool_result so pairing and dangling detection work.
 */
export function expandTrajectory(obj: Record<string, unknown>, line?: number): TraceEvent[] {
  const spans = obj.spans
  if (!Array.isArray(spans)) return []
  const startedAt = toIso(obj.startedAt)
  const base = typeof obj.startedAt === 'string' ? Date.parse(String(obj.startedAt)) : Date.now()
  const model = obj.model as string | undefined
  const session = (obj.runId ?? obj.session ?? obj.agent) as string | undefined
  const out: TraceEvent[] = []
  for (const span of spans) {
    if (typeof span !== 'object' || span == null) continue
    const s = span as Record<string, unknown>
    const kind = String(s.kind ?? '').toLowerCase()
    const name = (s.name as string) ?? (s.tool as string) ?? 'span'
    const startMs = typeof s.startMs === 'number' ? s.startMs : 0
    const endMs = typeof s.endMs === 'number' ? s.endMs : startMs
    const { tokensIn, tokensOut } = tokens(s)
    const status = String(s.status ?? '').toLowerCase()
    const ok = status === 'ok' || status === 'success' || status === ''
    const ts = new Date(base + startMs).toISOString()
    const dur = Math.max(0, endMs - startMs)
    const callId = (s.id as string) ?? String(line ?? 0)
    const label = String(s.input ?? name).slice(0, 120)
    if (kind === 'llm') {
      out.push({ ts, type: 'llm_call', session, model, label, durationMs: dur, tokensIn, tokensOut, data: s, line, ok })
    } else if (kind === 'tool') {
      const tool = (s.tool as string) ?? name
      out.push({ ts, type: 'tool_call', session, tool, callId, label, durationMs: dur, data: s, line, ok })
      out.push({
        ts: new Date(base + endMs).toISOString(),
        type: 'tool_result', session, tool, callId, label: String(s.output ?? name).slice(0, 120),
        durationMs: dur, ok, data: s, line,
      })
    } else if (kind === 'error' || status === 'error' || status === 'failed') {
      out.push({ ts, type: 'error', session, label, durationMs: dur, data: s, line, ok: false })
    }
  }
  return out
}

/** True when the parsed object is a trajectory (has a `spans` array). */
export function isTrajectory(obj: Record<string, unknown>): boolean {
  return Array.isArray(obj.spans)
}

/** Normalize one parsed log object into a TraceEvent (or null if unusable). */
export function normalizeObject(obj: Record<string, unknown>, line?: number): TraceEvent | null {
  const rawType = String(pick(obj, ['type', 'event', 'kind', 'role']) ?? '').toLowerCase()
  const type = TYPE_ALIASES[rawType]
  if (!type) return null
  const { tokensIn, tokensOut } = type === 'llm_call' ? tokens(obj) : {}
  const label =
    (pick(obj, ['label', 'name', 'action', 'summary', 'content', 'text']) as string | undefined) ??
    (type === 'tool_call' || type === 'tool_result' ? String(pick(obj, ['tool', 'function', 'tool_name']) ?? 'tool') : type)
  const dur = pick(obj, ['duration_ms', 'durationMs', 'duration', 'latency_ms'])
  return {
    ts: toIso(pick(obj, ['ts', 'time', 'timestamp', 'created_at', 'startTime'])),
    type,
    session: pick(obj, ['session', 'session_id', 'sessionId', 'trace_id', 'run_id']) as string | undefined,
    model: pick(obj, ['model', 'model_name']) as string | undefined,
    tool: pick(obj, ['tool', 'tool_name', 'function', 'name']) as string | undefined,
    callId: pick(obj, ['call_id', 'callId', 'id', 'tool_use_id', 'item_id']) as string | undefined,
    label: String(label).slice(0, 120),
    durationMs: typeof dur === 'number' ? dur : undefined,
    tokensIn,
    tokensOut,
    ok: pick(obj, ['ok', 'success', 'is_error']) as boolean | undefined,
    data: obj,
    line,
  }
}

/** Parse JSONL text (string) into events. Skips unparseable lines, keeps count. */
export function parseJsonl(text: string): { events: TraceEvent[]; skipped: number } {
  // Fast path: the whole input is a single JSON document (e.g. a pretty-printed
  // trajectory or one normalized event). Detect before falling back to line mode.
  const whole = text.trim()
  if (whole) {
    try {
      const obj = JSON.parse(whole)
      if (!Array.isArray(obj) && typeof obj === 'object') {
        if (isTrajectory(obj as Record<string, unknown>)) return { events: expandTrajectory(obj as Record<string, unknown>), skipped: 0 }
        const ev = normalizeObject(obj as Record<string, unknown>)
        return { events: ev ? [ev] : [], skipped: ev ? 0 : 1 }
      }
    } catch {
      /* not a single doc — fall through to line mode */
    }
  }

  const events: TraceEvent[] = []
  let skipped = 0
  for (const [i, rawLine] of text.split(/\r?\n/).entries()) {
    const lineText = rawLine.trim()
    if (!lineText || lineText.startsWith('//') || lineText.startsWith('#')) continue
    try {
      const obj = JSON.parse(lineText)
      if (Array.isArray(obj)) {
        skipped++
        continue
      }
      if (isTrajectory(obj as Record<string, unknown>)) {
        events.push(...expandTrajectory(obj as Record<string, unknown>, i + 1))
      } else {
        const ev = normalizeObject(obj as Record<string, unknown>, i + 1)
        if (ev) events.push(ev)
        else skipped++
      }
    } catch {
      skipped++
    }
  }
  return { events, skipped }
}

/** Parse a trace file — handles both JSONL and single-document JSON. */
export async function parseFile(path: string): Promise<{ events: TraceEvent[]; skipped: number }> {
  const text = await fs.promises.readFile(path, 'utf8')
  return parseJsonl(text)
}
