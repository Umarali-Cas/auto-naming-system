import { NextResponse } from 'next/server';
import { fetchNames } from '@/lib/names-source';
import { processNames } from '@/lib/pipeline';

export const dynamic = 'force-dynamic';
export const maxDuration = 60;

export async function GET(req: Request) {
  const llm = new URL(req.url).searchParams.get('llm') || undefined;
  try {
    const names = await fetchNames(200);
    return NextResponse.json({ items: await processNames(names, llm) });
  } catch (e) {
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Ошибка обработки' }, { status: 502 });
  }
}
