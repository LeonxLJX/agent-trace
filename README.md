# agent-trace 🔍

**Observability for AI agent sessions — harness-neutral, zero-dep, offline.**

Every agent harness logs what it does, and every log format is different — so almost nobody actually inspects their sessions. `agent-trace` normalizes any agent log (JSONL with recognizable fields: Claude Code sessions, OpenAI-style usage, custom loops) into **one event stream**, then answers the questions that matter:

- **What did the agent do?** — chronological timeline, tool-call→result pairing, dangling-call detection (the "hangs forever" class of bug)
- **What did it cost?** — per-model token accounting with a built-in USD price table, prefix-matched to dated model names
- **Where did it burn time?** — slowest calls, per-tool usage histogram
- **What failed?** — error events and failed tool results, marked in-line

```console
$ agent-trace stats session.jsonl
session: (unnamed)
  events      5 (1 llm · 1 tool · 2 errors · 1 dangling)
  wall clock  1m0s
  tokens      5,000 in / 300 out
  est. cost   $0.008
  tools:
       1  edit_file
```

## Install

```bash
npm install agent-trace      # library
npx agent-trace models       # CLI: show the built-in price table
```

## CLI

```bash
agent-trace stats session.jsonl             # aggregate numbers
agent-trace timeline session.jsonl -n 100   # chronological one-liners
agent-trace report session.jsonl -o out.html  # self-contained HTML report (no CDN, works offline)
agent-trace models                          # USD per 1M tokens, built-in table
```

## Library

```ts
import { parseFile, analyzeSession, pairCalls, timeline, renderHtml, DEFAULT_PRICES } from 'agent-trace'

const { events, skipped } = await parseFile('session.jsonl')

const stats = analyzeSession(events)
stats.estimatedCostUsd   // 0.008
stats.dangling           // tool calls that never returned — your hangs
stats.byTool             // { edit_file: 4, bash: 12 }
stats.slowest            // [{ label: 'run full test suite', durationMs: 48000 }]

// call→result pairing (by callId, with name-order fallback)
const nodes = pairCalls(events).filter((n) => n.dangling)

// write the report
import fs from 'node:fs'
fs.writeFileSync('report.html', renderHtml(events, stats, 'my session'))
```

## What it parses

The generic JSONL adapter maps common field aliases onto the normalized event:

| normalized | accepted aliases |
|---|---|
| `type` | `type`, `event`, `kind`, `role` (+ aliases: `tool_use`→`tool_call`, `observation`→`tool_result`, `completion`/`assistant`→`llm_call`, …) |
| `ts` | `ts`, `time`, `timestamp`, `created_at` — epoch seconds, epoch ms, or ISO strings |
| `tokensIn/tokensOut` | `usage.input_tokens` / `usage.prompt_tokens`, `output_tokens` / `completion_tokens`, and top-level variants |
| `tool` | `tool`, `tool_name`, `function`, `name` |
| `callId` | `call_id`, `tool_use_id`, `id`, `item_id` |
| `durationMs` | `duration_ms`, `durationMs`, `duration`, `latency_ms` |
| `ok` | `ok`, `success`, `is_error` (inverted) |

Unparseable lines are skipped and counted — agent logs always contain some.

## Cost model

Built-in prices (USD per 1M tokens, Sept 2026): Claude Sonnet 4.5 ($3/$15), Opus 4.1 ($15/$75), Haiku 4 ($1/$5), GPT-5.2 ($1.25/$10), GPT-5.2-mini ($0.25/$2), GPT-4.1 ($2/$8), DeepSeek Chat ($0.27/$1.10), DeepSeek Reasoner ($0.55/$2.19).

Model names match by exact key or prefix, so `claude-haiku-4-20260101` picks up the Haiku row. Unknown models cost $0 (visible in the report, not silently wrong). Override anything:

```ts
analyzeSession(events, { ...DEFAULT_PRICES, 'my-finetune': { input: 0.5, output: 1.5 } })
```

## The HTML report

One file, inline CSS, no CDN, no JS framework — open it offline, send it in a PR, archive it with the session. Cost cards, token bars per model (in blue / out green), tool histogram, slowest calls, full timeline with failures marked.

## Development

```bash
npm install && npm test    # build + 11 tests, zero runtime deps
```

Node ≥ 20.

## License

MIT
