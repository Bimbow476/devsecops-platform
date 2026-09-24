import express from 'express';
import cors from 'cors';
import { loadConfig } from './config';
import { getSystemMetrics } from './metrics';

const app = express();
const config = loadConfig();

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

app.get('/api/metrics', async (_req, res) => {
  try {
    const metrics = await getSystemMetrics();
    res.json(metrics);
  } catch (err) {
    res.status(500).json({
      error: 'failed to collect metrics',
      detail: err instanceof Error ? err.message : String(err),
    });
  }
});

const server = app.listen(config.port, () => {
  console.log(
    `[metrics] listening on http://localhost:${config.port} (v${config.version})`,
  );
});

function shutdown(): void {
  server.close(() => process.exit(0));
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);