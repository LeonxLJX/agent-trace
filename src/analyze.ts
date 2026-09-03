import type { CallNode, ModelPrice, SessionStats, TraceEvent } from './types.js'

/**
 * Session analysis: totals, cost estimation, tool histograms, dangling calls.
 * All pure functions over the normalized event stream.
 */

/** Default USD per 1M tokens. Extend/override via options. */
export const DEFAULT_PRICES: Record<string, ModelPrice> = {
  'claude-sonnet-4-5': { input: 3, output: 15 },
  'claude-opus-4-1': { input: 15, output: 75 },
  'claude-haiku-4': { input: 1, output: 5 },
  'gpt-5.2': { input: 1.25, output: 10 },
  'gpt-5.2-mini': { input: 0.25, output: 2 },
  'gpt-4.1': { input: 2, output: 8 },
  'deepseek-chat': { input: 0.27, output: 1.1 },
  'deepseek-reasoner': { input: 0.55, output: 2.19 },
}

function priceFor(model: string | undefined, prices: Record<string, ModelPrice>): ModelPrice {
  if (!model) return { input: 0, output: 0 }
  // exact, then prefix (model names carry date suffixes like claude-sonnet-4-5-20250929)
  if (prices[model]) return prices[model]
  const prefix = Object.keys(prices).find((k) => model.startsWith(k))
  return prefix ? prices[prefix]! : { input: 0, output: 0 }
}

export function estimateCostUsd(
  events: TraceEvent[],
  prices: Record<string, ModelPrice> = DEFAULT_PRICES,
): number {
  let usd = 0
  for (const e of events) {
    if (e.type !== 'llm_call') continue
    const p = priceFor(e.model, prices)
    usd += ((e.tokensIn ?? 0) / 1e6) * p.input + ((e.tokensOut ?? 0) / 1e6) * p.output
  }
  return usd
}

/** Match a tool_result to its tool_call via callId, else via tool name order. */
export function pairCalls(events: TraceEvent[]): CallNode[] {
  const results = new Map<string, TraceEvent>()
  for (const e of events) if (e.type === 'tool_result' && e.callId) results.set(e.callId, e)
  const usedResults = new Set<TraceEvent>()
  const nodes: CallNode[] = []
  for (const e of events) {
    if (e.type === 'tool_call') {
      let result: TraceEvent | undefined
      if (e.callId && results.has(e.callId)) {
        result = results.get(e.callId)
      } else if (e.tool) {
        // fallback: first unused result with same tool name after this call
        result = events.find((r) => r.type === 'tool_result' && r.tool === e.tool && !usedResults.has(r) && r.ts >= e.ts)
      }
      if (result) usedResults.add(result)
      nodes.push({ event: e, result, dangling: !result })
    }
  }
  return nodes
}

export function analyzeSession(events: TraceEvent[], prices?: Record<string, ModelPrice>): SessionStats {
  const sorted = [...events].sort((a, b) => a.ts.localeCompare(b.ts))
  const llmCalls = sorted.filter((e) => e.type === 'llm_call')
  const toolCalls = sorted.filter((e) => e.type === 'tool_call')
  const errors = sorted.filter((e) => e.type === 'error' || (e.type === 'tool_result' && e.ok === false))

  const byTool: Record<string, number> = {}
  for (const t of toolCalls) {
    const name = t.tool ?? t.label
    byTool[name] = (byTool[name] ?? 0) + 1
  }

  const byModel: SessionStats['byModel'] = {}
  for (const c of llmCalls) {
    const m = c.model ?? 'unknown'
    byModel[m] ??= { calls: 0, tokensIn: 0, tokensOut: 0 }
    byModel[m]!.calls++
    byModel[m]!.tokensIn += c.tokensIn ?? 0
    byModel[m]!.tokensOut += c.tokensOut ?? 0
  }

  const durations = sorted
    .filter((e) => typeof e.durationMs === 'number')
    .map((e) => ({ label: e.label, durationMs: e.durationMs! }))
    .sort((a, b) => b.durationMs - a.durationMs)
    .slice(0, 5)

  const dangling = pairCalls(sorted).filter((n) => n.dangling).length
  const first = sorted[0]?.ts
  const last = sorted[sorted.length - 1]?.ts

  return {
    events: sorted.length,
    llmCalls: llmCalls.length,
    toolCalls: toolCalls.length,
    errors: errors.length,
    tokensIn: llmCalls.reduce((s, e) => s + (e.tokensIn ?? 0), 0),
    tokensOut: llmCalls.reduce((s, e) => s + (e.tokensOut ?? 0), 0),
    estimatedCostUsd: estimateCostUsd(sorted, prices),
    wallClockMs: first && last ? Math.max(0, Date.parse(last) - Date.parse(first)) : 0,
    dangling,
    byTool,
    byModel,
    slowest: durations,
  }
}

/** Compact chronological timeline — one line per event, tool results indented under calls. */
export function timeline(events: TraceEvent[], limit = 60): string[] {
  const sorted = [...events].sort((a, b) => a.ts.localeCompare(b.ts))
  const lines: string[] = []
  let t0 = sorted.length ? Date.parse(sorted[0]!.ts) : 0
  const shown = limit >= sorted.length ? sorted : sorted.slice(0, limit)
  for (const e of shown) {
    const t = ((Date.parse(e.ts) - t0) / 1000).toFixed(1).padStart(8)
    const icon = { llm_call: '◆', tool_call: '▸', tool_result: '·', system: '·', error: '✗' }[e.type]
    const dur = e.durationMs != null ? ` ${e.durationMs}ms` : ''
    const tok = e.type === 'llm_call' && (e.tokensIn || e.tokensOut) ? ` (${fmtTokens(e.tokensIn)}→${fmtTokens(e.tokensOut)})` : ''
    const mark = e.ok === false ? ' ✗FAILED' : ''
    lines.push(`${t}s ${icon} ${e.type.padEnd(12)} ${e.label}${dur}${tok}${mark}`)
  }
  if (shown.length < sorted.length) lines.push(`… ${sorted.length - shown.length} more events`)
  return lines
}

function fmtTokens(n?: number): string {
  if (n == null) return '?'
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

export function fmtCost(usd: number): string {
  if (usd === 0) return '$0'
  if (usd < 0.01) return `$${usd.toFixed(4)}`
  if (usd < 1) return `$${usd.toFixed(3)}`
  return `$${usd.toFixed(2)}`
}

export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  return `${m}m${Math.round((ms % 60_000) / 1000)}s`
}
