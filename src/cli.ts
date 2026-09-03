#!/usr/bin/env node
import { readFileSync, writeFileSync, existsSync, copyFileSync, mkdirSync } from 'node:fs';
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Span, Trace } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  llm: (s: string) => `\x1b[36m${s}\x1b[0m`,
  tool: (s: string) => `\x1b[32m${s}\x1b[0m`,
  err: (s: string) => `\x1b[31m${s}\x1b[0m`,
  warn: (s: string) => `\x1b[33m${s}\x1b[0m`,
  bold: (s: string) => `\x1b[1m${s}\x1b[0m`,
};

const load = (p: string): Trace => JSON.parse(readFileSync(p, 'utf8'));
const fmtS = (ms: number) => (ms / 1000).toFixed(2) + 's';
const fmtTok = (n: number) => (n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n));

function spanCost(s: Span, p: Trace['pricing']) {
  return (s.tokens.in / 1e6) * p.inputPerMTok + (s.tokens.out / 1e6) * p.outputPerMTok;
}

function bar(v: number, max: number, width: number, ch = '█'): string {
  const n = Math.max(max > 0 ? Math.round((v / max) * width) : 0, v > 0 ? 1 : 0);
  return ch.repeat(Math.min(n, width)).padEnd(width, '░');
}

function summ(t: Trace) {
  const tokIn = t.spans.reduce((a, s) => a + s.tokens.in, 0);
  const tokOut = t.spans.reduce((a, s) => a + s.tokens.out, 0);
  const cost = t.spans.reduce((a, s) => a + spanCost(s, t.pricing), 0);
  const fails = t.spans.filter((s) => s.status === 'error').length;
  return { tokIn, tokOut, tok: tokIn + tokOut, cost, fails };
}

function stats(file: string) {
  const t = load(file);
  const m = summ(t);
  console.log('');
  console.log(C.bold(`${t.runId}`) + C.dim(` · ${t.agent} · ${t.model}`));
  if (t.task) console.log(C.dim(t.task));
  console.log('');
  const rows: [string, string][] = [
    ['elapsed', fmtS(t.totalMs)],
    ['steps', `${t.spans.length}`],
    ['tokens', `${fmtTok(m.tok)}  ${C.dim(`(in ${fmtTok(m.tokIn)} / out ${fmtTok(m.tokOut)})`)}`],
    ['cost', `$${m.cost.toFixed(4)}`],
    ['failures', m.fails ? C.err(String(m.fails)) : '0'],
  ];
  for (const [k, v] of rows) console.log(`  ${k.padEnd(10)}${v}`);
  console.log('');
  console.log(C.bold('TRAJECTORY'));

  const W = 34;
  const maxEnd = Math.max(...t.spans.map((s) => s.endMs));
  const maxTok = Math.max(...t.spans.map((s) => s.tokens.in + s.tokens.out), 1);
  t.spans.forEach((s, i) => {
    const failed = s.status === 'error';
    const retried = !failed && i > 0 && t.spans[i - 1].status === 'error';
    const color = failed ? C.err : retried ? C.warn : s.kind === 'llm' ? C.llm : C.tool;
    const line =
      `  ${s.name.padEnd(20).slice(0, 20)} ` +
      color(bar(s.endMs - s.startMs, maxEnd, W)) +
      ` ${fmtS(s.endMs - s.startMs).padStart(6)} ` +
      C.dim(bar(s.tokens.in + s.tokens.out, maxTok, 8).replace(/░/g, '·')) +
      ` ${fmtTok(s.tokens.in + s.tokens.out).padStart(5)}` +
      (failed ? '  ' + C.err('FAILED') : '');
    console.log(line);
  });
  console.log('');
  console.log(C.dim('  █ llm   █ tool   █ failed   █ after retry'));
  console.log(C.dim(`  open the interactive viewer: agent-trace view ${file}`));
  console.log('');
}

