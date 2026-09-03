export type SpanKind = 'llm' | 'tool';
export type SpanStatus = 'ok' | 'error';

export interface TokenCount {
  in: number;
  out: number;
}

export interface Span {
  id: string;
  name: string;
  kind: SpanKind;
  tool?: string | null;
  startMs: number;
  endMs: number;
  tokens: TokenCount;
  status: SpanStatus;
  input: string;
  output: string;
  error: string | null;
}

export interface Pricing {
  inputPerMTok: number;
  outputPerMTok: number;
}

export interface Trace {
  runId: string;
  agent: string;
  model: string;
  task?: string;
  startedAt: string;
  totalMs: number;
  pricing: Pricing;
  spans: Span[];
}

/**
 * 常见 provider 的价格表（美元 / 每百万 token）。
 * 只用于估算，真正计费请以 provider 账单为准。
 */
export const PRICING: Record<string, Pricing> = {
  'deepseek-chat': { inputPerMTok: 0.27, outputPerMTok: 1.10 },
  'gpt-4o': { inputPerMTok: 2.50, outputPerMTok: 10.00 },
  'gpt-4o-mini': { inputPerMTok: 0.15, outputPerMTok: 0.60 },
  'claude-sonnet-4': { inputPerMTok: 3.00, outputPerMTok: 15.00 },
  'claude-haiku-3-5': { inputPerMTok: 0.80, outputPerMTok: 4.00 },
};
