import type { CSSProperties } from "react";

/** A shared moving selection surface for small, mutually exclusive choices. */
export function SegmentedControl<T extends string | number>({ value, onChange, options, label, className = "", disabled = false }: {
  value: T; onChange: (value: T) => void; label: string; className?: string; disabled?: boolean;
  options: { value: T; label: string; ariaLabel?: string }[];
}) {
  const active = options.findIndex((option) => option.value === value);
  return <div role="group" aria-label={label} className={`segmented-control ${className}`} style={{ "--segment-count": options.length, "--active-segment": Math.max(0, active) } as CSSProperties}>
    <span className="segment-indicator" data-active={active >= 0} aria-hidden="true" />
    {options.map((option) => <button key={option.value} disabled={disabled} aria-label={option.ariaLabel} aria-pressed={value === option.value} onClick={() => onChange(option.value)}>{option.label}</button>)}
  </div>;
}
