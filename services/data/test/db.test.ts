import assert from 'node:assert/strict';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { test, type TestContext } from 'node:test';
import Database from 'better-sqlite3';
import {
  ArchivedResourceError,
  createProject,
  createTask,
  deleteProject,
  deleteTask,
  getProject,
  getProjectSummary,
  getTask,
  listProjects,
  listTasks,
  listTasksPage,
  migrateDatabase,
  openDatabase,
  ResourceNotFoundError,
  updateProject,
  updateTask,
} from '../src/db';
import { createApp } from '../src/index';
import {
  createProjectSchema,
  createTaskSchema,
  listProjectsQuerySchema,
  listTasksQuerySchema,
  updateProjectSchema,
  updateTaskSchema,
} from '../src/schema';

function testDb(t: TestContext): Database.Database {
  const db = openDatabase(':memory:');
  t.after(() => db.close());
  return db;
}

function countRows(db: Database.Database, table: 'projects' | 'tasks'): number {
  const row = db.prepare(`SELECT COUNT(*) AS count FROM ${table}`).get() as {
    count: number;
  };
  return row.count;
}

test('a fresh in-memory database has the project schema and no demo data', (t) => {
  const db = testDb(t);

  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  assert.equal(countRows(db, 'projects'), 0);
  assert.equal(countRows(db, 'tasks'), 0);

  const legacyTable = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'records'")
    .get();
  assert.equal(legacyTable, undefined);

  const projectColumns = (
    db.pragma('table_info(projects)') as Array<{ name: string }>
  ).map((column) => column.name);
  assert.deepEqual(projectColumns, [
    'id',
    'name',
    'description',
    'status',
    'priority',
    'owner',
    'due_date',
    'created_at',
    'updated_at',
  ]);

  const taskColumns = (
    db.pragma('table_info(tasks)') as Array<{ name: string }>
  ).map((column) => column.name);
  assert.deepEqual(taskColumns, [
    'id',
    'project_id',
    'title',
    'description',
    'status',
    'priority',
    'assignee',
    'due_date',
    'created_at',
    'updated_at',
  ]);
});

test('project CRUD uses domain defaults and updates only supplied fields', (t) => {
  const db = testDb(t);

  const project = createProject(db, { name: 'Platform modernization' });
  assert.ok(project.id > 0);
  assert.equal(project.name, 'Platform modernization');
  assert.equal(project.status, 'planned');
  assert.equal(project.priority, 3);
  assert.equal(project.description, null);
  assert.equal(project.owner, null);
  assert.equal(project.due_date, null);
  assert.equal(project.created_at, project.updated_at);
  assert.deepEqual(getProject(db, project.id), project);

  const updated = updateProject(db, project.id, {
    description: 'Move critical services to the new platform',
    status: 'active',
    owner: 'Platform team',
    due_date: '2027-03-20',
  });
  assert.ok(updated);
  assert.equal(updated.name, project.name);
  assert.equal(updated.priority, project.priority);
  assert.equal(updated.status, 'active');
  assert.equal(updated.owner, 'Platform team');
  assert.equal(updated.due_date, '2027-03-20');
  assert.ok(Date.parse(updated.updated_at) > Date.parse(updated.created_at));

  const cleared = updateProject(db, project.id, {
    description: null,
    owner: null,
    due_date: null,
  });
  assert.ok(cleared);
  assert.equal(cleared.description, null);
  assert.equal(cleared.owner, null);
  assert.equal(cleared.due_date, null);

  assert.equal(updateProject(db, 999_999, { name: 'Missing' }), null);
  assert.equal(deleteProject(db, project.id), true);
  assert.equal(getProject(db, project.id), null);
  assert.equal(deleteProject(db, project.id), false);
});

