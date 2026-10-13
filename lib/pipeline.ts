import { CONF_THRESHOLD, check } from './stress';
import { stressNames } from './llm';
import { fuzzyFix } from './fuzzy';
import type { Item } from './types';

const LLM_FAIL = 'LLM не справился (проверка ответа не прошла)';
const bad = (raw: string, reason: string): Item => ({ raw, status: 'invalid', stress: [], conf: 0, reason });

/**
 * Технические ошибки → «Ошибки». Остальное идёт в LLM:
 * корректные имена получают ударение («На проверку» или «Неуверенные» по уверенности);
 * имена, которые модель сочла опечаткой, исправляются алгоритмом fuzzy (ближайшее имя из словаря),
 * для исправленного имени ставится ударение, и запись попадает в «Неуверенные» на проверку человеком.
 */
export async function processNames(names: string[], llm?: string): Promise<Item[]> {
  const out: Item[] = names.map((r) => ({ raw: r, status: 'invalid', stress: [], conf: 0, reason: check(r) || undefined }));
  const idx = out.map((o, i) => (o.reason ? -1 : i)).filter((i) => i >= 0);
  const clean = idx.map((i) => names[i].trim());
  const res = await stressNames(clean, llm);

  const typos: number[] = []; // позиции в idx
  idx.forEach((i, k) => {
    const raw = clean[k], r = res[k];
    if (r.failed) out[i] = bad(raw, LLM_FAIL);
    else if (r.typo) typos.push(k);
    else out[i] = { raw, status: r.conf < CONF_THRESHOLD ? 'uncertain' : 'review', stress: r.stress, conf: r.conf };
  });

  if (typos.length) {
    const fixes = typos.map((k) => fuzzyFix(clean[k]));
    const res2 = await stressNames(fixes.map((f) => f.name), llm);
    typos.forEach((k, t) => {
      const i = idx[k], f = fixes[t], r = res2[t];
      if (r.failed) { out[i] = bad(clean[k], LLM_FAIL); return; }
      out[i] = {
        raw: f.name, original: clean[k], status: 'uncertain', stress: r.stress, conf: Math.min(r.conf, 0.5),
        note: f.changed ? `Возможная опечатка: «${clean[k]}» заменено на «${f.name}»` : 'Возможная опечатка, похожего имени в словаре нет',
      };
    });
  }
  return out;
}
