import { NextResponse } from 'next/server';
import { defaultOption, listOptions } from '@/lib/llm/config';

export const dynamic = 'force-dynamic';

/** Список доступных моделей для выпадающего списка (ключи наружу не отдаются). */
export async function GET() {
  const options = listOptions().map(({ id, label }) => ({ id, label }));
  const d2 = process.env.LLM_DEFAULT_2 ?? '';
  return NextResponse.json({ options, default: defaultOption().id, default2: options.some((o) => o.id === d2) ? d2 : '' });
}
