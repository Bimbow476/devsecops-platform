import express from 'express';
import cors from 'cors';
import { createProxyMiddleware } from 'http-proxy-middleware';
import pidusage from 'pidusage';
import { loadConfig } from './config';
import { collectStatus, type ServiceStatus } from './status';

const app = express();
const config = loadConfig();

app.use(cors());
// УВАГА: gateway НЕ парсить JSON-тіла. express.json() споживав би потік
// запиту до того, як його переслати проксі, ламаючи POST через шлюз.
// Валідацію тіла виконує сам сервіс (data/...).

// Проксі до мікросервісів.
// У v3 http-proxy-middleware передає шлях відносно точки монтування, тому
// використовуємо pathFilter із повним шляхом (без app.use(path)).
const metricsProxy = createProxyMiddleware({
  target: config.metricsUrl,
  changeOrigin: true,
  pathFilter: '/api/metrics',
});
// Сервіс data експонує маршрути /api/records; gateway монтує їх під /api/data/*
// та переписує шлях (топологія шлюзу відокремлена від домену сервісу).
const dataProxy = createProxyMiddleware({
  target: config.dataUrl,
  changeOrigin: true,
  pathFilter: '/api/data',
  pathRewrite: (path: string) => path.replace(/^\/api\/data/, '/api'),
});

/** Процесна телеметрія з graceful fallback (pidusage може не працювати на Windows). */
async function selfProcessInfo(): Promise<ServiceStatus['process']> {
  try {
    const stats = await pidusage(process.pid);
    return {
      pid: stats.pid,
      cpu: Math.round(stats.cpu * 10) / 10,
      memory: stats.memory,
      uptimeSec: Math.round(process.uptime()),
      source: 'pidusage',
    };
  } catch {
    return {
      pid: process.pid,
      cpu: 0,
      memory: process.memoryUsage().rss,
      uptimeSec: Math.round(process.uptime()),
      source: 'process',
    };
  }
}

app.get('/', (_req, res) => {
  res.json({
    service: config.serviceName,
    version: config.version,
    endpoints: {
      status: '/api/status',
      metrics: '/api/metrics',
      records: '/api/data/records',
      health: '/health',
    },
  });
});

app.get('/health', (_req, res) => {
  res.json({
    status: 'ok',
    service: config.serviceName,
    version: config.version,
    uptime: process.uptime(),
    timestamp: Date.now(),
  });
});

/**
 * Агрегація стану всієї платформи: health-перевірка кожного сервісу
 * + процесна телеметрія самого gateway (pid, CPU, пам'ять).
 */
app.get('/api/status', async (_req, res) => {
  try {
    const selfProcess = await selfProcessInfo();
    const children: ServiceStatus[] = await collectStatus([
      { name: 'metrics', url: config.metricsUrl },
      { name: 'data', url: config.dataUrl },
    ]);

    const self: ServiceStatus = {
      name: 'gateway',
      url: `http://localhost:${config.port}`,
      healthy: true,
      status: 'ok',
      latencyMs: 0,
      error: null,
      version: config.version,
      process: selfProcess,
    };

    res.json([self, ...children]);
  } catch (err) {
    res.status(500).json({
      error: 'failed to collect platform status',
      detail: err instanceof Error ? err.message : String(err),
    });
  }
});

// Проксі підключаємо глобально (pathFilter відфільтровує потрібні шляхи).
app.use(metricsProxy);
app.use(dataProxy);

// Централізована обробка помилок: без HTML-стек-трейсів назовні (безпека).
// eslint-disable-next-line @typescript-eslint/no-unused-vars
app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  if (err instanceof SyntaxError) {
    res.status(400).json({ error: 'bad_request', detail: 'invalid JSON body' });
    return;
  }
  console.error(err);
  res.status(500).json({ error: 'internal_error' });
});

const server = app.listen(config.port, () => {
  console.log(
    `[gateway] listening on http://localhost:${config.port} (v${config.version})`,
  );
  console.log(`[gateway] metrics -> ${config.metricsUrl}`);
  console.log(`[gateway] data    -> ${config.dataUrl}`);
});

function shutdown(): void {
  server.close(() => process.exit(0));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);