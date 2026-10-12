import { guess } from './stress';

export interface LlmResult { stress: number | null; conf: number; failed?: boolean }

/**
 * ЗАГЛУШКА. Для боевой версии замените тело функции на вызов LLM:
 * отправляйте пачки по 20–50 имён, просите строгий JSON, а после ответа проверяйте:
 * имя без значка ударения == исходное имя, ударение на гласной. Иначе failed: true.
 */
export async function stressNames(names: string[]): Promise<LlmResult[]> {
  await new Promise((r) => setTimeout(r, 400));
  return names.map((n) => (Math.random() < 0.03 ? { stress: null, conf: 0, failed: true } : guess(n)));
}
