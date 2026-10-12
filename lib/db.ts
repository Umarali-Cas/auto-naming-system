import bcrypt from 'bcryptjs';

export interface User { email: string; hash: string }

// ЗАГЛУШКА: список пользователей в памяти процесса. Регистрации нет — пользователей заводит администратор.
// Для внедрения замените на Postgres/Prisma, структура User сохраняется.
const g = globalThis as unknown as { __users?: Map<string, User> };
export const users: Map<string, User> = (g.__users ??= new Map());

function seed(email: string, password: string) {
  const e = email.trim().toLowerCase();
  if (e && !users.has(e)) users.set(e, { email: e, hash: bcrypt.hashSync(password, 10) });
}
seed('demo@example.com', 'demo12345');
if (process.env.ADMIN_EMAIL && process.env.ADMIN_PASSWORD) seed(process.env.ADMIN_EMAIL, process.env.ADMIN_PASSWORD);
