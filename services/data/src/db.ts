import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

export interface RecordRow {
  id: number;
  title: string;
  description: string | null;
  status: string;
  priority: number;
  created_at: string;
  updated_at: string;
}

export interface ListOptions {
  search?: string;
  status?: string;
  limit?: number;
  offset?: number;
}

export interface ListResult {
  items: RecordRow[];
  total: number;
  limit: number;
  offset: number;
}

function isoNow(): string {
  return new Date().toISOString();
}

/** Відкриває (та за потреби створює) базу даних із схемою та демо-даними. */
export function openDatabase(dbPath: string): Database.Database {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');

  // SQLite LIKE за замовчуванням реєструє лише ASCII-літери.
  // Реєструємо власну функцію locase() для коректного (unicode) пошуку.
  db.function('locase', (value: unknown) =>
    typeof value === 'string' ? value.toLowerCase() : value,
  );

  db.exec(`
    CREATE TABLE IF NOT EXISTS records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'new',
      priority INTEGER NOT NULL DEFAULT 3,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);
  seedIfEmpty(db);
  return db;
}

function seedIfEmpty(db: Database.Database): void {
  const { n } = db
    .prepare('SELECT COUNT(*) AS n FROM records')
    .get() as { n: number };
  if (n > 0) return;

  const insert = db.prepare(
    'INSERT INTO records (title, description, status, priority, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const seed: Array<[string, string, string, number]> = [
    ['Огляд архітектури платформи', 'Документація мікросервісної архітектури', 'done', 2],
    ['Налаштування Dependabot', 'Підключити npm, docker та github-actions екосистеми', 'in_progress', 1],
    ['Trivy-сканування образів', 'Додати сканування Docker-образів у CI', 'in_progress', 1],
    ['Дешборд: графіки CPU/RAM', 'Історія метрик на головній сторінці', 'new', 3],
    ['Резервне копіювання БД', 'Реалізувати щоденний бекап SQLite', 'new', 4],
    ['Тестування resilience', 'Перевірити поведінку при падінні сервісу', 'archived', 5],
  ];
  const now = isoNow();
  const tx = db.transaction(() => {
    for (const [title, description, status, priority] of seed) {
      insert.run(title, description, status, priority, now, now);
    }
  });
  tx();
}

export function listRecords(
  db: Database.Database,
  options: ListOptions = {},
): ListResult {
  const limit = Math.min(Math.max(options.limit ?? 50, 1), 100);
  const offset = Math.max(options.offset ?? 0, 0);

  const where: string[] = [];
  const params: unknown[] = [];

  if (options.search) {
    where.push('(locase(title) LIKE ? OR locase(description) LIKE ?)');
    const like = `%${options.search.toLowerCase()}%`;
    params.push(like, like);
  }
  if (options.status) {
    where.push('status = ?');
    params.push(options.status);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  const { n: total } = db
    .prepare(`SELECT COUNT(*) AS n FROM records ${whereSql}`)
    .get(...params) as { n: number };

  const items = db
    .prepare(
      `SELECT * FROM records ${whereSql} ORDER BY id DESC LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as RecordRow[];

  return { items, total, limit, offset };
}

export function getRecord(db: Database.Database, id: number): RecordRow | null {
  const row = db.prepare('SELECT * FROM records WHERE id = ?').get(id) as
    | RecordRow
    | undefined;
  return row ?? null;
}

export function insertRecord(
  db: Database.Database,
  input: { title: string; description?: string | null; status?: string; priority?: number },
): RecordRow {
  const now = isoNow();
  const info = db
    .prepare(
      'INSERT INTO records (title, description, status, priority, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .run(
      input.title,
      input.description ?? null,
      input.status ?? 'new',
      input.priority ?? 3,
      now,
      now,
    );
  return getRecord(db, Number(info.lastInsertRowid)) as RecordRow;
}

export function updateRecord(
  db: Database.Database,
  id: number,
  patch: { title?: string; description?: string | null; status?: string; priority?: number },
): RecordRow | null {
  const existing = getRecord(db, id);
  if (!existing) return null;

  const title = patch.title ?? existing.title;
  const description =
    patch.description !== undefined ? patch.description : existing.description;
  const status = patch.status ?? existing.status;
  const priority = patch.priority ?? existing.priority;

  db.prepare(
    'UPDATE records SET title = ?, description = ?, status = ?, priority = ?, updated_at = ? WHERE id = ?',
  ).run(title, description, status, priority, isoNow(), id);

  return getRecord(db, id);
}

export function deleteRecord(db: Database.Database, id: number): boolean {
  return db.prepare('DELETE FROM records WHERE id = ?').run(id).changes > 0;
}