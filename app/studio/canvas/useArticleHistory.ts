"use client";
import { useEffect, useRef, useState } from "react";

/** Article snapshots share immutable image strings; coalesce adjacent typing, never structural edits. */
export function useArticleHistory<T>(article: T | undefined, apply: (article: T) => void, scope: string) {
  const [history, setHistory] = useState<{ past: T[]; future: T[] }>({ past: [], future: [] });
  const expected = useRef<T | undefined>(article); const activeScope = useRef(scope); const typing = useRef({ key: "", at: 0 });
  useEffect(() => {
    if (activeScope.current !== scope) {
      activeScope.current = scope; expected.current = article; typing.current = { key: "", at: 0 }; setHistory({ past: [], future: [] });
    } else if (expected.current !== article) {
      const previous = expected.current;
      expected.current = article; typing.current = { key: "", at: 0 };
      if (previous && article && JSON.stringify(previous) !== JSON.stringify(article)) setHistory((current) => ({ past: [...current.past.slice(-39), previous], future: [] }));
    }
  }, [article, scope]);
  const change = (next: T, key = "") => {
    if (!article || next === article || JSON.stringify(article) === JSON.stringify(next)) return;
    const now = Date.now(); const coalesce = key && key === typing.current.key && now - typing.current.at < 800;
    setHistory((current) => ({ past: coalesce ? current.past : [...current.past.slice(-39), article], future: [] }));
    typing.current = { key, at: now }; expected.current = next; apply(next);
  };
  const undo = () => {
    const next = history.past.at(-1); if (!article || !next) return;
    expected.current = next; typing.current.key = ""; setHistory({ past: history.past.slice(0, -1), future: [article, ...history.future] }); apply(next);
  };
  const redo = () => {
    const next = history.future[0]; if (!article || !next) return;
    expected.current = next; typing.current.key = ""; setHistory({ past: [...history.past, article], future: history.future.slice(1) }); apply(next);
  };
  return { change, undo, redo, canUndo: Boolean(history.past.length), canRedo: Boolean(history.future.length) };
}
