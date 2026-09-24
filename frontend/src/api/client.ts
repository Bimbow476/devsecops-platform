import type { RecordInput, RecordItem, RecordsPage, ServiceStatus, SystemMetrics } from '../types';

const TIMEOUT_MS = 5000;

export async function apiGet<T>(path: string): Promise<T> {
  const res = await fetch(path, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`API error: HTTP ${res.status}`);
  return (await res.json()) as T;
}

export type MutateMethod = 'POST' | 'PUT' | 'DELETE';

export async function apiSend<T>(
  path: string,
  method: MutateMethod,
  body?: unknown,
): Promise<T | null> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`API error: HTTP ${res.status}${text ? ` — ${text}` : ''}`);
  }
  if (res.status === 204) return null;
  return (await res.json()) as T;
}

export interface RecordsQuery {
  search?: string;
  status?: string;
  offset?: number;
  limit?: number;
}

export const api = {
  status: () => apiGet<ServiceStatus[]>('/api/status'),
  metrics: () => apiGet<SystemMetrics>('/api/metrics'),
  records: (query: RecordsQuery = {}) => {
    const params = new URLSearchParams();
    if (query.search) params.set('search', query.search);
    if (query.status) params.set('status', query.status);
    if (query.limit !== undefined) params.set('limit', String(query.limit));
    if (query.offset !== undefined) params.set('offset', String(query.offset));
    const qs = params.toString();
    return apiGet<RecordsPage>(`/api/data/records${qs ? `?${qs}` : ''}`);
  },
  createRecord: (input: RecordInput) =>
    apiSend<RecordItem>('/api/data/records', 'POST', input),
  updateRecord: (id: number, patch: RecordInput) =>
    apiSend<RecordItem>(`/api/data/records/${id}`, 'PUT', patch),
  deleteRecord: (id: number) => apiSend<void>(`/api/data/records/${id}`, 'DELETE'),
};