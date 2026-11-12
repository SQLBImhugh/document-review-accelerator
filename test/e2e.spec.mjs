import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { PDFDocument, StandardFonts, degrees } from 'pdf-lib';
import { createCase, hash, reasons, summary } from '../server/domain.mjs';
import { discoverCuLayout } from '../server/cu-layout.mjs';

const origin = 'http://127.0.0.1:8088';
test.beforeEach(async ({ page }) => {
  // Isolate browser interactions from identity; JWT and live Entra checks run separately.
  await page.route('**/vendor/msal/msal-browser.min.js', route => route.fulfill({
    contentType: 'application/javascript',
    body: `window.msal={PublicClientApplication:class {
      async initialize(){} async loginPopup(){return {account:{name:'Synthetic reviewer'}}}
      setActiveAccount(){} async acquireTokenSilent(){return {accessToken:'synthetic-ui-test'}}
      async clearCache(request){await window.__testLogout?.(request)}
    }};`
  }));
  await page.route(/^https:\/\/login\.microsoftonline\.com\/[^/]+\/oauth2\/v2\.0\/logout(?:\?|$)/, route => {
    const url = new URL(route.request().url());
    return route.fulfill({ status: 302, headers: { location: url.searchParams.get('post_logout_redirect_uri') }, body: '' });
  });
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

test('new portal deployments show identity setup guidance without starting sign-in or loading cases', async ({ page }) => {
  await page.route('**/api/config', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ mode: 'identity_setup_required', tenantId: '11111111-1111-4111-8111-111111111111', spaClientId: null, apiScope: null })
  }));
  await page.route('**/vendor/msal/msal-browser.min.js', route => route.fulfill({
    contentType: 'application/javascript',
    body: "window.msal={PublicClientApplication:class {constructor(){throw new Error('Sign-in must not initialize before setup')}}};"
  }));
  const dataRequests = [];
  page.on('request', request => {
    if (/\/api\/(me|cases|documents)(\/|$)/.test(new URL(request.url()).pathname)) dataRequests.push(request.url());
  });
  await page.reload();
  await expect(page.locator('#setup-notice')).toBeVisible();
  await expect(page.locator('#setup-notice')).toContainText('No review data is accessible');
  await expect(page.locator('#signin')).toBeDisabled();
  await expect(page.locator('#queue .queue-item')).toHaveCount(0);
  expect(dataRequests).toEqual([]);
});

