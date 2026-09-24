import type { ServiceStatus } from '../types';
import { formatBytes, formatUptime } from '../utils';
import StatusBadge from './StatusBadge';

export default function ServiceCard({ service }: { service: ServiceStatus }) {
  return (
    <div className={`card service-card ${service.status === 'down' ? 'down' : ''}`}>
      <div className="service-head">
        <div className="service-name">
          <span className="service-dot" />
          {service.name}
        </div>
        <StatusBadge status={service.status} />
      </div>

      <div className="service-meta">
        <div className="meta-row">
          <span className="muted">Версія</span>
          <span>{service.version ?? '—'}</span>
        </div>
        <div className="meta-row">
          <span className="muted">Latency</span>
          <span>{service.latencyMs !== null ? `${service.latencyMs} мс` : '—'}</span>
        </div>
        {service.process && (
          <>
            <div className="meta-row">
              <span className="muted">PID</span>
              <span>{service.process.pid}</span>
            </div>
            <div className="meta-row">
              <span className="muted">CPU</span>
              <span>{service.process.cpu.toFixed(1)}%</span>
            </div>
            <div className="meta-row">
              <span className="muted">Пам'ять</span>
              <span>{formatBytes(service.process.memory)}</span>
            </div>
            <div className="meta-row">
              <span className="muted">Uptime</span>
              <span>{formatUptime(service.process.uptimeSec)}</span>
            </div>
          </>
        )}
      </div>

      <div className="service-foot muted" title={service.url}>
        {service.error ? `Помилка: ${service.error}` : service.url}
      </div>
    </div>
  );
}