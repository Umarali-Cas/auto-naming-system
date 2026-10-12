import { NextResponse } from 'next/server';

interface Out { id: number; name: string; accented: string }

/** ЗАГЛУШКА отправки: POST на JSONPlaceholder. Замените на ваш сервер (с ретраями и идемпотентностью). */
export async function POST(req: Request) {
  const { items } = (await req.json().catch(() => ({}))) as { items?: Out[] };
  if (!Array.isArray(items) || !items.length) return NextResponse.json({ error: 'Пустая пачка' }, { status: 400 });
  try {
    const r = await fetch('https://jsonplaceholder.typicode.com/posts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'stress-batch', body: JSON.stringify(items), userId: 1 }),
    });
    return NextResponse.json({ status: r.status, count: items.length }, { status: r.ok ? 200 : 502 });
  } catch {
    return NextResponse.json({ status: 201, count: items.length, stub: true });
  }
}
