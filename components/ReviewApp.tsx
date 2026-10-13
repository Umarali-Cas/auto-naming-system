'use client';
import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { fmtName, isVowel } from '@/lib/stress';
import type { Item, Person } from '@/lib/types';

type Tab = 'review' | 'uncertain' | 'invalid' | 'history';
const JSON_HEADERS = { 'Content-Type': 'application/json' };
const PAGE = 50;
type Opt = { id: string; label: string };

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
  const [opts, setOpts] = useState<Opt[]>([]);
  const [llm, setLlm] = useState('');
  const [error, setError] = useState('');
  const [newName, setNewName] = useState('');
  const [multi, setMulti] = useState(false);

  const upd = (ids: number[], f: (p: Person) => Partial<Person>) => setP((a) => a.map((p) => (ids.includes(p.id) ? { ...p, ...f(p) } : p)));
  const by = (...s: Person['status'][]) => P.filter((p) => s.includes(p.status));
  const R = by('review'), U = by('uncertain'), E = by('invalid'), H = by('sent', 'sending', 'rejected').reverse();

  async function call<T>(url: string, init?: RequestInit): Promise<T | null> {
    const r = await fetch(url, init);
    if (r.status === 401) { router.replace('/login'); return null; }
    const j = (await r.json().catch(() => ({}))) as { error?: string };
    if (!r.ok) { setError(j.error ?? 'Ошибка запроса'); return null; }
    setError('');
    return j as T;
  }

  async function load(model = llm) {
    setBusy('Загрузка и обработка…');
    try {
      const j = await call<{ items: Item[] }>('/api/names?llm=' + encodeURIComponent(model));
      if (!j) return;
      if (!Array.isArray(j.items)) { setError('Неожиданный ответ /api/names'); return; }
      setP((a) => [...a, ...j.items.map((i) => ({ ...i, id: nid.current++ }))]);
    } finally { setBusy(''); }
  }

  // первая пачка грузится автоматически при открытии страницы
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      const j = await call<{ options: Opt[]; default: string }>('/api/llm');
      if (!j) return;
      setOpts(j.options);
      let id = j.default;
      try { const saved = localStorage.getItem('llm'); if (saved && j.options.some((o) => o.id === saved)) id = saved; } catch { /* нет доступа к storage */ }
      setLlm(id);
      await load(id);
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  async function accept(ids: number[]) {
    const it = P.filter((p) => ids.includes(p.id) && (p.status === 'review' || p.status === 'uncertain'));
    if (!it.length) return;
    const out = new Map(it.map((p) => [p.id, fmtName(p.raw, p.stress)]));
    upd(it.map((p) => p.id), (p) => ({ status: 'sending', out: out.get(p.id) }));
    setSel(new Set());
    const body = JSON.stringify({ items: it.map((p) => ({ id: p.id, name: p.raw, accented: out.get(p.id) })) });
    const r = await fetch('/api/send', { method: 'POST', headers: JSON_HEADERS, body });
    const j = (await r.json().catch(() => ({}))) as { status?: number };
    upd(it.map((p) => p.id), (p) => ({ status: r.ok ? 'sent' : p.stress.length === 0 || p.conf >= 0.7 ? 'review' : 'uncertain', http: j.status }));
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

  /** Ошибки: исправленное корректное имя уходит в API (пока заглушка /api/send) и исчезает из списка. */
  async function fix(p: Person, v: string) {
    const j = await call<{ items: Item[] }>('/api/process', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ names: [v], llm }) });
    const it = j?.items[0];
    if (!it) return;
    if (it.status === 'invalid') { upd([p.id], () => ({ raw: it.raw, reason: it.reason })); return; }
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
      setP((a) => [...j.items.map((i) => ({ ...i, id: nid.current++ })), ...a]);
      setNewName('');
      switchTab(j.items[0].status === 'invalid' ? 'invalid' : j.items[0].status === 'uncertain' ? 'uncertain' : 'review');
    } finally { setBusy(''); }
  }

  async function logout() {
    await fetch('/api/auth/logout', { method: 'POST' });
    router.replace('/login'); router.refresh();
  }

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

  return (
    <main className="w">
      <header className="top">
        <div><h1>Расстановка ударений в именах</h1><div className="mu">Демо: сервер и LLM заменены заглушками</div></div>
        <div className="mu">{email} <button className="link" onClick={logout}>Выйти</button></div>
      </header>

      <div className="bar">
        <button className="b p" onClick={() => load()} disabled={!!busy || !llm}>Обновить</button>
        <label className="mu">Модель{' '}
          <select value={llm} onChange={(e) => { setLlm(e.target.value); try { localStorage.setItem('llm', e.target.value); } catch { /* ignore */ } }}>
            {opts.map((o) => <option key={o.id} value={o.id}>{o.label}</option>)}
          </select>
        </label>
        <label className="mu"><input type="checkbox" checked={multi} onChange={(e) => setMulti(e.target.checked)} /> Несколько ударений (или Shift+клик)</label>
        <span className="mu">{busy}</span>
        {opts.length === 1 && <span className="mu">Ключ LLM не задан: работает заглушка. Добавьте GROQ_API_KEY в .env.local.</span>}
      </div>
      {error && <div className="er" role="alert" style={{ marginBottom: 8 }}>{error}</div>}
      <form className="bar" onSubmit={(e) => { e.preventDefault(); addName(); }}>
        <input className="t" style={{ maxWidth: 260 }} placeholder="Добавить имя вручную" aria-label="Добавить имя вручную" value={newName} onChange={(e) => setNewName(e.target.value)} />
        <button className="b" disabled={!!busy || !llm || !newName.trim()}>Добавить</button>
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
            {!isReview && <div className="mu" style={{ marginBottom: 8 }}>Модель не уверена в этих ударениях. Поправьте вручную (клик по гласной) или примите как есть.</div>}
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
                      <td>{p.raw}</td>
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
