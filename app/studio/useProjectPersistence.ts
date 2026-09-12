"use client";
import { useCallback, useEffect, useState, type SetStateAction } from "react";
import { recordEdit } from "./workflow/document";
import { createDefaultProject, type SavedCloneTemplate, type StudioProject } from "./types";
import { loadActiveProject, loadProjects, loadSavedTemplates, saveProject, storageNotices } from "./storage";
import { normalizeProjectTemplate } from "./project-utils";
import { useAutosave } from "./useAutosave";

export function useProjectPersistence() {
  const [project, setRawProject] = useState<StudioProject>(() => createDefaultProject("initial"));
  const setProject = useCallback((update: SetStateAction<StudioProject>, origin: "human" | "rule" | "model" = "human") => setRawProject((previous) => recordEdit(previous, typeof update === "function" ? update(previous) : update, origin)), []);
  const [projects, setProjects] = useState<StudioProject[]>([]);
  const [savedTemplates, setSavedTemplates] = useState<SavedCloneTemplate[]>([]);
  const [hydrated, setHydrated] = useState(false);
  const [storageReady, setStorageReady] = useState(false);
  const [notice, setNotice] = useState("");
  useEffect(() => {
    let cancelled = false;
    async function hydrate() {
      try {
        const all = (await loadProjects()).map(normalizeProjectTemplate);
        const active = await loadActiveProject(all);
        const templates = await loadSavedTemplates();
        if (cancelled) return;
        setRawProject(active || createDefaultProject()); setProjects(all); setSavedTemplates(templates);
        setStorageReady(true); setNotice(storageNotices().join(" "));
      } catch {
        if (cancelled) return;
        setRawProject(createDefaultProject()); setNotice("本机存储暂不可用，当前编辑可导出备份。");
      } finally { if (!cancelled) setHydrated(true); }
    }
    void hydrate();
    return () => { cancelled = true; };
  }, []);
  const persist = useCallback(async (snapshot: StudioProject) => {
    const updated = { ...snapshot, updatedAt: new Date().toISOString() };
    await saveProject(updated);
    setStorageReady(true);
    setProjects((all) => [updated, ...all.filter((item) => item.id !== updated.id)].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
  }, []);
  const autosave = useAutosave(project, hydrated, persist);
  return { project, setProject, projects, setProjects, savedTemplates, setSavedTemplates, hydrated,
    saveState: storageReady ? autosave.saveState : hydrated ? "未保存，请导出备份" : autosave.saveState,
    storageNotice: autosave.error || notice, flushProject: autosave.flush };
}
