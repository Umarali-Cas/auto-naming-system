import { cookies } from 'next/headers';
import { COOKIE, signToken, verifyToken } from './jwt';

export async function createSession(email: string) {
  cookies().set(COOKIE, await signToken(email), {
    httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: 60 * 60 * 24 * 7,
  });
}
export const clearSession = () => cookies().delete(COOKIE);
export const getSession = () => verifyToken(cookies().get(COOKIE)?.value);
