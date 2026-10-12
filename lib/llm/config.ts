/**
 * Реестр LLM. Провайдер появляется в выпадающем списке интерфейса, только если для него задан ключ в .env.local.
 * Любой OpenAI-совместимый сервис (Groq, OpenAI, Together, OpenRouter, Ollama, vLLM...) подключается через CUSTOM_LLM_*.
 */
export type Kind = 'openai' | 'anthropic' | 'stub';

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
    { id: 'groq', label: 'Groq', kind: 'openai', baseUrl: env.GROQ_BASE_URL || 'https://api.groq.com/openai/v1', keyEnv: 'GROQ_API_KEY', models: list(env.GROQ_MODELS, 'llama-3.3-70b-versatile,llama-3.1-8b-instant'), jsonMode: true },
    { id: 'openai', label: 'OpenAI', kind: 'openai', baseUrl: env.OPENAI_BASE_URL || 'https://api.openai.com/v1', keyEnv: 'OPENAI_API_KEY', models: list(env.OPENAI_MODELS, 'gpt-4o-mini'), jsonMode: true },
    { id: 'anthropic', label: 'Claude', kind: 'anthropic', baseUrl: env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com/v1', keyEnv: 'ANTHROPIC_API_KEY', models: list(env.ANTHROPIC_MODELS, 'claude-haiku-5-5'), jsonMode: false },
    { id: 'custom', label: env.CUSTOM_LLM_LABEL || 'Своя модель', kind: 'openai', baseUrl: (env.CUSTOM_LLM_BASE_URL || '').replace(/\/$/, ''), keyEnv: 'CUSTOM_LLM_API_KEY', models: list(env.CUSTOM_LLM_MODELS, ''), jsonMode: env.CUSTOM_LLM_JSON_MODE === '1' },
  ];
}

const STUB_PROVIDER: Provider = { id: 'stub', label: 'Заглушка', kind: 'stub', baseUrl: '', keyEnv: '', models: ['без LLM'], jsonMode: false };
const STUB: Option = { id: 'stub:none', label: 'Заглушка (без LLM)', provider: STUB_PROVIDER, model: 'none' };

/** Доступные варианты: настроенные провайдеры + заглушка (всегда последней). */
export function listOptions(): Option[] {
  const out: Option[] = [];
  for (const p of providers()) {
    const ready = p.id === 'custom' ? !!p.baseUrl && p.models.length > 0 : !!process.env[p.keyEnv];
    if (ready) p.models.forEach((m) => out.push({ id: `${p.id}:${m}`, label: `${p.label}: ${m}`, provider: p, model: m }));
  }
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
