import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

const origin = 'http://127.0.0.1:8088';
test.beforeEach(async ({ page }) => {
  // Isolate browser interactions from identity; JWT and live Entra checks run separately.
  await page.route('**/vendor/msal/msal-browser.min.js', route => route.fulfill({
    contentType: 'application/javascript',
    body: `window.msal={PublicClientApplication:class {
      async initialize(){} async loginPopup(){return {account:{name:'Synthetic reviewer'}}}
      setActiveAccount(){} async acquireTokenSilent(){return {accessToken:'synthetic-ui-test'}}
      async clearCache(){}
    }};`
  }));
  await page.goto(origin);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('.queue-item')).toHaveCount(10);
});
async function open(page, id) {
  await page.locator('.queue-item').filter({ hasText: id }).click();
  await expect(page.locator('#case-meta')).toContainText(id);
}
async function field(page, label) {
  await page.locator('.field-item').filter({ has: page.locator('span').filter({ hasText: new RegExp(`^${label}$`) }) }).click();
  await expect(page.locator('#field-title')).toHaveText(label);
}
async function save(page, reason, action = 'Save correction') {
  await page.locator('#reason').fill(reason);
  const saved = page.waitForResponse(response => response.url().endsWith('/commands') && response.request().method() === 'POST');
  await page.getByRole('button', { name: action, exact: true }).click();
  expect((await saved).status()).toBe(200);
  await expect(page.locator('#unresolved')).toBeEnabled();
  await expect(page.locator('#message')).toHaveText('Review decision saved to durable storage.');
}
async function themeColor(page, token) {
  return page.evaluate(name => {
    const probe = document.createElement('span');
    probe.style.color = `var(${name})`;
    document.body.append(probe);
    const color = getComputedStyle(probe).color;
    probe.remove();
    return color;
  }, token);
}

test('actual multipage PDF, row correction, explicit release, feedback, and reload', async ({ page, request }) => {
  await open(page, 'synthetic-01');
  await field(page, 'Length');
  await expect(page.locator('#pdf-canvas')).toBeVisible();
  await expect(page.locator('#page')).toHaveValue('2');
  await expect(page.locator('#evidence-overlay polygon')).toHaveCount(1);
  await expect(page.locator('#source-caption')).toContainText('120.0 mm');
  await expect(page.getByRole('button', { name: 'Accept original', exact: true })).toBeDisabled();
  await page.locator('input[value="row-A"]').uncheck();
  await page.locator('input[value="row-B"]').check();
  await expect(page.locator('#source-caption')).toContainText('140.0 mm');
  await page.locator('#reviewed-value').fill('140');
  await save(page, 'Requested suffix B is 140.0 mm on sheet 2.');
  await field(page, 'Outside diameter');
  await expect(page.locator('#page')).toHaveValue('1');
  await expect(page.locator('#model-score')).toHaveText('57%');
  await page.locator('#reviewed-value').fill('25');
  await save(page, 'Read 25.0 mm from the outside-diameter note.');
  await field(page, 'Item type');
  await expect(page.locator('#model-score')).toHaveText('Not provided');
  await save(page, 'The source explicitly identifies a tubular spacer.', 'Accept original');
  await expect(page.locator('#release-state')).toHaveText('Ready for case sign-off');
  await expect(page.locator('#case-status')).toHaveText('In review');
  await expect(page.locator('#signoff')).toBeEnabled();
  await page.locator('#signoff').click();
  await expect(page.locator('#case-status')).toHaveText('Validated');
  const downloadEvent = page.waitForEvent('download');
  await page.locator('#feedback').click();
  const download = await downloadEvent;
  const exported = JSON.parse(await readFile(await download.path(), 'utf8'));
  expect(exported.automaticTraining).toBe(false);
  expect(exported.fields.find(item => item.id === 'length')).toMatchObject({ originalValue: 120, reviewedValue: 140 });
  const rendered = await page.locator('#pdf-canvas').evaluate(canvas => canvas.toDataURL().length);
  expect(rendered).toBeGreaterThan(5000);
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: '.local/test-results/workbench-dark.png', fullPage: true });
  await page.reload();
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await open(page, 'synthetic-01');
  await expect(page.locator('#case-status')).toHaveText('Validated');
  await expect(page.locator('#reviewed-value')).toBeDisabled();
  const response = await request.get(`${origin}/api/cases/synthetic-01`, { headers: { authorization: 'Bearer synthetic-ui-test' } });
  const record = await response.json();
  expect(record.proposal.fields[1].value).toBe(120);
  expect(record.decisions.length.value).toBe(140);
  expect(record.audit).toHaveLength(5);
});

