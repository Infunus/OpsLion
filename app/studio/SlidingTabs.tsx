import type { CSSProperties } from "react";
import { StudioIcon, type StudioIconName } from "./StudioIcon";

export function SlidingTabs<T extends string>({ value, onChange, items, label, className = "" }: {
  value: T; onChange: (value: T) => void; label: string; className?: string;
  items: { id: T; label: string; icon?: StudioIconName }[];
}) {
  const activeIndex = Math.max(0, items.findIndex((item) => item.id === value));
  return <nav className={`sliding-tabs ${className}`} aria-label={label} style={{ "--tab-count": items.length, "--active-tab": activeIndex } as CSSProperties}>
    <span className="tab-indicator" aria-hidden="true" />
    {items.map((item) => <button key={item.id} className={value === item.id ? "active" : ""} aria-pressed={value === item.id} onClick={() => onChange(item.id)}>{item.icon && <StudioIcon name={item.icon} />}<span>{item.label}</span></button>)}
  </nav>;
}
