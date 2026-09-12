import { requestJson, type JsonRequestOptions } from "./request";

export type AgentProtocol = "openai-chat" | "openai-responses" | "anthropic" | "gemini";

export interface AgentProfile {
  profile_id?: string;
  provider?: string;
  protocol?: AgentProtocol;
  name?: string;
  base_url: string;
  model: string;
  temperature: number;
  configured: boolean;
  api_key_saved: boolean;
  api_key_source: "none" | "windows" | "environment";
  api_key_env?: string;
  max_output_tokens?: number;
  send_temperature?: boolean;
  json_mode?: "auto" | "off";
}

export interface AgentConfig extends AgentProfile {
  profiles?: AgentProfile[];
  layout_ai_enabled?: boolean;
  policy_generation?: number;
}

export interface AgentConfigInput {
  profile_id?: string;
  provider?: string;
  protocol?: AgentProtocol;
  name?: string;
  base_url: string;
  model: string;
  temperature: number;
  api_key?: string;
  clear_api_key?: boolean;
  api_key_env?: string;
  max_output_tokens?: number;
  send_temperature?: boolean;
  json_mode?: "auto" | "off";
}

function agentJson<T>(path: string, options: JsonRequestOptions = {}): Promise<T> {
  return requestJson<T>(`/local-api${path}`, { ...options, headers: { "Content-Type": "application/json", ...options.headers } });
}
let policy: AgentConfig | null = null;
const activeRequests = new Set<AbortController>();
export async function setLayoutAIEnabled(enabled: boolean) {
  if (!enabled) { policy = null; activeRequests.forEach((c) => c.abort()); }
  const payload = await agentJson<{ config: AgentConfig }>("/agent/policy", { method: "POST", body: JSON.stringify({ enabled }) });
  policy = payload.config;
  return payload.config;
}

export async function loadAgentConfig(signal?: AbortSignal) {
  const payload = await agentJson<{ config: AgentConfig }>("/agent/config", { signal });
  policy = payload.config;
  return payload.config;
}

export async function saveAgentConfig(config: AgentConfigInput, signal?: AbortSignal) {
  const payload = await agentJson<{ config: AgentConfig }>("/agent/config", {
    signal,
    method: "POST",
    body: JSON.stringify(config),
  });
  policy = payload.config;
  activeRequests.forEach((controller) => controller.abort());
  return payload.config;
}

export async function deleteAgentProfile(profile_id: string, signal?: AbortSignal) {
  const payload = await agentJson<{ config: AgentConfig }>("/agent/profiles/delete", { method: "POST", body: JSON.stringify({ profile_id }), signal });
  policy = payload.config;
  activeRequests.forEach((controller) => controller.abort());
  return payload.config;
}

export async function testAgentConfig(signal?: AbortSignal) {
  return agentJson<{ ok: true; latency_ms: number; model: string }>("/agent/test", { method: "POST", body: "{}", signal, timeoutMs: 130_000 });
}

export async function requestAgentPlan<TPlan>(request: object, signal?: AbortSignal) {
  const config = policy ?? await loadAgentConfig(signal);
  if (!config.layout_ai_enabled) throw new Error("当前使用本地排版；如需模型，请先在顶部选择 AI 增强。");
  const controller = new AbortController(), run_id = crypto.randomUUID();
  const abort = () => controller.abort();
  const cancel = () => { void agentJson("/agent/cancel", { method: "POST", body: JSON.stringify({ run_id }) }).catch(() => {}); };
  if (signal?.aborted) controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  controller.signal.addEventListener("abort", cancel, { once: true });
  activeRequests.add(controller);
  try {
    const result = await agentJson<{ ok: true; plan: TPlan; latency_ms: number; model: string; requests?: number; usage?: unknown }>("/agent/plan", {
      signal: controller.signal, timeoutMs: 180_000, method: "POST",
      body: JSON.stringify({ ...request, _execution: { run_id, generation: config.policy_generation } }),
    });
    if (controller.signal.aborted) throw new Error("模型任务已取消");
    return result;
  } catch (error) { cancel(); throw error; }
  finally { activeRequests.delete(controller); signal?.removeEventListener("abort", abort); }
}
