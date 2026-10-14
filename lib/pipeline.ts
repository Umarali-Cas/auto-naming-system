import { CONF_THRESHOLD, check } from './stress';
import { stressNames, type LlmResult } from './llm';
import { resolveOption } from './llm/config';
import { fuzzyFix } from './fuzzy';
import { isLatinName, loadKg } from './kg';
import type { TranslitResult } from './kg/translit';
import { checkSpelling, type Spell } from './spell';
import type { Item } from './types';

const LLM_FAIL = 'LLM не справился (проверка ответа не прошла)';
/** Ниже этой уверенности перевод из латиницы отправляется в «Неуверенные» (при 0,9 перевод верен в 95,7% случаев). */
const TRANSLIT_THRESHOLD = 0.9;
const bad = (raw: string, reason: string): Item => ({ raw, status: 'invalid', stress: [], conf: 0, reason });
const isUncertain = (r: LlmResult) => r.uncertain ?? r.conf < CONF_THRESHOLD;
const joinNotes = (...n: (string | undefined)[]) => n.filter(Boolean).join('. ') || undefined;

/** Проверка написания LLM только для тех имён, где want[k] = true (остальным возвращается пустой результат). */
async function spellFor(clean: string[], want: boolean[], llm?: string): Promise<Spell[]> {
  const ids = clean.map((_, k) => (want[k] ? k : -1)).filter((k) => k >= 0);
  const res = ids.length ? await checkSpelling(ids.map((k) => clean[k]), llm) : [];
  const out: Spell[] = clean.map(() => ({}));
  ids.forEach((k, j) => { out[k] = res[j] ?? {}; });
  return out;
}

/**
 * Технические ошибки → «Ошибки». Остальное идёт в LLM:
 * 1) LLM проверяет написание (lib/spell.ts): имя с опечаткой исправляется, запись всегда уходит в «Неуверенные»
 *    с исходным написанием, чтобы её проверил человек; если модель не уверена в написании, запись тоже там;
 * 2) выбранная модель ставит ударение на исправленном имени («На проверку» или «Неуверенные» по уверенности).
 * С моделью KG имена латиницей сначала переводятся в кириллицу (lib/kg/translit.ts), такие имена проверку написания не проходят.
 * origin — адрес сайта (нужен модели KG для загрузки весов).
 * trusted — имя введено человеком вручную («Изменить»): оно не исправляется и не проверяется, ставится только ударение.
 */
export async function processNames(names: string[], llm?: string, origin?: string, trusted = false): Promise<Item[]> {
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

  // 1. проверка написания LLM; ударение дальше ставится на исправленном имени
  const spell = trusted ? clean.map((): Spell => ({})) : await spellFor(clean, idx.map((i) => !tr[i]), llm);
  const work = clean.map((n, k) => spell[k].fixed ?? n);

  // 2. ударение
  const res = await stressNames(work, llm, origin);

  const typos: number[] = []; // позиции в idx
  idx.forEach((i, k) => {
    const raw = work[k], r = res[k], t = tr[i];
    if (r.failed) out[i] = bad(clean[k], LLM_FAIL);
    else if (r.typo && trusted) out[i] = { raw, status: 'uncertain', stress: [], conf: 0.3, note: 'Не удалось определить ударение, поставьте его кликом по гласной' };
    else if (r.typo) typos.push(k);
    else if (t) {
      const doubt = t.p < TRANSLIT_THRESHOLD;
      out[i] = {
        raw, original: names[i].trim(), stress: r.stress, conf: Math.min(r.conf, t.p),
        status: isUncertain(r) || doubt ? 'uncertain' : 'review',
        note: joinNotes(`Переведено из латиницы (уверенность ${Math.round(t.p * 100)}%)`, r.note),
        alts: doubt && t.alts.length ? t.alts : undefined,
      };
    } else out[i] = { raw, status: isUncertain(r) ? 'uncertain' : 'review', stress: r.stress, conf: r.conf, note: r.note };
  });

  if (typos.length) {
    const fixes = typos.map((k) => fuzzyFix(work[k]));
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

  // 3. итог проверки написания: исправленные и сомнительные имена всегда проверяет человек
  idx.forEach((i, k) => {
    const f = spell[k], it = out[i];
    if (it.status === 'invalid') return;
    if (f.fixed) {
      out[i] = {
        ...it, status: 'uncertain', original: it.original ?? clean[k], conf: Math.min(it.conf, 0.5),
        note: joinNotes(`Возможная опечатка: «${clean[k]}» исправлено на «${f.fixed}»`, it.note),
      };
    } else if (f.suspicious && it.status !== 'uncertain') {
      out[i] = { ...it, status: 'uncertain', conf: Math.min(it.conf, 0.6), note: joinNotes(f.why ? `Необычное написание: ${f.why}` : 'Модель не уверена в написании имени', it.note) };
    }
  });
  return out;
}
