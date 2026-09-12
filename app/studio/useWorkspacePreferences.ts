"use client";

import { useEffect, useState } from "react";

const STORAGE_KEY = "opslion:workspace-preferences:v1";
export const PREVIEW_MIN_WIDTH = 320;
export const PREVIEW_MAX_WIDTH = 640;

export function useWorkspacePreferences() {
  const [dark, setDark] = useState(false);
  const [previewWidth, setPreviewWidth] = useState(390);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    if (!ready) return;
    // Enable color interpolation after the stored theme has painted once.
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => { document.documentElement.dataset.appearanceReady = "true"; });
    });
    return () => { cancelAnimationFrame(frame); delete document.documentElement.dataset.appearanceReady; };
  }, [ready]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      let nextDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
      let nextWidth = 390;
      try {
        const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
        if (typeof stored?.dark === "boolean") nextDark = stored.dark;
        if (typeof stored?.previewWidth === "number" && Number.isFinite(stored.previewWidth)) {
          nextWidth = Math.min(PREVIEW_MAX_WIDTH, Math.max(PREVIEW_MIN_WIDTH, Math.round(stored.previewWidth)));
        }
      } catch { /* Unavailable or invalid storage must not prevent editing. */ }
      setDark(nextDark);
      setPreviewWidth(nextWidth);
      setReady(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (!ready) return;
    // Retire the old toggle, including previously persisted motion: false.
    document.documentElement.dataset.motion = "on";
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    const timer = window.setTimeout(() => {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify({ dark, previewWidth })); }
      catch { /* Keep session preferences usable when storage is full. */ }
    }, 200);
    return () => window.clearTimeout(timer);
  }, [dark, previewWidth, ready]);

  return { dark, setDark, previewWidth, setPreviewWidth, ready };
}
