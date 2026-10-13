import { POOL } from './stress';

const SNAP = ['Leanne Graham', 'Ervin Howell', 'Clementine Bauch', 'Patricia Lebsack', 'Chelsey Dietrich', 'Mrs. Dennis Schulist', 'Kurtis Weissnat', 'Glenna Reichert'];
const JUNK = ['"Иван"', 'Пётр (дубль)', '', 'Анна123', '<b>Олег</b>', '???', 'Мария [тест]'];
const rnd = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];
const TEST_NAMES = (process.env.TEST_NAMES || '').split(',').map((s) => s.trim()).filter(Boolean);

/** Заглушка «сервера с именами»: JSONPlaceholder /users + генератор. Замените на ваш API. */
export async function fetchNames(count = 200): Promise<string[]> {
  let users = SNAP;
  try {
    const r = await fetch('https://jsonplaceholder.typicode.com/users', { cache: 'no-store' });
    users = ((await r.json()) as { name: string }[]).map((u) => u.name);
  } catch {}
  const out = [...JUNK];
  for (let i = 0; i < 6; i++) out.push(rnd(users));
  while (out.length < count) out.push(rnd(POOL));
  // return out.sort(() => Math.random() - 0.5);
  const shuffled = out.sort(() => Math.random() - 0.5);
  return [...TEST_NAMES, ...shuffled]; //
}
