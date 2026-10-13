import { NextResponse } from 'next/server';
import { fetchNames } from '@/lib/names-source';

export const dynamic = 'force-dynamic';

const COUNT = 200; // сколько имён запрашивать за раз (впишите своё число)

/** Только список имён (быстро). Обработку LLM клиент запрашивает порциями через /api/process. */
export async function GET() {
  try {
    return NextResponse.json({ names: await fetchNames(COUNT) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Не удалось получить имена' }, { status: 502 });
  }
}
