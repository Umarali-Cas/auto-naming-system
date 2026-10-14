/**
 * Своя модель ударений KG: BiLSTM (lib/kg/model.ts) + перевод из латиницы (lib/kg/translit.ts).
 * Веса лежат в public/models/kg/ и скачиваются с того же сайта при первом запросе: в edge-функцию
 * 4,7 МБ весов не помещаются. Путь /models открыт в middleware.ts (веса не секретны).
 */
import { LlmError } from '../llm/errors';
import { StressModel, type Country, type WeightsFile } from './model';
import { Translit, type LmFile } from './translit';

export { isLatinName } from './translit';

/**
 * Порог уверенности своей модели. Шкала у неё своя (на отложенной выборке): при 0,9 автоматически проходит
 * 25% имён KG с точностью 94% (KZ — 82% имён, 96,5%), при 0,7 — 89% имён KG с точностью 83%.
 * Поэтому порог отдельный от CONF_THRESHOLD для LLM.
 */
export const KG_CONF_THRESHOLD = Number(process.env.KG_CONF_THRESHOLD || 0.9);

/** Страна по умолчанию (KG_MODEL_COUNTRY=kg|kz); имя с чисто казахскими буквами (ә, і, ұ, қ, ғ, һ) всегда считается KZ. */
const DEFAULT_COUNTRY: Country = process.env.KG_MODEL_COUNTRY === 'kz' ? 'kz' : 'kg';
export const countryOf = (raw: string): Country => (/[әіұқғһ]/i.test(raw) ? 'kz' : DEFAULT_COUNTRY);

/**
 * Слитные отчества (Абдулазизұлы, Куанышқызы, Мырзарахимугли): ударение ставится и в основе, и в окончании,
 * причём в окончании всегда на последней гласной. Основу размечает модель, окончание — это правило.
 */
const SUFFIX = /(уулу|қызы|кызы|гызы|кизи|қизи|кизы|оглы|угли|уғли|ұғлы|ұлы|улы)$/;

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

/**
 * Ударение для имени в исходном написании: индексы ударных букв в raw (по одной на каждую часть с гласной,
 * у слитного отчества — две: в основе и на последней гласной окончания).
 */
export function stressRaw(model: StressModel, raw: string, country: Country = countryOf(raw)): KgStress {
  const V = model.vowels, isV = (c: string) => V.has(c);
  const stress: number[] = [];
  let conf = 1, offset = 0;
  for (const part of raw.split(/([- ]+)/)) {
    const low = [...part.toLowerCase()];
    if (part && !/^[- ]+$/.test(part) && low.some(isV)) {
      let base = low.length;
      const m = SUFFIX.exec(low.join(''));
      if (m && low.slice(0, m.index).some(isV)) { // слитное отчество: окончание по правилу
        base = [...low.join('').slice(0, m.index)].length;
        for (let i = low.length - 1; i >= base; i--) if (isV(low[i])) { stress.push(offset + i); break; }
      }
      const p = model.probs(low.slice(0, base).join(''), country);
      let best = 0;
      p.forEach((v, i) => { if (v > p[best]) best = i; });
      stress.push(offset + best);
      conf = Math.min(conf, p[best]);
    }
    offset += low.length;
  }
  return { stress: stress.sort((a, b) => a - b), conf: stress.length ? conf : 0.3 };
}
