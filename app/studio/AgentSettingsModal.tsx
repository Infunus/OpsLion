import { useEffect, useRef, useState } from "react";
import catalog from "../../config/agent-providers.json";
import { deleteAgentProfile, saveAgentConfig, testAgentConfig, type AgentConfig, type AgentConfigInput, type AgentProfile, type AgentProtocol } from "./agent-client";
import { ModalDialog } from "./ModalDialog";
import { StudioIcon } from "./StudioIcon";

const protocols: { value: AgentProtocol; name: string }[] = [
  { value: "openai-chat", name: "Chat Completions · 通用兼容" },
  { value: "openai-responses", name: "Responses" },
  { value: "anthropic", name: "Claude Messages" },
  { value: "gemini", name: "Gemini generateContent" },
];
const groups = ["国内厂商", "国际厂商", "模型平台", "本机与自定义"];
const apiRoot = (url: string) => url.trim().replace(/\/+$/, "").replace(/\/(chat\/completions|responses|messages|models\/[^/]+:generateContent)$/, "");
const presetFor = (id?: string) => catalog.find((item) => item.id === id) ?? catalog[0];

function newDraft(provider = "openai"): AgentConfigInput {
  const preset = presetFor(provider);
  return { profile_id: "", provider: preset.id, protocol: preset.protocol as AgentProtocol, name: preset.name, base_url: preset.base_url,
    model: "", temperature: 0.1, send_temperature: false, max_output_tokens: 4096, json_mode: "auto", api_key_env: "", api_key: "", clear_api_key: false };
}

function profileDraft(profile?: AgentProfile | null): AgentConfigInput {
  if (!profile) return newDraft();
  const provider = profile.provider ?? catalog.find((item) => item.base_url && apiRoot(item.base_url) === apiRoot(profile.base_url))?.id ?? "custom";
  return { ...newDraft(provider), profile_id: profile.profile_id ?? (profile.model ? "default" : ""), provider,
    protocol: profile.protocol ?? "openai-chat", name: profile.name ?? presetFor(provider).name, base_url: profile.base_url,
    model: profile.model, temperature: profile.temperature, send_temperature: profile.send_temperature ?? true,
    max_output_tokens: profile.max_output_tokens ?? 4096, json_mode: profile.json_mode ?? "auto", api_key_env: profile.api_key_env ?? "" };
}