test('CU discovery shows real source boxes, requires manual selection, and retains the saved link', async ({ page, request }) => {
  const load = async () => (await request.get(`${origin}/api/cases/synthetic-09`, {
    headers: { authorization: 'Bearer synthetic-ui-test' }
  })).json();
  const original = await load();
  const finish = original.cuLayout.regions.find(item => item.discovery.kind === 'line' && item.quote === 'Finish: zinc plated');
  const commands = [];
  page.on('request', request => { if (request.url().endsWith('/commands')) commands.push(request.url()); });
  await open(page, 'synthetic-09');
  await field(page, 'Finish');
  await page.locator('#page').selectOption('1');
  await expect(page.locator('#cu-toolbar')).toBeVisible();
  await expect(page.locator('#show-cu-boxes')).not.toBeChecked();
  await expect(page.locator('#evidence-selection')).toContainText('0 sources selected');
  await page.locator('#show-cu-boxes').check();
  await expect(page.locator('#discovery-overlay polygon')).toHaveCount(
    original.cuLayout.regions.filter(item => item.page === 1 && item.discovery.kind === 'line').length);
  const box = page.locator(`#discovery-overlay [data-evidence-id="${finish.id}"]`);
  const ink = await page.locator('#pdf-canvas').evaluate((canvas, polygon) => {
    const xs = polygon.map(point => point[0]), ys = polygon.map(point => point[1]);
    const left = Math.floor(Math.min(...xs) * canvas.width), top = Math.floor(Math.min(...ys) * canvas.height);
    const pixels = canvas.getContext('2d').getImageData(left, top,
      Math.ceil((Math.max(...xs) - Math.min(...xs)) * canvas.width),
      Math.ceil((Math.max(...ys) - Math.min(...ys)) * canvas.height)).data;
    let count = 0;
    for (let index = 0; index < pixels.length; index += 4) if (pixels[index] < 180 && pixels[index + 1] < 180 && pixels[index + 2] < 180) count++;
    return count;
  }, finish.polygon);
  expect(ink).toBeGreaterThan(100);
  const before = await box.boundingBox();
  await page.locator('#zoom').selectOption('125');
  await expect.poll(async () => (await box.boundingBox()).width / before.width).toBeGreaterThan(1.24);
  expect((await box.boundingBox()).width / before.width).toBeCloseTo(1.25, 2);
  await box.click();
  await expect(box).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('#source-caption')).toContainText('Finish: zinc plated');
  await expect(page.locator('#reviewed-value')).toHaveValue('zinc plated');
  await expect(page.locator('#reason')).toHaveValue('');
  await expect(page.locator('#evidence-selection')).toContainText('Save an acceptance or correction');
  expect(commands).toHaveLength(0);
  expect((await load()).proposal.fields.find(item => item.id === 'finish').evidenceIds).toEqual([]);
  await save(page, '', 'Accept original');
  await page.reload();
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await open(page, 'synthetic-09');
  await field(page, 'Finish');
  await expect(page.locator(`#evidence-list input[value="${finish.id}"]`)).toBeChecked();
  await expect(page.locator('#page')).toHaveValue('1');
  await expect(page.locator('#source-caption')).toContainText('Finish: zinc plated');
  const saved = await load();
  expect(saved.decisions.finish.evidenceIds).toEqual([finish.id]);
  expect(saved.proposal.fields.find(item => item.id === 'finish').evidenceIds).toEqual([]);
  await field(page, 'Length');
  await expect(page.locator('#page')).toHaveValue('2');
  await page.locator('#show-cu-boxes').check();
  await page.locator('#cu-kind').selectOption('word');
  const lengthWord = original.cuLayout.regions.find(item => item.discovery.kind === 'word' && item.quote === '140.0');
  const word = page.locator(`#discovery-overlay [data-evidence-id="${lengthWord.id}"]`);
  await word.focus();
  await word.press('Space');
  await expect(word).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('#accept')).toBeDisabled();
  await expect(page.locator('#review-explanation')).toContainText('wrong variant');
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#themetoggle').click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)).toBe(false);
  await page.screenshot({ path: '.local/test-results/cu-box-discovery-light.png', fullPage: true });
  await open(page, 'synthetic-03');
  await expect(page.locator('#cu-toolbar')).toBeHidden();
  await expect(page.locator('#discovery-overlay polygon')).toHaveCount(0);
});

