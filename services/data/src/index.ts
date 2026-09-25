import type Database from 'better-sqlite3';
import cors from 'cors';
import express, {
  type Express,
  type NextFunction,
  type Request,
  type Response,
} from 'express';
import { ZodError } from 'zod';
import { loadConfig } from './config';
import {
  ArchivedResourceError,
  createProject,
  createTask,
  deleteProject,
  deleteTask,
  getProject,
  getProjectSummary,
  getTask,
  isSqliteError,
  listProjects,
  listTasksPage,
  migrateDatabase,
  openDatabase,
  ResourceNotFoundError,
  updateProject,
  updateTask,
} from './db';
import {
  createProjectSchema,
  createTaskSchema,
  idParamsSchema,
  listProjectsQuerySchema,
  listTasksQuerySchema,
  updateProjectSchema,
  updateTaskSchema,
} from './schema';

function validationFailed(res: Response, error: ZodError): Response {
  return res.status(400).json({
    error: 'validation_failed',
    details: error.flatten(),
  });
}

function notFound(res: Response, resource: string, id: number): Response {
  return res.status(404).json({ error: 'not_found', detail: `${resource} ${id}` });
}

export interface AppMetadata {
  serviceName?: string;
  version?: string;
}

export function createApp(
  db: Database.Database,
  metadata: AppMetadata = {},
): Express {
  // createApp() is also used by integration tests with a raw better-sqlite3
  // connection, so keep the same invariants as openDatabase() here.
  db.pragma('foreign_keys = ON');
  migrateDatabase(db);

  const app = express();

  app.disable('x-powered-by');
  app.use(cors());
  app.use(express.json());

  app.get('/health', (_req, res) => {
    res.json({
      status: 'ok',
      service: metadata.serviceName ?? 'data',
      version: metadata.version ?? '0.1.0',
      uptime: process.uptime(),
      timestamp: Date.now(),
    });
  });

  app.get('/api/projects', (req: Request, res: Response) => {
    const parsed = listProjectsQuerySchema.safeParse(req.query);
    if (!parsed.success) return validationFailed(res, parsed.error);

    res.json(listProjects(db, parsed.data));
  });

  app.post('/api/projects', (req: Request, res: Response) => {
    const parsed = createProjectSchema.safeParse(req.body);
    if (!parsed.success) return validationFailed(res, parsed.error);

    const created = createProject(db, parsed.data);
    res.status(201).json(getProjectSummary(db, created.id));
  });

  app.get('/api/projects/:id', (req: Request, res: Response) => {
    const parsedId = idParamsSchema.safeParse(req.params);
    if (!parsedId.success) return validationFailed(res, parsedId.error);

    const project = getProjectSummary(db, parsedId.data.id);
    if (!project) return notFound(res, 'project', parsedId.data.id);

    res.json(project);
  });

  app.put('/api/projects/:id', (req: Request, res: Response) => {
    const parsedId = idParamsSchema.safeParse(req.params);
    if (!parsedId.success) return validationFailed(res, parsedId.error);

    const parsedBody = updateProjectSchema.safeParse(req.body);
    if (!parsedBody.success) return validationFailed(res, parsedBody.error);

    const project = updateProject(db, parsedId.data.id, parsedBody.data);
    if (!project) return notFound(res, 'project', parsedId.data.id);

    res.json(getProjectSummary(db, project.id));
  });

  app.delete('/api/projects/:id', (req: Request, res: Response) => {
    const parsedId = idParamsSchema.safeParse(req.params);
    if (!parsedId.success) return validationFailed(res, parsedId.error);

    if (!deleteProject(db, parsedId.data.id)) {
      return notFound(res, 'project', parsedId.data.id);
    }

    res.status(204).end();
  });

  app.get('/api/projects/:id/tasks', (req: Request, res: Response) => {
    const parsedId = idParamsSchema.safeParse(req.params);
    if (!parsedId.success) return validationFailed(res, parsedId.error);
    const parsedQuery = listTasksQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) return validationFailed(res, parsedQuery.error);

    const projectId = parsedId.data.id;
    if (!getProject(db, projectId)) return notFound(res, 'project', projectId);

    res.json(listTasksPage(db, projectId, parsedQuery.data));
  });

  app.post('/api/projects/:id/tasks', (req: Request, res: Response) => {
    const parsedId = idParamsSchema.safeParse(req.params);
    if (!parsedId.success) return validationFailed(res, parsedId.error);

    const parsedBody = createTaskSchema
      .omit({ project_id: true })
      .safeParse(req.body);
    if (!parsedBody.success) return validationFailed(res, parsedBody.error);

    res.status(201).json(
      createTask(db, {
        ...parsedBody.data,
        project_id: parsedId.data.id,
      }),
    );
  });

  app.get('/api/tasks/:id', (req: Request, res: Response) => {
    const parsedId = idParamsSchema.safeParse(req.params);
    if (!parsedId.success) return validationFailed(res, parsedId.error);

    const task = getTask(db, parsedId.data.id);
    if (!task) return notFound(res, 'task', parsedId.data.id);

    res.json(task);
  });

  app.put('/api/tasks/:id', (req: Request, res: Response) => {
    const parsedId = idParamsSchema.safeParse(req.params);
    if (!parsedId.success) return validationFailed(res, parsedId.error);

    const parsedBody = updateTaskSchema.safeParse(req.body);
    if (!parsedBody.success) return validationFailed(res, parsedBody.error);

    const task = updateTask(db, parsedId.data.id, parsedBody.data);
    if (!task) return notFound(res, 'task', parsedId.data.id);

    res.json(task);
  });

  app.delete('/api/tasks/:id', (req: Request, res: Response) => {
    const parsedId = idParamsSchema.safeParse(req.params);
    if (!parsedId.success) return validationFailed(res, parsedId.error);

    if (!deleteTask(db, parsedId.data.id)) {
      return notFound(res, 'task', parsedId.data.id);
    }

    res.status(204).end();
  });

  app.use((_req: Request, res: Response) => {
    res.status(404).json({ error: 'not_found' });
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof ZodError) {
      validationFailed(res, error);
      return;
    }

    if (error instanceof SyntaxError) {
      res.status(400).json({ error: 'bad_request', detail: 'invalid JSON body' });
      return;
    }

    if (error instanceof ResourceNotFoundError) {
      notFound(res, error.resource, error.id);
      return;
    }

    if (error instanceof ArchivedResourceError) {
      res.status(409).json({
        error: 'archived_read_only',
        detail: `${error.resource} ${error.id} is archived and read-only`,
      });
      return;
    }

    if (isSqliteError(error) && error.code?.startsWith('SQLITE_CONSTRAINT')) {
      res.status(409).json({
        error: 'conflict',
        detail: 'the operation conflicts with related data or a database constraint',
      });
      return;
    }

    console.error(error);
    res.status(500).json({ error: 'internal_error' });
  });

  return app;
}

if (require.main === module) {
  const config = loadConfig();
  const db = openDatabase(config.dbPath);
  const app = createApp(db, {
    serviceName: config.serviceName,
    version: config.version,
  });
  const server = app.listen(config.port, () => {
    console.log(
      `[data] listening on http://localhost:${config.port} (v${config.version})`,
    );
    console.log(`[data] database: ${config.dbPath}`);
  });

  let shuttingDown = false;
  function shutdown(): void {
    if (shuttingDown) return;
    shuttingDown = true;

    server.close(() => {
      db.close();
      process.exit(0);
    });
  }

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}
