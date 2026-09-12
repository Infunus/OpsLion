export class RequestError extends Error {
  constructor(message: string, public readonly kind: "timeout" | "network" | "http" | "payload", public readonly retryable: boolean, public readonly status?: number) { super(message); }
}

export type JsonRequestOptions = RequestInit & { timeoutMs?: number };

/** No implicit retries: POST requests can start paid work or a crawler. */
export async function requestJson<T>(url: string, { timeoutMs = 12_000, signal, ...init }: JsonRequestOptions = {}): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    const response = await fetch(url, { ...init, cache: "no-store", headers: new Headers(init.headers), signal: controller.signal });
    const text = await response.text();
    let payload;
    try { payload = text ? JSON.parse(text) : {}; }
    catch {
      if (response.ok) throw new RequestError("服务返回了无法识别的数据", "payload", false);
    }
    if (!response.ok) throw new RequestError(payload?.message || `本地服务返回 ${response.status}`, "http", response.status === 429 || response.status >= 500, response.status);
    return payload as T;
  } catch (error) {
    if (timedOut) throw new RequestError("请求超时，请稍后重试", "timeout", true);
    if (signal?.aborted) throw new DOMException("请求已取消", "AbortError");
    if (error instanceof RequestError) throw error;
    throw new RequestError("无法连接本地服务，请检查服务是否启动", "network", true);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
