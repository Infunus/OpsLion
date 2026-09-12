import { builtinTemplates } from "./catalog";
import { compileArticle } from "./render";
import { publishTemplate, LayoutError } from "./validate";
import type { TemplateDefinition } from "./types";

const releaseKey = (template: TemplateDefinition) => `${template.id}@${template.version}`;
export function canonicalTemplate(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalTemplate).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b, "en")).map(([key, item]) => `${JSON.stringify(key)}:${canonicalTemplate(item)}`).join(",")}}`;
  return JSON.stringify(value);
}
function openLibrary() {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open("opslion-layout-library", 1);
    request.onupgradeneeded = () => request.result.createObjectStore("releases");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}
export async function loadLayoutTemplates(): Promise<TemplateDefinition[]> {
  const database = await openLibrary();
  try {
    const values = await new Promise<unknown[]>((resolve, reject) => { const request = database.transaction("releases").objectStore("releases").getAll(); request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    return values.map(publishTemplate);
  } finally { database.close(); }
}
export async function backupLayoutLibrary(): Promise<[IDBValidKey, unknown][]> {
  const database = await openLibrary();
  try {
    const store = database.transaction("releases").objectStore("releases");
    const read = <T>(request: IDBRequest<T>) => new Promise<T>((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const [keys, values] = await Promise.all([read(store.getAllKeys()), read(store.getAll())]);
    return keys.map((key, index) => [key, values[index]]);
  } finally { database.close(); }
}
export async function saveLayoutTemplate(input: unknown): Promise<TemplateDefinition> {
  const template = publishTemplate(input);
  for (const article of template.examples) compileArticle(article, template);
  const builtIn = builtinTemplates.find((item) => releaseKey(item) === releaseKey(template));
  if (builtIn && canonicalTemplate(publishTemplate(builtIn)) !== canonicalTemplate(template)) throw new LayoutError("该内置模板版本已经存在，请使用新的模板 ID 或版本号");
  const database = await openLibrary();
  try {
    await new Promise<void>((resolve, reject) => {
      const transaction = database.transaction("releases", "readwrite"); const store = transaction.objectStore("releases"); const key = releaseKey(template); const read = store.get(key);
      let conflict = false;
      read.onsuccess = () => {
        if (read.result && canonicalTemplate(read.result) !== canonicalTemplate(template)) { conflict = true; transaction.abort(); }
        else store.put(template, key);
      };
      transaction.oncomplete = () => resolve(); transaction.onabort = () => reject(conflict ? new LayoutError("这个模板版本已经存在且内容不同，请增加版本号") : transaction.error); transaction.onerror = () => reject(transaction.error);
    });
    return template;
  } finally { database.close(); }
}
export async function removeLayoutTemplate(id: string, version: string) {
  const database = await openLibrary();
  try { await new Promise<void>((resolve, reject) => { const transaction = database.transaction("releases", "readwrite"); transaction.objectStore("releases").delete(`${id}@${version}`); transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(transaction.error); transaction.onabort = () => reject(transaction.error); }); }
  finally { database.close(); }
}
