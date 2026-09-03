import { writeFileSync } from 'node:fs';
import {
  PRICING,
  type Pricing,
  type Span,
  type SpanKind,
  type TokenCount,
  type Trace,
} from './types.js';

export interface RecorderOptions {
  agent: string;
  model: string;
  task?: string;
  pricing?: Pricing;
  runId?: string;
}

export interface TrackOptions {
  tool?: string;
  input?: unknown;
  tokens?: TokenCount;
}

const preview = (v: unknown, max = 800): string => {
  if (v == null) return '';
  const s = typeof v === 'string' ? v : JSON.stringify(v, null, 2);
  return s.length > max ? s.slice(0, max) + ' …[truncated]' : s;
};

/**
 * 一行接入的 agent 轨迹记录器。
 *
 *   const trace = new TraceRecorder({ agent: 'codefix', model: 'deepseek-chat' });
 *   const reply = await trace.track('planner', 'llm', () => callModel(prompt), { input: prompt, tokens });
 *   trace.save('trace.json');
 */
export class TraceRecorder {
  readonly runId: string;
  readonly startedAt: string;
  private readonly opts: RecorderOptions;
  private readonly spans: Span[] = [];
  private seq = 0;
  private readonly t0 = performance.now();

  constructor(opts: RecorderOptions) {
    this.opts = opts;
    this.runId = opts.runId ?? `run_${Math.random().toString(16).slice(2, 10)}`;
    this.startedAt = new Date().toISOString();
  }

  /** 自动计时：成功写入 output，抛错则标记 error 并保留原异常。 */
  async track<T>(
    name: string,
    kind: SpanKind,
    fn: () => Promise<T> | T,
    opts: TrackOptions = {},
  ): Promise<T> {
    const startMs = performance.now() - this.t0;
    const input = preview(opts.input);
    try {
      const result = await fn();
      const endMs = performance.now() - this.t0;
      const output =
        typeof result === 'string' ? preview(result) : preview(pickText(result));
      this.spans.push({
        id: `s${++this.seq}`,
        name,
        kind,
        tool: opts.tool ?? null,
        startMs: round(startMs),
        endMs: round(endMs),
        tokens: opts.tokens ?? { in: 0, out: 0 },
        status: 'ok',
        input,
        output,
        error: null,
      });
      return result;
    } catch (e) {
      const endMs = performance.now() - this.t0;
      this.spans.push({
        id: `s${++this.seq}`,
        name,
        kind,
        tool: opts.tool ?? null,
        startMs: round(startMs),
        endMs: round(endMs),
        tokens: opts.tokens ?? { in: 0, out: 0 },
        status: 'error',
        input,
        output: '',
        error: e instanceof Error ? `${e.name}: ${e.message}` : String(e),
      });
      throw e;
    }
  }

  /** 手动记录一段已经完成的调用。 */
  add(span: Omit<Span, 'id'>): Span {
    const full: Span = { ...span, id: `s${++this.seq}` };
    this.spans.push(full);
    return full;
  }

  toJSON(): Trace {
    const totalMs = round(
      this.spans.length ? Math.max(...this.spans.map((s) => s.endMs)) : 0,
    );
    return {
      runId: this.runId,
      agent: this.opts.agent,
      model: this.opts.model,
      task: this.opts.task,
      startedAt: this.startedAt,
      totalMs,
      pricing: this.opts.pricing ?? PRICING[this.opts.model] ?? { inputPerMTok: 0, outputPerMTok: 0 },
      spans: this.spans,
    };
  }

  save(path: string): Trace {
    const t = this.toJSON();
    writeFileSync(path, JSON.stringify(t, null, 2), 'utf8');
    return t;
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

/** 从常见 provider 的响应体里取文本，避免把整个对象塞进 output。 */
function pickText(r: unknown): unknown {
  if (r && typeof r === 'object') {
    const o = r as Record<string, any>;
    if (Array.isArray(o.choices) && o.choices[0]) {
      return o.choices[0].message?.content ?? o.choices[0].text ?? r;
    }
    if (Array.isArray(o.content)) return o.content;
    if (typeof o.text === 'string') return o.text;
  }
  return r;
}

export { PRICING };
export type { Span, SpanKind, TokenCount, Trace };
