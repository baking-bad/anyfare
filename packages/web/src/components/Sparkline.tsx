/** A 96 by 28 line of recent values, in the text color. Fewer than two values draw a flat line. `label` names it for screen readers. */
export const Sparkline = ({ values, label }: { readonly values: readonly number[]; readonly label?: string }) => {
  const width = 96;
  const height = 28;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  const points = values.length > 1
    ? values.map((value, i) => `${(i * width / (values.length - 1)).toFixed(1)},${(height - 2 - (height - 4) * (value - min) / span).toFixed(1)}`)
    : [`0,${height / 2}`, `${width},${height / 2}`];

  return (
    <svg className="spark" viewBox={`0 0 ${width} ${height}`} {...label === undefined ? { 'aria-hidden': true } : { role: 'img', 'aria-label': label }}>
      <path d={`M${points.join('L')}`} />
    </svg>
  );
};
