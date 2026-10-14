import { CONF_THRESHOLD, check } from './stress';
import { stressNames, type LlmResult } from './llm';
import { resolveOption } from './llm/config';
import { fuzzyFix } from './fuzzy';
import { isLatinName, loadKg } from './kg';
import type { TranslitResult } from './kg/translit';
import type { Item } from './types';

const LLM_FAIL = 'LLM не справился (проверка ответа не прошла)';
/** Ниже этой уверенности перевод из латиницы отправляется в «Неуверенные» (при 0,9 перевод верен в 95,7% случаев). */
const TRANSLIT_THRESHOLD = 0.9;
const bad = (raw: string, reason: string): Item => ({ raw, status: 'invalid', stress: [], conf: 0, reason });
const isUncertain = (r: LlmResult) => r.uncertain ?? r.conf < CONF_THRESHOLD;
const joinNotes = (...n: (string | undefined)[]) => n.filter(Boolean).join('. ') || undefined;

/**
 * Технические ошибки → «Ошибки». Остальное идёт в LLM:
 * корректные имена получают ударение («На проверку» или «Неуверенные» по уверенности);
 * имена, которые модель сочла опечаткой, исправляются алгоритмом fuzzy (ближайшее имя из словаря),
 * для исправленного имени ставится ударение, и запись попадает в «Неуверенные» на проверку человеком.
 * С моделью KG имена латиницей сначала переводятся в кириллицу (lib/kg/translit.ts).
 * origin — адрес сайта (нужен модели KG для загрузки весов).
 */
export async function processNames(names: string[], llm?: string, origin?: string): Promise<Item[]> {
  const kg = resolveOption(llm).provider.kind === 'kg';
  const tr: (TranslitResult | null)[] = names.map(() => null);
  let input = names;
  if (kg && origin && names.some(isLatinName)) {
    const { tr: t } = await loadKg(origin);
    input = names.map((n, i) => {
      if (!isLatinName(n)) return n;
      tr[i] = t.name(n.trim());
      return tr[i]!.text;
    });
  }

  const out: Item[] = input.map((r) => ({ raw: r, status: 'invalid', stress: [], conf: 0, reason: check(r) || undefined }));
  const idx = out.map((o, i) => (o.reason ? -1 : i)).filter((i) => i >= 0);
  const clean = idx.map((i) => input[i].trim());
  const res = await stressNames(clean, llm, origin);

  const typos: number[] = []; // позиции в idx
  idx.forEach((i, k) => {
    const raw = clean[k], r = res[k], t = tr[i];
    if (r.failed) out[i] = bad(raw, LLM_FAIL);
    else if (r.typo) typos.push(k);
    else if (t) {
      const alts = t.alts.length && t.p < TRANSLIT_THRESHOLD ? `, другие написания: ${t.alts.join(', ')}` : '';
      out[i] = {
        raw, original: names[i].trim(), stress: r.stress, conf: Math.min(r.conf, t.p),
        status: isUncertain(r) || t.p < TRANSLIT_THRESHOLD ? 'uncertain' : 'review',
        note: joinNotes(`Переведено из латиницы (уверенность ${Math.round(t.p * 100)}%${alts})`, r.note),
      };
    } else out[i] = { raw, status: isUncertain(r) ? 'uncertain' : 'review', stress: r.stress, conf: r.conf, note: r.note };
  });

  if (typos.length) {
    const fixes = typos.map((k) => fuzzyFix(clean[k]));
    const res2 = await stressNames(fixes.map((f) => f.name), llm, origin);
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
