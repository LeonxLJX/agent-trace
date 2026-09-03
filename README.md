# agent-trace 🔍

**A trajectory debugger for LLM agents — record every span, replay the run, diff two attempts.**

Agents fail in ways that chat logs can't show: a tool call that burned 60% of
your tokens, a retry loop hiding inside a "successful" run, a step ordering
that only breaks on certain inputs. agent-trace records each run as a span
tree (LLM calls, tool calls, token counts, status) and gives you two ways to
see it: a **flame-chart viewer** with replay animation, and a **diff mode**
that puts two runs side by side.

## The 10-second demo

Open `viewer/index.html` in a browser — zero dependencies, zero build:

```bash
# option 1: just open the viewer and load the bundled sample trace
# option 2: from the CLI
npm install && npm run build
node dist/cli.js view examples/sample-trace.json
node dist/cli.js stats examples/sample-trace.json   # terminal flame chart
node dist/cli.js diff run-a.json run-b.json         # what changed between two runs
```

## What the viewer shows

- **Metric cards** — total elapsed, steps, tokens, cost (per-model pricing table), failure count
- **Flame-chart timeline** — LLM spans in blue, tool spans in teal, errors in red, retries in amber; bar height = token share, so the expensive step is instantly visible
- **Replay** — press ▶ and watch the run unfold in real time (1x / 2x / 4x), exactly as the agent experienced it
- **Compare** — toggle a baseline trace; diverging steps are highlighted
- **Click any span** — full input/output/error payload in the detail panel

## Recording is one wrapper call

```ts
import { TraceRecorder } from 'agent-trace';

const trace = new TraceRecorder({ agent: 'codefix-agent', model: 'deepseek-chat' });

await trace.track('planner', 'llm', () => callModel(prompt), { tokens: { in: 812, out: 203 } });
await trace.track('run-tests', 'tool', () => bash('npm test'));

trace.save('trace.json');
```

`track()` times the call, catches errors, records status — you don't
instrument anything twice. The JSON it produces is the interchange format:
the viewer, the CLI, and harness-live all speak it.

## Why this exists

If you build agents for a living, "it failed somewhere" is not a debuggable
statement. Trace-first debugging — spans, replay, diffing two attempts — is
how the infrastructure teams behind serious agent products actually work.
agent-trace is that workflow, in a dependency you can read in an afternoon.

Part of an Agent-infra toolkit: **agent-trace** (observe runs) · **[mcpscope](https://github.com/LeonxLJX/mcpscope)** (audit tools) · **[harness-live](https://github.com/LeonxLJX/harness-live)** (run + watch).

MIT
