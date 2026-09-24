import { useEffect, useState } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { api } from '../api/client';
import MetricBar from '../components/MetricBar';
import { usePolling } from '../hooks/usePolling';
import { average, formatBytes, formatUptime } from '../utils';

const HISTORY_LIMIT = 60;

interface HistoryPoint {
  t: string;
  cpu: number;
  mem: number;
}

export default function MetricsPage() {
  const { data, error, retries } = usePolling(api.metrics, 3000);
  const [history, setHistory] = useState<HistoryPoint[]>([]);

  useEffect(() => {
    if (!data) return;
    const cpuAvg = average(data.cpu.usagePerCore);
    setHistory((prev) => [
      ...prev.slice(-(HISTORY_LIMIT - 1)),
      {
        t: new Date(data.timestamp).toLocaleTimeString('uk-UA'),
        cpu: Math.round(cpuAvg * 10) / 10,
        mem: data.memory.usagePercent,
      },
    ]);
  }, [data]);

  return (
    <div>
      <header className="page-head">
        <h1>Системні метрики</h1>
        <p className="muted">CPU, пам'ять та Load Average хоста · автооновлення кожні 3 секунди</p>
      </header>

      {error && (
        <div className="banner error">
          ⚠️ Не вдається отримати метрики (спроба {retries})
        </div>
      )}

      {data && (
        <>
          <section className="cards compact">
            <div className="card stat">
              <div className="muted">Хост</div>
              <div className="stat-value">{data.hostname}</div>
              <div className="muted">
                {data.platform} · {data.arch}
              </div>
            </div>
            <div className="card stat">
              <div className="muted">Uptime системи</div>
              <div className="stat-value">{formatUptime(data.uptime)}</div>
              <div className="muted">Load average: {data.loadavg.map((v) => v.toFixed(2)).join(' / ')}</div>
            </div>
            <div className="card stat">
              <div className="muted">CPU</div>
              <div className="stat-value">{average(data.cpu.usagePerCore).toFixed(1)}%</div>
              <div className="muted">{data.cpu.cores} ядер · {data.cpu.model}</div>
            </div>
            <div className="card stat">
              <div className="muted">Пам'ять</div>
              <div className="stat-value">{formatBytes(data.memory.used)}</div>
              <div className="muted">
                з {formatBytes(data.memory.total)} · {data.memory.usagePercent.toFixed(1)}%
              </div>
            </div>
          </section>

          <section className="info-block">
            <h2>Історія навантаження</h2>
            <div className="chart">
              <ResponsiveContainer width="100%" height={280}>
                <AreaChart data={history}>
                  <defs>
                    <linearGradient id="gCpu" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#38bdf8" stopOpacity={0.6} />
                      <stop offset="100%" stopColor="#38bdf8" stopOpacity={0.05} />
                    </linearGradient>
                    <linearGradient id="gMem" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#4ade80" stopOpacity={0.6} />
                      <stop offset="100%" stopColor="#4ade80" stopOpacity={0.05} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
                  <XAxis dataKey="t" stroke="#94a3b8" fontSize={11} />
                  <YAxis stroke="#94a3b8" fontSize={11} domain={[0, 100]} unit="%" />
                  <Tooltip
                    contentStyle={{ background: '#0f172a', border: '1px solid #334155', borderRadius: 8 }}
                  />
                  <Legend />
                  <Area
                    type="monotone"
                    dataKey="cpu"
                    name="CPU %"
                    stroke="#38bdf8"
                    fill="url(#gCpu)"
                    strokeWidth={2}
                  />
                  <Area
                    type="monotone"
                    dataKey="mem"
                    name="Пам'ять %"
                    stroke="#4ade80"
                    fill="url(#gMem)"
                    strokeWidth={2}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </section>

          <section className="info-block">
            <h2>Використання пам'яті</h2>
            <MetricBar
              label="Пам'ять (RSS)"
              value={data.memory.usagePercent}
              color={data.memory.usagePercent >= 85 ? 'err' : data.memory.usagePercent >= 60 ? 'warn' : 'accent'}
            />
          </section>

          <section className="info-block">
            <h2>Завантаження ядер CPU</h2>
            <div className="core-grid">
              {data.cpu.usagePerCore.map((usage, index) => (
                <MetricBar key={index} label={`Ядро ${index + 1}`} value={usage} />
              ))}
            </div>
          </section>

          <section className="info-block">
            <h2>Процеси платформи</h2>
            <table className="table">
              <thead>
                <tr>
                  <th>PID</th>
                  <th>Процес</th>
                  <th>CPU</th>
                  <th>Пам'ять</th>
                  <th>Uptime</th>
                </tr>
              </thead>
              <tbody>
                {data.processes.map((p) => (
                  <tr key={p.pid}>
                    <td>{p.pid}</td>
                    <td>{p.name}</td>
                    <td>{p.cpu.toFixed(1)}%</td>
                    <td>{formatBytes(p.memory)}</td>
                    <td>{formatUptime(p.uptimeSec)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}

      {!data && !error && <div className="banner">Завантаження метрик…</div>}
    </div>
  );
}