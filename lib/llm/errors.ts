/** Ошибка LLM с признаком «можно повторить позже» (лимиты, перегрузка) и подсказкой, через сколько. */
export class LlmError extends Error {
  retryable: boolean;
  retryAfterMs: number;
  constructor(message: string, opts: { retryable?: boolean; retryAfterMs?: number } = {}) {
    super(message);
    this.name = 'LlmError';
    this.retryable = !!opts.retryable;
    this.retryAfterMs = opts.retryAfterMs ?? 5000;
  }
}