export function AgentSettingsModal(props: { config: AgentConfig | null; close: () => void; saved: (config: AgentConfig) => void }) {
  const [draft, setDraft] = useState<AgentConfigInput>(() => profileDraft(props.config));
  const [working, setWorking] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const requestController = useRef<AbortController | null>(null);
  useEffect(() => () => requestController.current?.abort(), []);
  const profiles = props.config?.profiles ?? (props.config?.model ? [{ ...props.config, profile_id: "default" }] : []);
  const selected = profiles.find((profile) => profile.profile_id === draft.profile_id);
  const sameDestination = Boolean(selected && (selected.provider ?? profileDraft(selected).provider) === draft.provider && apiRoot(selected.base_url) === apiRoot(draft.base_url));
  const savedKey = sameDestination && selected?.api_key_saved;
  const preset = presetFor(draft.provider);

  const changeConnection = (id: string) => {
    setDraft(id ? profileDraft(profiles.find((profile) => profile.profile_id === id)) : newDraft("custom"));
    setResult(null);
  };
  const persist = async (andTest: boolean) => {
    requestController.current?.abort();
    const controller = new AbortController();
    requestController.current = controller;
    setWorking(true);
    setResult(null);
    try {
      const config = await saveAgentConfig(draft, controller.signal);
      if (controller.signal.aborted) return;
      props.saved(config);
      setDraft(profileDraft(config));
      if (andTest) {
        const tested = await testAgentConfig(controller.signal);
        if (!controller.signal.aborted) setResult({ ok: true, message: `连接成功 · ${tested.model} · ${tested.latency_ms}ms` });
      } else {
        setResult({ ok: true, message: "连接已保存并设为当前模型" });
      }
    } catch (error) {
      if (!controller.signal.aborted) setResult({ ok: false, message: error instanceof Error ? error.message : "保存失败" });
    } finally {
      if (!controller.signal.aborted) setWorking(false);
    }
  };
  const remove = async () => {
    if (!selected?.profile_id || !window.confirm(`删除模型连接“${selected.name || selected.model}”及其保存的密钥？`)) return;
    const controller = new AbortController();
    requestController.current = controller;
    setWorking(true);
    setResult(null);
    try {
      const config = await deleteAgentProfile(selected.profile_id, controller.signal);
      if (controller.signal.aborted) return;
      props.saved(config);
      setDraft(profileDraft(config));
      setResult({ ok: true, message: "连接已删除" });
    } catch (error) {
      if (!controller.signal.aborted) setResult({ ok: false, message: error instanceof Error ? error.message : "删除失败" });
    } finally {
      if (!controller.signal.aborted) setWorking(false);
    }
  };

  return <ModalDialog close={props.close} label="模型设置">{(dismiss) => (
    <section className="modal agent-modal">
      <header><div><h2>模型设置</h2><p>选择服务商，填写模型与密钥。可保存多个连接，随时切换。</p></div><button className="close-button" aria-label="关闭弹窗" onClick={dismiss}><StudioIcon name="close" /></button></header>
      <div className="agent-settings-body">
        <fieldset className="agent-settings-fields" disabled={working}>
          {profiles.length > 0 && <>
            <label className="field-label" htmlFor="agent-connection">已保存的连接</label>
            <select id="agent-connection" className="text-input" value={draft.profile_id || ""} onChange={(event) => changeConnection(event.target.value)}>
              <option value="">＋ 新建连接</option>
              {profiles.map((profile) => <option key={profile.profile_id} value={profile.profile_id}>{profile.name || profile.model} · {profile.model || "未填写模型"}{profile.profile_id === props.config?.profile_id ? "（当前）" : ""}</option>)}
            </select>
          </>}
          <label className="field-label" htmlFor="agent-provider">模型服务商</label>
          <select id="agent-provider" className="text-input" value={draft.provider} onChange={(event) => { setDraft(newDraft(event.target.value)); setResult(null); }}>
            {groups.map((group) => <optgroup key={group} label={group}>{catalog.filter((item) => item.group === group).map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</optgroup>)}
          </select>
          <p className="agent-field-hint">{preset.note} {preset.docs_url && <a href={preset.docs_url} target="_blank" rel="noreferrer">接入文档 ↗</a>}</p>
          <label className="field-label" htmlFor="agent-model">模型名称</label>
          <input id="agent-model" className="text-input" value={draft.model} onChange={(event) => setDraft({ ...draft, model: event.target.value })} placeholder="填写控制台提供的模型 ID" autoComplete="off" />
          <label className="field-label" htmlFor="agent-base-url">API 地址</label>
          <input id="agent-base-url" className="text-input" value={draft.base_url} onChange={(event) => setDraft({ ...draft, base_url: event.target.value, api_key: "", api_key_env: "", clear_api_key: false })} placeholder="https://api.example.com/v1" autoComplete="off" spellCheck={false} />
          <label className="field-label" htmlFor="agent-api-key">API Key <span>{savedKey ? `当前连接已保存（${selected?.api_key_source === "environment" ? "环境变量" : "Windows 加密"}）` : "本机免鉴权服务可留空"}</span></label>
          <input id="agent-api-key" className="text-input" type="password" autoComplete="new-password" value={draft.api_key || ""} onChange={(event) => setDraft({ ...draft, api_key: event.target.value, api_key_env: event.target.value ? "" : draft.api_key_env, clear_api_key: false })} placeholder={savedKey ? "留空保留当前连接的密钥" : "填写这个服务商的 API Key"} />
          {selected && !sameDestination && <p className="agent-field-hint">地址已变化，请为新地址填写密钥。</p>}
          {savedKey && selected?.api_key_source !== "environment" && <label className="agent-clear-key"><input type="checkbox" checked={Boolean(draft.clear_api_key)} onChange={(event) => setDraft({ ...draft, clear_api_key: event.target.checked, api_key: event.target.checked ? "" : draft.api_key })} /> 清除当前连接保存的密钥</label>}
          <details className="agent-advanced" open={draft.provider === "custom" ? true : undefined}>
            <summary>高级设置</summary>
            <label className="field-label" htmlFor="agent-protocol">API 协议</label>
            <select id="agent-protocol" className="text-input" value={draft.protocol} onChange={(event) => setDraft({ ...draft, protocol: event.target.value as AgentProtocol })}>{protocols.map((protocol) => <option key={protocol.value} value={protocol.value}>{protocol.name}</option>)}</select>
            <label className="field-label" htmlFor="agent-name">连接名称</label>
            <input id="agent-name" className="text-input" maxLength={80} value={draft.name || ""} onChange={(event) => setDraft({ ...draft, name: event.target.value })} />
            <label className="field-label" htmlFor="agent-output-limit">最大输出 tokens</label>
            <input id="agent-output-limit" className="text-input" type="number" min={256} max={65536} step={256} value={draft.max_output_tokens ?? 4096} onChange={(event) => setDraft({ ...draft, max_output_tokens: Number(event.target.value) })} />
            <p className="agent-field-hint">较长文稿或推理模型可提高上限，实际用量由服务商返回。</p>
            <label className="field-label" htmlFor="agent-json-mode">JSON 输出</label>
            <select id="agent-json-mode" className="text-input" value={draft.json_mode} onChange={(event) => setDraft({ ...draft, json_mode: event.target.value as "auto" | "off" })}><option value="auto">自动适配</option><option value="off">由提示词约束</option></select>
            <label className="agent-clear-key"><input type="checkbox" checked={draft.send_temperature ?? true} onChange={(event) => setDraft({ ...draft, send_temperature: event.target.checked })} /> 自定义温度</label>
            {draft.send_temperature && <><label className="field-label" htmlFor="agent-temperature">温度 <span>{draft.temperature.toFixed(1)}</span></label><input id="agent-temperature" className="agent-range" type="range" min="0" max="1" step="0.1" value={draft.temperature} onChange={(event) => setDraft({ ...draft, temperature: Number(event.target.value) })} /></>}
            <label className="field-label" htmlFor="agent-key-env">密钥环境变量（可选）</label>
            <input id="agent-key-env" className="text-input" value={draft.api_key_env || ""} onChange={(event) => setDraft({ ...draft, api_key_env: event.target.value, api_key: "" })} placeholder="例如：ANTHROPIC_API_KEY" autoComplete="off" spellCheck={false} />
          </details>
          <p className="agent-field-hint agent-storage-note">密钥按连接使用 Windows 加密，保存在本机应用数据目录。保存并测试只发送固定测试消息。</p>
        </fieldset>
        {result && <div role="status" className={`agent-test-result ${result.ok ? "ok" : "error"}`}>{result.message}</div>}
      </div>
      <footer className="agent-modal-actions">
        {selected && <button className="small-button agent-delete-profile" disabled={working} onClick={() => void remove()}>删除连接</button>}
        <button className="secondary-button" onClick={() => void persist(false)} disabled={working || !draft.base_url.trim()}>{working ? "处理中…" : "仅保存"}</button>
        <button className="primary-button" onClick={() => void persist(true)} disabled={working || !draft.model.trim() || !draft.base_url.trim()}>{working ? "连接中…" : "保存并测试"}</button>
      </footer>
    </section>
  )}</ModalDialog>;
}
