import { CONF_THRESHOLD, check } from './stress';
import { stressNames } from './llm';
import type { Item } from './types';

/** Валидация → LLM → результат в том же порядке, что и names. llm — id модели из выпадающего списка. */
export async function processNames(names: string[], llm?: string): Promise<Item[]> {
  const out: Item[] = names.map((r) => ({ raw: r, status: 'invalid', stress: [], conf: 0, reason: check(r) || undefined }));
  const idx = out.map((o, i) => (o.reason ? -1 : i)).filter((i) => i >= 0);
  const res = await stressNames(idx.map((i) => names[i].trim()), llm);
  idx.forEach((i, k) => {
    const raw = names[i].trim();
    const r = res[k];
    out[i] = r.failed
      ? { raw, status: 'invalid', stress: [], conf: 0, reason: 'LLM не справился (проверка ответа не прошла)' }
      : { raw, status: r.conf < CONF_THRESHOLD ? 'uncertain' : 'review', stress: r.stress, conf: r.conf };
  });
  return out;
}