test('missing source blocks release and supports unresolved review on mobile and light theme', async ({ page }) => {
  await open(page, 'synthetic-03');
  await field(page, 'Length');
  await expect(page.locator('#pdf-sheet')).toBeVisible();
  await expect(page.locator('#source-caption')).toContainText('140.0 mm');
  await page.setViewportSize({ width: 390, height: 844 });
  await open(page, 'synthetic-08');
  await expect(page.locator('#pdf-empty')).toContainText('Source PDF missing');
  await expect(page.locator('#page')).toBeDisabled();
  await expect(page.locator('#page-total')).toHaveText('of --');
  await expect(page.locator('#source-caption')).toContainText('No source PDF');
  await expect(page.locator('#download-pdf')).toBeDisabled();
  await expect(page.locator('#accept')).toBeDisabled();
  await expect(page.locator('#correct')).toBeDisabled();
  await save(page, 'The original drawing was not supplied.', 'Needs information');
  await expect(page.locator('#case-status')).toHaveText('Needs information');
  await expect(page.locator('#signoff')).toBeDisabled();
  await page.locator('#themetoggle').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  expect(overflow).toBe(false);
  await expect(page.locator('#pdf-empty h3')).toHaveText('Source PDF missing');
  await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: '.local/test-results/workbench-mobile-light.png', fullPage: true });
});

test('failed review preserves unsaved value and selected evidence', async ({ page }) => {
  await open(page, 'synthetic-02');
  await field(page, 'Length');
  await page.locator('input[value="row-A"]').uncheck();
  await page.locator('input[value="row-B"]').check();
  await page.locator('#reviewed-value').fill('140');
  await page.locator('#correct').click();
  await expect(page.locator('#message')).toHaveText('A review reason is required.');
  await expect(page.locator('#reviewed-value')).toHaveValue('140');
  await expect(page.locator('input[value="row-B"]')).toBeChecked();
});

test('sign-in waits for asynchronous identity initialization after a reload', async ({ page }) => {
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const configRequested = new Promise(resolve => { entered = resolve; });
  await page.route('**/api/config', async route => { entered(); await gate; await route.continue(); });
  const loaded = page.reload({ waitUntil: 'domcontentloaded' });
  await configRequested;
  try { await expect(page.locator('#signin')).toBeDisabled(); } finally { release(); }
  await loaded;
  await expect(page.locator('#signin')).toBeEnabled();
});

test('review clarity separates required input, saved corrections, and unflagged values', async ({ page }) => {
  await open(page, 'synthetic-02');
  await field(page, 'Length');
  await expect(page.locator('#requested-part')).toHaveText('DR-742-B');
  await expect(page.locator('#requested-variant')).toHaveText('Required suffix: B');
  await expect(page.locator('#source-request')).toContainText('DR-742-B');
  await expect(page.locator('#review-explanation')).toContainText('120 mm');
  await expect(page.locator('#review-explanation')).toContainText('suffix A');
  await expect(page.locator('#review-explanation')).toContainText('suffix B');
  await expect(page.locator('#routing-signals')).not.toHaveAttribute('open');
  await expect(page.locator('input[value="row-A"]')).toBeChecked();
  await expect(page.locator('input[value="row-B"]')).not.toBeChecked();
  await expect(page.locator('.evidence-option').filter({ has: page.locator('input[value="row-B"]') })).toContainText('Matches requested suffix B');
  for (const label of ['Part number', 'Finish']) {
    await expect(page.locator('.field-item').filter({ has: page.locator('span').filter({ hasText: new RegExp(`^${label}$`) }) }).locator('.field-state')).toHaveCount(0);
  }
  await expect(page.locator('#fields')).not.toContainText('Included in case sign-off');
  await save(page, 'Waiting for confirmation of the requested suffix.', 'Needs information');
  await field(page, 'Outside diameter');
  await page.locator('#reviewed-value').fill('25');
  await save(page, 'Verified the outside-diameter note.');
  await expect(page.locator('#field-summary')).toHaveText('2 fields need your input');
  const length = page.locator('.field-item').filter({ has: page.locator('span').filter({ hasText: /^Length$/ }) });
  const diameter = page.locator('.field-item').filter({ has: page.locator('span').filter({ hasText: /^Outside diameter$/ }) });
  await expect(length.locator('.field-state')).toHaveText('Needs information');
  await expect(length.locator('.field-state')).toHaveCSS('color', await themeColor(page, '--red'));
  await expect(diameter.locator('.field-state')).toHaveText('Resolved: correction saved');
  await expect(diameter.locator('.field-state')).toHaveCSS('color', await themeColor(page, '--green'));
  await field(page, 'Length');
  await page.locator('input[value="row-A"]').uncheck();
  await page.locator('input[value="row-B"]').check();
  await page.locator('#reviewed-value').fill('140');
  await save(page, 'Confirmed suffix B is 140.0 mm.');
  await expect(page.locator('#review-state-label')).toHaveText('Resolved: correction saved');
  await expect(page.locator('#review-explanation')).not.toContainText('wrong');
  await expect(page.locator('#review-state-label')).toHaveCSS('color', await themeColor(page, '--green'));
  await expect(page.locator('#field-reasons')).not.toBeVisible();
  await field(page, 'Item type');
  await expect(page.locator('#review-explanation')).toContainText('does not mean the value is wrong');
  await page.locator('#themetoggle').click();
  await expect(page.locator('#review-state-label')).toHaveCSS('color', await themeColor(page, '--red'));
});