test('project list supports Unicode search, status filtering, and pagination', (t) => {
  const db = testDb(t);

  const infrastructure = createProject(db, {
    name: 'Інфраструктура',
    description: 'Kubernetes and observability',
    status: 'active',
    owner: 'DevOps',
  });
  const security = createProject(db, {
    name: 'Security review',
    description: 'Перевірка безпеки',
    status: 'blocked',
  });
  const planned = createProject(db, {
    name: 'Documentation',
    status: 'planned',
  });

  const all = listProjects(db);
  assert.equal(all.total, 3);
  assert.equal(all.limit, 50);
  assert.equal(all.offset, 0);
  assert.deepEqual(
    all.items.map((project) => project.id),
    [planned.id, security.id, infrastructure.id],
  );

  const cyrillicSearch = listProjects(db, { search: 'інфраструктура' });
  assert.equal(cyrillicSearch.total, 1);
  assert.equal(cyrillicSearch.items[0].id, infrastructure.id);

  const descriptionSearch = listProjects(db, { search: 'obsERVA' });
  assert.equal(descriptionSearch.total, 1);
  assert.equal(descriptionSearch.items[0].id, infrastructure.id);

  const ownerSearch = listProjects(db, { search: 'devops' });
  assert.equal(ownerSearch.total, 1);
  assert.equal(ownerSearch.items[0].id, infrastructure.id);

  const active = listProjects(db, { status: 'active' });
  assert.equal(active.total, 1);
  assert.equal(active.items[0].id, infrastructure.id);

  const page = listProjects(db, { limit: 1, offset: 1 });
  assert.equal(page.total, 3);
  assert.equal(page.limit, 1);
  assert.equal(page.offset, 1);
  assert.deepEqual(page.items.map((project) => project.id), [security.id]);

  const literalWildcard = listProjects(db, { search: '%' });
  assert.equal(literalWildcard.total, 0);
});

test('project progress is calculated from completed tasks, including zero-task projects', (t) => {
  const db = testDb(t);
  const alpha = createProject(db, { name: 'Alpha' });
  const beta = createProject(db, { name: 'Beta' });
  const empty = createProject(db, { name: 'Empty' });

  createTask(db, { project_id: alpha.id, title: 'One', status: 'done' });
  createTask(db, { project_id: alpha.id, title: 'Two', status: 'done' });
  createTask(db, { project_id: alpha.id, title: 'Three', status: 'todo' });
  createTask(db, { project_id: beta.id, title: 'Four', status: 'in_progress' });

  const result = listProjects(db);
  const alphaSummary = result.items.find((project) => project.id === alpha.id);
  const betaSummary = result.items.find((project) => project.id === beta.id);
  const emptySummary = result.items.find((project) => project.id === empty.id);

  assert.ok(alphaSummary);
  assert.equal(alphaSummary.task_count, 3);
  assert.equal(alphaSummary.completed_task_count, 2);
  assert.equal(alphaSummary.progress_percent, 66.67);

  assert.ok(betaSummary);
  assert.equal(betaSummary.task_count, 1);
  assert.equal(betaSummary.completed_task_count, 0);
  assert.equal(betaSummary.progress_percent, 0);

  assert.ok(emptySummary);
  assert.equal(emptySummary.task_count, 0);
  assert.equal(emptySummary.completed_task_count, 0);
  assert.equal(emptySummary.progress_percent, 0);
  assert.deepEqual(getProjectSummary(db, empty.id), emptySummary);
  assert.equal(getProjectSummary(db, 999_999), null);
});

test('tasks can be created, moved, updated, listed, and deleted', (t) => {
  const db = testDb(t);
  const source = createProject(db, { name: 'Source' });
  const destination = createProject(db, { name: 'Destination' });

  const task = createTask(db, {
    project_id: source.id,
    title: 'Implement API',
    description: 'Project/task endpoints',
    priority: 1,
    assignee: 'Backend team',
    due_date: '2026-12-31',
  });
  assert.ok(task.id > 0);
  assert.equal(task.project_id, source.id);
  assert.equal(task.status, 'todo');
  assert.equal(task.priority, 1);
  assert.equal(task.created_at, task.updated_at);
  assert.deepEqual(getTask(db, task.id), task);
  assert.deepEqual(listTasks(db, source.id), [task]);

  const updated = updateTask(db, task.id, {
    project_id: destination.id,
    status: 'in_progress',
    title: 'Implement project API',
  });
  assert.ok(updated);
  assert.equal(updated.project_id, destination.id);
  assert.equal(updated.status, 'in_progress');
  assert.equal(updated.title, 'Implement project API');
  assert.equal(updated.description, task.description);
  assert.equal(updated.priority, task.priority);
  assert.ok(Date.parse(updated.updated_at) > Date.parse(updated.created_at));
  assert.deepEqual(listTasks(db, source.id), []);
  assert.deepEqual(listTasks(db, destination.id), [updated]);

  assert.equal(updateTask(db, 999_999, { status: 'done' }), null);
  assert.equal(deleteTask(db, task.id), true);
  assert.equal(getTask(db, task.id), null);
  assert.equal(deleteTask(db, task.id), false);
});

