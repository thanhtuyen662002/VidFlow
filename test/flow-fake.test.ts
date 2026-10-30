import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { startFakeFlow, FAKE_FLOW_SELECTORS as selectors } from './support/flow-fake/index.ts';
import { browserAvailable, BROWSER_SKIP_REASON, launchHeadless } from './support/browser.ts';
import { mediaHome } from './helpers/media.ts';

async function login(url: string) {
  const response = await fetch(url + '/login', { method: 'POST', body: 'email=fake', redirect: 'manual' });
  assert.equal(response.status, 303);
  return response.headers.get('set-cookie')!.split(';')[0];
}
function generate(url: string, cookie: string, prompt = 'A forest', image?: string) {
  return fetch(url + '/api/generate', { method: 'POST', headers: { cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt, image }) });
}
async function waitForJob(url: string, cookie: string, id: string) {
  for (let attempt = 0; attempt < 500; attempt++) {
    const job = await (await fetch(`${url}/api/jobs/${id}`, { headers: { cookie } })).json();
    if (job.status === 'done' || job.status === 'failed') return job;
    await delay(50);
  }
  throw new Error('Fake job did not finish within 25 seconds');
}
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64');

test('fake Flow: HTTP login, upload, job, MP4 and idempotent cleanup', async t => {
  mediaHome(t);
  const flow = await startFakeFlow({ delayMs: 30 }); t.after(() => flow.close());
  assert.equal(new URL(flow.url).hostname, '127.0.0.1'); assert.ok(flow.port > 0);
  const anonymous = await fetch(flow.url + '/project', { redirect: 'manual' });
  assert.equal(anonymous.headers.get('location'), '/login');
  const cookie = await login(flow.url);
  const response = await generate(flow.url, cookie, 'Forest', png.toString('base64'));
  assert.equal(response.status, 202);
  const pending = await response.json(); assert.equal(pending.status, 'pending');
  assert.equal(flow.state.credits, 90);
  assert.deepEqual(await readFile(flow.state.uploadedFiles[0]), png);
  const job = await waitForJob(flow.url, cookie, pending.id); assert.equal(job.status, 'done');
  const download = await fetch(flow.url + job.mediaUrl, { headers: { cookie } });
  assert.equal(download.headers.get('content-type'), 'video/mp4');
  const bytes = Buffer.from(await download.arrayBuffer());
  assert.ok(bytes.length > 32); assert.equal(bytes.toString('ascii', 4, 8), 'ftyp');
  t.diagnostic(`MP4 source: ${flow.state.mediaSource}`);
  await flow.close(); await flow.close(); assert.equal(existsSync(flow.state.tempDir), false);
  await assert.rejects(fetch(flow.url));
});

for (const [name, options, code] of [
  ['rejectPrompt', { rejectPrompt: true }, 'POLICY_REJECTION'],
  ['out of credits', { credits: 0 }, 'OUT_OF_CREDITS'],
  ['verification', { verification: true }, 'VERIFICATION_REQUIRED'],
] as const) {
  test(`fake Flow scenario: ${name}`, async t => {
    mediaHome(t); const flow = await startFakeFlow(options); t.after(() => flow.close());
    const cookie = await login(flow.url);
    const response = await generate(flow.url, cookie);
    assert.equal((await response.json()).code, code); assert.equal(flow.state.jobs.length, 0);
    assert.equal(flow.state.credits, options.credits ?? 100);
    if (name === 'verification') {
      const page = await (await fetch(flow.url + '/project', { headers: { cookie } })).text();
      assert.match(page, /data-testid="verify-challenge"/);
      await fetch(flow.url + '/__verify', { method: 'POST', headers: { cookie }, redirect: 'manual' });
      assert.doesNotMatch(await (await fetch(flow.url + '/project', { headers: { cookie } })).text(), /data-testid="verify-challenge"/);
    }
  });
}

test('fake Flow scenario: changed DOM and runtime configuration, regex, failed jobs, reset', async t => {
  mediaHome(t); const flow = await startFakeFlow({ domVariant: 'changed', delayMs: 20 }); t.after(() => flow.close());
  const cookie = await login(flow.url);
  const page = await (await fetch(flow.url + '/project', { headers: { cookie } })).text();
  assert.doesNotMatch(page, /data-testid="prompt-input"/); assert.match(page, /data-testid="prompt-textarea-v2"/);
  assert.doesNotMatch(page, /data-testid="generate-button"/); assert.match(page, /data-testid="generate-button-v2"/);
  flow.setScenario({ rejectPrompt: ['forest', /blocked/gi] });
  for (const prompt of ['forest', 'BLOCKED', 'BLOCKED']) assert.equal((await generate(flow.url, cookie, prompt)).status, 422);
  flow.setScenario({ rejectPrompt: false, jobFails: true });
  const job = await (await generate(flow.url, cookie)).json();
  assert.equal((await waitForJob(flow.url, cookie, job.id)).status, 'failed');
  flow.setScenario({ verification: true });
  assert.equal((await generate(flow.url, cookie)).status, 403);
  await flow.reset(); assert.equal(flow.state.credits, 100); assert.equal(flow.state.jobs.length, 0); assert.equal(flow.state.sessions.size, 0);
});

test('fake Flow [browser]: login, upload, generate and download', { skip: browserAvailable ? false : BROWSER_SKIP_REASON }, async t => {
  const home = mediaHome(t); const flow = await startFakeFlow();
  try {
    const browser = await launchHeadless();
    try {
      const { page } = browser;
      await page.goto(flow.url + '/project');
      await page.locator(selectors['login-email']).fill('fake@example.invalid');
      await page.locator(selectors['login-submit']).click();
      await page.locator(selectors['prompt-input']).fill('A forest');
      const image = join(home, 'reference image.png'); await writeFile(image, png);
      await page.locator(selectors['image-input']).setInputFiles(image);
      await page.locator(selectors['generate-button']).click();
      await page.locator(selectors['video-result']).waitFor({ timeout: 25000 });
      assert.equal(await page.locator(selectors['credit-balance']).textContent(), '90');
      assert.equal(flow.state.uploadedFiles.length, 1);
      const downloadPromise = page.waitForEvent('download');
      await page.locator(selectors['download-link']).click();
      const download = await downloadPromise;
      const target = join(home, 'download.mp4'); await download.saveAs(target);
      const bytes = await readFile(target); assert.ok(bytes.length > 32); assert.equal(bytes.toString('ascii', 4, 8), 'ftyp');
      t.diagnostic(`MP4 source: ${flow.state.mediaSource}`);
    } finally { await browser.close(); }
  } finally { await flow.close(); }
});
