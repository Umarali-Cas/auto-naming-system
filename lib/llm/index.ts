import { guess, isVowel } from '../stress';
import { chat } from './call';
import { resolveOption, type Option } from './config';
import { SYSTEM_PROMPT, userPrompt } from './prompt';

export interface LlmResult { stress: number | null; conf: number; failed?: boolean }

const CHUNK = 30; // имён в одном запросе
const CONCURRENCY = 3; // запросов одновременно
const CONF = { high: 0.95, medium: 0.65, low: 0.35 } as const;
const FAIL: LlmResult = { stress: null, conf: 0, failed: true };
const cache = new Map<string, LlmResult>(); // повторяющиеся имена не уходят в LLM второй раз
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const cap = (raw: string, r: LlmResult): LlmResult => (/[- ]/.test(raw) ? { ...r, conf: Math.min(r.conf, 0.6) } : r);

/** Случаи, где LLM не нужна: одна гласная, «ё», нет гласных. */
function local(raw: string): LlmResult | null {
  const ch = [...raw];
  const yo = ch.findIndex((c) => c === 'ё' || c === 'Ё');
  if (yo >= 0) return cap(raw, { stress: yo, conf: 0.95 });
  const vs = ch.map((c, i) => (isVowel(c) ? i : -1)).filter((i) => i >= 0);
  if (vs.length === 1) return cap(raw, { stress: vs[0], conf: 0.97 });
  if (vs.length === 0) return { stress: null, conf: 0.3 };
  return null;
}

/** Проверка ответа модели: без «+» строка совпадает с исходной, «+» один и стоит перед гласной. */
function parse(raw: string, accented: unknown, confidence: unknown): LlmResult {
  if (typeof accented !== 'string') return FAIL;
  const s = [...accented], r = [...raw];
  const i = s.indexOf('+');
  if (i < 0 || s.lastIndexOf('+') !== i) return FAIL;
  if (s.filter((c) => c !== '+').join('') !== raw) return FAIL;
  if (!isVowel(r[i])) return FAIL;
  return cap(raw, { stress: i, conf: CONF[confidence as keyof typeof CONF] ?? 0.65 });
}

async function askChunk(o: Option, names: string[]): Promise<LlmResult[]> {
  const text = await chat(o, SYSTEM_PROMPT, userPrompt(names));
  const m = text.replace(/```(?:json)?/g, '').match(/\{[\s\S]*\}/);
  let items: { id?: number; accented?: unknown; confidence?: unknown }[] = [];
  try { items = JSON.parse(m?.[0] ?? '{}').items ?? []; } catch { /* битый JSON: все записи уйдут на повтор */ }
  const byId = new Map(items.map((i) => [i.id, i]));
  return names.map((n, k) => { const it = byId.get(k); return it ? parse(n, it.accented, it.confidence) : FAIL; });
}

/** Главная функция: ударения для списка имён выбранной моделью (optionId вида "groq:llama-3.3-70b-versatile"). */
export async function stressNames(names: string[], optionId?: string): Promise<LlmResult[]> {
  const o = resolveOption(optionId);

  if (o.provider.kind === 'stub') {
    await sleep(300);
    return names.map((n) => (Math.random() < 0.03 ? FAIL : guess(n)));
  }

  const res: LlmResult[] = new Array(names.length);
  const todo: number[] = [];
  names.forEach((n, i) => {
    const l = local(n) ?? cache.get(`${o.id}|${n}`);
    if (l) res[i] = l; else todo.push(i);
  });

  const uniq = [...new Set(todo.map((i) => names[i]))];
  const chunks: string[][] = [];
  for (let k = 0; k < uniq.length; k += CHUNK) chunks.push(uniq.slice(k, k + CHUNK));
  const answers = new Map<string, LlmResult>();

  for (let k = 0; k < chunks.length; k += CONCURRENCY) {
    await Promise.all(chunks.slice(k, k + CONCURRENCY).map(async (c) => {
      const r = await askChunk(o, c);
      const bad = c.map((_, i) => i).filter((i) => r[i].failed);
      if (bad.length) { // один повтор для неудавшихся
        const r2 = await askChunk(o, bad.map((i) => c[i]));
        bad.forEach((i, j) => { r[i] = r2[j]; });
      }
      c.forEach((n, i) => {
        answers.set(n, r[i]);
        if (!r[i].failed) { if (cache.size > 5000) cache.clear(); cache.set(`${o.id}|${n}`, r[i]); }
      });
    }));
  }
  todo.forEach((i) => { res[i] = answers.get(names[i])!; });
  return res;
}
