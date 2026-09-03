import { test } from 'node:test'
import assert from 'node:assert/strict'
import { normalizeObject, parseJsonl } from '../lib/parse.js'
import { analyzeSession, pairCalls, estimateCostUsd, timeline, fmtCost, DEFAULT_PRICES } from '../lib/analyze.js'
import { renderHtml } from '../lib/html.js'

const base = (over) => ({
  ts: '2026-09-03T10:00:00Z', type: 'tool_call', label: 'x', ...over,
})

test('normalizeObject maps common aliases', () => {
  const ev = normalizeObject({
    timestamp: 1756893600, event: 'tool_use', tool_name: 'bash', call_id: 'c1',
    is_error: false,
  })
  assert.ok(ev)
  assert.equal(ev.type, 'tool_call')
  assert.equal(ev.tool, 'bash')
  assert.equal(ev.callId, 'c1')
  assert.equal(new Date(ev.ts).getUTCFullYear(), 2025) // epoch seconds → ms
})

test('normalizeObject extracts usage from OpenAI-style and Anthropic-style shapes', () => {
  const openai = normalizeObject({ type: 'llm_call', model: 'gpt-4.1', usage: { prompt_tokens: 100, completion_tokens: 50 } })
  assert.equal(openai.tokensIn, 100)
  assert.equal(openai.tokensOut, 50)
  const anthropic = normalizeObject({ kind: 'completion', model: 'claude-haiku-4', usage: { input_tokens: 200, output_tokens: 80 } })
  assert.equal(anthropic.tokensIn, 200)
  assert.equal(anthropic.tokensOut, 80)
})

test('parseJsonl skips junk lines and reports count', () => {
  const text = [
    'not json at all',
    JSON.stringify({ type: 'system', label: 'session start' }),
    '# comment',
    '',
    JSON.stringify(['array', 'line']),
    JSON.stringify({ role: 'assistant', label: 'thinking' }),
  ].join('\n')
  const { events, skipped } = parseJsonl(text)
  assert.equal(events.length, 2)
  assert.equal(skipped, 2)
})

test('pairCalls links via callId and flags dangling', () => {
  const events = [
    base({ type: 'tool_call', tool: 'bash', callId: 'a', label: 'run tests' }),
    base({ type: 'tool_call', tool: 'bash', callId: 'b', label: 'hangs forever' }),
    base({ type: 'tool_result', tool: 'bash', callId: 'a', label: 'run tests', ok: true }),
  ]
  const nodes = pairCalls(events)
  assert.equal(nodes.length, 2)
  assert.equal(nodes[0].dangling, false)
  assert.equal(nodes[0].result.callId, 'a')
  assert.equal(nodes[1].dangling, true)
})

test('estimateCostUsd uses the price table with prefix matching', () => {
  const events = [
    base({ type: 'llm_call', model: 'claude-haiku-4', tokensIn: 1_000_000, tokensOut: 1_000_000 }),
    base({ type: 'llm_call', model: 'claude-haiku-4-20260101', tokensIn: 2_000_000, tokensOut: 0 }),
  ]
  const usd = estimateCostUsd(events, DEFAULT_PRICES)
  assert.equal(usd, 1 * 1 + 1 * 5 + 2 * 1) // 6 + 2
})

test('estimateCostUsd returns 0 for unknown models', () => {
  assert.equal(estimateCostUsd([base({ type: 'llm_call', model: 'mystery-model', tokensIn: 1000 })]), 0)
})

test('analyzeSession aggregates tools, models, errors, wall clock', () => {
  const events = [
    base({ ts: '2026-09-03T10:00:00Z', type: 'system', label: 'start' }),
    base({ ts: '2026-09-03T10:00:10Z', type: 'llm_call', model: 'gpt-5.2', tokensIn: 5000, tokensOut: 300 }),
    base({ ts: '2026-09-03T10:00:20Z', type: 'tool_call', tool: 'edit_file', label: 'edit', durationMs: 120 }),
    base({ ts: '2026-09-03T10:00:25Z', type: 'tool_result', tool: 'edit_file', ok: false, label: 'edit' }),
    base({ ts: '2026-09-03T10:01:00Z', type: 'error', label: 'rate limit' }),
  ]
  const s = analyzeSession(events)
  assert.equal(s.events, 5)
  assert.equal(s.llmCalls, 1)
  assert.equal(s.toolCalls, 1)
  assert.equal(s.errors, 2) // failed result + error event
  assert.equal(s.byTool.edit_file, 1)
  assert.equal(s.byModel['gpt-5.2'].tokensIn, 5000)
  assert.equal(s.wallClockMs, 60_000)
  assert.equal(s.estimatedCostUsd > 0, true)
})

test('analyzeSession counts dangling calls', () => {
  const events = [base({ type: 'tool_call', tool: 'bash', label: 'never returns' })]
  assert.equal(analyzeSession(events).dangling, 1)
})

test('timeline is chronological and marks failures', () => {
  const events = [
    base({ ts: '2026-09-03T10:00:05Z', type: 'tool_result', tool: 'bash', ok: false, label: 'boom' }),
    base({ ts: '2026-09-03T10:00:00Z', type: 'llm_call', model: 'gpt-5.2', tokensIn: 1000, tokensOut: 10 }),
  ]
  const lines = timeline(events)
  assert.equal(lines.length, 2)
  assert.ok(lines[0].includes('llm_call'))
  assert.ok(lines[1].includes('✗FAILED'))
})

test('fmtCost formats sensibly', () => {
  assert.equal(fmtCost(0), '$0')
  assert.equal(fmtCost(0.0004), '$0.0004')
  assert.equal(fmtCost(12.5), '$12.50')
})

test('renderHtml produces a self-contained report', () => {
  const events = [base({ type: 'llm_call', model: 'gpt-5.2', tokensIn: 1000, tokensOut: 50, label: 'call' })]
  const s = analyzeSession(events)
  const html = renderHtml(events, s, 'test session')
  assert.ok(html.startsWith('<!DOCTYPE html>'))
  assert.ok(html.includes('test session'))
  assert.ok(html.includes('gpt-5.2'))
  assert.ok(!html.includes('http://') && !html.includes('https://')) // no CDN, offline-safe
})
