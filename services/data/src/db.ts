import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import type {
  CreateProjectInput,
  CreateTaskInput,
  PersistedProjectStatus,
  TaskStatus,
  UpdateProjectInput,
  UpdateTaskInput,
} from './schema';

export interface ProjectRow {
  id: number;
  name: string;
  description: string | null;
  status: PersistedProjectStatus;
  priority: number;
  owner: string | null;
  due_date: string | null;
  created_at: string;
  updated_at: string;
}

export interface TaskRow {
  id: number;
  project_id: number;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: number;
  assignee: string | null;
  due_date: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProjectSummary extends ProjectRow {
  task_count: number;
  completed_task_count: number;
  progress_percent: number;
}

export interface ListProjectsOptions {
  search?: string;
  status?: PersistedProjectStatus;
  limit?: number;
  offset?: number;
}

export interface ListProjectsResult {
  items: ProjectSummary[];
  total: number;
  limit: number;
  offset: number;
}

export interface ListTasksOptions {
  search?: string;
  status?: TaskStatus;
  limit?: number;
  offset?: number;
}

export interface ListTasksResult {
  items: TaskRow[];
  total: number;
  limit: number;
  offset: number;
}

interface LegacyColumnInfo {
  name: string;
}

interface LegacyRecord {
  id: number;
  title: string;
  description: string | null;
  status: string;
  priority: number;
  created_at: string;
  updated_at: string;
}

interface SqliteError extends Error {
  code?: string;
}

const DATABASE_VERSION = 1;
const MIGRATION_TABLE = 'app_schema_migrations';
const LEGACY_MIGRATION_TABLE = 'app_legacy_record_migrations';

const LEGACY_STATUS_MAP: Readonly<Record<string, PersistedProjectStatus>> = {
  new: 'planned',
  in_progress: 'active',
  done: 'completed',
  archived: 'archived',
};

const PROJECT_WITH_PROGRESS_SELECT = `
  SELECT
    p.*,
    COUNT(t.id) AS task_count,
    COALESCE(SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END), 0)
      AS completed_task_count,
    CASE
      WHEN COUNT(t.id) = 0 THEN 0
      ELSE ROUND(100.0 * SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END)
        / COUNT(t.id), 2)
    END AS progress_percent
  FROM projects p
  LEFT JOIN tasks t ON t.project_id = p.id
`;

function isoNow(): string {
  return new Date().toISOString();
}

function nextUpdatedAt(previous: string): string {
  const now = Date.now();
  const previousTime = Date.parse(previous);

  if (!Number.isFinite(previousTime)) return new Date(now).toISOString();

  const candidate = now > previousTime ? now : previousTime + 1;
  return new Date(candidate).toISOString();
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

function normalizeLegacyPriority(value: unknown): number {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') {
    return 3;
  }
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) return 3;
  return Math.min(Math.max(Math.trunc(numeric), 1), 5);
}

function normalizeLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return 50;
  return Math.min(Math.max(Math.trunc(limit), 1), 100);
}

function normalizeOffset(offset: number | undefined): number {
  if (offset === undefined || !Number.isFinite(offset)) return 0;
  return Math.max(Math.trunc(offset), 0);
}

function normalizeTaskLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return 50;
  return Math.min(Math.max(Math.trunc(limit), 1), 200);
}

function tableExists(db: Database.Database, tableName: string): boolean {
  const row = db
    .prepare(
      `SELECT 1 AS present
       FROM sqlite_master
       WHERE type = 'table' AND name = ?`,
    )
    .get(tableName) as { present: number } | undefined;

  return row?.present === 1;
}

