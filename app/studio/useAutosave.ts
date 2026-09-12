"use client";
import { useCallback, useEffect, useRef, useState } from "react";

/** Flush on tab hiding and project switches; warn only while a write is pending. */
export function useAutosave<T>(value: T, ready: boolean, save: (value: T) => Promise<void>) {
  const pending = useRef<T | null>(null);
  const writer = useRef(save);
  const running = useRef<Promise<void> | null>(null);
  const [saved, setSaved] = useState<T | null>(null);
  const [error, setError] = useState("");
  useEffect(() => { writer.current = save; }, [save]);
  const flush = useCallback(async function flushPending(): Promise<void> {
    if (running.current) { await running.current; if (pending.current !== null) return flushPending(); return; }
    const snapshot = pending.current;
    if (snapshot === null) return;
    const task = writer.current(snapshot).then(() => {
      if (pending.current === snapshot) pending.current = null;
      setSaved(() => snapshot); setError("");
    }).catch((reason) => { setError(reason instanceof Error ? reason.message : "保存失败"); throw reason; });
    running.current = task;
    try { await task; } finally { running.current = null; }
  }, []);
  useEffect(() => {
    if (!ready) return;
    pending.current = value;
    const timer = setTimeout(() => { void flush().catch(() => {}); }, 400);
    return () => clearTimeout(timer);
  }, [value, ready, flush]);
  useEffect(() => {
    const onHide = () => { if (document.visibilityState === "hidden") void flush().catch(() => {}); };
    const onLeave = (event: BeforeUnloadEvent) => {
      if (pending.current !== null) { void flush().catch(() => {}); event.preventDefault(); event.returnValue = ""; }
    };
    document.addEventListener("visibilitychange", onHide);
    window.addEventListener("beforeunload", onLeave);
    return () => { document.removeEventListener("visibilitychange", onHide); window.removeEventListener("beforeunload", onLeave); };
  }, [flush]);
  return { flush, error, saveState: error ? "保存失败，请备份或重试" : !ready ? "正在读取草稿…" : saved === value ? "已保存到本机" : "正在保存…" };
}
