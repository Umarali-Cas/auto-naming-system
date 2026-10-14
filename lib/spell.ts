/**
 * Проверка написания имён (положите в lib/spell.ts).
 * Отдельный шаг до расстановки ударений. Три уровня, результат объединяется:
 *  1) LLM возвращает правильное написание (fixed) и уверенность; проверка идёт небольшими порциями и в несколько проходов
 *     с разным составом порций (SPELL_VOTES, по умолчанию 2): опечатка засчитывается, если её нашёл любой проход;
 *  2) незнакомое или странное имя (уверенность low) тоже уходит на проверку человеку;
 *  3) проверка по форме слова без LLM и без словаря: серии одинаковых букв, нет гласных, 4+ согласных подряд,
 *     «ь» после гласной, регистр. Работает, даже если LLM недоступна.
 * Если LLM недоступна, шаги 1 и 2 пропускаются, остальной конвейер не ломается.
 */
import { chat } from './llm/call';
import { listOptions, type Option } from './llm/config';
import { check } from './stress';

export interface Spell {
  fixed?: string; // исправленное написание (модель нашла опечатку)
  suspicious?: boolean; // имя не исправлено, но написание сомнительно
  why?: string; // причина, если сомнение найдено по форме слова
}

const CHUNK = 30; // имён в одном запросе: чем меньше порция, тем внимательнее проверка
const VOTES = Math.max(1, Math.min(3, Number(process.env.SPELL_VOTES) || 2)); // сколько проходов
const cache = new Map<string, Spell>(); // повторяющиеся имена не уходят в LLM второй раз

const SYSTEM = `Ты строгий корректор личных имён: русских, кыргызских, узбекских. Имена записаны кириллицей (для кыргызских допустимы ө, ү, ң).
Для каждого имени:
1. Вспомни, как правильно пишется такое имя, и верни в поле fixed правильное написание.
2. Проверь каждую букву. Ищи: пропущенную букву (Нурлн), лишнюю или повторённую (Азаммат, Азамаааат), заменённую похожей (Айгурь вместо Айгуль), переставленные буквы (Нурлна), склеенные или разорванные части имени.
3. Если имя написано правильно, fixed равно входной строке. Редкие, но существующие имена не меняй. Не придумывай другое имя: правка отличается от исходного лишь парой букв. Регистр и дефисы сохраняй.
4. confidence: "high" только если ты точно знаешь, что такое имя существует именно в таком написании. Если имя незнакомо, странно выглядит или ты сомневаешься, ставь "low". Лучше усомниться, чем пропустить опечатку.
Используй только буквы русского и кыргызского алфавитов (включая ө, ү, ң). Букв ғ, қ, ҳ, ў, ә, і, ұ в ответе быть не должно: «Самгар» остаётся «Самгар», это не опечатка.

Примеры (вход -> fixed, confidence):
Нурлн -> Нурлан, high
Азаммат -> Азамат, high
Каныбк -> Каныбек, high
Дмитрй -> Дмитрий, high
Алишр -> Алишер, high
Нурлна -> Нурлан, high
Бакыд -> Бакыт, medium
Азамат -> Азамат, high
Эрлан -> Эрлан, high
Мырзабек -> Мырзабек, high
Айгерим -> Айгерим, high
Анна-Мария -> Анна-Мария, high
Самгар -> Самгар, low

Ответ строго JSON, без пояснений и без markdown:
{"items":[{"id":0,"fixed":"Азамат","confidence":"high"}]}
id берётся из входных данных, верни запись для каждого id.`;

