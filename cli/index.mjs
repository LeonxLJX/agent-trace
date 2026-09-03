#!/usr/bin/env node
/**
 * agent-trace CLI
 *   agent-trace stats <trace.jsonl>            aggregate numbers for a session
 *   agent-trace timeline <trace.jsonl> [-n 60] chronological one-liners
 *   agent-trace report <trace.jsonl> [-o out.html]  self-contained HTML report
 *   agent-trace models                         show the built-in price table
 */
import fs from 'node:fs'
import { parseFile } from '../lib/index.js'
import { analyzeSession, fmtCost, fmtDuration, timeline, DEFAULT_PRICES, renderHtml } from '../lib/index.js'

const args = process.argv.slice(2)
const cmd = args[0]

function flagValue(name, fallback) {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] != null ? args[i + 1] : fallback
}

function die(msg) { console.error(`✗ ${msg}`); process.exit(1) }

async function load(path) {
  if (!path || !fs.existsSync(path)) die(`trace file not found: ${path}`)
  const { events, skipped } = await parseFile(path)
  if (!events.length) die(`no recognizable events in ${path} (${skipped} lines skipped)`)
  if (skipped) console.error(`(skipped ${skipped} unparseable lines)`)
  return events
}

switch (cmd) {
  case 'stats': {
    const events = await load(args[1])
    const s = analyzeSession(events)
    console.log(`session: ${events[0].session ?? '(unnamed)'}`)
    console.log(`  events      ${s.events} (${s.llmCalls} llm · ${s.toolCalls} tool · ${s.errors} errors · ${s.dangling} dangling)`)
    console.log(`  wall clock  ${fmtDuration(s.wallClockMs)}`)
    console.log(`  tokens      ${s.tokensIn.toLocaleString()} in / ${s.tokensOut.toLocaleString()} out`)
    console.log(`  est. cost   ${fmtCost(s.estimatedCostUsd)}`)
    if (Object.keys(s.byTool).length) {
      console.log('  tools:')
      for (const [name, n] of Object.entries(s.byTool).sort((a, b) => b[1] - a[1])) console.log(`    ${String(n).padStart(4)}  ${name}`)
    }
    if (s.slowest.length) {
      console.log('  slowest:')
      for (const x of s.slowest) console.log(`    ${fmtDuration(x.durationMs).padStart(8)}  ${x.label}`)
    }
    break
  }
  case 'timeline': {
    const events = await load(args[1])
    const n = parseInt(flagValue('-n', '60'), 10)
    for (const line of timeline(events, n)) console.log(line)
    break
  }
  case 'report': {
    const events = await load(args[1])
    const out = flagValue('-o', 'agent-trace-report.html')
    const s = analyzeSession(events)
    fs.writeFileSync(out, renderHtml(events, s, args[1] ?? 'agent session'), 'utf8')
    console.log(`✓ wrote ${out} (${fmtCost(s.estimatedCostUsd)} est. cost, ${s.events} events)`)
    break
  }
  case 'models': {
    for (const [m, p] of Object.entries(DEFAULT_PRICES)) console.log(`${m.padEnd(24)} $${p.input}/M in · $${p.output}/M out`)
    break
  }
  default:
    console.log('usage: agent-trace <stats|timeline|report|models> <trace.jsonl> [options]')
    process.exit(cmd ? 1 : 0)
}
