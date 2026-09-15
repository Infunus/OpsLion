import { expect, test, type Page } from '@playwright/test';

const baseTask = {
  task_id: 'synthetic-task', mp_id: 'MP_WXS_TEST', mp_name: '合成订阅',
  status: 'pending', message: '已加入采集队列，等待执行', start_page: 1, end_page: 1,
  current_page: 1, pages_received: 0, article_count: 0,
};

async function nativePage(page: Page, initialTask: object | null = null) {
  let latest: object | null = initialTask;
  let state = { ...baseTask };
  const submissions: URL[] = [];
  let articleReads = 0;
  let failPoll = false;
  await page.addInitScript(() => {
    localStorage.setItem('token', 'synthetic-only');
    localStorage.setItem('sponsor', '5');
  });
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://127.0.0.1:3189') return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    let data: unknown = {};
    if (url.pathname.endsWith('/wx/auth/verify')) data = { is_valid: true, username: 'synthetic' };
    else if (url.pathname.endsWith('/wx/mps')) data = { list: [{ id: 'MP_WXS_TEST', mp_name: '合成订阅', status: 1 }], total: 1 };
    else if (url.pathname.endsWith('/wx/articles')) { data = { list: [], total: 0 }; articleReads += 1; }
    else if (url.pathname.includes('/update/latest/')) data = { task: latest };
    else if (url.pathname.includes('/update/tasks/')) {
      if (failPoll) return route.abort();
      data = state;
    } else if (url.pathname.includes('/wx/mps/update/')) {
      submissions.push(url); latest = state; data = state;
    }
    return route.fulfill({ json: { code: 0, data, message: 'success' } });
  });
  await page.goto('/');
  await page.getByText('合成订阅', { exact: true }).first().click();
  await page.getByRole('button', { name: initialTask ? '查看采集进度' : '刷新', exact: true }).click();
  return {
    submissions,
    setState: (next: Partial<typeof baseTask>) => { state = { ...state, ...next }; latest = state; },
    reads: () => articleReads,
    failPoll: (value: boolean) => { failPoll = value; },
  };
}

test('first-page refresh remains open and reports actual failure', async ({ page }) => {
  const app = await nativePage(page);
  await page.getByRole('button', { name: '开始采集', exact: true }).click();
  await expect(page.getByText('等待采集', { exact: true })).toBeVisible();
  await expect(page.getByText('刷新成功', { exact: true })).toHaveCount(0);
  expect(app.submissions).toHaveLength(1);
  expect(app.submissions[0].searchParams.get('start_page')).toBe('0');
  expect(app.submissions[0].searchParams.get('end_page')).toBe('1');
  await expect(page.getByRole('button', { name: '采集中', exact: true })).toBeDisabled();
  app.setState({ status: 'failed', message: '微信返回 200013：请求频率受限，请稍后重试' });
  await expect(page.getByText('采集失败', { exact: true })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: '200013' })).toBeVisible();
});

test('completion reloads articles only after collection ends', async ({ page }) => {
  const app = await nativePage(page);
  const before = app.reads();
  await page.getByRole('button', { name: '开始采集', exact: true }).click();
  await expect(page.getByText('等待采集', { exact: true })).toBeVisible();
  expect(app.reads()).toBe(before);
  app.setState({ status: 'running', message: '正在处理第 1 页', article_count: 2 });
  await expect(page.getByText('正在采集', { exact: true })).toBeVisible();
  app.setState({ status: 'success', message: '采集完成，处理 2 篇文章' });
  await expect(page.getByText('采集完成', { exact: true })).toBeVisible();
  await expect.poll(app.reads).toBeGreaterThan(before);
});

test('refresh resumes an existing task and survives a progress request failure', async ({ page }) => {
  const app = await nativePage(page, baseTask);
  app.failPoll(true);
  await expect(page.getByText(/暂时无法读取进度/)).toBeVisible();
  expect(app.submissions).toHaveLength(0);
  await expect(page.getByRole('button', { name: '采集中', exact: true })).toBeDisabled();
  app.failPoll(false);
  app.setState({ status: 'failed', message: '微信返回 200003：授权已过期，请重新扫码' });
  await expect(page.getByText('采集失败', { exact: true })).toBeVisible();
  await expect(page.getByText(/暂时无法读取进度/)).toHaveCount(0);
});