/** Расстояние Дамерау-Левенштейна (вставка, удаление, замена, перестановка соседних букв). */
function dist(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/** Допустимые буквы в исправленном имени: русские и кыргызские (ө, ү, ң). Казахские и узбекские особые буквы не вставляем. */
const ALLOWED = /^[А-ЯЁа-яёӨөҮүҢң\s-]+$/u;
const norm = (s: string) => s.toLowerCase().replace(/ё/g, 'е');
const VOWELS = 'аеёиоуыэюяөү';

/** Проверка по форме слова (без LLM и без списка имён). Возвращает причину сомнения или пустую строку. */
export function shapeIssue(name: string): string {
  if (/^[а-яёөүң]/u.test(name)) return 'имя начинается со строчной буквы';
  if (/[а-яёөүң][А-ЯЁӨҮҢ]/u.test(name)) return 'заглавная буква внутри слова';
  if (name.length > 2 && name === name.toUpperCase() && /[А-ЯЁ]/u.test(name)) return 'имя написано заглавными буквами';
  if (/(.)\1{2,}/iu.test(name)) return 'три одинаковые буквы подряд';
  for (const part of name.split(/[\s-]+/)) {
    const w = part.toLowerCase();
    if (!w) continue;
    if (w.length > 2 && ![...w].some((c) => VOWELS.includes(c))) return 'в слове нет гласных';
    if (/[аеёиоуыэюяөү]ь|^[ъь]|ъ|[ъь]{2}/u.test(w)) return 'необычное сочетание с «ь» или «ъ»';
    if (/[^аеёиоуыэюяөүьъй]{4,}/u.test(w)) return 'четыре согласные подряд';
  }
  return '';
}

/** Какая LLM проверяет написание: SPELL_LLM из окружения, затем gpt-oss (лучше 120b), затем выбранная пользователем, затем первая доступная. */
function pickOption(llmId?: string): Option | null {
  const llms = listOptions().filter((o) => o.provider.kind === 'openai' || o.provider.kind === 'anthropic');
  if (!llms.length) return null;
  const want = process.env.SPELL_LLM;
  return (
    llms.find((o) => !!want && o.id === want) ??
    llms.find((o) => /gpt-oss-120b/.test(o.model)) ??
    llms.find((o) => /gpt-oss/.test(o.model)) ??
    llms.find((o) => o.id === llmId) ??
    llms[0]
  );
}

/** Один проход: список делится на порции, для каждого имени возвращается ответ модели. Ошибка порции не ломает остальные. */
async function runPass(o: Option, list: string[]): Promise<Map<string, Spell>> {
  const answers = new Map<string, Spell>();
  for (let k = 0; k < list.length; k += CHUNK) {
    const part = list.slice(k, k + CHUNK);
    try {
      const text = await chat(o, SYSTEM, 'Имена:\n' + JSON.stringify(part.map((name, id) => ({ id, name }))) + '\nВерни JSON.');
      const clean = text.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/```(?:json)?/g, '');
      let items: { id?: number; fixed?: unknown; confidence?: unknown }[] = [];
      try {
        items = JSON.parse(clean.match(/\{[\s\S]*\}/)?.[0] ?? '{}').items ?? [];
      } catch {
        // битый JSON: вытаскиваем записи по шаблону
        for (const x of clean.matchAll(/"id"\s*:\s*(\d+)\s*,\s*"fixed"\s*:\s*"([^"]*)"(?:\s*,\s*"confidence"\s*:\s*"([^"]*)")?/g)) {
          items.push({ id: Number(x[1]), fixed: x[2], confidence: x[3] });
        }
      }
      const byId = new Map(items.map((it) => [it.id, it]));
      part.forEach((n, id) => {
        const it = byId.get(id);
        if (!it) return;
        const f = typeof it.fixed === 'string' ? it.fixed.trim() : '';
        let r: Spell = {};
        if (f && f !== n) {
          const limit = Math.max(2, Math.ceil([...n].length * 0.4)); // защита от выдуманных замен
          if (!ALLOWED.test(f)) r = {}; // правка лишь подменяет букву на особую (Самгар → Самғар): это не опечатка
          else r = check(f) === '' && dist(norm(n), norm(f)) <= limit ? { fixed: f } : { suspicious: true };
        } else if (it.confidence === 'low') {
          r = { suspicious: true };
        }
        answers.set(n, r);
      });
    } catch (e) {
      console.warn('Проверка написания: порция пропущена:', e instanceof Error ? e.message : e); // не ломаем основной конвейер
    }
  }
  return answers;
}

/** Для каждого имени: исправление (fixed), пометка «сомнительно» (suspicious, why) или пустой объект, если всё в порядке. */
export async function checkSpelling(names: string[], llmId?: string): Promise<Spell[]> {
  const shape = (n: string): Spell => { const why = shapeIssue(n); return why ? { suspicious: true, why } : {}; };
  const o = pickOption(llmId);
  if (!o) return names.map(shape); // LLM не настроена: работает только проверка по форме слова

  const out: Spell[] = names.map(() => ({}));
  const todo: number[] = [];
  names.forEach((n, i) => {
    const c = cache.get(`${o.id}|${n}`);
    if (c) out[i] = c; else todo.push(i);
  });

  const uniq = [...new Set(todo.map((i) => names[i]))];
  const lists = [uniq, [...uniq].reverse(), [...uniq].sort(() => Math.random() - 0.5)].slice(0, VOTES); // разный состав порций
  const passes: Map<string, Spell>[] = [];
  for (const l of lists) if (l.length) passes.push(await runPass(o, l));

  const answers = new Map<string, Spell>();
  for (const n of uniq) {
    const rs = passes.map((m) => m.get(n)).filter((r): r is Spell => !!r);
    const fixed = rs.find((r) => r.fixed);
    let r: Spell = fixed ? { fixed: fixed.fixed } : rs.some((r2) => r2.suspicious) ? { suspicious: true } : {};
    if (!r.fixed && !r.suspicious) r = shape(n);
    answers.set(n, r);
    if (rs.length) { // кэшируем только если модель ответила
      if (cache.size > 5000) cache.clear();
      cache.set(`${o.id}|${n}`, r);
    }
  }
  todo.forEach((i) => { out[i] = answers.get(names[i]) ?? {}; });
  return out;
}
