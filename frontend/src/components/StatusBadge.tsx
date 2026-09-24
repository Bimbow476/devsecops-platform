export type BadgeStatus = 'ok' | 'down' | 'degraded';

const labels: Record<BadgeStatus, string> = {
  ok: 'OK',
  degraded: 'Degraded',
  down: 'DOWN',
};

export default function StatusBadge({ status }: { status: BadgeStatus }) {
  return <span className={`badge badge-${status}`}>{labels[status]}</span>;
}