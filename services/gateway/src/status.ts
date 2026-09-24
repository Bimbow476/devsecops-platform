export interface ChildService {
  name: string;
  url: string;
}

export interface ProcessInfo {
  pid: number;
  cpu: number;
  memory: number;
  uptimeSec: number;
}

export interface ServiceStatus {
  name: string;
  url: string;
  healthy: boolean;
  status: 'ok' | 'down';
  latencyMs: number | null;
  error: string | null;
  version: string | null;
  process: ProcessInfo | null;
}

/** Тип fetch-функції, що інжектується для тестування. */
export type Fetcher = (
  url: string,
  init?: { signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

export interface CheckOptions {
  timeoutMs?: number;
  fetcher?: Fetcher;
}

/**
 * Перевіряє health-ендпоінт дочірнього сервісу.
 * Повертає статус сервісу та затримку відповіді (latency).
 */
export async function checkService(
  svc: ChildService,
  options: CheckOptions = {},
): Promise<ServiceStatus> {
  const timeoutMs = options.timeoutMs ?? 2000;
  const fetcher: Fetcher = options.fetcher ?? ((url, init) => fetch(url, init));
  const started = Date.now();

  const base = {
    name: svc.name,
    url: svc.url,
    process: null,
  };

  try {
    const res = await fetcher(`${svc.url}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    const latencyMs = Date.now() - started;

    if (!res.ok) {
      return {
        ...base,
        healthy: false,
        status: 'down',
        latencyMs,
        error: `HTTP ${res.status}`,
        version: null,
      };
    }

    const body = (await res.json()) as { status?: string; version?: string };
    return {
      ...base,
      healthy: true,
      status: 'ok',
      latencyMs,
      error: null,
      version: typeof body.version === 'string' ? body.version : null,
    };
  } catch (err) {
    return {
      ...base,
      healthy: false,
      status: 'down',
      latencyMs: Date.now() - started,
      error: err instanceof Error ? err.message : String(err),
      version: null,
    };
  }
}

export function collectStatus(children: ChildService[]): Promise<ServiceStatus[]> {
  return Promise.all(children.map((child) => checkService(child)));
}

/** Форматує відповідь /health у нормалізований вигляд (вживається в тестах). */
export function normalizeHealth(body: unknown): { status?: string; version?: string } {
  if (typeof body !== 'object' || body === null) return {};
  const record = body as Record<string, unknown>;
  return {
    status: typeof record.status === 'string' ? record.status : undefined,
    version: typeof record.version === 'string' ? record.version : undefined,
  };
}