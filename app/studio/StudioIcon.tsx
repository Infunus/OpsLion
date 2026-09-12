import type { CSSProperties } from "react";

// One 24px grid, rounded joins and a consistent optical stroke throughout the UI.
const paths = {
  settings: "M21.32 10.15L21.50 12.00L19.36 13.46L18.93 14.87L19.90 17.28L18.72 18.72L16.17 18.24L14.87 18.93L13.85 21.32L12.00 21.50L10.54 19.36L9.13 18.93L6.72 19.90L5.28 18.72L5.76 16.17L5.07 14.87L2.68 13.85L2.50 12.00L4.64 10.54L5.07 9.13L4.10 6.72L5.28 5.28L7.83 5.76L9.13 5.07L10.15 2.68L12.00 2.50L13.46 4.64L14.87 5.07L17.28 4.10L18.72 5.28L18.24 7.83L18.93 9.13ZM15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z",
  cpu: "M8 5h8a3 3 0 0 1 3 3v8a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V8a3 3 0 0 1 3-3Zm1 4h6v6H9V9ZM9 2v3m6-3v3M9 19v3m6-3v3M2 9h3m-3 6h3m14-6h3m-3 6h3",
  panel: "M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Zm10 0v16",
  arrow: "M4 12h15m-5-5 5 5-5 5",
  document: "M6 3h8l5 5v11a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2Zm8 0v5h5M8 12h7m-7 4h7",
  layout: "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2ZM7 7h10M7 11h4v6H7v-6Zm8 0h2m-2 3h2m-2 3h2",
  edit: "m14 5 5 5M4 20l5-1L20 8a2.8 2.8 0 0 0-4-4L5 15l-1 5Z",
  layers: "m12 3 9 5-9 5-9-5 9-5ZM3 12l9 5 9-5M3 16l9 5 9-5",
  calendar: "M5 5h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2ZM7 3v4m10-4v4M3 11h18M7 15h2m6 0h2M7 18h2",
  sun: "M12 3v1m0 16v1M3 12h1m16 0h1M5.6 5.6l.7.7m11.4 11.4.7.7M5.6 18.4l.7-.7M17.7 6.3l.7-.7M16 12a4 4 0 1 1-8 0 4 4 0 0 1 8 0Z",
  moon: "M20.6 13.2A8.6 8.6 0 0 1 10.8 3.4a8.7 8.7 0 1 0 9.8 9.8Z",
  folder: "M3 7V6a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z",
  export: "M12 15V3m-4 4 4-4 4 4M5 12H4v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7h-1",
  download: "M12 3v12m-4-4 4 4 4-4M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3",
  upload: "M12 16V4m-4 4 4-4 4 4M4 16v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3",
  spark: "m13 6 5 5M4 20l3.5-.5L20 7a2.1 2.1 0 0 0-3-3L4.5 16.5 4 20ZM5 3v4M3 5h4M19 16v5m-2.5-2.5h5",
  check: "m5 12 4.5 4.5L19 7",
  close: "m6 6 12 12M18 6 6 18",
  trash: "M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7",
  up: "m6 14 6-6 6 6",
  down: "m6 10 6 6 6-6",
  copy: "M9 7V5a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-2M5 9h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2Z",
  eye: "M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12Zm13 0a3 3 0 1 1-6 0 3 3 0 0 1 6 0Z",
  eyeOff: "m3 3 18 18M10 5.7a13 13 0 0 1 2-.2c6.5 0 10 6.5 10 6.5a19 19 0 0 1-3 3.8M6.3 6.3A20 20 0 0 0 2 12s3.5 6.5 10 6.5a12 12 0 0 0 5.7-1.4M9.9 9.9a3 3 0 0 0 4.2 4.2",
  image: "M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2ZM3 17l6-6 4 4 3-3 5 5M17 7h.01",
  plus: "M12 5v14M5 12h14",
  focus: "M8 3H5a2 2 0 0 0-2 2v3m13-5h3a2 2 0 0 1 2 2v3M3 16v3a2 2 0 0 0 2 2h3m13-5v3a2 2 0 0 1-2 2h-3",
  collapse: "M3 8h5V3m8 0v5h5M8 21v-5H3m13 5v-5h5",
  phone: "M8 2h8a3 3 0 0 1 3 3v14a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3V5a3 3 0 0 1 3-3Zm2 3h4m-3 14h2",
  code: "m8 7-5 5 5 5m8-10 5 5-5 5M14 4l-4 16",
  external: "M14 3h7v7m0-7L11 13M10 5H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5",
  package: "m12 3 9 5v9l-9 5-9-5V8l9-5ZM3 8l9 5 9-5m-9 5v9M7.5 5.5l9 5V15",
  extension: "M9 3H4v6h2a2 2 0 1 1 0 4H4v7h7v-2a2 2 0 1 1 4 0v2h6v-7h-2a2 2 0 1 1 0-4h2V3h-6v2a3 3 0 0 1-6 0V3Z",
} as const;

export type StudioIconName = keyof typeof paths;
export function StudioIcon({ name, className = "", style }: { name: StudioIconName; className?: string; style?: CSSProperties }) {
  return <svg className={`studio-icon ${className}`} data-icon={name} style={style} width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.75" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d={paths[name]} /></svg>;
}
