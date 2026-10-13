'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { fmtName, isVowel } from '@/lib/stress';
import type { Item, Person } from '@/lib/types';

type Tab = 'review' | 'uncertain' | 'invalid' | 'history';
const JSON_HEADERS = { 'Content-Type': 'application/json' };
const PAGE = 50; // записей на странице
const STEP = 30; // имён в одном запросе к LLM
const GIVE_UP_MS = 5 * 60e3; // если 5 минут нет ни одного успешного ответа, останавливаемся
const UNPROCESSED = 'Не обработано';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
type Opt = { id: string; label: string };
type Prog = { done: number; total: number; label: string };

function Letters({ p, onPick }: { p: Person; onPick: (id: number, i: number, add: boolean) => void }) {
  return (
    <>
      {[...p.raw].map((c, k) => {
        if (!isVowel(c)) return <span key={k}>{c}</span>;
        const on = p.stress.includes(k);
        return (
          <b key={k} className={'v' + (on ? ' on' : '')} onClick={(e) => onPick(p.id, k, e.shiftKey || e.ctrlKey || e.metaKey)}>
            {on ? '+' : ''}{c}
          </b>
        );
      })}
    </>
  );
}

function Pager({ page, pages, total, onPage }: { page: number; pages: number; total: number; onPage: (n: number) => void }) {
  if (pages <= 1) return null;
  return (
    <div className="pager">
      <button className="b" disabled={page <= 1} onClick={() => onPage(page - 1)}>Назад</button>
      <span className="mu">Страница {page} из {pages}, всего записей: {total}</span>
      <button className="b" disabled={page >= pages} onClick={() => onPage(page + 1)}>Вперёд</button>
    </div>
  );
}

function ErrRow({ p, onFix, onDel }: { p: Person; onFix: (v: string) => Promise<void>; onDel: () => void }) {
  const [v, setV] = useState(p.raw);
  const [busy, setBusy] = useState(false);
  return (
    <tr>
      <td><input className="t" value={v} onChange={(e) => setV(e.target.value)} aria-label="Исправить значение" /></td>
      <td className="er">{p.reason}</td>
      <td className="nw">
        <button className="b p" disabled={busy} onClick={async () => { setBusy(true); await onFix(v); setBusy(false); }}>Исправить</button>{' '}
        <button className="b dn" disabled={busy} onClick={onDel}>Удалить</button>
      </td>
    </tr>
  );
}

