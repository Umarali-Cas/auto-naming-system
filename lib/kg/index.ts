/**
 * Своя модель ударений KG: BiLSTM (lib/kg/model.ts) + перевод из латиницы (lib/kg/translit.ts).
 * Веса лежат в public/models/kg/ и скачиваются с того же сайта при первом запросе: в edge-функцию
 * 4,7 МБ весов не помещаются. Путь /models открыт в middleware.ts (веса не секретны).
 */
import { LlmError } from '../llm/errors';
import { StressModel, KG_VOWELS, type WeightsFile } from './model';
import { Translit, type LmFile } from './translit';

export { isLatinName } from './translit';

/**
 * Порог уверенности своей модели. Шкала у неё своя (на отложенной выборке): при 0,9 автоматически проходит
 * 24% имён с точностью 94%, при 0,7 — 91% имён с точностью 82%. Поэтому порог отдельный от CONF_THRESHOLD для LLM.
 */
export const KG_CONF_THRESHOLD = Number(process.env.KG_CONF_THRESHOLD || 0.9);

interface Kg { model: StressModel; tr: Translit }
let loading: Promise<Kg> | null = null;

async function getJson<T>(origin: string, path: string): Promise<T> {
  // no-store: кэш fetch в Next не берёт ответы больше 2 МБ; веса и так держатся в памяти после первой загрузки
  const r = await fetch(new URL(path, origin), { cache: 'no-store' });
  if (!r.ok) throw new LlmError(`Своя модель: не удалось загрузить ${path} (HTTP ${r.status})`);
  return (await r.json()) as T;
}

/** Загружает веса один раз на экземпляр сервера; при ошибке следующий запрос попробует снова. */
export function loadKg(origin: string): Promise<Kg> {
  if (!loading) {
    loading = Promise.all([
      getJson<WeightsFile>(origin, '/models/kg/weights.json'),
      getJson<LmFile>(origin, '/models/kg/translit_lm.json'),
    ]).then(([w, lm]) => ({ model: new StressModel(w), tr: new Translit(lm) }));
    loading.catch(() => { loading = null; });
  }
  return loading;
}

export interface KgStress { stress: number[]; conf: number }

/** Ударение для имени в исходном написании: индексы ударных букв в raw (по одной на каждую часть с гласной). */
export function stressRaw(model: StressModel, raw: string): KgStress {
  const stress: number[] = [];
  let conf = 1, offset = 0;
  for (const part of raw.split(/([- ]+)/)) {
    const chars = [...part];
    const low = part.toLowerCase();
    if (part && !/^[- ]+$/.test(part) && [...low].some((c) => KG_VOWELS.has(c))) {
      const p = model.probs(low);
      let best = 0;
      p.forEach((v, i) => { if (v > p[best]) best = i; });
      stress.push(offset + best);
      conf = Math.min(conf, p[best]);
    }
    offset += chars.length;
  }
  return { stress, conf: stress.length ? conf : 0.3 };
}