function migrateLegacyRecords(db: Database.Database): void {
  if (!tableExists(db, 'records')) return;

  const columns = db.pragma('table_info(records)') as LegacyColumnInfo[];
  const { count } = db
    .prepare('SELECT COUNT(*) AS count FROM records')
    .get() as { count: number };

  if (count === 0) return;

  const requiredColumns = [
    'id',
    'title',
    'description',
    'status',
    'priority',
    'created_at',
    'updated_at',
  ];
  const columnNames = new Set(columns.map((column) => column.name));
  const missingColumns = requiredColumns.filter((name) => !columnNames.has(name));

  if (missingColumns.length > 0) {
    throw new Error(
      `Cannot migrate legacy records table; missing columns: ${missingColumns.join(', ')}`,
    );
  }

  const records = db
    .prepare(
      `SELECT id, title, description, status, priority, created_at, updated_at
       FROM records
       ORDER BY id`,
    )
    .all() as LegacyRecord[];
  const insertProject = db.prepare(
    `INSERT INTO projects
       (id, name, description, status, priority, owner, due_date, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, ?)`,
  );
  const findProject = db.prepare('SELECT * FROM projects WHERE id = ?');
  const findLegacyMigration = db.prepare(
    `SELECT legacy_id FROM ${LEGACY_MIGRATION_TABLE} WHERE legacy_id = ?`,
  );
  const recordLegacyMigration = db.prepare(
    `INSERT INTO ${LEGACY_MIGRATION_TABLE}
       (legacy_id, migrated_project_id, migrated_at)
     VALUES (?, ?, ?)`,
  );
  const seenIds = new Set<number>();
  let processedCount = 0;

  for (const record of records) {
    processedCount += 1;
    if (
      typeof record.id !== 'number' ||
      !Number.isInteger(record.id) ||
      record.id <= 0 ||
      typeof record.title !== 'string' ||
      typeof record.status !== 'string' ||
      typeof record.created_at !== 'string' ||
      typeof record.updated_at !== 'string'
    ) {
      throw new Error('Cannot migrate legacy records table; row has invalid required fields');
    }
    if (seenIds.has(record.id)) {
      throw new Error(
        `Cannot migrate legacy records table; duplicate id ${record.id}`,
      );
    }
    seenIds.add(record.id);

    // A ledger row means this source record was migrated by an earlier run.
    // Do not resurrect it if a user later deleted the resulting project.
    if (findLegacyMigration.get(record.id)) continue;

    const migratedStatus = LEGACY_STATUS_MAP[record.status];
    if (!migratedStatus) {
      throw new Error(
        `Cannot migrate legacy records table; unsupported status ${JSON.stringify(record.status)} for id ${record.id}`,
      );
    }
    const migratedPriority = normalizeLegacyPriority(record.priority);
    const existing = findProject.get(record.id) as ProjectRow | undefined;

    if (existing) {
      const matchesExisting =
        existing.name === record.title &&
        existing.description === record.description &&
        existing.status === migratedStatus &&
        existing.priority === migratedPriority &&
        existing.owner === null &&
        existing.due_date === null &&
        existing.created_at === record.created_at &&
        existing.updated_at === record.updated_at;
      if (!matchesExisting) {
        throw new Error(
          `Cannot migrate legacy records table; project id ${record.id} already exists with different data`,
        );
      }
    } else {
      insertProject.run(
        record.id,
        record.title,
        record.description,
        migratedStatus,
        migratedPriority,
        record.created_at,
        record.updated_at,
      );
    }

    recordLegacyMigration.run(record.id, record.id, isoNow());
  }

  if (processedCount !== records.length || seenIds.size !== records.length) {
    throw new Error('Cannot migrate legacy records table; source rows could not be verified');
  }
}

/**
 * Creates the project/task schema and migrates legacy records transactionally.
 * It is safe to call repeatedly; migrated IDs are never overwritten.
 */
