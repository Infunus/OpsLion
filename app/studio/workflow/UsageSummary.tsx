/** Display only numeric counters actually returned by the supplier. */
export function UsageSummary({ usage }: { usage: unknown }) {
  if (!usage || typeof usage !== "object" || !("provider_responses" in usage) || !Array.isArray(usage.provider_responses)) return <p>供应商用量未知，费用未知。</p>;
  const responses: unknown[] = usage.provider_responses;
  const count = (key: string) => {
    const values = responses.map((r) => r && typeof r === "object" && key in r ? (r as Record<string, unknown>)[key] : undefined);
    return values.length && values.every((v) => typeof v === "number" && Number.isFinite(v) && v >= 0) ? values.reduce<number>((sum, v) => sum + Number(v), 0).toLocaleString() : "未知";
  };
  return <p>已回报输入 {count("prompt_tokens")} tokens · 输出 {count("completion_tokens")} tokens{!("complete" in usage && usage.complete === true) && "（回包不完整）"} · 费用未知</p>;
}
