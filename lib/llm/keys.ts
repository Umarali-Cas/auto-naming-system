import type { Provider } from './config';

interface KeyState { until: number; dead: boolean }
const state = new Map<string, KeyState>(); // состояние ключей живёт в памяти процесса
const cursor = new Map<string, number>();

/** Ключи провайдера: в переменной (или <ИМЯ>S) через запятую, пробел или перевод строки. */
export function keysOf(p: Provider): string[] {
  if (!p.keyEnv) return [];
  const raw = [process.env[p.keyEnv], process.env[`${p.keyEnv}S`]].filter(Boolean).join(',');
  return [...new Set(raw.split(/[\s,;]+/).filter(Boolean))];
}

function st(p: Provider, key: string): KeyState {
  const id = `${p.id}|${key}`;
  let s = state.get(id);
  if (!s) { s = { until: 0, dead: false }; state.set(id, s); }
  return s;
}

export type Pick = { key: string; index: number } | { wait: number } | { none: true };

/** Следующий доступный ключ по кругу (нагрузка делится между аккаунтами). Или сколько ждать, или «все недействительны». */
export function pickKey(p: Provider, keys: string[]): Pick {
  const now = Date.now();
  const alive = keys.map((key, index) => ({ key, index })).filter(({ key }) => !st(p, key).dead);
  if (!alive.length) return { none: true };
  const ready = alive.filter(({ key }) => st(p, key).until <= now);
  if (ready.length) {
    const n = (cursor.get(p.id) ?? 0) % ready.length;
    cursor.set(p.id, n + 1);
    return ready[n];
  }
  return { wait: Math.min(...alive.map(({ key }) => st(p, key).until)) - now };
}

/** Ключ временно не используем (лимит, нет кредитов). */
export const blockKey = (p: Provider, key: string, ms: number) => { st(p, key).until = Date.now() + ms; };
/** Ключ недействителен: больше не используем до перезапуска. */
export const killKey = (p: Provider, key: string) => { st(p, key).dead = true; };
