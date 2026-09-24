export default function MetricBar({
  label,
  value,
  suffix = '%',
  color,
}: {
  label: string;
  value: number;
  suffix?: string;
  color?: 'accent' | 'warn' | 'err';
}) {
  const clamped = Math.min(Math.max(value, 0), 100);
  const tone = color ?? (clamped >= 85 ? 'err' : clamped >= 60 ? 'warn' : 'accent');
  return (
    <div className="metric-bar">
      <div className="metric-bar-label">
        <span>{label}</span>
        <span className="metric-bar-value">
          {value.toFixed(1)}
          {suffix}
        </span>
      </div>
      <div className="metric-bar-track">
        <div
          className={`metric-bar-fill ${tone}`}
          style={{ width: `${clamped}%` }}
        />
      </div>
    </div>
  );
}