test('discovered boxes align with actual text on a rotated PDF page', async ({ page }) => {
  const pdf = await PDFDocument.create();
  const source = pdf.addPage([200, 100]);
  const font = await pdf.embedFont(StandardFonts.Helvetica);
  const quote = 'SOURCE REGION';
  source.drawText(quote, { x: 20, y: 60, size: 12, font });
  source.setRotation(degrees(90));
  const bytes = Buffer.from(await pdf.save());
  const id = hash(bytes);
  const proposal = {
    schemaVersion: '1.0', id: 'synthetic-09', requestedPart: 'ROTATED-PDF', runId: 'rotated-layout',
    documentRevision: 'A', document: { id, sha256: id, filename: 'rotated.pdf', pages: [{ number: 1, width: 200, height: 100, rotation: 90 }] },
    evidence: [], fields: [{ id: 'text', label: 'Source text', value: quote, valueType: 'string', kind: 'extracted', evidenceIds: [] }]
  };
  const record = createCase(proposal, { id: 'synthetic-importer' });
  record.cuLayout = await discoverCuLayout({
    documentSha256: id, coordinateSpace: 'unrotated',
    analysis: { contents: [{ kind: 'document', unit: 'inch', pages: [{
      pageNumber: 1, width: 200 / 72, height: 100 / 72,
      lines: [{ content: quote, source: `D(1,${20 / 72},${28 / 72},${font.widthOfTextAtSize(quote, 12) / 72},${15 / 72})` }]
    }] }] }
  }, proposal, bytes);
  await page.route('**/api/cases/synthetic-09', route => route.fulfill({
    contentType: 'application/json',
    body: JSON.stringify({ ...record, etag: '"rotated-layout"', summary: summary(record), fieldReasons: { text: reasons(proposal, proposal.fields[0]) } })
  }));
  await page.route('**/api/cases/synthetic-09/document', route => route.fulfill({ contentType: 'application/pdf', body: bytes }));
  await open(page, 'synthetic-09');
  await expect(page.locator('#case-title')).toHaveText('ROTATED-PDF');
  await expect(page.locator('#show-cu-boxes')).toBeEnabled();
  await page.locator('#show-cu-boxes').check();
  const region = page.getByRole('checkbox', { name: `Use CU line: ${quote}`, exact: true });
  await expect(region).toBeVisible();
  const ink = await page.locator('#pdf-canvas').evaluate(canvas => {
    const pixels = canvas.getContext('2d').getImageData(
      Math.floor(canvas.width * 0.57), Math.floor(canvas.height * 0.1),
      Math.ceil(canvas.width * 0.15), Math.ceil(canvas.height * 0.52)).data;
    let count = 0;
    for (let index = 0; index < pixels.length; index += 4) if (pixels[index] < 100) count++;
    return count;
  });
  expect(ink).toBeGreaterThan(100);
  const bounds = await region.boundingBox();
  const sheet = await page.locator('#pdf-sheet').boundingBox();
  expect((bounds.x - sheet.x) / sheet.width).toBeCloseTo(0.57, 2);
  expect((bounds.y - sheet.y) / sheet.height).toBeCloseTo(0.1, 2);
});

test('signed-off CU evidence remains inspectable but cannot be relinked', async ({ page, request }) => {
  let record = await (await request.get(`${origin}/api/cases/synthetic-09`, {
    headers: { authorization: 'Bearer synthetic-ui-test' }
  })).json();
  const finish = record.cuLayout.regions.find(item => item.discovery.kind === 'line' && item.quote === 'Finish: zinc plated');
  const send = async (command, key) => {
    const response = await request.post(`${origin}/api/cases/synthetic-09/commands`, {
      headers: { authorization: 'Bearer synthetic-ui-test', 'if-match': record.etag, 'idempotency-key': key },
      data: { ...command, runId: record.proposal.runId, documentSha256: record.proposal.document.sha256 }
    });
    expect(response.status()).toBe(200);
    record = await response.json();
  };
  await send({ action: 'correct', fieldId: 'length', value: 140, evidenceIds: ['row-B'], reason: 'Verified suffix B.' }, 'cu-readonly-length');
  await send({ action: 'correct', fieldId: 'diameter', value: 25, evidenceIds: ['diameter'], reason: 'Verified diameter.' }, 'cu-readonly-diameter');
  await send({ action: 'accept', fieldId: 'type', evidenceIds: ['type'] }, 'cu-readonly-type');
  await send({ action: 'accept', fieldId: 'finish', evidenceIds: [finish.id] }, 'cu-readonly-finish');
  await send({ action: 'signoff' }, 'cu-readonly-signoff');
  await open(page, 'synthetic-09');
  await field(page, 'Finish');
  await page.locator('#show-cu-boxes').check();
  const box = page.locator(`#discovery-overlay [data-evidence-id="${finish.id}"]`);
  await expect(box).toHaveAttribute('aria-disabled', 'true');
  await expect(box).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator(`#evidence-list input[value="${finish.id}"]`)).toBeDisabled();
  await box.dispatchEvent('click');
  await expect(box).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('#accept')).toBeDisabled();
  await expect(page.locator('#correct')).toBeDisabled();
});

