import type { Option } from './config';
import { LlmError } from './errors';
import { blockKey, keysOf, killKey, pickKey, type Pick } from './keys';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const HOUR = 3600e3;

/** Сколько ждать после 429: из текста «try again in 4.47s» или заголовка retry-after. */
function waitMs(msg: string, h: Headers): number {
  const m = /try again in (?:(\d+)m)?([\d.]+)(ms|s)/i.exec(msg);
  if (m) return (Number(m[1] || 0) * 60 + (m[3].toLowerCase() === 'ms' ? Number(m[2]) / 1000 : Number(m[2]))) * 1000;
  return (Number(h.get('retry-after')) || 5) * 1000;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function errMsg(j: any, status: number): string {
  const e = j?.error;
  const raw = e?.metadata?.raw; // OpenRouter кладёт сюда ответ провайдера модели
  return [
    e?.message ?? j?.message ?? `HTTP ${status}`,
    e?.metadata?.provider_name && `провайдер: ${e.metadata.provider_name}`,
    raw && String(typeof raw === 'string' ? raw : JSON.stringify(raw)).slice(0, 300),
  ].filter(Boolean).join(' | ');
}

async function send(o: Option, key: string, system: string, user: string, signal: AbortSignal, useJson: boolean) {
  const p = o.provider;
  if (p.kind === 'anthropic') {
    const r = await fetch(`${p.baseUrl}/messages`, {
      method: 'POST', signal,
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: o.model, max_tokens: 4000, temperature: 0, system, messages: [{ role: 'user', content: user }] }),
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const j = (await r.json().catch(() => ({}))) as any;
    return { r, j, text: r.ok ? (j.content as { text?: string }[]).map((c) => c.text ?? '').join('') : '' };
  }

  const payload: Record<string, unknown> = {
    model: o.model, temperature: 0, max_tokens: 2000,
    messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
  };
  if (useJson) payload.response_format = { type: 'json_object' };
  if (p.id === 'groq' && /gpt-oss/.test(o.model)) payload.reasoning_effort = 'low';
  // OpenRouter: «размышления» отключены (быстрее, не упираемся в таймаут Vercel). OPENROUTER_REASONING=1 включает обратно.
  if (p.id === 'openrouter' && process.env.OPENROUTER_REASONING !== '1') payload.reasoning = { enabled: false };

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (key) headers.authorization = `Bearer ${key}`;
  if (p.id === 'openrouter') { headers['HTTP-Referer'] = process.env.APP_URL || 'https://vercel.com'; headers['X-Title'] = 'Stress names'; }

  const r = await fetch(`${p.baseUrl}/chat/completions`, { method: 'POST', signal, headers, body: JSON.stringify(payload) });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const j = (await r.json().catch(() => ({}))) as any;
  return { r, j, text: r.ok ? String(j.choices?.[0]?.message?.content ?? '') : '' };
}

/**
 * Один запрос к LLM с перебором ключей и ожиданием лимитов.
 * Лимиты (429) не считаются ошибкой: код ждёт ровно столько, сколько просит провайдер, и повторяет запрос,
 * пока не истечёт время одного запроса (LLM_TIMEOUT_MS). Если не успевает, бросает LlmError с retryable
 * и подсказкой, через сколько повторить: интерфейс подождёт и повторит сам.
 * 401 — ключ недействителен, 402 — нет кредитов, 403 — доступ запрещён: берём следующий ключ.
 */
export async function chat(o: Option, system: string, user: string): Promise<string> {
  const p = o.provider;
  const keys = keysOf(p);
  const pool = keys.length ? keys : p.id === 'custom' ? [''] : [];
  if (!pool.length) throw new LlmError(`Не задан ключ ${p.keyEnv} в настройках окружения`);

  const budget = Number(process.env.LLM_TIMEOUT_MS) || 50000;
  const deadline = Date.now() + budget;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), budget);
  const maxFails = pool.length * 2 + 3;
  let useJson = p.jsonMode;
  let fails = 0;
  let last = '';
  try {
    for (;;) {
      if (fails >= maxFails) throw new LlmError(`${p.label}: сервис временно недоступен. ${last}`.trim(), { retryable: true, retryAfterMs: 8000 });
      const pk: Pick = pickKey(p, pool);
      if ('none' in pk) throw new LlmError(`${p.label}: все ключи (${pool.length}) недействительны. ${last}`.trim());
      if ('wait' in pk) {
        if (pk.wait + 300 > deadline - Date.now() - 2000) { // за время этого запроса лимит не освободится
          throw new LlmError(`${p.label}: лимит, освободится через ${Math.ceil(pk.wait / 1000)} с. ${last}`.trim(), { retryable: pk.wait <= 90000, retryAfterMs: pk.wait + 500 });
        }
        await sleep(pk.wait + 300);
        continue;
      }

      let res: Awaited<ReturnType<typeof send>>;
      try {
        res = await send(o, pk.key, system, user, ctrl.signal, useJson);
      } catch (e) {
        if (e instanceof Error && e.name === 'AbortError') throw new LlmError(`${p.label}: превышено время ожидания ответа`, { retryable: true, retryAfterMs: 3000 });
        last = `ключ №${pk.index + 1}: ${e instanceof Error ? e.message : 'сетевая ошибка'}`;
        blockKey(p, pk.key, 3000);
        fails++;
        continue;
      }

      const { r, j, text } = res;
      if (r.ok) return text;
      const msg = errMsg(j, r.status);
      last = `ключ №${pk.index + 1}: ${msg}`;

      if (useJson && r.status === 400 && /response_format|json/i.test(msg)) { useJson = false; continue; } // модель без JSON-режима
      if (typeof j?.error?.failed_generation === 'string') return j.error.failed_generation; // спасаем недописанный ответ

      if (r.status === 401) { killKey(p, pk.key); continue; } // ключ недействителен
      if (r.status === 402) { blockKey(p, pk.key, HOUR); continue; } // закончились кредиты
      if (r.status === 403) { blockKey(p, pk.key, 5 * 60e3); continue; }
      if (r.status === 429) {
        const daily = /per[- ]day|daily|\bTPD\b|\bRPD\b/i.test(msg); // суточный лимит: этот ключ на сегодня всё
        const w = waitMs(msg, r.headers);
        blockKey(p, pk.key, daily || w > 60000 ? HOUR : Math.max(w, 1000) + 300);
        continue;
      }
      if (r.status >= 500) { blockKey(p, pk.key, 3000); fails++; continue; }
      if (/not have access|permission/i.test(msg)) { blockKey(p, pk.key, 10 * 60e3); continue; } // у аккаунта нет доступа к модели
      throw new LlmError(`${p.label}: ${msg}`); // ошибка запроса или модели, повтор не поможет
    }
  } finally {
    clearTimeout(timer);
  }
}
