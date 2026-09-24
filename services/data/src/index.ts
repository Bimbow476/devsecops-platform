import express, { type NextFunction, type Request, type Response } from 'express';
import cors from 'cors';
import { ZodError } from 'zod';
import { loadConfig } from './config';
import {
  deleteRecord,
  getRecord,
  insertRecord,
  listRecords,
  openDatabase,
  updateRecord,
} from './db';
import { createRecordSchema, updateRecordSchema } from './schema';

const app = express();
const config = loadConfig();
const db = openDatabase(config.dbPath);

app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: config.serviceName,
    version: config.version,
    uptime: process.uptime(),
    timestamp: Date.now(),
  });
});

app.get('/api/records', (req: Request, res: Response) => {
  const search =
    typeof req.query.search === 'string' && req.query.search.trim()
      ? req.query.search.trim()
      : undefined;
  const status =
    typeof req.query.status === 'string' && req.query.status ? req.query.status : undefined;
  const limit = req.query.limit !== undefined ? Number(req.query.limit) : undefined;
  const offset = req.query.offset !== undefined ? Number(req.query.offset) : undefined;

  const result = listRecords(db, { search, status, limit, offset });
  res.json(result);
});

app.post('/api/records', (req: Request, res: Response) => {
  const parsed = createRecordSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'validation_failed', details: parsed.error.flatten() });
  }
  const record = insertRecord(db, parsed.data);
  res.status(201).json(record);
});

app.get('/api/records/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const record = Number.isInteger(id) ? getRecord(db, id) : null;
  if (!record) {
    return res.status(404).json({ error: 'not_found', detail: `record ${req.params.id}` });
  }
  res.json(record);
});

app.put('/api/records/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'invalid_id' });
  }
  const parsed = updateRecordSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'validation_failed', details: parsed.error.flatten() });
  }
  const record = updateRecord(db, id, parsed.data);
  if (!record) {
    return res.status(404).json({ error: 'not_found', detail: `record ${req.params.id}` });
  }
  res.json(record);
});

app.delete('/api/records/:id', (req: Request, res: Response) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) {
    return res.status(400).json({ error: 'invalid_id' });
  }
  const deleted = deleteRecord(db, id);
  if (!deleted) {
    return res.status(404).json({ error: 'not_found', detail: `record ${req.params.id}` });
  }
  res.status(204).end();
});

// Централізована обробка помилок
app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof ZodError) {
    res.status(400).json({ error: 'validation_failed', details: err.flatten() });
    return;
  }
  if (err instanceof SyntaxError) {
    res.status(400).json({ error: 'bad_request', detail: 'invalid JSON body' });
    return;
  }
  console.error(err);
  res.status(500).json({ error: 'internal_error' });
});

const server = app.listen(config.port, () => {
  console.log(
    `[data] listening on http://localhost:${config.port} (v${config.version})`,
  );
  console.log(`[data] database: ${config.dbPath}`);
});

function shutdown(): void {
  db.close();
  server.close(() => process.exit(0));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);