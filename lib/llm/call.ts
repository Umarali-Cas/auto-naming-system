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

    const r = await fetch(`${p.baseUrl}/chat/completions`, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
      body: JSON.stringify({
        model: o.model, temperature: 0,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        ...(p.jsonMode ? { response_format: { type: 'json_object' } } : {}),
      }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const j = (await r.json().catch(() => ({}))) as any;
    if (!r.ok) throw new Error(`${p.label}: ${j?.error?.message ?? 'HTTP ' + r.status}`);
    return String(j.choices?.[0]?.message?.content ?? '');
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw new Error(`${p.label}: превышено время ожидания`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
