import { NextResponse } from 'next/server';
import { processNames } from '@/lib/pipeline';
import { LlmError } from '@/lib/llm/errors';

export const maxDuration = 60;
export const preferredRegion = 'fra1';
export const runtime = 'edge';
export async function POST(req: Request) {
  const { names, llm } = (await req.json().catch(() => ({}))) as { names?: unknown; llm?: string };
  if (!Array.isArray(names) || names.length > 500 || names.some((n) => typeof n !== 'string' || n.length > 100)) {
    return NextResponse.json({ error: 'Некорректный список имён' }, { status: 400 });
  }
  try {
    return NextResponse.json({ items: await processNames(names as string[], llm) });
  } catch (e) {
    if (e instanceof LlmError) {
      const body = { error: e.message, retryable: e.retryable, retryAfterMs: e.retryAfterMs };
      return NextResponse.json(body, { status: e.retryable ? 503 : 502 });
    }
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Ошибка обработки' }, { status: 502 });
  }
}
