import path from 'node:path';

export interface AppConfig {
  port: number;
  serviceName: string;
  version: string;
  dbPath: string;
}

export function parsePort(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0 || parsed > 65535) return fallback;
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: parsePort(env.PORT, 8082),
    serviceName: env.SERVICE_NAME ?? 'data',
    version: env.VERSION ?? '0.1.0',
    dbPath: env.DB_PATH ?? path.join(process.cwd(), 'data', 'records.db'),
  };
}