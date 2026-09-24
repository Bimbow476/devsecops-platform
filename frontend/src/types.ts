export interface ProcessInfo {
  pid: number;
  name: string;
  cpu: number;
  memory: number;
  uptimeSec: number;
  source: 'pidusage' | 'process';
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

export interface SystemMetrics {
  hostname: string;
  platform: string;
  arch: string;
  uptime: number;
  loadavg: number[];
  cpu: {
    model: string;
    cores: number;
    usagePerCore: number[];
  };
  memory: {
    total: number;
    free: number;
    used: number;
    usagePercent: number;
  };
  processes: ProcessInfo[];
  timestamp: number;
}

export interface RecordItem {
  id: number;
  title: string;
  description: string | null;
  status: string;
  priority: number;
  created_at: string;
  updated_at: string;
}

export interface RecordsPage {
  items: RecordItem[];
  total: number;
  limit: number;
  offset: number;
}

export interface RecordInput {
  title: string;
  description?: string | null;
  status?: string;
  priority?: number;
}