export function migrateDatabase(db: Database.Database): void {
  // Keep referential integrity for callers that use this migration helper
  // directly, not only through openDatabase() or createApp().
  db.pragma('foreign_keys = ON');

  // SQLite LIKE is ASCII-only by default. Register this on every migration
  // entry point so direct users of the DB helpers get the same search behavior
  // as openDatabase()/createApp().
  db.function('locase', (value: unknown) =>
    typeof value === 'string' ? value.toLowerCase() : value,
  );

  const migration = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS ${MIGRATION_TABLE} (
        version INTEGER PRIMARY KEY,
        applied_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS ${LEGACY_MIGRATION_TABLE} (
        legacy_id INTEGER PRIMARY KEY,
        migrated_project_id INTEGER NOT NULL,
        migrated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'planned'
          CHECK (status IN ('planned', 'active', 'blocked', 'completed', 'archived')),
        priority INTEGER NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),
        owner TEXT,
        due_date TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'todo'
          CHECK (status IN ('todo', 'in_progress', 'done')),
        priority INTEGER NOT NULL DEFAULT 3 CHECK (priority BETWEEN 1 AND 5),
        assignee TEXT,
        due_date TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_projects_status ON projects(status);
      CREATE INDEX IF NOT EXISTS idx_tasks_project_id ON tasks(project_id);
      CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
    `);

    const databaseVersion = db.pragma('user_version', { simple: true }) as number;
    const migrationRow = db
      .prepare(`SELECT MAX(version) AS version FROM ${MIGRATION_TABLE}`)
      .get() as { version: number | null };
    const appliedVersion = migrationRow.version ?? 0;

    if (databaseVersion > DATABASE_VERSION || appliedVersion > DATABASE_VERSION) {
      throw new Error(
        `Database schema version ${Math.max(databaseVersion, appliedVersion)} is newer than supported version ${DATABASE_VERSION}`,
      );
    }

    // The application ledger is authoritative rather than SQLite's global
    // user_version. This also migrates databases created by older builds that
    // happened to use user_version=1 without recording the legacy import.
    migrateLegacyRecords(db);
    db.prepare(
      `INSERT INTO ${MIGRATION_TABLE} (version, applied_at)
       VALUES (?, ?)
       ON CONFLICT(version) DO UPDATE SET applied_at = excluded.applied_at`,
    ).run(DATABASE_VERSION, isoNow());
    db.pragma(`user_version = ${DATABASE_VERSION}`);
  });

  migration.immediate();
}

/** Opens (and, when necessary, creates and migrates) the data database. */
export function openDatabase(dbPath: string): Database.Database {
  if (dbPath !== ':memory:') {
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  }

  const db = new Database(dbPath);

  try {
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');

    migrateDatabase(db);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export function listProjects(
  db: Database.Database,
  options: ListProjectsOptions = {},
): ListProjectsResult {
  const limit = normalizeLimit(options.limit);
  const offset = normalizeOffset(options.offset);
  const where: string[] = [];
  const params: Array<string | number> = [];

  if (options.search !== undefined && options.search !== '') {
    const like = `%${escapeLike(options.search.toLowerCase())}%`;
    where.push(
      `(locase(p.name) LIKE ? ESCAPE '\\'
        OR locase(p.description) LIKE ? ESCAPE '\\'
        OR locase(p.owner) LIKE ? ESCAPE '\\')`,
    );
    params.push(like, like, like);
  }

  if (options.status !== undefined) {
    where.push('p.status = ?');
    params.push(options.status);
  }

  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const { total } = db
    .prepare(`SELECT COUNT(*) AS total FROM projects p ${whereSql}`)
    .get(...params) as { total: number };

  const items = db
    .prepare(
      `${PROJECT_WITH_PROGRESS_SELECT}
       ${whereSql}
       GROUP BY p.id
       ORDER BY p.id DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as ProjectSummary[];

  return { items, total, limit, offset };
}

export function getProject(
  db: Database.Database,
  id: number,
): ProjectRow | null {
  const row = db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as
    | ProjectRow
    | undefined;
  return row ?? null;
}

export function getProjectSummary(
  db: Database.Database,
  id: number,
): ProjectSummary | null {
  const row = db
    .prepare(
      `${PROJECT_WITH_PROGRESS_SELECT}
       WHERE p.id = ?
       GROUP BY p.id`,
    )
    .get(id) as ProjectSummary | undefined;
  return row ?? null;
}

export function createProject(
  db: Database.Database,
  input: CreateProjectInput,
): ProjectRow {
  const now = isoNow();
  const info = db
    .prepare(
      `INSERT INTO projects
         (name, description, status, priority, owner, due_date, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.name,
      input.description ?? null,
      input.status ?? 'planned',
      input.priority ?? 3,
      input.owner ?? null,
      input.due_date ?? null,
      now,
      now,
    );

  const project = getProject(db, Number(info.lastInsertRowid));
  if (!project) throw new Error('Created project could not be read back');
  return project;
}

export function updateProject(
  db: Database.Database,
  id: number,
  patch: UpdateProjectInput,
): ProjectRow | null {
  const existing = getProject(db, id);
  if (!existing) return null;
  if (existing.status === 'archived') {
    throw new ArchivedResourceError('project', id);
  }

  const updatedAt = nextUpdatedAt(existing.updated_at);
  db.prepare(
    `UPDATE projects
     SET name = ?, description = ?, status = ?, priority = ?, owner = ?,
         due_date = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    patch.name ?? existing.name,
    patch.description !== undefined ? patch.description : existing.description,
    patch.status ?? existing.status,
    patch.priority ?? existing.priority,
    patch.owner !== undefined ? patch.owner : existing.owner,
    patch.due_date !== undefined ? patch.due_date : existing.due_date,
    updatedAt,
    id,
  );

  return getProject(db, id);
}

export function deleteProject(db: Database.Database, id: number): boolean {
  const project = getProject(db, id);
  if (!project) return false;
  if (project.status === 'archived') {
    throw new ArchivedResourceError('project', id);
  }
  return db.prepare('DELETE FROM projects WHERE id = ?').run(id).changes > 0;
}

export function listTasks(
  db: Database.Database,
  projectId: number,
): TaskRow[] {
  return db
    .prepare('SELECT * FROM tasks WHERE project_id = ? ORDER BY id DESC')
    .all(projectId) as TaskRow[];
}

export function listTasksPage(
  db: Database.Database,
  projectId: number,
  options: ListTasksOptions = {},
): ListTasksResult {
  const limit = normalizeTaskLimit(options.limit);
  const offset = normalizeOffset(options.offset);
  const where = ['project_id = ?'];
  const params: Array<string | number> = [projectId];

  if (options.search !== undefined && options.search !== '') {
    const like = `%${escapeLike(options.search.toLowerCase())}%`;
    where.push(
      `(locase(title) LIKE ? ESCAPE '\\'
        OR locase(description) LIKE ? ESCAPE '\\'
        OR locase(assignee) LIKE ? ESCAPE '\\')`,
    );
    params.push(like, like, like);
  }

  if (options.status !== undefined) {
    where.push('status = ?');
    params.push(options.status);
  }

  const whereSql = `WHERE ${where.join(' AND ')}`;
  const { total } = db
    .prepare(`SELECT COUNT(*) AS total FROM tasks ${whereSql}`)
    .get(...params) as { total: number };
  const items = db
    .prepare(
      `SELECT * FROM tasks
       ${whereSql}
       ORDER BY id DESC
       LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as TaskRow[];

  return { items, total, limit, offset };
}

export function getTask(db: Database.Database, id: number): TaskRow | null {
  const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(id) as
    | TaskRow
    | undefined;
  return row ?? null;
}

export function createTask(
  db: Database.Database,
  input: CreateTaskInput,
): TaskRow {
  const project = getProject(db, input.project_id);
  if (!project) {
    throw new ResourceNotFoundError('project', input.project_id);
  }
  if (project.status === 'archived') {
    throw new ArchivedResourceError('project', input.project_id);
  }

  const now = isoNow();
  const info = db
    .prepare(
      `INSERT INTO tasks
         (project_id, title, description, status, priority, assignee, due_date,
          created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.project_id,
      input.title,
      input.description ?? null,
      input.status ?? 'todo',
      input.priority ?? 3,
      input.assignee ?? null,
      input.due_date ?? null,
      now,
      now,
    );

  const task = getTask(db, Number(info.lastInsertRowid));
  if (!task) throw new Error('Created task could not be read back');
  return task;
}

export function updateTask(
  db: Database.Database,
  id: number,
  patch: UpdateTaskInput,
): TaskRow | null {
  const existing = getTask(db, id);
  if (!existing) return null;

  const sourceProject = getProject(db, existing.project_id);
  if (!sourceProject) {
    throw new ResourceNotFoundError('project', existing.project_id);
  }
  if (sourceProject.status === 'archived') {
    throw new ArchivedResourceError('project', existing.project_id);
  }

  const projectId = patch.project_id ?? existing.project_id;
  const destinationProject = getProject(db, projectId);
  if (!destinationProject) {
    throw new ResourceNotFoundError('project', projectId);
  }
  if (destinationProject.status === 'archived') {
    throw new ArchivedResourceError('project', projectId);
  }

  const updatedAt = nextUpdatedAt(existing.updated_at);
  db.prepare(
    `UPDATE tasks
     SET project_id = ?, title = ?, description = ?, status = ?, priority = ?,
         assignee = ?, due_date = ?, updated_at = ?
     WHERE id = ?`,
  ).run(
    projectId,
    patch.title ?? existing.title,
    patch.description !== undefined ? patch.description : existing.description,
    patch.status ?? existing.status,
    patch.priority ?? existing.priority,
    patch.assignee !== undefined ? patch.assignee : existing.assignee,
    patch.due_date !== undefined ? patch.due_date : existing.due_date,
    updatedAt,
    id,
  );

  return getTask(db, id);
}

export function deleteTask(db: Database.Database, id: number): boolean {
  const task = getTask(db, id);
  if (!task) return false;
  const project = getProject(db, task.project_id);
  if (!project) {
    throw new ResourceNotFoundError('project', task.project_id);
  }
  if (project.status === 'archived') {
    throw new ArchivedResourceError('project', project.id);
  }
  return db.prepare('DELETE FROM tasks WHERE id = ?').run(id).changes > 0;
}

export class ResourceNotFoundError extends Error {
  constructor(
    readonly resource: 'project' | 'task',
    readonly id: number,
  ) {
    super(`${resource} ${id} not found`);
    this.name = 'ResourceNotFoundError';
  }
}

export class ArchivedResourceError extends Error {
  constructor(
    readonly resource: 'project' | 'task',
    readonly id: number,
  ) {
    super(`${resource} ${id} is archived and read-only`);
    this.name = 'ArchivedResourceError';
  }
}

export function isSqliteError(error: unknown): error is SqliteError {
  return error instanceof Error && 'code' in error;
}