test('task lists support search, status filtering, and pagination', (t) => {
  const db = testDb(t);
  const project = createProject(db, { name: 'Backlog' });
  const otherProject = createProject(db, { name: 'Other' });

  createTask(db, {
    project_id: project.id,
    title: 'Підготувати API',
    description: 'Спроєктувати endpoints',
    status: 'todo',
    assignee: 'Backend',
  });
  createTask(db, {
    project_id: project.id,
    title: 'Review API',
    status: 'done',
  });
  createTask(db, {
    project_id: project.id,
    title: 'Ship API',
    status: 'in_progress',
  });
  createTask(db, {
    project_id: otherProject.id,
    title: 'Do not leak',
    status: 'done',
  });

  const all = listTasksPage(db, project.id);
  assert.equal(all.total, 3);
  assert.equal(all.limit, 50);
  assert.equal(all.offset, 0);
  assert.deepEqual(
    all.items.map((task) => task.title),
    ['Ship API', 'Review API', 'Підготувати API'],
  );

  const searched = listTasksPage(db, project.id, { search: 'підготувати' });
  assert.equal(searched.total, 1);
  assert.equal(searched.items[0].title, 'Підготувати API');

  const active = listTasksPage(db, project.id, { status: 'in_progress' });
  assert.equal(active.total, 1);
  assert.equal(active.items[0].title, 'Ship API');

  const page = listTasksPage(db, project.id, { limit: 1, offset: 1 });
  assert.equal(page.total, 3);
  assert.equal(page.items.length, 1);
  assert.equal(page.items[0].title, 'Review API');
});

test('task foreign keys reject missing projects and project deletion cascades', (t) => {
  const db = testDb(t);
  const project = createProject(db, { name: 'Cascade parent' });
  const task = createTask(db, { project_id: project.id, title: 'Child task' });

  assert.throws(
    () => createTask(db, { project_id: 999_999, title: 'Orphan' }),
    ResourceNotFoundError,
  );
  assert.throws(
    () => updateTask(db, task.id, { project_id: 999_999 }),
    ResourceNotFoundError,
  );

  assert.equal(deleteProject(db, project.id), true);
  assert.equal(getTask(db, task.id), null);
  assert.equal(countRows(db, 'tasks'), 0);
});

test('archived projects and their tasks are read-only in the data layer', (t) => {
  const db = testDb(t);
  const now = '2026-01-01T00:00:00.000Z';
  const archivedId = Number(
    db
      .prepare(
        `INSERT INTO projects
           (name, description, status, priority, owner, due_date, created_at, updated_at)
         VALUES (?, ?, 'archived', ?, NULL, NULL, ?, ?)`,
      )
      .run('Legacy archive', null, 3, now, now).lastInsertRowid,
  );
  const active = createProject(db, { name: 'Active destination' });
  const activeTask = createTask(db, {
    project_id: active.id,
    title: 'Active task',
  });
  const archivedTaskId = Number(
    db
      .prepare(
        `INSERT INTO tasks
           (project_id, title, description, status, priority, assignee, due_date,
            created_at, updated_at)
         VALUES (?, ?, NULL, 'todo', 3, NULL, NULL, ?, ?)`,
      )
      .run(archivedId, 'Legacy task', now, now).lastInsertRowid,
  );

  assert.throws(
    () => updateProject(db, archivedId, { status: 'active' }),
    ArchivedResourceError,
  );
  assert.throws(() => deleteProject(db, archivedId), ArchivedResourceError);
  assert.throws(
    () => createTask(db, { project_id: archivedId, title: 'Forbidden' }),
    ArchivedResourceError,
  );
  assert.throws(
    () => updateTask(db, activeTask.id, { project_id: archivedId }),
    ArchivedResourceError,
  );
  assert.throws(
    () => updateTask(db, archivedTaskId, { status: 'done' }),
    ArchivedResourceError,
  );
  assert.throws(
    () => updateTask(db, archivedTaskId, { project_id: active.id }),
    ArchivedResourceError,
  );
  assert.throws(() => deleteTask(db, archivedTaskId), ArchivedResourceError);

  // The failed mutations must not alter either side of the relationship.
  assert.equal(getProject(db, archivedId)?.status, 'archived');
  assert.equal(getTask(db, archivedTaskId)?.project_id, archivedId);
  assert.equal(getTask(db, activeTask.id)?.project_id, active.id);
  assert.equal(countRows(db, 'tasks'), 2);
});

