import { NextRequest, NextResponse } from 'next/server';
import { COOKIE, verifyToken } from '@/lib/jwt';

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const user = await verifyToken(req.cookies.get(COOKIE)?.value);
  if (pathname === '/login') return user ? NextResponse.redirect(new URL('/', req.url)) : NextResponse.next();
  if (user) return NextResponse.next();
  return pathname.startsWith('/api')
    ? NextResponse.json({ error: 'Требуется вход' }, { status: 401 })
    : NextResponse.redirect(new URL('/login', req.url));
}
// models/ — веса модели ударений KG (public/models/kg): их скачивает сам сервер без cookie, секретов там нет
export const config = { matcher: ['/((?!_next|favicon.ico|api/auth|models/).*)'] };
