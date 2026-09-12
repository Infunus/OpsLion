import { projectSchema, savedTemplateSchema, weeklyDraftSchema, type WeeklyDraft } from "./project-schema";
import type { SavedCloneTemplate, StudioProject } from "./types";
import type { z } from "zod";
import { backupLayoutLibrary } from "./template-engine/library-store";
import { assetSchema, type Asset } from "./submission/types";

const LEGACY_KEYS = { projects: "wechat-agent-studio:projects:v1", templates: "wechat-agent-studio:templates:v1", active: "wechat-agent-studio:active:v1" };
const STORES = ["projects", "templates", "drafts", "assets", "meta", "recovery"] as const;
type Store = typeof STORES[number];
type RecordEnvelope = { version: 2; value: unknown; assetIds?: string[]; revision?: number };
const observedRevisions = new Map<string, number>();
let databasePromise: Promise<IDBDatabase> | undefined;
let migrationPromise: Promise<void> | undefined;
const notices = new Set<string>();
export const storageNotices = () => [...notices];
const request = <T>(operation: IDBRequest<T>) => new Promise<T>((resolve, reject) => { operation.onsuccess = () => resolve(operation.result); operation.onerror = () => reject(operation.error); });
const completed = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => { tx.oncomplete = () => resolve(); tx.onabort = () => reject(tx.error || new Error("存储事务已取消")); tx.onerror = () => reject(tx.error); });