test('Logout ends the selected account session and clears the page without saving or deleting reviews', async ({ page, request }) => {
  const load = async () => (await request.get(`${origin}/api/cases/synthetic-04`, {
    headers: { authorization: 'Bearer synthetic-ui-test' }
  })).json();
  const before = await load();
  const calls = [], writes = [], logoutRequests = [];
  let release, entered;
  const gate = new Promise(resolve => { release = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  await page.exposeFunction('__testLogout', async input => { calls.push(input); entered(); await gate; });
  page.on('request', request => {
    if (request.url().endsWith('/commands')) writes.push(request.method());
    if (request.url().startsWith('https://login.microsoftonline.com/') && new URL(request.url()).pathname.endsWith('/logout')) {
      logoutRequests.push(new URL(request.url()));
    }
  });
  await open(page, 'synthetic-04');
  await field(page, 'Finish');
  await page.locator('#reviewed-value').fill('unsaved draft');
  await page.locator('#reason').fill('Do not save this draft.');
  await expect(page.getByRole('button', { name: 'Logout', exact: true })).toBeVisible();
  try {
    await page.getByRole('button', { name: 'Logout', exact: true }).click();
    await started;
    await expect(page.locator('.workbench')).toBeHidden();
    await expect(page.locator('.release-bar')).toBeHidden();
    await expect(page.locator('#signout')).toBeDisabled();
  } finally { release(); }
  await expect(page.locator('#identity')).toHaveText('Not signed in');
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled();
  await expect(page.locator('#signout')).toBeHidden();
  await expect(page.locator('.queue-item')).toHaveCount(0);
  await expect(page.locator('#pdf-sheet')).toBeHidden();
  await expect(page.locator('#inspector')).toBeHidden();
  expect(calls).toEqual([{ account: { name: 'Synthetic reviewer' } }]);
  expect(logoutRequests).toHaveLength(1);
  expect(logoutRequests[0].searchParams.get('post_logout_redirect_uri')).toBe(`${origin}/auth.html`);
  expect(logoutRequests[0].searchParams.get('client_id')).toBe('33333333-3333-4333-8333-333333333333');
  expect(logoutRequests[0].searchParams.has('logout_hint')).toBe(false);
  expect(writes).toEqual([]);
  expect((await load()).etag).toBe(before.etag);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await open(page, 'synthetic-04');
  await field(page, 'Finish');
  await expect(page.locator('#reviewed-value')).toHaveValue(before.proposal.fields.find(item => item.id === 'finish').value);
  await expect(page.locator('#reason')).toHaveValue('');
});

test('a failed local sign-out still resets the workbench and explains the remaining Microsoft session', async ({ page }) => {
  await page.exposeFunction('__testLogout', () => { throw new Error('The token cache could not be cleared.'); });
  await expect(page.getByRole('button', { name: 'Logout', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Logout', exact: true }).click();
  await expect(page.locator('#identity')).toHaveText('Not signed in');
  await expect(page.locator('.queue-item')).toHaveCount(0);
  await expect(page.locator('#pdf-sheet')).toBeHidden();
  await expect(page.locator('#message')).toContainText('Microsoft sign-out did not complete');
  await expect(page.locator('#message')).toContainText('signed out of the workbench');
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled();
  await expect(page).toHaveURL(`${origin}/`);
});

test('an account without a Reviewer role can still use Logout', async ({ page }) => {
  let caseRequests = 0;
  await page.route('**/api/me', route => route.fulfill({
    contentType: 'application/json', body: JSON.stringify({ id: 'unassigned-account', roles: [] })
  }));
  await page.route('**/api/cases', route => { caseRequests++; return route.continue(); });
  await page.reload();
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.locator('#message')).toContainText('no Reviewer role');
  await expect(page.getByRole('button', { name: 'Logout', exact: true })).toBeVisible();
  expect(caseRequests).toBe(0);
  await page.getByRole('button', { name: 'Logout', exact: true }).click();
  await expect(page.locator('#identity')).toHaveText('Not signed in');
  await expect(page.locator('.queue-item')).toHaveCount(0);
});

test('a logout callback without an authentication payload returns to a clean sign-in page', async ({ page }) => {
  await page.goto(`${origin}/auth.html`);
  await expect(page).toHaveURL(`${origin}/`);
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeEnabled();
  await expect(page.locator('#identity')).toHaveText('Not signed in');
  await expect(page.locator('.queue-item')).toHaveCount(0);
});
