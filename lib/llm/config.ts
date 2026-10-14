/**
 * Реестр LLM. Провайдер появляется в выпадающем списке интерфейса, только если для него задан ключ в .env.local.
 * Любой OpenAI-совместимый сервис (Groq, OpenAI, Together, OpenRouter, Ollama, vLLM...) подключается через CUSTOM_LLM_*.
 */
import { keysOf } from './keys';

export type Kind = 'openai' | 'anthropic' | 'stub' | 'kg';

export interface Provider {
  id: string;
  label: string;
  kind: Kind;
  baseUrl: string;
  keyEnv: string; // имя переменной окружения с ключом
  models: string[];
  jsonMode: boolean; // отправлять response_format: json_object
}
export interface Option { id: string; label: string; provider: Provider; model: string }

const list = (v: string | undefined, d: string) => (v || d).split(',').map((s) => s.trim()).filter(Boolean);
const e = () => process.env;

export function providers(): Provider[] {
  const env = e();
  return [
    { id: 'groq', label: 'Groq', kind: 'openai', baseUrl: env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1', keyEnv: 'GROQ_API_KEY', models: list(env.GROQ_MODELS, 'openai/gpt-oss-120b,openai/gpt-oss-20b,qwen/qwen3.6-27b'), jsonMode: env.GROQ_JSON_MODE === '1' },
    { id: 'openai', label: 'OpenAI', kind: 'openai', baseUrl: env.OPENAI_BASE_URL || 'https://api.openai.com/v1', keyEnv: 'OPENAI_API_KEY', models: list(env.OPENAI_MODELS, 'gpt-4o-mini'), jsonMode: true },
    { id: 'anthropic', label: 'Claude', kind: 'anthropic', baseUrl: env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1', keyEnv: 'ANTHROPIC_API_KEY', models: list(env.ANTHROPIC_MODELS, 'claude-haiku-5-5'), jsonMode: false },
    { id: 'openrouter', label: 'OpenRouter', kind: 'openai', baseUrl: env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api/v1', keyEnv: 'OPENROUTER_API_KEY', models: list(env.OPENROUTER_MODELS, 'qwen/qwen3.8-27b:free,cohere/north-mini-code:free'), jsonMode: false },
    { id: 'custom', label: env.CUSTOM_LLM_LABEL || 'Своя модель', kind: 'openai', baseUrl: (env.CUSTOM_LLM_BASE_URL || '').replace(/\/$/, ''), keyEnv: 'CUSTOM_LLM_API_KEY', models: list(env.CUSTOM_LLM_MODELS, ''), jsonMode: env.CUSTOM_LLM_JSON_MODE === '1' },
  ];
}

const STUB_PROVIDER: Provider = { id: 'stub', label: 'Заглушка', kind: 'stub', baseUrl: '', keyEnv: '', models: ['без LLM'], jsonMode: false };
const STUB: Option = { id: 'stub:none', label: 'Заглушка (без LLM)', provider: STUB_PROVIDER, model: 'none' };

/**
 * Модель ударений KG (lib/kg): работает без ключей и без внешних запросов.
 * kg:bilstm — только своя модель; kg:hybrid — своя модель, а имена ниже её порога уверенности
 * дополнительно спрашиваются у LLM (KG_HYBRID_LLM или первая настроенная) для сверки.
 */
const KG_PROVIDER: Provider = { id: 'kg', label: 'Модель ударений KG', kind: 'kg', baseUrl: '', keyEnv: '', models: ['bilstm', 'hybrid'], jsonMode: false };

/** LLM, которой гибрид отдаёт сомнительные имена. */
export function hybridLlm(llms: Option[]): Option | undefined {
  return llms.find((o) => o.id === process.env.KG_HYBRID_LLM) ?? llms[0];
}

/** Доступные варианты: настроенные провайдеры, модель KG, заглушка (всегда последней). */
export function listOptions(): Option[] {
  const out: Option[] = [];
  for (const p of providers()) {
    const n = keysOf(p).length;
    const ready = p.id === 'custom' ? !!p.baseUrl && p.models.length > 0 : n > 0;
    const suffix = n > 1 ? ` [ключей: ${n}]` : '';
    if (ready) p.models.forEach((m) => out.push({ id: `${p.id}:${m}`, label: `${p.label}: ${m}${suffix}`, provider: p, model: m }));
  }
  const h = hybridLlm(out);
  out.push({ id: 'kg:bilstm', label: 'Модель ударений KG (без LLM)', provider: KG_PROVIDER, model: 'bilstm' });
  if (h) out.push({ id: 'kg:hybrid', label: `Модель ударений KG + ${h.label} для сомнительных`, provider: KG_PROVIDER, model: 'hybrid' });
  out.push(STUB);
  return out;
}

export function defaultOption(): Option {
  const all = listOptions();
  return all.find((o) => o.id === process.env.LLM_DEFAULT) ?? all[0];
}

export function resolveOption(id?: string | null): Option {
  if (!id) return defaultOption();
  const o = listOptions().find((x) => x.id === id);
  if (!o) throw new Error('Неизвестная или ненастроенная модель: ' + id);
  return o;
}
