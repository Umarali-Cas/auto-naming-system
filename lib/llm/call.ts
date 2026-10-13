import type { Option } from './config';

/**
 * Один запрос к LLM. Здесь меняется формат API, если провайдер нестандартный.
 * openai: POST {baseUrl}/chat/completions (Groq, OpenAI, Ollama, vLLM, OpenRouter и др.)
 * anthropic: POST {baseUrl}/messages
 */
export async function chat(o: Option, system: string, user: string): Promise<string> {
  const { provider: p } = o;
  const key = process.env[p.keyEnv];
  if (!key && p.id !== 'custom') throw new Error(`Не задан ключ ${p.keyEnv} в .env.local`);

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), Number(process.env.LLM_TIMEOUT_MS) || 40000);
  try {
    if (p.kind === 'anthropic') {
      const r = await fetch(`${p.baseUrl}/messages`, {
        method: 'POST', signal: ctrl.signal,
        headers: { 'content-type': 'application/json', 'x-api-key': key!, 'anthropic-version': '2023-06-01' },
        body: JSON.stringify({ model: o.model, max_tokens: 4000, temperature: 0, system, messages: [{ role: 'user', content: user }] }),
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const j = (await r.json().catch(() => ({}))) as any;
      if (!r.ok) throw new Error(`${p.label}: ${j?.error?.message ?? 'HTTP ' + r.status}`);
      return (j.content as { text?: string }[]).map((c) => c.text ?? '').join('');
    }

    for (const useJson of p.jsonMode ? [true, false] : [false]) {
      const payload: Record<string, unknown> = {
        model: o.model, temperature: 0, max_tokens: 4096,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      };
      if (useJson) payload.response_format = { type: 'json_object' };
      if (p.id === 'groq' && /gpt-oss/.test(o.model)) payload.reasoning_effort = 'low'; // меньше «размышлений», быстрее и дешевле
      const r = await fetch(`${p.baseUrl}/chat/completions`, {
        method: 'POST', signal: ctrl.signal,
        headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
        body: JSON.stringify(payload),
      });
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const j = (await r.json().catch(() => ({}))) as any;
      if (r.ok) return String(j.choices?.[0]?.message?.content ?? '');
      const msg = j?.error?.message ?? 'HTTP ' + r.status;
      if (useJson && /response_format|json/i.test(msg)) continue; // JSON-режим не удался: повтор без него
      if (typeof j?.error?.failed_generation === 'string') return j.error.failed_generation; // спасаем то, что модель успела написать
      throw new Error(`${p.label}: ${msg}`);
    }
    throw new Error(`${p.label}: пустой ответ`);
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw new Error(`${p.label}: превышено время ожидания`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