test('critical review is not presented as a proven error and reviewer-added blockers stay visible', async ({ page }) => {
  await open(page, 'synthetic-06');
  await field(page, 'Length');
  await expect(page.locator('#review-explanation')).toContainText('human confirmation');
  await expect(page.locator('#review-explanation')).not.toContainText('wrong variant');
  await expect(page.locator('#value-label')).toHaveText('Value to review');
  await save(page, 'Confirmed 140 mm for suffix B.', 'Accept original');
  await expect(page.locator('#review-state-label')).toHaveText('Resolved: original accepted');
  await expect(page.locator('#field-reasons')).not.toBeVisible();
  await field(page, 'Part number');
  await expect(page.locator('#review-callout')).toBeHidden();
  await save(page, 'A reviewer requested another source check.', 'Needs information');
  await open(page, 'synthetic-06');
  await expect(page.locator('#field-title')).toHaveText('Part number');
  await expect(page.locator('#review-state-label')).toHaveText('Needs information');
  await expect(page.locator('#review-state-label')).toHaveCSS('color', await themeColor(page, '--red'));
});

test('accept original is one click without a note while needs-information keeps a reasoned blocker', async ({ page, request }) => {
  await open(page, 'synthetic-10');
  await field(page, 'Item type');
  await expect(page.locator('#accept')).toBeEnabled();
  await expect(page.locator('#reason')).toHaveValue('');
  await save(page, '', 'Accept original');
  await expect(page.locator('#review-state-label')).toHaveText('Resolved: original accepted');
  await expect(page.locator('label[for="reason"]')).toContainText('Optional for Accept original');
  await expect(page.locator('#reason-help')).toContainText('Required for Save correction or Needs information');
  await expect(page.locator('#unresolved-help')).toContainText('blocks case sign-off');
  await expect(page.locator('#unresolved-help')).toContainText('does not notify anyone');
  const response = await request.get(`${origin}/api/cases/synthetic-10`, { headers: { authorization: 'Bearer synthetic-ui-test' } });
  const record = await response.json();
  expect(record.decisions.type).toMatchObject({ kind: 'accepted', value: 'tubular spacer', reason: '' });
  expect(record.audit.at(-1).action).toBe('accept');
  await field(page, 'Finish');
  const rejected = page.waitForResponse(item => item.url().endsWith('/commands') && item.request().method() === 'POST');
  await page.locator('#unresolved').click();
  expect((await rejected).status()).toBe(400);
  await expect(page.locator('#message')).toHaveText('A review reason is required.');
  await save(page, 'The finish note is unreadable; another source is needed.', 'Needs information');
  await expect(page.locator('#review-state-label')).toHaveText('Needs information');
  await expect(page.locator('#signoff')).toBeDisabled();
});
