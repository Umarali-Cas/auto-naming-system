import { SignJWT, jwtVerify } from 'jose';

export const COOKIE = 'session';
const key = () => new TextEncoder().encode(process.env.AUTH_SECRET || 'dev-only-secret-change-me-32-chars!!');

export const signToken = (email: string) =>
  new SignJWT({ email }).setProtectedHeader({ alg: 'HS256' }).setExpirationTime('7d').sign(key());

export async function verifyToken(t?: string): Promise<string | null> {
  if (!t) return null;
  try {
    const { payload } = await jwtVerify(t, key());
    return typeof payload.email === 'string' ? payload.email : null;
  } catch {
    return null;
  }
}