test('legacy records migrate one-to-one, preserve fields, and are idempotent', (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.pragma('foreign_keys = ON');
  db.exec(`
    CREATE TABLE records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'new',
      priority INTEGER NOT NULL DEFAULT 3,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  const insert = db.prepare(
    `INSERT INTO records
       (id, title, description, status, priority, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  insert.run(10, 'New record', 'first', 'new', 1, '2025-01-01T00:00:00.000Z', '2025-01-02T00:00:00.000Z');
  insert.run(20, 'Active record', null, 'in_progress', 2, '2025-02-01T00:00:00.000Z', '2025-02-02T00:00:00.000Z');
  insert.run(30, 'Done record', 'third', 'done', 3, '2025-03-01T00:00:00.000Z', '2025-03-02T00:00:00.000Z');
  insert.run(40, 'Archived record', null, 'archived', 4, '2025-04-01T00:00:00.000Z', '2025-04-02T00:00:00.000Z');
  // Стара схема не мала CHECK; некоректний пріоритет не повинен ламати міграцію.
  insert.run(50, 'Legacy out-of-range priority', null, 'new', 0, '2025-05-01T00:00:00.000Z', '2025-05-02T00:00:00.000Z');

  migrateDatabase(db);
  migrateDatabase(db);

  assert.equal(db.pragma('user_version', { simple: true }), 1);
  assert.equal(countRows(db, 'projects'), 5);
  assert.deepEqual(
    db.prepare('SELECT id, name, status, priority FROM projects ORDER BY id').all(),
    [
      { id: 10, name: 'New record', status: 'planned', priority: 1 },
      { id: 20, name: 'Active record', status: 'active', priority: 2 },
      { id: 30, name: 'Done record', status: 'completed', priority: 3 },
      { id: 40, name: 'Archived record', status: 'archived', priority: 4 },
      { id: 50, name: 'Legacy out-of-range priority', status: 'planned', priority: 1 },
    ],
  );

  const first = getProject(db, 10);
  assert.ok(first);
  assert.equal(first.description, 'first');
  assert.equal(first.created_at, '2025-01-01T00:00:00.000Z');
  assert.equal(first.updated_at, '2025-01-02T00:00:00.000Z');
  assert.equal(first.owner, null);
  assert.equal(first.due_date, null);

  const next = createProject(db, { name: 'Created after migration' });
  assert.equal(next.id, 51);

  assert.equal(deleteProject(db, 10), true);
  migrateDatabase(db);
  assert.equal(getProject(db, 10), null);
});

test('application migration ledger handles an old user_version collision', (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE records (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL,
      priority INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO records (id, title, description, status, priority, created_at, updated_at)
    VALUES (7, 'Version collision', NULL, 'done', 2, '2025-01-01', '2025-01-02');
    PRAGMA user_version = 1;
  `);

  migrateDatabase(db);
  assert.equal(getProject(db, 7)?.status, 'completed');
  assert.equal(
    db.prepare('SELECT version FROM app_schema_migrations WHERE version = 1').get()
      .version,
    1,
  );
});

test('legacy migration rejects ID conflicts instead of silently dropping rows', (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  migrateDatabase(db);
  db.exec(`
    CREATE TABLE records (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL,
      priority INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO records (id, title, description, status, priority, created_at, updated_at)
    VALUES (1, 'Legacy row', NULL, 'new', 3, '2025-01-01', '2025-01-02');
  `);
  const existing = createProject(db, { name: 'User-created conflict' });

  assert.throws(
    () => migrateDatabase(db),
    /project id 1 already exists with different data/,
  );
  assert.equal(getProject(db, existing.id)?.name, 'User-created conflict');
});

test('legacy migration rejects unknown statuses rather than losing them', (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE records (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL,
      priority INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    INSERT INTO records (id, title, description, status, priority, created_at, updated_at)
    VALUES (1, 'Unknown status', NULL, 'paused', 3, '2025-01-01', '2025-01-02');
  `);

  assert.throws(() => migrateDatabase(db), /unsupported status/);
  assert.equal(
    db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projects'").get(),
    undefined,
  );
});

test('a failed legacy migration rolls back the whole schema migration', (t) => {
  const db = new Database(':memory:');
  t.after(() => db.close());
  db.exec(`
    CREATE TABLE records (
      id INTEGER PRIMARY KEY,
      title TEXT NOT NULL,
      status TEXT NOT NULL
    );
    INSERT INTO records (id, title, status) VALUES (1, 'Incomplete', 'new');
  `);

  assert.throws(
    () => migrateDatabase(db),
    /Cannot migrate legacy records table/,
  );
  const projects = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'projects'")
    .get();
  assert.equal(projects, undefined);
  assert.equal(db.pragma('user_version', { simple: true }), 0);
});

test('HTTP API exposes project/task CRUD and calculated progress', async (t) => {
  const db = testDb(t);
  const server = createApp(db).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );

  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const jsonRequest = async (path: string, method: string, body?: unknown) => {
    const response = await fetch(`${baseUrl}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return response;
  };

  const projectResponse = await jsonRequest('/api/projects', 'POST', {
    name: 'HTTP project',
    priority: 2,
  });
  assert.equal(projectResponse.status, 201);
  const project = (await projectResponse.json()) as { id: number };

  const taskResponse = await jsonRequest(
    `/api/projects/${project.id}/tasks`,
    'POST',
    { title: 'HTTP task' },
  );
  assert.equal(taskResponse.status, 201);
  const task = (await taskResponse.json()) as { id: number };

  const updateResponse = await jsonRequest(`/api/tasks/${task.id}`, 'PUT', {
    status: 'done',
  });
  assert.equal(updateResponse.status, 200);

  const taskGetResponse = await jsonRequest(`/api/tasks/${task.id}`, 'GET');
  assert.equal(taskGetResponse.status, 200);
  assert.equal(((await taskGetResponse.json()) as { status: string }).status, 'done');

  const summaryResponse = await jsonRequest(`/api/projects/${project.id}`, 'GET');
  assert.equal(summaryResponse.status, 200);
  const summary = (await summaryResponse.json()) as {
    task_count: number;
    completed_task_count: number;
    progress_percent: number;
  };
  assert.equal(summary.task_count, 1);
  assert.equal(summary.completed_task_count, 1);
  assert.equal(summary.progress_percent, 100);

  const taskListResponse = await jsonRequest(`/api/projects/${project.id}/tasks`, 'GET');
  assert.equal(taskListResponse.status, 200);
  const taskList = (await taskListResponse.json()) as { total: number };
  assert.equal(taskList.total, 1);

  const deleteResponse = await jsonRequest(`/api/projects/${project.id}`, 'DELETE');
  assert.equal(deleteResponse.status, 204);
  assert.equal((await jsonRequest(`/api/projects/${project.id}`, 'GET')).status, 404);
});

test('HTTP API rejects every mutation of archived projects and tasks', async (t) => {
  const db = testDb(t);
  const now = '2026-01-01T00:00:00.000Z';
  const archivedId = Number(
    db
      .prepare(
        `INSERT INTO projects
           (name, description, status, priority, owner, due_date, created_at, updated_at)
         VALUES (?, ?, 'archived', ?, NULL, NULL, ?, ?)`,
      )
      .run('HTTP legacy archive', null, 3, now, now).lastInsertRowid,
  );
  const active = createProject(db, { name: 'HTTP active project' });
  const activeTask = createTask(db, {
    project_id: active.id,
    title: 'HTTP active task',
  });
  const archivedTaskId = Number(
    db
      .prepare(
        `INSERT INTO tasks
           (project_id, title, description, status, priority, assignee, due_date,
            created_at, updated_at)
         VALUES (?, ?, NULL, 'todo', 3, NULL, NULL, ?, ?)`,
      )
      .run(archivedId, 'HTTP legacy task', now, now).lastInsertRowid,
  );

  const server = createApp(db).listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(
    () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  );
  const address = server.address() as AddressInfo;
  const baseUrl = `http://127.0.0.1:${address.port}`;
  const request = (path: string, method: string, body?: unknown) =>
    fetch(`${baseUrl}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });

  const attempts = [
    request(`/api/projects/${archivedId}`, 'PUT', { status: 'active' }),
    request(`/api/projects/${archivedId}`, 'DELETE'),
    request(`/api/projects/${archivedId}/tasks`, 'POST', { title: 'Forbidden' }),
    request(`/api/tasks/${activeTask.id}`, 'PUT', { project_id: archivedId }),
    request(`/api/tasks/${archivedTaskId}`, 'PUT', { status: 'done' }),
    request(`/api/tasks/${archivedTaskId}`, 'PUT', { project_id: active.id }),
    request(`/api/tasks/${archivedTaskId}`, 'DELETE'),
  ];
  for (const responsePromise of attempts) {
    assert.equal((await responsePromise).status, 409);
  }

  assert.equal(getProject(db, archivedId)?.status, 'archived');
  assert.equal(getTask(db, archivedTaskId)?.project_id, archivedId);
  assert.equal(getTask(db, activeTask.id)?.project_id, active.id);
});

test('Zod schemas validate project, task, query, and update inputs', () => {
  assert.deepEqual(
    createProjectSchema.parse({
      name: '  Valid project  ',
      status: 'active',
      priority: 2,
      owner: null,
      due_date: '2028-02-29',
    }),
    {
      name: 'Valid project',
      status: 'active',
      priority: 2,
      owner: null,
      due_date: '2028-02-29',
    },
  );

  for (const input of [
    { name: '' },
    { name: 'x', priority: 0 },
    { name: 'x', priority: 6 },
    { name: 'x', priority: 1.5 },
    { name: 'x', status: 'archived' },
    { name: 'x', due_date: '2027-02-30' },
    { name: 'x', due_date: '01/02/2027' },
    { name: 'x', unknown: true },
  ]) {
    assert.equal(createProjectSchema.safeParse(input).success, false);
  }

  assert.equal(updateProjectSchema.safeParse({}).success, false);
  assert.equal(updateProjectSchema.safeParse({ unknown: true }).success, false);
  assert.equal(
    updateProjectSchema.safeParse({ status: 'blocked', owner: null }).success,
    true,
  );

  assert.equal(
    createTaskSchema.safeParse({
      project_id: 1,
      title: 'Task',
      status: 'done',
      priority: 5,
    }).success,
    true,
  );
  for (const input of [
    { project_id: 0, title: 'Task' },
    { project_id: 1, title: '' },
    { project_id: 1, title: 'Task', status: 'planned' },
    { project_id: 1, title: 'Task', priority: 6 },
    { project_id: 1, title: 'Task', assignee: 42 },
  ]) {
    assert.equal(createTaskSchema.safeParse(input).success, false);
  }
  assert.equal(updateTaskSchema.safeParse({}).success, false);
  assert.equal(updateTaskSchema.safeParse({ project_id: 2 }).success, true);

  assert.deepEqual(listProjectsQuerySchema.parse({}), {
    limit: 50,
    offset: 0,
  });
  assert.deepEqual(
    listProjectsQuerySchema.parse({
      search: '  platform  ',
      status: 'planned',
      limit: '10',
      offset: '20',
    }),
    {
      search: 'platform',
      status: 'planned',
      limit: 10,
      offset: 20,
    },
  );
  assert.equal(listProjectsQuerySchema.safeParse({ limit: 0 }).success, false);
  assert.equal(listProjectsQuerySchema.safeParse({ limit: 101 }).success, false);
  assert.equal(listProjectsQuerySchema.safeParse({ limit: 1.5 }).success, false);
  assert.equal(listProjectsQuerySchema.safeParse({ offset: -1 }).success, false);
  assert.equal(listProjectsQuerySchema.safeParse({ status: 'new' }).success, false);
  assert.equal(listProjectsQuerySchema.safeParse({ status: 'archived' }).success, true);

  assert.deepEqual(
    listTasksQuerySchema.parse({ search: ' API ', status: 'done', limit: '200' }),
    { search: 'API', status: 'done', limit: 200, offset: 0 },
  );
  assert.equal(listTasksQuerySchema.safeParse({ status: 'completed' }).success, false);
  assert.equal(listTasksQuerySchema.safeParse({ limit: 201 }).success, false);
});
