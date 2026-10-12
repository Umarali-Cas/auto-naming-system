'use client';
import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';

export default function Login() {
  const router = useRouter();
  const [email, setEmail] = useState('demo@example.com');
  const [password, setPassword] = useState('demo12345');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true); setError('');
    const r = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
    if (r.ok) { router.replace('/'); router.refresh(); return; }
    setError(((await r.json().catch(() => ({}))) as { error?: string }).error ?? 'Не удалось войти');
    setBusy(false);
  }

  return (
    <main className="w narrow">
      <h1>Вход</h1>
      <p className="mu">Демо-аккаунт уже подставлен: demo@example.com / demo12345</p>
      <form className="card form" onSubmit={submit}>
        <label>Почта<input className="t" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" required /></label>
        <label>Пароль<input className="t" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required /></label>
        {error && <div className="er" role="alert">{error}</div>}
        <button className="b p" disabled={busy}>Войти</button>
      </form>
    </main>
  );
}
