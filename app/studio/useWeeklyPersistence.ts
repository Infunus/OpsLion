"use client";
import { useEffect, useState } from "react";
import type { WeeklyDraft } from "./project-schema";
import { loadWeeklyDraft, saveWeeklyDraft } from "./storage";
import { useAutosave } from "./useAutosave";

export const emptyWeeklyDraft = (): WeeklyDraft => ({ preparedCopy: null });
export function useWeeklyPersistence() {
  const [weekly, setWeekly] = useState<WeeklyDraft>(emptyWeeklyDraft);
  const [ready, setReady] = useState(false);
  const [writable, setWritable] = useState(false);
  const [loadError, setLoadError] = useState("");
  useEffect(() => {
    let cancelled = false;
    void loadWeeklyDraft().then((draft) => {
      if (cancelled) return;
      setWeekly(draft || emptyWeeklyDraft()); setWritable(true);
    }).catch(() => { if (!cancelled) setLoadError("周报草稿无法读取，原始数据已保留，请下载存储备份。"); })
      .finally(() => { if (!cancelled) setReady(true); });
    return () => { cancelled = true; };
  }, []);
  const autosave = useAutosave(weekly, ready && writable, saveWeeklyDraft);
  return { weekly, setWeekly, ready, writable, saveState: loadError ? "草稿未保存" : autosave.saveState, storageError: loadError || autosave.error, flush: autosave.flush };
}
