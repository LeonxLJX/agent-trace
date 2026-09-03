/**
 * Core types for agent-trace.
 *
 * Agent harnesses (Claude Code, Codex, custom loops) all write logs, and every
 * log format is different — which is why nobody actually inspects their agent
 * sessions. agent-trace normalizes them into one event stream, then answers
 * the questions that matter: what did the agent do, what did it cost, where
 * did it burn time, which tool calls hang or fail.
 */

export type EventType =
  | 'llm_call'     // a model invocation
  | 'tool_call'    // the agent invoked a tool
  | 'tool_result'  // a tool returned
  | 'system'       // lifecycle/system message
  | 'error'        // anything that failed

/** The normalized event — everything else is derived from this. */
export interface TraceEvent {
  /** ISO 8601 timestamp (normalized on parse). */
  ts: string
  type: EventType
  /** Which agent/session produced it. */
  session?: string
  /** Model name for llm_call events. */
  model?: string
  /** Tool name for tool_call / tool_result. */
  tool?: string
  /** Correlation id — links a tool_result to its tool_call. */
  callId?: string
  /** Terse human description (one line). */
  label: string
  durationMs?: number
  tokensIn?: number
  tokensOut?: number
  /** Free-form passthrough (truncated by reporters). */
  data?: unknown
  ok?: boolean
  /** Original line number in the source log. */
  line?: number
}

/** USD per 1M tokens, input and output. */
export interface ModelPrice {
  input: number
  output: number
}

/** Aggregate numbers for one session. */
export interface SessionStats {
  events: number
  llmCalls: number
  toolCalls: number
  errors: number
  tokensIn: number
  tokensOut: number
  estimatedCostUsd: number
  wallClockMs: number
  /** Calls (llm or tool) still open when the log ends — the "hangs". */
  dangling: number
  byTool: Record<string, number>
  byModel: Record<string, { calls: number; tokensIn: number; tokensOut: number }>
  /** Slowest tool calls, worst first. */
  slowest: Array<{ label: string; durationMs: number }>
}

/** One linked call→result pair, for the tree view. */
export interface CallNode {
  event: TraceEvent
  result?: TraceEvent
  /** true when the call never got a matching result. */
  dangling: boolean
}