function view(file: string) {
  const t = load(file);
  const outDir = path.join(ROOT, '.viewer-out');
  mkdirSync(outDir, { recursive: true });
  copyFileSync(path.join(ROOT, 'viewer', 'index.html'), path.join(outDir, 'index.html'));
  copyFileSync(path.resolve(file), path.join(outDir, 'trace.json'));
  const html = readFileSync(path.join(outDir, 'index.html'), 'utf8').replace(
    'const q = new URLSearchParams(location.search).get(\'trace\');',
    'const q = location.protocol === \'file:\' ? null : \'trace.json\';',
  );
  copyFileSync(path.join(outDir, 'index.html'), path.join(outDir, 'index.html'));
  const target = path.join(outDir, 'index.html');
  require_fs().writeFileSync(target, html, 'utf8');
  console.log(C.dim(`\n  viewer ready: ${target}\n`));
  try {
    execSync(`start "" "${target}"`, { shell: 'cmd.exe' });
  } catch {
    /* 非 Windows 或无法自动打开时静默 */
  }
  void t;
}

function require_fs() {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  return { writeFileSync };
}

function diff(a: string, b: string) {
  const A = load(a);
  const B = load(b);
  const ma = summ(A);
  const mb = summ(B);
  console.log('');
  console.log(C.bold('DIFF') + C.dim(`  baseline=${a}  current=${b}`));
  console.log('');
  const cmp = (k: string, x: number, y: number, fmt: (n: number) => string, lowerBetter = true) => {
    const d = y - x;
    const good = lowerBetter ? d < 0 : d > 0;
    const tag = Math.abs(d) < 1e-9 ? C.dim('  same') : good ? C.tool(`  ${d > 0 ? '-' : ''}${fmt(Math.abs(d))} better`) : C.err(`  +${fmt(Math.abs(d))} worse`);
    console.log(`  ${k.padEnd(10)}${fmt(x).padStart(9)}  ->  ${fmt(y).padStart(9)}${tag}`);
  };
  cmp('elapsed', A.totalMs, B.totalMs, fmtS);
  cmp('tokens', ma.tok, mb.tok, fmtTok);
  cmp('cost', ma.cost, mb.cost, (n) => `$${n.toFixed(4)}`);
  cmp('failures', ma.fails, mb.fails, String);
  console.log('');

  console.log(C.bold('PER-STEP'));
  const n = Math.max(A.spans.length, B.spans.length);
  for (let i = 0; i < n; i++) {
    const x = A.spans[i];
    const y = B.spans[i];
    if (!x || !y) {
      console.log(`  ${(x?.name ?? y?.name ?? '?').padEnd(20)} ${C.warn('structure differs')}`);
      continue;
    }
    const dx = y.endMs - y.startMs - (x.endMs - x.startMs);
    const dt = y.tokens.in + y.tokens.out - (x.tokens.in + x.tokens.out);
    if (Math.abs(dx) < 50 && dt === 0) {
      console.log(`  ${x.name.padEnd(20)} ${C.dim('—')}`);
    } else {
      const t1 = Math.abs(dx) >= 50 ? (dx < 0 ? C.tool(`-${fmtS(-dx)}`) : C.err(`+${fmtS(dx)}`)) : C.dim('—');
      const t2 = dt ? (dt < 0 ? C.tool(`${fmtTok(-dt)} fewer tok`) : C.err(`${fmtTok(dt)} more tok`)) : C.dim('—');
      console.log(`  ${x.name.padEnd(20)} ${t1}  ${t2}`);
    }
  }
  console.log('');
}

const [cmd, a, b] = process.argv.slice(2);
const USAGE = `
  ${C.bold('agent-trace')} — see what your agent actually did

    ${C.bold('agent-trace stats <trace.json>')}        terminal summary + ASCII timeline
    ${C.bold('agent-trace view <trace.json>')}         open the interactive viewer
    ${C.bold('agent-trace diff <a.json> <b.json>')}    compare two runs

  example:
    node dist/cli.js stats examples/sample-trace.json
`;

if (!cmd) {
  console.log(USAGE);
  process.exit(0);
}

if (cmd === 'stats' && a) stats(a);
else if (cmd === 'view' && a) view(a);
else if (cmd === 'diff' && a && b) diff(a, b);
else {
  console.log(USAGE);
  if (a && !existsSync(a)) console.log(C.err(`  file not found: ${a}`));
  process.exit(1);
}
