let opening;
export function database() {
  if (!opening) opening = new Promise((resolve,reject) => {
    const request = indexedDB.open('opslion-collector-extension', 1);
    request.onupgradeneeded = () => { for (const name of ['meta','bodies','images','archives']) request.result.createObjectStore(name); };
    request.onsuccess = () => { const db = request.result; db.onversionchange = () => { db.close(); opening = null; }; resolve(db); };
    request.onerror = () => reject(request.error);
    request.onblocked = () => reject(new Error('请关闭其他采集台标签页后重试。'));
  }).catch(error => { opening = null; throw error; });
  return opening;
}
export async function get(store,key) {
  const db = await database();
  return new Promise((resolve,reject) => { const r=db.transaction(store).objectStore(store).get(key);r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error); });
}
export async function put(store,key,value) {
  const db=await database();
  return new Promise((resolve,reject) => { const tx=db.transaction(store,'readwrite'); tx.oncomplete=()=>resolve();tx.onerror=tx.onabort=()=>reject(tx.error || new Error('本机存储未完成'));tx.objectStore(store).put(value,key); });
}
export async function all(store) {
  const db=await database();return new Promise((resolve,reject)=>{const r=db.transaction(store).objectStore(store).getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
}
