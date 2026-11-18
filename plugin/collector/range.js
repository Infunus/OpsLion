export function today() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date());
}

export function validateRange(input) {
  for (const key of ['start_date', 'end_date']) {
    const value = input[key];
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '') || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString().slice(0, 10) !== value) {
      throw new Error('请选择有效的开始和结束日期。');
    }
  }
  if (input.start_date > input.end_date) throw new Error('开始日期不能晚于结束日期。');
}

export function normalizeRange(input) {
  const normalized = input.all_history === true
    ? { ...input, start_date: '1970-01-01', end_date: today() }
    : { ...input, all_history: false };
  validateRange(normalized);
  return normalized;
}

export const inDateRange = (item, start, end) => Number.isFinite(item.t)
  && item.t >= Date.parse(start + 'T00:00:00+08:00') / 1000
  && item.t < Date.parse(end + 'T00:00:00+08:00') / 1000 + 86400;

export function sourceCovered(source, input) {
  return source.ended || (!input.all_history && source.items.some(item => item.t > 0 && item.t < Date.parse(input.start_date + 'T00:00:00+08:00') / 1000));
}
