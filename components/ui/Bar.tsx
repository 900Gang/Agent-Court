export function Bar({
  label,
  value,
  max,
  display,
}: {
  label: string;
  value: number;
  max: number;
  display?: string;
}) {
  const safeMax = Number.isFinite(max) && max > 0 ? max : 0;
  const safeValue = Number.isFinite(value) ? Math.min(Math.max(value, 0), safeMax) : 0;
  const percent = safeMax === 0 ? 0 : Math.round((safeValue / safeMax) * 100);

  return (
    <div className="bar-row">
      <span className="bar-label">{label}</span>
      <div
        className="bar"
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={safeMax}
        aria-valuenow={safeValue}
      >
        <i className="bar-fill" style={{ width: `${percent}%` }} />
      </div>
      <span className="bar-value">{display ?? `${value} / ${max}`}</span>
    </div>
  );
}
