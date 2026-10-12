import { NextResponse } from 'next/server';
import bcrypt from 'bcryptjs';
import { users } from '@/lib/db';
import { clearSession, createSession } from '@/lib/auth';

const err = (error: string, status: number) => NextResponse.json({ error }, { status });

export async function POST(req: Request, { params }: { params: { action: string } }) {
  const { action } = params;
  if (action === 'logout') { clearSession(); return NextResponse.json({ ok: true }); }
  if (action !== 'login') return err('Не найдено', 404);

  const body = (await req.json().catch(() => ({}))) as { email?: string; password?: string };
  const email = String(body.email ?? '').trim().toLowerCase();
  const password = String(body.password ?? '');
  if (!email || !password) return err('Введите почту и пароль', 400);

  const u = users.get(email);
  if (!u || !(await bcrypt.compare(password, u.hash))) return err('Неверная почта или пароль', 401);
  await createSession(email);
  return NextResponse.json({ ok: true });
}
