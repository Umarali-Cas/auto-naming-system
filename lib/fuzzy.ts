import { DICT, POOL } from './stress';
import { NAMES } from './names-dict';

const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е');

// нормализованное имя → каноническое написание
const WORDS = new Map<string, string>();
[...NAMES, ...POOL, ...Object.keys(DICT)].forEach((n) => WORDS.set(norm(n), n));

/** Расстояние Дамерау-Левенштейна (вставка, удаление, замена, перестановка соседних букв). */
function dist(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/** Ближайшее имя из словаря: допускается 1 ошибка для коротких слов (до 4 букв) и до 2 для остальных. */
export function nearestName(word: string): { name: string; dist: number } | null {
  const w = norm(word);
  const exact = WORDS.get(w);
  if (exact) return { name: exact, dist: 0 };
  const max = w.length <= 4 ? 1 : 2;
  let best: { name: string; dist: number } | null = null;
  for (const [k, v] of WORDS) {
    const d = dist(w, k, max);
    if (d <= max && (!best || d < best.dist)) best = { name: v, dist: d };
  }
  return best;
}

/** Исправляет каждую часть имени (через дефис или пробел), которой нет в словаре. */
export function fuzzyFix(raw: string): { name: string; changed: boolean } {
  let changed = false;
  const name = raw.replace(/[А-ЯЁа-яё]+/g, (part) => {
    const n = nearestName(part);
    if (!n || n.dist === 0) return part;
    changed = true;
    return part[0] === part[0].toUpperCase() ? n.name : n.name.toLowerCase();
  });
  return { name, changed };
}

/** Для заглушки без LLM: имя похоже на опечатку (нет в словаре, но есть сосед на расстоянии 1). */
export function looksLikeTypo(raw: string): boolean {
  return (raw.match(/[А-ЯЁа-яё]+/g) ?? []).some((p) => nearestName(p)?.dist === 1);
}