function openDatabase(): Promise<IDBDatabase> {
  if (!databasePromise) databasePromise = new Promise<IDBDatabase>((resolve, reject) => {
    const operation = indexedDB.open("opslion-workspace", 1);
    operation.onupgradeneeded = () => { for (const name of STORES) if (!operation.result.objectStoreNames.contains(name)) operation.result.createObjectStore(name); };
    operation.onsuccess = () => { const db = operation.result; db.onversionchange = () => { db.close(); databasePromise = undefined; }; resolve(db); };
    operation.onerror = () => reject(operation.error);
    operation.onblocked = () => reject(new Error("请关闭其他工作台标签页后重试"));
  }).catch((error) => { databasePromise = undefined; throw error; });
  return databasePromise;
}
async function read<T>(store: Store, key: string): Promise<T | undefined> { const db = await openDatabase(); return request(db.transaction(store).objectStore(store).get(key)); }
async function entries(store: Store): Promise<[IDBValidKey, unknown][]> {
  const db = await openDatabase(); const source = db.transaction(store).objectStore(store);
  const [keys, values] = await Promise.all([request(source.getAllKeys()), request(source.getAll())]);
  return keys.map((key, index) => [key, values[index]]);
}
async function write(store: Store, key: string, value: unknown) {
  const db = await openDatabase(); const tx = db.transaction(store, "readwrite"); const done = completed(tx);
  try { tx.objectStore(store).put(value, key); }
  catch (error) { tx.abort(); await done.catch(() => {}); throw error; }
  await done;
}
const DATA_IMAGE = /data:image\/(?:png|jpe?g|gif|webp|avif);base64,[a-z\d+/=]+/gi;
const ASSET_REF = /opslion-asset:[a-f\d]{64}/g;
const assetCache = new Map<string, Promise<{ key: string; blob: Blob }>>();
function prepareAsset(data: string) {
  let cached = assetCache.get(data);
  if (!cached) {
    // Cache in-flight preparation too: source HTML and slots often share an image.
    cached = (async () => {
      const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(data));
      const key = `opslion-asset:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
      const [header, body] = data.split(",");
      const blob = new Blob([Uint8Array.from(atob(body), (char) => char.charCodeAt(0))], { type: header.slice(5).split(";")[0] });
      return { key, blob };
    })();
    if (assetCache.size >= 4) assetCache.delete(assetCache.keys().next().value!);
    assetCache.set(data, cached);
    void cached.catch(() => assetCache.delete(data));
  }
  return cached;
}
const blobToDataUrl = (blob: Blob) => new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob); });
async function mapStrings(value: unknown, transform: (value: string) => Promise<string>): Promise<unknown> {
  if (typeof value === "string") return transform(value);
  if (Array.isArray(value)) return Promise.all(value.map((item) => mapStrings(item, transform)));
  // Preformatted weekly copy is opaque, even when it contains literal data URLs or asset markers.
  if (value && typeof value === "object") return Object.fromEntries(await Promise.all(Object.entries(value).map(async ([key, item]) => [key, key === "preparedCopy" ? item : await mapStrings(item, transform)])));
  return value;
}
async function pack(value: unknown) {
  const assets = new Map<string, Blob>();
  const packed = await mapStrings(value, async (text) => {
    for (const data of new Set(text.match(DATA_IMAGE) || [])) {
      const { key, blob } = await prepareAsset(data);
      assets.set(key, blob);
      text = text.replaceAll(data, key);
    }
    return text;
  });
  return { packed, assets };
}
async function unpack(value: unknown) {
  const cache = new Map<string, Promise<string>>();
  return mapStrings(value, async (text) => {
    for (const key of new Set(text.match(ASSET_REF) || [])) {
      if (!cache.has(key)) cache.set(key, read<Blob>("assets", key).then((blob) => { if (!(blob instanceof Blob)) throw new Error("图片数据缺失"); return blobToDataUrl(blob); }));
      text = text.replaceAll(key, await cache.get(key)!);
    }
    return text;
  });
}
// Serialize mutations so slow image hashing cannot overwrite a more recent edit.
let queue: Promise<unknown> = Promise.resolve();
function enqueue<T>(action: () => Promise<T>): Promise<T> { const next = queue.then(action); queue = next.catch(() => {}); return next; }
async function writeRecord(store: "projects" | "templates" | "drafts", key: string, value: unknown, active = false) {
  const { packed, assets } = await pack(value);
  const assetIds = [...new Set([...assets.keys(), ...(JSON.stringify(packed, (key, item) => key === "preparedCopy" ? null : item).match(ASSET_REF) ?? [])])];
  let previous: RecordEnvelope | undefined;
  let nextRevision = 0;
  const db = await openDatabase(); const tx = db.transaction([store, "assets", "meta"], "readwrite"); const done = completed(tx);
  try {
    previous = await request<RecordEnvelope | undefined>(tx.objectStore(store).get(key));
    const actual = previous?.revision ?? 0;
    if (store === "projects" && actual !== (observedRevisions.get(key) ?? 0)) {
      throw new Error("其他标签页已更新这篇稿件。当前编辑仍保留，请存为副本或导出备份后重新打开。");
    }
    nextRevision = actual + 1;
    for (const [id, blob] of assets) {
      const assetStore = tx.objectStore("assets"); const existing = assetStore.getKey(id);
      existing.onsuccess = () => { if (existing.result === undefined) assetStore.put(blob, id); };
    }
    tx.objectStore(store).put({ version: 2, value: packed, assetIds, revision: nextRevision } satisfies RecordEnvelope, key);
    if (active) tx.objectStore("meta").put(key, "active");
  } catch (error) { tx.abort(); await done.catch(() => {}); throw error; }
  await done;
  if (store === "projects") observedRevisions.set(key, nextRevision);
  if (previous && JSON.stringify(previous.assetIds) !== JSON.stringify(assetIds)) await collectUnusedAssets();
}

/** Read all references and remove orphans in one transaction, including other tabs. */
async function collectUnusedAssets() {
  const db = await openDatabase(); const tx = db.transaction(["projects", "templates", "drafts", "assets"], "readwrite"); const done = completed(tx);
  const referenced = new Set<string>(); let remaining = 3; let unknownVersion = false;
  for (const name of ["projects", "templates", "drafts"]) {
    const records = tx.objectStore(name).getAll();
    records.onsuccess = () => {
      for (const record of records.result as RecordEnvelope[]) {
        if (record?.version !== 2) { unknownVersion = true; continue; }
        for (const key of record.assetIds || JSON.stringify(record.value).match(ASSET_REF) || []) referenced.add(key);
      }
      if (--remaining || unknownVersion) return;
      const cursor = tx.objectStore("assets").openCursor();
      cursor.onsuccess = () => { const item = cursor.result; if (!item) return; if (!referenced.has(String(item.key))) item.delete(); item.continue(); };
    };
  }
  await done;
}
async function migrate() {
  if (await read("meta", "legacy-migrated")) return;
  let readable = true;
  for (const store of ["projects", "templates"] as const) {
    let raw: string | null = null;
    try { raw = localStorage.getItem(LEGACY_KEYS[store]); }
    catch { readable = false; notices.add("无法读取旧版存储；可继续编辑并导出备份。"); continue; }
    if (!raw) continue;
    let values: unknown;
    try { values = JSON.parse(raw); } catch { await write("recovery", LEGACY_KEYS[store], raw); continue; }
    if (!Array.isArray(values)) { await write("recovery", LEGACY_KEYS[store], raw); continue; }
    let invalid = false;
    for (const value of values) {
      const parsed = (store === "projects" ? projectSchema : savedTemplateSchema).safeParse(value);
      if (!parsed.success) { invalid = true; continue; }
      if (!(await read(store, parsed.data.id))) await writeRecord(store, parsed.data.id, parsed.data);
    }
    if (invalid) await write("recovery", LEGACY_KEYS[store], raw);
  }
  try { const active = localStorage.getItem(LEGACY_KEYS.active); if (active) await write("meta", "active", active); }
  catch { notices.add("无法读取上次使用的项目。"); }
  if (readable) await write("meta", "legacy-migrated", true);
  // Keep the old keys intact. They remain a recovery copy, never a write target.
}
export async function initializeStorage() {
  if (!migrationPromise) migrationPromise = migrate().catch((error) => { migrationPromise = undefined; throw error; });
  await migrationPromise;
  if ((await entries("recovery")).length) notices.add("部分旧记录无法读取，原始数据已保留。");
}
async function loadRecords<T>(store: "projects" | "templates", schema: z.ZodType<T>): Promise<T[]> {
  await initializeStorage(); const valid: T[] = [];
  for (const [key, envelope] of await entries(store)) {
    try {
      const record = envelope as RecordEnvelope;
      if (record?.version !== 2) throw new Error("不支持的数据版本");
      valid.push(schema.parse(await unpack(record.value)));
      if (store === "projects" && !observedRevisions.has(String(key))) observedRevisions.set(String(key), record.revision ?? 0);
    } catch { notices.add("部分记录无法读取，原始数据已保留，可下载备份。"); }
  }
  return valid;
}
export const loadProjects = () => loadRecords("projects", projectSchema);
export const loadSavedTemplates = () => loadRecords("templates", savedTemplateSchema);
export async function loadActiveProject(projects?: StudioProject[]) { const all = projects || await loadProjects(); const active = await read<string>("meta", "active"); return all.find((item) => item.id === active) ?? all[0] ?? null; }
export const saveProject = (project: StudioProject) => enqueue(async () => { await initializeStorage(); await writeRecord("projects", project.id, project, true); });
export async function saveProjectVersion(project: StudioProject, reason: string): Promise<StudioProject> {
  const now = new Date().toISOString();
  const version = { ...project, id: `version-${crypto.randomUUID()}`, name: `${project.name}（${reason}前 · ${new Date().toLocaleString("zh-CN")}）`, createdAt: now, updatedAt: now };
  await enqueue(async () => { await initializeStorage(); await writeRecord("projects", version.id, version); });
  return version;
}
export const saveReusableTemplate = (template: SavedCloneTemplate) => enqueue(async () => { await initializeStorage(); await writeRecord("templates", template.id, template); });
async function remove(store: Store, key: string) {
  await initializeStorage(); const db = await openDatabase(); const tx = db.transaction([store, "meta"], "readwrite"); const done = completed(tx);
  tx.objectStore(store).delete(key); const active = tx.objectStore("meta").get("active");
  active.onsuccess = () => { if (store === "projects" && active.result === key) tx.objectStore("meta").delete("active"); }; await done;
  await collectUnusedAssets();
}
export const removeProject = (id: string) => enqueue(() => remove("projects", id));
export const removeReusableTemplate = (id: string) => enqueue(() => remove("templates", id));
export async function loadWeeklyDraft(): Promise<WeeklyDraft | null> {
  await initializeStorage(); const record = await read<RecordEnvelope>("drafts", "weekly");
  if (!record) return null;
  if (record.version !== 2) throw new Error("周报草稿版本无法识别，请下载备份");
  return weeklyDraftSchema.parse(await unpack(record.value));
}
export const saveWeeklyDraft = (draft: WeeklyDraft) => enqueue(async () => { await initializeStorage(); await writeRecord("drafts", "weekly", draft); });
export async function loadReusableAssets(): Promise<Asset[]> {
  await initializeStorage(); const record = await read<RecordEnvelope>("drafts", "reusable-assets");
  return record ? assetSchema.array().parse(await unpack(record.value)) : [];
}
export const saveReusableAssets = (assets: Asset[]) => enqueue(async () => { await initializeStorage(); await writeRecord("drafts", "reusable-assets", assetSchema.array().parse(assets)); });
export async function recoveryBackup() {
  const legacy: Record<string, string | null> = {};
  for (const key of Object.values(LEGACY_KEYS)) { try { legacy[key] = localStorage.getItem(key); } catch { legacy[key] = null; } }
  const stores: Record<string, unknown> = {};
  try { for (const store of STORES) stores[store] = await Promise.all((await entries(store)).map(async ([key, value]) => [key, value instanceof Blob ? await blobToDataUrl(value) : value])); } catch { /* Legacy remains exportable when IndexedDB is blocked. */ }
  let layoutLibrary: unknown;
  try { layoutLibrary = await backupLayoutLibrary(); } catch { layoutLibrary = { error: "文章模板库暂时无法读取" }; }
  return { schema: "opslion-recovery/v1", exportedAt: new Date().toISOString(), legacy, stores, layoutLibrary };
}
