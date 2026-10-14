const VOWELS = 'аеёиоуыэюяөүАЕЁИОУЫЭЮЯӨҮ'; // ө, ү — кыргызские гласные
/** Ниже этой уверенности запись попадает во вкладку «Неуверенные» */
export const CONF_THRESHOLD = 0.7;
export const isVowel = (c: string) => VOWELS.includes(c);

// ' стоит после ударной буквы (только для словаря-заглушки)
const SRC =
  "Алекса'ндр Анастаси'я Дми'трий Екатери'на Мари'я Серге'й Андре'й О'льга Татья'на Никола'й Еле'на Влади'мир Светла'на Ири'на Миха'ил Ю'лия Па'вел Арте'м Окса'на Ники'та Васи'лий Анто'н Любо'вь Васили'са Макси'м И'горь Ната'лья Людми'ла Ге'ннадий Ефи'м Зинаи'да Ку'зьма Бори'с Да'рья Яросла'в Ки'рилл Ли'дия Фё'дор Пё'тр Ана'толий Валенти'на Га'лина Ле'в Ра'иса";
export const DICT: Record<string, number> = {};
SRC.split(' ').forEach((w) => (DICT[w.replace("'", '')] = w.indexOf("'") - 1));
export const POOL = Object.keys(DICT).concat(['Мирослава', 'Радомир', 'Всеволод', 'Эльвира', 'Тимур', 'Анна-Мария', 'Святослав', 'Глафира']);

/** Техническая проверка имени. Пустая строка = всё хорошо. */
export function check(raw: string): string {
  const r = raw.trim();
  if (!r) return 'пустая строка';
  if (/[A-Za-z]/.test(r)) return 'латинские буквы';
  if (/["'«»“”()\[\]{}<>]/.test(r)) return 'кавычки/скобки/теги';
  if (/\d/.test(r)) return 'цифры';
  if (!/^[А-ЯЁа-яёӨөҮүҢң]+(?:[- ][А-ЯЁа-яёӨөҮүҢң]+)*$/.test(r) || r.length > 60) return 'недопустимые символы';
  return '';
}

/** Эвристика-заглушка вместо LLM */
export function guess(n: string): { stress: number[]; conf: number } {
  if (DICT[n] !== undefined) return { stress: [DICT[n]], conf: 0.98 };
  const ch = [...n];
  const vs = ch.map((c, k) => (isVowel(c) ? k : -1)).filter((k) => k >= 0);
  const yo = ch.findIndex((c) => c === 'ё' || c === 'Ё');
  if (yo >= 0) return { stress: [yo], conf: 0.95 };
  if (vs.length === 1) return { stress: [vs[0]], conf: 0.97 };
  if (!vs.length) return { stress: [], conf: 0.3 };
  return { stress: [vs[vs.length - 2]], conf: 0.55 + Math.random() * 0.2 };
}

/** Ударение: «+» перед каждой ударной буквой, например +Ольга или +Анна-Мар+ия */
export function fmtName(n: string, stress: number[]): string {
  return [...n].map((c, k) => (stress.includes(k) ? '+' + c : c)).join('');
}
