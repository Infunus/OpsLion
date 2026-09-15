import { expect, test, type Page } from '@playwright/test';

async function nativeAuth(page: Page) {
  let state = { state: 'loading', qr_code: false, login_status: false, error: '' };
  let polls = 0;
  let starts = 0;
  await page.addInitScript(() => {
    localStorage.setItem('token', 'synthetic-only');
    localStorage.setItem('sponsor', '5');
  });
  await page.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://127.0.0.1:3189') return route.abort();
    if (url.pathname === '/static/synthetic-qr.svg') {
      return route.fulfill({ contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200"><rect width="200" height="200" fill="white"/><text x="10" y="100">Synthetic test image</text></svg>' });
    }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    let data: unknown = {};
    if (url.pathname.endsWith('/wx/auth/verify')) data = { is_valid: true, username: 'synthetic' };
    else if (url.pathname.endsWith('/wx/user')) data = { username: 'synthetic' };
    else if (url.pathname.endsWith('/wx/mps') || url.pathname.endsWith('/wx/articles')) data = { list: [], total: 0 };
    else if (url.pathname.endsWith('/wx/auth/qr/code')) {
      starts += 1;
      data = { code: '/static/synthetic-qr.svg', state: 'loading', is_exists: false };
    } else if (url.pathname.endsWith('/wx/auth/qr/status')) {
      polls += 1;
      data = state;
    }
    return route.fulfill({ json: { code: 0, data, message: 'success' } });
  });
  await page.goto('/');
  const open = async () => {
    await page.locator('.user-info').click();
    await page.getByText('扫码授权', { exact: true }).click();
  };
  await open();
  return {
    open,
    state: (next: Partial<typeof state>) => { state = { ...state, ...next }; },
    polls: () => polls, starts: () => starts,
  };
}

test('QR failure is shown promptly and retry stays in the authorization window', async ({ page }) => {
  const app = await nativeAuth(page);
  await expect(page.getByText('正在获取二维码...')).toBeVisible();
  app.state({ state: 'failed', error: '微信登录页打开失败，请检查网络或 RSS 代理配置后重试' });
  await expect(page.getByText('微信登录页打开失败，请检查网络或 RSS 代理配置后重试')).toBeVisible();
  app.state({ state: 'waiting', qr_code: true, error: '' });
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await expect(page.getByAltText('微信授权二维码')).toBeVisible();
  expect(app.starts()).toBe(2);
  app.state({ state: 'success', login_status: true });
  await expect(page.getByAltText('微信授权二维码')).toBeHidden();
});

test('closing the QR window cancels polling and reopening starts cleanly', async ({ page }) => {
  const app = await nativeAuth(page);
  await expect.poll(app.polls).toBeGreaterThan(0);
  await page.locator('.arco-modal-close-btn:visible').click();
  await page.waitForTimeout(150);
  const polls = app.polls();
  await page.waitForTimeout(1300);
  expect(app.polls()).toBe(polls);
  app.state({ state: 'waiting', qr_code: true });
  await app.open();
  await expect(page.getByAltText('微信授权二维码')).toBeVisible();
});

test('expired QR shows the actual error and can be retried', async ({ page }) => {
  const app = await nativeAuth(page);
  app.state({ state: 'waiting', qr_code: true });
  await expect(page.getByAltText('微信授权二维码')).toBeVisible();
  app.state({ state: 'failed', qr_code: false, error: '二维码已过期，请重新获取并扫码' });
  await expect(page.getByText('二维码已过期，请重新获取并扫码')).toBeVisible();
  await expect(page.getByRole('button', { name: '重试', exact: true })).toBeVisible();
});