export default function ReviewApp({ email }: { email: string }) {
  const router = useRouter();
  const nid = useRef(1);
  const started = useRef(false);
  const [P, setP] = useState<Person[]>([]);
  const [tab, setTab] = useState<Tab>('review');
  const [pages, setPages] = useState<Record<Tab, number>>({ review: 1, uncertain: 1, invalid: 1, history: 1 });
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState('');
  const [prog, setProg] = useState<Prog | null>(null);
  const [opts, setOpts] = useState<Opt[]>([]);
  const [llm, setLlm] = useState('');
  const [llm2, setLlm2] = useState(''); // вторая модель (необязательно): пачка делится между двумя
  const [error, setError] = useState('');
  const [note, setNote] = useState(''); // спокойное сообщение: ждём лимит модели
  const [newName, setNewName] = useState('');
  const [multi, setMulti] = useState(false);

  const upd = (ids: number[], f: (p: Person) => Partial<Person>) => setP((a) => a.map((p) => (ids.includes(p.id) ? { ...p, ...f(p) } : p)));
  const by = (...s: Person['status'][]) => P.filter((p) => s.includes(p.status));
  const R = by('review'), U = by('uncertain'), E = by('invalid'), H = by('sent', 'sending', 'rejected').reverse();
  const unproc = E.filter((p) => p.reason?.startsWith(UNPROCESSED));
  const add = (items: Item[]) => {
    const withIds: Person[] = items.map((i) => ({ ...i, id: nid.current++ }));
    setP((a) => [...a, ...withIds]);
  };

  async function call<T>(url: string, init?: RequestInit): Promise<T | null> {
    for (let attempt = 0; ; attempt++) {
      const r = await fetch(url, init);
      if (r.status === 401) { router.replace('/login'); return null; }
      const j = (await r.json().catch(() => ({}))) as { error?: string; retryable?: boolean; retryAfterMs?: number };
      if (r.ok) { setError(''); setNote(''); return j as T; }
      if (j.retryable && attempt < 4) { // лимит или перегрузка: ждём и повторяем сами
        const wait = Math.min(Math.max(j.retryAfterMs ?? 5000, 3000), 30000);
        setNote(`Лимит модели, повтор через ${Math.ceil(wait / 1000)} с…`);
        await sleep(wait);
        continue;
      }
      setNote('');
      setError(j.error ?? 'Ошибка запроса');
      return null;
    }
  }

  /** Один запрос на обработку порции имён выбранной моделью. */
  async function proc(names: string[], model: string): Promise<{ items?: Item[]; error?: string; unauthorized?: boolean; retryable?: boolean; retryAfterMs?: number }> {
    try {
      const r = await fetch('/api/process', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ names, llm: model }) });
      if (r.status === 401) { router.replace('/login'); return { error: 'Требуется вход', unauthorized: true }; }
      const j = (await r.json().catch(() => ({}))) as { items?: Item[]; error?: string; retryable?: boolean; retryAfterMs?: number };
      if (r.ok && Array.isArray(j.items)) return { items: j.items };
      // 502/504 от платформы (таймаут функции) тоже считаем временными
      return { error: j.error ?? `Ошибка запроса (${r.status})`, retryable: j.retryable ?? (r.status === 504 || r.status === 502 && !j.error), retryAfterMs: j.retryAfterMs };
    } catch {
      return { error: 'Нет связи с сервером', retryable: true, retryAfterMs: 5000 };
    }
  }

  /**
   * Общая очередь порций. Каждая выбранная модель берёт следующую порцию, как только свободна,
   * поэтому пачка делится между двумя моделями. При временной ошибке (лимит, перегрузка) порция возвращается
   * в очередь, модель делает паузу и пробует снова, а пока её может забрать другая модель.
   * Остановка только при постоянной ошибке (неверный ключ, нет модели) или если 5 минут нет ни одного успеха.
   */
  async function runQueue(names: string[], models: string[], options: Opt[]) {
    const queue: string[][] = [];
    for (let k = 0; k < names.length; k += STEP) queue.push(names.slice(k, k + STEP));
    const total = names.length;
    const counts: Record<string, number> = Object.fromEntries(models.map((m) => [m, 0]));
    const errs = new Set<string>();
    const label = (id: string) => options.find((o) => o.id === id)?.label ?? id;
    let done = 0;
    let lastOk = Date.now();
    let unauthorized = false;
    const report = () => setProg({ done, total, label: models.map((m) => `${label(m)}: ${counts[m]}`).join('    ') });
    setBusy('LLM обрабатывает пачку…');
    report();

    const worker = async (model: string) => {
      while (queue.length && !unauthorized) {
        const chunk = queue.shift()!;
        const r = await proc(chunk, model);
        if (r.unauthorized) { unauthorized = true; return; }
        if (r.items) {
          lastOk = Date.now();
          add(r.items);
          done += chunk.length;
          counts[model] += chunk.length;
          setNote('');
          report();
          continue;
        }
        queue.unshift(chunk); // порцию может взять другая модель
        if (r.retryable && Date.now() - lastOk < GIVE_UP_MS) {
          const wait = Math.min(Math.max(r.retryAfterMs ?? 5000, 3000), 60000);
          setNote(`${label(model)}: лимит или перегрузка, пауза ${Math.ceil(wait / 1000)} с, затем повтор`);
          await sleep(wait);
          continue;
        }
        errs.add(`${label(model)}: ${r.error}`);
        return;
      }
    };
    await Promise.all(models.map(worker));

    if (queue.length && !unauthorized) { // отказали все модели: необработанные не теряем
      add(queue.flat().map((raw) => ({ raw, status: 'invalid' as const, stress: [], conf: 0, reason: `${UNPROCESSED}: LLM недоступна. Нажмите «Повторить необработанные» во вкладке «Ошибки»` })));
    }
    setNote('');
    setError([...errs].join('\n'));
  }

  async function load(m1 = llm, m2 = llm2, options = opts) {
    setBusy('Получение имён…');
    setProg({ done: 0, total: 0, label: '' });
    try {
      const j = await call<{ names?: string[]; items?: Item[] }>('/api/names?llm=' + encodeURIComponent(m1));
      if (!j) return;
      if (Array.isArray(j.items)) { add(j.items); return; } // прежний формат ответа: имена уже обработаны на сервере
      if (!Array.isArray(j.names)) { setError('Неожиданный ответ /api/names'); return; }
      await runQueue(j.names, [...new Set([m1, m2].filter(Boolean))], options);
    } finally { setBusy(''); setProg(null); }
  }

  /** Повторная обработка записей, которые не удалось обработать (лимиты, недоступность LLM). */
  async function retryUnprocessed() {
    if (working || !unproc.length) return;
    const names = unproc.map((p) => p.raw);
    setP((a) => a.filter((p) => !(p.status === 'invalid' && p.reason?.startsWith(UNPROCESSED))));
    setBusy('LLM обрабатывает пачку…');
    setProg({ done: 0, total: names.length, label: '' });
    try { await runQueue(names, [...new Set([llm, llm2].filter(Boolean))], opts); }
    finally { setBusy(''); setProg(null); }
  }

  // первая пачка грузится автоматически при открытии страницы
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      const j = await call<{ options: Opt[]; default: string; default2?: string }>('/api/llm');
      if (!j) return;
      setOpts(j.options);
      const ok = (id: string | null) => !!id && j.options.some((o) => o.id === id);
      let id = j.default, id2 = j.default2 ?? '';
      try {
        const s1 = localStorage.getItem('llm'), s2 = localStorage.getItem('llm2');
        if (ok(s1)) id = s1!;
        if (s2 !== null && (s2 === '' || ok(s2))) id2 = s2;
      } catch { /* нет доступа к storage */ }
      setLlm(id); setLlm2(id2);
      await load(id, id2, j.options);
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function accept(ids: number[]) {
    const it = P.filter((p) => ids.includes(p.id) && (p.status === 'review' || p.status === 'uncertain'));
    if (!it.length) return;
    const out = new Map(it.map((p) => [p.id, fmtName(p.raw, p.stress)]));
    upd(it.map((p) => p.id), (p) => ({ status: 'sending', out: out.get(p.id) }));
    setSel(new Set());
    const body = JSON.stringify({ items: it.map((p) => ({ id: p.id, name: p.raw, original: p.original, accented: out.get(p.id) })) });
    const r = await fetch('/api/send', { method: 'POST', headers: JSON_HEADERS, body });
    const j = (await r.json().catch(() => ({}))) as { status?: number };
    upd(it.map((p) => p.id), (p) => ({ status: r.ok ? 'sent' : p.original || (p.stress.length > 0 && p.conf < 0.7) ? 'uncertain' : 'review', http: j.status }));
  }

  /** Клик по гласной: ударение «перескакивает». Shift/Ctrl+клик или режим «несколько ударений» добавляет/убирает ещё одно. */
  const pick = (id: number, i: number, add: boolean) => upd([id], (q) => {
    const has = q.stress.includes(i);
    const many = add || multi;
    const next = many
      ? (has ? q.stress.filter((x) => x !== i) : [...q.stress, i].sort((a, b) => a - b))
      : (has && q.stress.length === 1 ? [] : [i]);
    return { stress: next, conf: 1 };
  });

  // все кнопки «Удалить» проходят через подтверждение
  const reject = (ids: number[]) => {
    if (!ids.length) return;
    const msg = ids.length === 1 ? 'Удалить эту запись?' : `Удалить записи: ${ids.length} шт.?`;
    if (!window.confirm(`${msg}\nОни уйдут в «История» со статусом «удалено».`)) return;
    upd(ids, () => ({ status: 'rejected' }));
    setSel(new Set());
  };

  /**
   * Ошибки: исправленное корректное имя уходит в API (пока заглушка /api/send) и исчезает из списка.
   * Если система нашла в нём опечатку и исправила по словарю, запись идёт в «Неуверенные» на проверку человеком.
   */
  async function fix(p: Person, v: string) {
    const j = await call<{ items: Item[] }>('/api/process', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ names: [v], llm }) });
    const it = j?.items[0];
    if (!it) return;
    if (it.status === 'invalid') { upd([p.id], () => ({ raw: it.raw, reason: it.reason })); return; }
    if (it.original) { upd([p.id], () => ({ ...it, reason: undefined })); return; }
    const out = fmtName(it.raw, it.stress);
    upd([p.id], () => ({ ...it, reason: undefined, status: 'sending', out, fixed: true }));
    const r = await fetch('/api/send', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ items: [{ id: p.id, name: it.raw, accented: out }] }) });
    const s = (await r.json().catch(() => ({}))) as { status?: number };
    upd([p.id], () => (r.ok ? { status: 'sent', http: s.status } : { status: 'invalid', reason: 'Не удалось отправить, повторите' }));
  }

  /** Ручное добавление имени: проходит тот же путь (проверка, LLM), что и имена с сервера. */
  async function addName() {
    const v = newName.trim();
    if (!v) return;
    setBusy('Обработка…');
    try {
      const j = await call<{ items: Item[] }>('/api/process', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ names: [v], llm }) });
      if (!j) return;
      const withIds: Person[] = j.items.map((i) => ({ ...i, id: nid.current++ }));
      setP((a) => [...withIds, ...a]);
      setNewName('');
      switchTab(withIds[0].status === 'invalid' ? 'invalid' : withIds[0].status === 'uncertain' ? 'uncertain' : 'review');
    } finally { setBusy(''); }
  }

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.replace('/login'); router.refresh();
  }

  const saveModel = (key: 'llm' | 'llm2', v: string) => { try { localStorage.setItem(key, v); } catch { /* ignore */ } };
  const tabs: [Tab, string, number][] = [['review', 'На проверку', R.length], ['uncertain', 'Неуверенные', U.length], ['invalid', 'Ошибки', E.length], ['history', 'История', H.length]];
  const cur = { review: R, uncertain: U, invalid: E, history: H }[tab];
  const total = cur.length;
  const n = Math.max(1, Math.ceil(total / PAGE));
  const pg = Math.min(pages[tab], n);
  const rows = cur.slice((pg - 1) * PAGE, pg * PAGE);
  const pager = <Pager page={pg} pages={n} total={total} onPage={(x) => setPages((s) => ({ ...s, [tab]: x }))} />;
  const switchTab = (k: Tab) => { setTab(k); setSel(new Set()); };
  const toggleRow = (id: number, on: boolean) => setSel((s) => { const m = new Set(s); if (on) m.add(id); else m.delete(id); return m; });
  const isReview = tab === 'review';
  const working = !!busy || !!prog;

  return (
    <main className="w">
      <header className="top">
        <div><h1>Расстановка ударений в именах</h1><div className="mu">Демо: сервер заменён заглушкой</div></div>
        <div className="mu">{email} <button className="link" onClick={logout}>Выйти</button></div>
      </header>

      <div className="bar">
        <button className="b p" onClick={() => load()} disabled={working || !llm}>Обновить</button>
        <label className="mu">Модель 1{' '}
          <select value={llm} onChange={(e) => { setLlm(e.target.value); saveModel('llm', e.target.value); }}>
            {opts.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        </label>
        {opts.length > 1 && (
          <label className="mu">Модель 2{' '}
            <select value={llm2} onChange={(e) => { setLlm2(e.target.value); saveModel('llm2', e.target.value); }}>
              <option value="">без второй модели</option>
              {opts.filter((o) => o.id !== llm).map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
            </select>
          </label>
        )}
        <label className="mu"><input type="checkbox" checked={multi} onChange={(e) => setMulti(e.target.checked)} /> Несколько ударений (или Shift+клик)</label>
        {opts.length === 1 && <span className="mu">Ключ LLM не задан: работает заглушка. Добавьте ключ в настройки окружения (см. .env.example).</span>}
      </div>

      {working && (
        <div className="prog" role="status" aria-live="polite">
          <div className="prog-top">
            <span><i className="dot" />{busy || 'Обработка…'}</span>
            {prog && prog.total > 0 && <span className="mu">{prog.done} из {prog.total}</span>}
          </div>
          <div className="track"><div className={'fill' + (prog && prog.total > 0 ? '' : ' ind')} style={prog && prog.total > 0 ? { width: `${Math.round((prog.done / prog.total) * 100)}%` } : undefined} /></div>
          {prog?.label && <div className="mu">{prog.label}</div>}
          {note && <div className="mu">{note}</div>}
        </div>
      )}
      {error && <div className="er" role="alert" style={{ marginBottom: 8, whiteSpace: 'pre-line' }}>{error}</div>}

      <form className="bar" onSubmit={(e) => { e.preventDefault(); addName(); }}>
        <input className="t" style={{ maxWidth: 260 }} placeholder="Добавить имя вручную" aria-label="Добавить имя вручную" value={newName} onChange={(e) => setNewName(e.target.value)} />
        <button className="b" disabled={working || !llm || !newName.trim()}>Добавить</button>
      </form>

      <div className="tabs" role="tablist">
        {tabs.map(([k, label, c]) => (
          <button key={k} role="tab" aria-selected={tab === k} className={'tab' + (tab === k ? ' on' : '')} onClick={() => switchTab(k)}>
            {label}<span className="n">{c}</span>
          </button>
        ))}
      </div>

      <div style={{ marginTop: 12 }}>
        {(tab === 'review' || tab === 'uncertain') && (
          <>
            <div className="bar">
              <button className="b ok" disabled={!total} onClick={() => accept(cur.map((p) => p.id))}>{isReview ? 'Принять пачку' : 'Принять все'} ({total})</button>
              <button className="b dn" disabled={!total} onClick={() => reject(cur.map((p) => p.id))}>{isReview ? 'Удалить пачку' : 'Удалить все'}</button>
              <button className="b" disabled={!sel.size} onClick={() => accept([...sel])}>Принять выбранные ({sel.size})</button>
              <button className="b dn" disabled={!sel.size} onClick={() => reject([...sel])}>Удалить выбранные</button>
            </div>
            {!isReview && <div className="mu" style={{ marginBottom: 8 }}>Здесь записи, в которых модель не уверена, и имена с возможной опечаткой: для них система предложила исправление по словарю (написано под исходным значением). Проверьте написание и ударение, поправьте клик по гласной или примите.</div>}
            {total ? (
              <>
                <div className="card"><table>
                  <thead><tr>
                    <th><input type="checkbox" aria-label="Выбрать всю страницу" checked={rows.length > 0 && rows.every((p) => sel.has(p.id))} onChange={(e) => rows.forEach((p) => toggleRow(p.id, e.target.checked))} /></th>
                    <th>Исходное</th><th>Ударение (клик по гласной)</th><th>Уйдёт на сервер</th><th>Уверенность</th><th />
                  </tr></thead>
                  <tbody>{rows.map((p) => (
                    <tr key={p.id}>
                      <td><input type="checkbox" aria-label={`Выбрать ${p.raw}`} checked={sel.has(p.id)} onChange={(e) => toggleRow(p.id, e.target.checked)} /></td>
                      <td>{p.original ?? p.raw}{p.note && <div className="note">{p.note}</div>}</td>
                      <td className="nm pick"><Letters p={p} onPick={pick} /></td>
                      <td className="mono">{fmtName(p.raw, p.stress)}</td>
                      <td className="mu">{Math.round(p.conf * 100)}%</td>
                      <td className="nw"><button className="b ok sm" onClick={() => accept([p.id])}>Принять</button> <button className="b dn sm" onClick={() => reject([p.id])}>Удалить</button></td>
                    </tr>))}</tbody>
                </table></div>
                {pager}
              </>
            ) : <div className="empty">{isReview ? 'Нет записей на проверку. Нажмите «Обновить», чтобы получить новые.' : 'Неуверенных записей нет.'}</div>}
          </>
        )}

        {tab === 'invalid' && (total ? (
          <>
            {unproc.length > 0 && (
              <div className="bar"><button className="b p" disabled={working} onClick={retryUnprocessed}>Повторить необработанные ({unproc.length})</button></div>
            )}
            <div className="card"><table>
              <thead><tr><th>Значение (можно править)</th><th>Причина</th><th /></tr></thead>
              <tbody>{rows.map((p) => <ErrRow key={p.id + p.raw} p={p} onFix={(v) => fix(p, v)} onDel={() => reject([p.id])} />)}</tbody>
            </table></div>
            {pager}
          </>
        ) : <div className="empty">Ошибок нет.</div>)}

        {tab === 'history' && (total ? (
          <>
            <div className="card"><table>
              <thead><tr><th>Имя</th><th>Статус</th><th>Запрос</th></tr></thead>
              <tbody>{rows.map((p) => (
                <tr key={p.id}>
                  <td className="nm">{p.out ?? p.raw}</td>
                  <td>
                    {p.status === 'rejected' ? <span className="er">удалено</span> : p.status === 'sending' ? 'отправка…' : <span className="okc">отправлено</span>}
                    {p.fixed && p.status !== 'rejected' && <span className="mu"> (исправлено вручную)</span>}
                  </td>
                  <td className="mono mu">{p.status === 'sent' ? `POST /posts → ${p.http}` : ''}</td>
                </tr>))}</tbody>
            </table></div>
            {pager}
          </>
        ) : <div className="empty">Пока пусто.</div>)}
      </div>
    </main>
  );
}
