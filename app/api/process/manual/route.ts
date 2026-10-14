import { NextResponse } from 'next/server';
import { processNames } from '@/lib/pipeline';
import { LlmError } from '@/lib/llm/errors';

export const maxDuration = 60;

/**
 * Ручная правка написания («Изменить» и выбор другого написания): имя берётся как есть,
 * без проверки опечаток, модель только ставит ударение.
 */
export async function POST(req: Request) {
  const { name, llm } = (await req.json().catch(() => ({}))) as { name?: unknown; llm?: string };
  if (typeof name !== 'string' || !name.trim() || name.length > 100) {
    return NextResponse.json({ error: 'Некорректное имя' }, { status: 400 });
  }
  try {
    // адрес сайта для загрузки весов KG: возьмите ту же строку, что и в app/api/process/route.ts
    const origin = new URL(req.url).origin;
    return NextResponse.json({ items: await processNames([name], llm, origin, true) });
  } catch (e) {
    if (e instanceof LlmError) {
      const body = { error: e.message, retryable: e.retryable, retryAfterMs: e.retryAfterMs };
      return NextResponse.json(body, { status: e.retryable ? 503 : 502 });
    }
    return NextResponse.json({ error: e instanceof Error ? e.message : 'Ошибка обработки' }, { status: 502 });
  }
}
