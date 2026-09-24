import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import { useDebouncedValue } from '../hooks/useDebouncedValue';
import type { RecordInput, RecordItem } from '../types';

const STATUSES = ['new', 'in_progress', 'done', 'archived'];
const EMPTY_FORM: RecordInput = { title: '', description: '', status: 'new', priority: 3 };

export default function DataPage() {
  const [records, setRecords] = useState<RecordItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const debouncedSearch = useDebouncedValue(search, 350);

  const [form, setForm] = useState<RecordInput>(EMPTY_FORM);
  const [busy, setBusy] = useState(false);

  const [editingId, setEditingId] = useState<number | null>(null);
  const [draft, setDraft] = useState<RecordInput>(EMPTY_FORM);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const page = await api.records({
        search: debouncedSearch || undefined,
        status: statusFilter || undefined,
        limit: 50,
      });
      setRecords(page.items);
      setTotal(page.total);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch, statusFilter]);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    if (!form.title.trim() || busy) return;
    setBusy(true);
    try {
      await api.createRecord({ ...form, title: form.title.trim(), priority: Number(form.priority) });
      setForm(EMPTY_FORM);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  function startEdit(record: RecordItem) {
    setEditingId(record.id);
    setDraft({
      title: record.title,
      description: record.description ?? '',
      status: record.status,
      priority: record.priority,
    });
  }

  async function saveEdit(record: RecordItem) {
    if (!draft.title.trim() || busy) return;
    setBusy(true);
    try {
      await api.updateRecord(record.id, {
        title: draft.title.trim(),
        description: draft.description || null,
        status: draft.status,
        priority: Number(draft.priority),
      });
      setEditingId(null);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(id: number) {
    if (!window.confirm('Видалити цей запис?')) return;
    setBusy(true);
    try {
      await api.deleteRecord(id);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div>
      <header className="page-head">
        <h1>Управління даними</h1>
        <p className="muted">CRUD над записами через data-сервіс (SQLite) · через API Gateway</p>
      </header>

      {error && <div className="banner error">⚠️ {error}</div>}

      <section className="card form-card">
        <h2>Новий запис</h2>
        <form onSubmit={handleCreate} className="form-grid">
          <input
            className="input"
            placeholder="Заголовок *"
            value={form.title}
            onChange={(e) => setForm({ ...form, title: e.target.value })}
            required
          />
          <textarea
            className="input"
            placeholder="Опис"
            rows={2}
            value={form.description ?? ''}
            onChange={(e) => setForm({ ...form, description: e.target.value })}
          />
          <select
            className="input"
            value={form.status}
            onChange={(e) => setForm({ ...form, status: e.target.value })}
          >
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <input
            className="input"
            type="number"
            min={1}
            max={5}
            placeholder="Пріоритет (1–5)"
            value={form.priority}
            onChange={(e) => setForm({ ...form, priority: Number(e.target.value) })}
          />
          <button className="btn primary" type="submit" disabled={busy || !form.title.trim()}>
            Створити
          </button>
        </form>
      </section>

      <section className="info-block">
        <div className="table-tools">
          <input
            className="input"
            placeholder="🔍 Пошук…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
          />
          <select
            className="input"
            value={statusFilter}
            onChange={(e) => setStatusFilter(e.target.value)}
          >
            <option value="">Усі статуси</option>
            {STATUSES.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
          <span className="muted">
            {total} записів{loading ? ' · завантаження…' : ''}
          </span>
        </div>

        <table className="table">
          <thead>
            <tr>
              <th>#</th>
              <th>Заголовок</th>
              <th>Опис</th>
              <th>Статус</th>
              <th>Пріоритет</th>
              <th>Оновлено</th>
              <th className="col-actions">Дії</th>
            </tr>
          </thead>
          <tbody>
            {records.map((record) =>
              editingId === record.id ? (
                <tr key={record.id} className="row-editing">
                  <td>{record.id}</td>
                  <td>
                    <input
                      className="input"
                      value={draft.title}
                      onChange={(e) => setDraft({ ...draft, title: e.target.value })}
                    />
                  </td>
                  <td>
                    <input
                      className="input"
                      value={draft.description ?? ''}
                      onChange={(e) => setDraft({ ...draft, description: e.target.value })}
                    />
                  </td>
                  <td>
                    <select
                      className="input"
                      value={draft.status}
                      onChange={(e) => setDraft({ ...draft, status: e.target.value })}
                    >
                      {STATUSES.map((s) => (
                        <option key={s} value={s}>
                          {s}
                        </option>
                      ))}
                    </select>
                  </td>
                  <td>
                    <input
                      className="input narrow"
                      type="number"
                      min={1}
                      max={5}
                      value={draft.priority}
                      onChange={(e) => setDraft({ ...draft, priority: Number(e.target.value) })}
                    />
                  </td>
                  <td>{new Date(record.updated_at).toLocaleString('uk-UA')}</td>
                  <td>
                    <div className="row-actions">
                      <button className="btn small" onClick={() => void saveEdit(record)} disabled={busy}>
                        Зберегти
                      </button>
                      <button className="btn small ghost" onClick={() => setEditingId(null)} disabled={busy}>
                        Скасувати
                      </button>
                    </div>
                  </td>
                </tr>
              ) : (
                <tr key={record.id}>
                  <td>{record.id}</td>
                  <td className="cell-title">{record.title}</td>
                  <td className="cell-desc muted">{record.description || '—'}</td>
                  <td>
                    <span className={`badge badge-${record.status}`}>{record.status}</span>
                  </td>
                  <td>{record.priority}</td>
                  <td className="muted">{new Date(record.updated_at).toLocaleString('uk-UA')}</td>
                  <td>
                    <div className="row-actions">
                      <button className="btn small" onClick={() => startEdit(record)} disabled={busy}>
                        Edit
                      </button>
                      <button
                        className="btn small danger"
                        onClick={() => void handleDelete(record.id)}
                        disabled={busy}
                      >
                        Del
                      </button>
                    </div>
                  </td>
                </tr>
              ),
            )}
            {records.length === 0 && !loading && (
              <tr>
                <td colSpan={7} className="muted center">
                  Жодного запису не знайдено
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  );
}