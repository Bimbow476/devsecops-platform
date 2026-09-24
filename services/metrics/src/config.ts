export interface AppConfig {
  port: number;
  serviceName: string;
  version: string;
}

export function parsePort(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed) || parsed <= 0 || parsed > 65535) return fallback;
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    port: parsePort(env.PORT, 8081),
    serviceName: env.SERVICE_NAME ?? 'metrics',
    version: env.VERSION ?? '0.1.0',
  };
}