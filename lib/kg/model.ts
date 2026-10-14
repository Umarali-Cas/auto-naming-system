/**
 * Посимвольная BiLSTM для ударений в именах (обучена на 215 тыс. размеченных имён, фамилий и отчеств KG).
 * Веса: public/models/kg/weights.json (float16 в base64). Расчёт на чистом JS, без зависимостей,
 * поэтому работает и в edge-рантайме, и в Node, и в браузере.
 */
export const KG_VOWELS = new Set([...'аеёиоуыэюяөү']);

interface Tensor { shape: number[]; d: Float32Array }
export interface WeightsFile {
  cfg: { emb: number; hidden: number; layers: number };
  stoi: Record<string, number>;
  w: Record<string, { shape: number[]; b64: string }>;
}

function half(u: number): number {
  const s = u & 0x8000 ? -1 : 1, e = (u >> 10) & 0x1f, f = u & 0x3ff;
  if (e === 0) return s * Math.pow(2, -14) * (f / 1024);
  if (e === 31) return f ? NaN : s * Infinity;
  return s * Math.pow(2, e - 15) * (1 + f / 1024);
}
let HALF: Float32Array | null = null; // все 65536 значений float16, считается один раз

function decode(b64: string): Float32Array {
  if (!HALF) { HALF = new Float32Array(65536); for (let u = 0; u < 65536; u++) HALF[u] = half(u); }
  const bin = atob(b64), n = bin.length >> 1, out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = HALF[bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8)];
  return out;
}
const sig = (x: number) => 1 / (1 + Math.exp(-x));

export class StressModel {
  private P: Record<string, Tensor> = {};
  private stoi: Record<string, number>;
  private H: number;
  private E: number;

  constructor(w: WeightsFile) {
    this.stoi = w.stoi; this.H = w.cfg.hidden; this.E = w.cfg.emb;
    for (const [k, v] of Object.entries(w.w)) this.P[k] = { shape: v.shape, d: decode(v.b64) };
  }

  private lstmDir(xs: Float32Array[], sfx: string): Float32Array[] {
    const H = this.H, Wi = this.P['lstm.weight_ih_' + sfx], Wh = this.P['lstm.weight_hh_' + sfx];
    const bi = this.P['lstm.bias_ih_' + sfx].d, bh = this.P['lstm.bias_hh_' + sfx].d;
    const I = Wi.shape[1], G = 4 * H, wi = Wi.d, wh = Wh.d;
    let h = new Float32Array(H), c = new Float32Array(H);
    const g = new Float32Array(G), out: Float32Array[] = [];
    for (const x of xs) {
      for (let r = 0; r < G; r++) {
        let s = bi[r] + bh[r];
        const oi = r * I; for (let j = 0; j < I; j++) s += wi[oi + j] * x[j];
        const oh = r * H; for (let j = 0; j < H; j++) s += wh[oh + j] * h[j];
        g[r] = s;
      }
      const nh = new Float32Array(H), nc = new Float32Array(H);
      for (let k = 0; k < H; k++) { // порядок гейтов PyTorch: i, f, g, o
        nc[k] = sig(g[H + k]) * c[k] + sig(g[k]) * Math.tanh(g[2 * H + k]);
        nh[k] = sig(g[3 * H + k]) * Math.tanh(nc[k]);
      }
      h = nh; c = nc; out.push(nh);
    }
    return out;
  }

  /** Вероятность ударения на каждом символе слова в нижнем регистре (у согласных 0). Слово без дефисов и пробелов. */
  probs(word: string): number[] {
    const H = this.H, E = this.E, emb = this.P['emb.weight'].d, chars = [...word];
    let xs = chars.map((ch) => { const id = this.stoi[ch] ?? 1; return emb.subarray(id * E, (id + 1) * E); });
    for (const layer of ['l0', 'l1']) {
      const fw = this.lstmDir(xs, layer), bw = this.lstmDir([...xs].reverse(), layer + '_reverse').reverse();
      xs = fw.map((f, i) => { const v = new Float32Array(2 * H); v.set(f); v.set(bw[i], H); return v; });
    }
    const ow = this.P['out.weight'].d, ob = this.P['out.bias'].d[0];
    const logits = xs.map((x, i) => {
      if (!KG_VOWELS.has(chars[i])) return -Infinity;
      let s = ob; for (let j = 0; j < x.length; j++) s += ow[j] * x[j];
      return s;
    });
    const m = Math.max(...logits);
    const ex = logits.map((l) => (l === -Infinity ? 0 : Math.exp(l - m)));
    const sum = ex.reduce((a, b) => a + b, 0);
    return ex.map((e) => e / sum);
  }
}
