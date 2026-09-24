import os from 'node:os';
import pidusage from 'pidusage';

export interface CpuTimes {
  idle: number;
  user: number;
  nice: number;
  sys: number;
  irq: number;
}

/** Відсоток завантаження ядра CPU на основі лічильників часу. */
export function cpuUsagePercent(times: CpuTimes): number {
  const total = times.idle + times.user + times.nice + times.sys + times.irq;
  if (total <= 0) return 0;
  const idle = times.idle;
  return Math.round(((total - idle) / total) * 1000) / 10;
}

export interface ProcessInfo {
  pid: number;
  name: string;
  cpu: number;
  memory: number;
  uptimeSec: number;
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

export async function getSelfProcessInfo(): Promise<ProcessInfo> {
  const stats = await pidusage(process.pid);
  return {
    pid: stats.pid,
    name: 'node (metrics)',
    cpu: Math.round(stats.cpu * 10) / 10,
    memory: stats.memory,
    uptimeSec: Math.round(process.uptime()),
  };
}

/** Збирає системні метрики хоста та телеметрію власного процесу. */
export async function getSystemMetrics(): Promise<SystemMetrics> {
  const cpus = os.cpus();
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;

  return {
    hostname: os.hostname(),
    platform: os.platform(),
    arch: os.arch(),
    uptime: os.uptime(),
    loadavg: os.loadavg(),
    cpu: {
      model: cpus[0]?.model ?? 'unknown',
      cores: cpus.length,
      usagePerCore: cpus.map((c) => cpuUsagePercent(c.times)),
    },
    memory: {
      total,
      free,
      used,
      usagePercent: total > 0 ? Math.round((used / total) * 1000) / 10 : 0,
    },
    processes: [await getSelfProcessInfo()],
    timestamp: Date.now(),
  };
}