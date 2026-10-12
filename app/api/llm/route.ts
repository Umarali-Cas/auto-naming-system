import { NextResponse } from 'next/server';
import { defaultOption, listOptions } from '@/lib/llm/config';

export const dynamic = 'force-dynamic';

/** Список доступных моделей для выпадающего списка (ключи наружу не отдаются). */
export async function GET() {
  return NextResponse.json({ options: listOptions().map(({ id, label }) => ({ id, label })), default: defaultOption().id });
}
