import { NextResponse } from 'next/server';
import { fetchNames } from '@/lib/names-source';
import { processNames } from '@/lib/pipeline';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

/** Берёт имена из fetchNames, обрабатывает их выбранной моделью и возвращает { items }. */
export async function GET(req: Request) {
  const llm = new URL(req.url).searchParams.get('llm') || undefined;
  try {
    const names = await fetchNames(20);
    return NextResponse.json({ items: await processNames(names, llm) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Ошибка обработки' }, { status: 502 });
  }
}
