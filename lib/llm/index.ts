import { guess, isVowel } from '../stress';
import { looksLikeTypo } from '../fuzzy';
import { chat } from './call';
import { resolveOption, type Option } from './config';
import { SYSTEM_PROMPT, userPrompt } from './prompt';

export interface LlmResult { stress: number[]; conf: number; failed?: boolean; typo?: boolean }

const CHUNK = 30; // имён в одном запросе
const CONCURRENCY = 1; // запросов одновременно
const CONF = { high: 0.95, medium: 0.65, low: 0.35 } as const;
const FAIL: LlmResult = { stress: [], conf: 0, failed: true };
const TYPO: LlmResult = { stress: [], conf: 0.3, typo: true };
const cache = new Map<string, LlmResult>(); // повторяющиеся имена не уходят в LLM второй раз
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Случаи, где LLM не нужна: одна гласная, «ё», нет гласных. Составные имена всегда спрашиваем у модели. */
function local(raw: string): LlmResult | null {
  const ch = [...raw];
  const vs = ch.map((c, i) => (isVowel(c) ? i : -1)).filter((i) => i >= 0);
  if (vs.length === 0) return { stress: [], conf: 0.3 };
  if (/[- ]/.test(raw)) return null;
  const yo = ch.findIndex((c) => c === 'ё' || c === 'Ё');
  if (yo >= 0) return { stress: [yo], conf: 0.95 };
  if (vs.length === 1) return { stress: [vs[0]], conf: 0.97 };
  return null;
}

/**
 * Проверка ответа модели: без «+» строка совпадает с исходной, каждый «+» стоит перед гласной,
 * в каждой части имени (через дефис или пробел) не больше одного «+».
 * Если у какой-то части с гласными ударения нет, уверенность понижается до 60% (уйдёт в «Неуверенные»).
 */
function parse(raw: string, accented: unknown, confidence: unknown): LlmResult {
  if (typeof accented !== 'string') return FAIL;
  const s = [...accented], r = [...raw];
  const stress: number[] = [];
  let pos = 0;
  for (const c of s) { if (c === '+') stress.push(pos); else pos++; }
  if (stress.length < 1) return FAIL;
  if (s.filter((c) => c !== '+').join('') !== raw) return FAIL;
  if (!stress.every((i) => isVowel(r[i] ?? ''))) return FAIL;

  let part = 0;
  const partOf = r.map((c) => (c === '-' || c === ' ' ? ++part : part)); // номер части для каждой буквы
  const stressed = new Set(stress.map((i) => partOf[i]));
  if (stressed.size !== stress.length) return FAIL; // два «+» в одной части
  const vowelParts = new Set(r.map((c, i) => (isVowel(c) ? partOf[i] : -1)).filter((x) => x >= 0));
  const missing = [...vowelParts].some((pt) => !stressed.has(pt));

  const conf = CONF[confidence as keyof typeof CONF] ?? 0.65;
  return { stress, conf: missing ? Math.min(conf, 0.6) : conf };
}

async function askChunk(o: Option, names: string[]): Promise<LlmResult[]> {
  const text = await chat(o, SYSTEM_PROMPT, userPrompt(names));
  const clean = text.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/```(?:json)?/g, '');
  const m = clean.match(/\{[\s\S]*\}/);
  let items: { id?: number; ok?: unknown; accented?: unknown; confidence?: unknown }[] = [];
  try {
    items = JSON.parse(m?.[0] ?? '{}').items ?? [];
  } catch {
    // битый JSON (обрыв, лишний текст): вытаскиваем записи по шаблону, остальные уйдут на повтор
    for (const x of clean.matchAll(/"id"\s*:\s*(\d+)\s*,\s*(?:"lang"\s*:\s*"[^"]*"\s*,\s*)?(?:"ok"\s*:\s*(true|false)\s*,\s*)?"accented"\s*:\s*"([^"]*)"(?:\s*,\s*"confidence"\s*:\s*"([^"]*)")?/g)) {
      items.push({ id: Number(x[1]), ok: x[2] !== 'false', accented: x[3], confidence: x[4] });
    }
  }
  const byId = new Map(items.map((i) => [i.id, i]));
  return names.map((n, k) => {
    const it = byId.get(k);
    if (!it) return FAIL;
    if (it.ok === false) return TYPO; // модель считает, что в имени опечатка
    return parse(n, it.accented, it.confidence);
  });
}

/** Главная функция: ударения для списка имён выбранной моделью (optionId вида "openrouter:qwen/qwen3.8-27b:free"). */
export async function stressNames(names: string[], optionId?: string): Promise<LlmResult[]> {
  const o = resolveOption(optionId);

  if (o.provider.kind === 'stub') {
    await sleep(300);
    return names.map((n) => (Math.random() < 0.03 ? FAIL : looksLikeTypo(n) ? TYPO : guess(n)));
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
