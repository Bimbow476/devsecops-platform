import express from 'express';
import cors from 'cors';
import { createProxyMiddleware } from 'http-proxy-middleware';
import pidusage from 'pidusage';
import { loadConfig } from './config';
import { collectStatus, type ServiceStatus } from './status';

const app = express();
const config = loadConfig();

app.use(cors());
app.use(express.json());

// Проксі до мікросервісів
const metricsProxy = createProxyMiddleware({
  target: config.metricsUrl,
  changeOrigin: true,
});
const dataProxy = createProxyMiddleware({
  target: config.dataUrl,
  changeOrigin: true,
});

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
    const selfStats = await pidusage(process.pid);
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
      process: {
        pid: selfStats.pid,
        cpu: Math.round(selfStats.cpu * 10) / 10,
        memory: selfStats.memory,
        uptimeSec: Math.round(process.uptime()),
      },
    };

    res.json([self, ...children]);
  } catch (err) {
    res.status(500).json({
      error: 'failed to collect platform status',
      detail: err instanceof Error ? err.message : String(err),
    });
  }
});

// Проксі підключаємо після власних маршрутів, щоб вони не перехоплювались.
app.use('/api/metrics', metricsProxy);
app.use('/api/data', dataProxy);

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