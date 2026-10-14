/**
 * Латиница → кыргызская кириллица. Правила дают все возможные написания (o → о/ө, uu → уу/үү, ng → ң/нг, ...),
 * символьная 4-граммная модель, обученная на 215 тыс. имён из базы, выбирает самое правдоподобное.
 * Модель: public/models/kg/translit_lm.json. Точность на 1500 незнакомых именах (паспортная латиница):
 * 86,5% верно с первого раза, 97% среди трёх вариантов; при уверенности ≥ 0,9 верно 95,7%.
 */
export interface LmFile { order: number; total1: number; c: Record<string, number>; ctx: Record<string, number> }

const RULES: Record<string, string[]> = {
  shch: ['щ'], sch: ['щ', 'сч'], zh: ['ж'], ch: ['ч'], sh: ['ш'], kh: ['х'], ts: ['ц', 'тс'], tc: ['ц'],
  dzh: ['дж'], dj: ['дж'], ya: ['я', 'йа', 'ыя'], ia: ['я', 'ия', 'иа'], iya: ['ия'], yu: ['ю', 'йу'], iu: ['ю', 'иу'],
  yo: ['ё', 'йо', 'ыо'], io: ['ё', 'ио'], ye: ['е', 'йе', 'ые'], ie: ['ие', 'е'], yi: ['ый', 'йи', 'ы'], ng: ['ң', 'нг'],
  oe: ['ө', 'ое'], ue: ['ү', 'уе'], ou: ['оу', 'у'], uu: ['уу', 'үү'], oo: ['оо', 'өө'], ee: ['ээ', 'ее', 'и'],
  'ö': ['ө'], 'ü': ['ү'], 'ñ': ['ң'], a: ['а'], b: ['б'], c: ['ц', 'к', 'ч'], d: ['д'], e: ['е', 'э'], f: ['ф'], g: ['г'],
  h: ['х', 'г'], i: ['и', 'й'], j: ['ж', 'дж', 'й'], k: ['к'], l: ['л'], m: ['м'], n: ['н', 'ң'], o: ['о', 'ө'], p: ['п'],
  q: ['к'], r: ['р'], s: ['с'], t: ['т'], u: ['у', 'ү'], v: ['в'], w: ['в', 'у'], x: ['х', 'кс'], y: ['ы', 'й'], z: ['з'],
  "'": ['ь', 'ъ', ''], '`': ['ь', 'ъ', ''],
};
const SOFTABLE = new Set([...'бвгдзклмнпрстф']); // после этих согласных можно вставить ь
const MAXK = 4, BOS = '^', EOS = '$', LOG04 = Math.log(0.4);
const hasRule = (f: string) => Object.prototype.hasOwnProperty.call(RULES, f);

export interface TranslitResult { text: string; p: number; alts: string[] }

export class Translit {
  constructor(private lm: LmFile) {}

  /** log P(ch | история), stupid backoff 0.4 */
  private lp(hist: string, ch: string): number {
    const { c, ctx, order, total1 } = this.lm;
    let pen = 0;
    for (let n = order; n > 1; n--) {
      const h = hist.slice(-(n - 1)), num = c[h + ch];
      if (num) { const den = ctx[h]; if (den) return pen + Math.log(num / den); }
      pen += LOG04;
    }
    return pen + Math.log(((c[ch] || 0) + 0.5) / (total1 + 50));
  }

  /** Все написания одного слова: [кириллица, score] по убыванию score. */
  candidates(lat: string, beam = 32, topn = 10): [string, number][] {
    lat = lat.toLowerCase();
    const pad = BOS.repeat(this.lm.order - 1);
    const states = new Map<number, [number, string][]>([[0, [[0, '']]]]);
    const push = (pos: number, item: [number, string]) => {
      const l = states.get(pos); if (l) l.push(item); else states.set(pos, [item]);
    };
    for (let pos = 0; pos < lat.length; pos++) {
      const st = states.get(pos);
      if (!st) continue;
      const cur = st.sort((a, b) => b[0] - a[0]).slice(0, beam);
      states.delete(pos);
      let matched = false;
      for (let k = 1; k <= MAXK; k++) {
        const frag = lat.substr(pos, k);
        if (frag.length < k || !hasRule(frag)) continue;
        matched = true;
        for (const opt of RULES[frag]) {
          const outs = [opt];
          if (opt && SOFTABLE.has(opt[opt.length - 1])) outs.push(opt + 'ь');
          for (const o of outs) for (const [sc, cy] of cur) {
            let hist = pad + cy, s = sc;
            for (const ch of o) { s += this.lp(hist, ch); hist += ch; }
            push(pos + k, [s, cy + o]);
          }
        }
      }
      if (!matched) for (const [sc, cy] of cur) push(pos + 1, [sc - 5, cy + lat[pos]]);
    }
    const final = (states.get(lat.length) ?? [])
      .map(([sc, cy]) => [sc + this.lp(pad + cy, EOS), cy] as [number, string])
      .sort((a, b) => b[0] - a[0]);
    const best = new Map<string, number>();
    for (const [sc, cy] of final) if (!best.has(cy)) best.set(cy, sc);
    return [...best.entries()].slice(0, topn);
  }

  /** Лучшее написание слова, его вероятность среди вариантов и до трёх альтернатив. */
  word(lat: string): TranslitResult {
    const cands = this.candidates(lat);
    if (!cands.length) return { text: lat, p: 0, alts: [] };
    const top = cands[0][1], z = cands.reduce((a, [, s]) => a + Math.exp(s - top), 0);
    return { text: cands[0][0], p: 1 / z, alts: cands.slice(1, 4).map(([c]) => c) };
  }

  /**
   * Имя целиком (части через дефис или пробел); заглавная первая буква части сохраняется.
   * alts — полные варианты имени: в лучшем написании заменена одна часть, начиная с самой сомнительной.
   */
  name(raw: string): TranslitResult {
    const parts = raw.split(/([- ]+)/).map((part) => {
      if (!part || /^[- ]+$/.test(part)) return { sep: part };
      const r = this.word(part);
      const cap = part[0] !== part[0].toLowerCase();
      const fix = (s: string) => (cap ? s[0].toUpperCase() + s.slice(1) : s);
      return { text: fix(r.text), p: r.p, alts: r.alts.map(fix) };
    });
    const words = parts.filter((x): x is { text: string; p: number; alts: string[] } => 'text' in x);
    const text = parts.map((x) => ('sep' in x ? x.sep : x.text)).join('');
    const p = words.reduce((m, x) => Math.min(m, x.p), 1);
    const alts: string[] = [];
    for (const w of [...words].sort((a, b) => a.p - b.p)) {
      for (const a of w.alts) alts.push(parts.map((x) => ('sep' in x ? x.sep : x === w ? a : x.text)).join(''));
    }
    return { text, p, alts: alts.slice(0, 4) };
  }
}

/** Имя записано латиницей (допускаются дефис, пробел, апостроф). */
export const isLatinName = (s: string) => /[A-Za-z]/.test(s) && /^[A-Za-zÖÜÑöüñ'`]+(?:[- ]+[A-Za-zÖÜÑöüñ'`]+)*$/.test(s.trim());
