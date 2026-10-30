import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join, relative } from 'node:path';
import { spawnSync } from 'node:child_process';
import { redactString, redactHeaders, redactUrl, redactObject, redactCookies, SENSITIVE_KEYS } from '../src/redact.ts';
import { createLogger } from '../src/logger.ts';
import { getProfilesDir, getEvidenceDir, getScreenshotsDir } from '../src/paths.ts';
import { saveHtml, saveNetworkLog, saveNote, saveScreenshot } from '../src/flow/evidence.ts';

const secrets = ['COOKIE_SECRET_TEST', 'TOKEN_SECRET_TEST', 'PASSWORD_SECRET_TEST', 'ya29.OAUTH_SECRET_TEST', '1//OAUTH_SECRET_TEST', 'eyJTEST_SECRET.eyJTEST_SECRET.TEST_SECRET'];
function assertClean(text: string) { for (const secret of secrets) assert.ok(!text.includes(secret), `Leaked ${secret}`); }
test('shared filters handle text, URL, headers, cookies, errors and cycles', () => {
  assertClean(redactString(`Cookie: other=${secrets[0]}; HSID=COOKIE_SECRET_TEST\nAuthorization: Bearer ${secrets[1]}\nBasic TOKEN_SECRET_TEST ${secrets.slice(3).join(' ')}\npassword=${secrets[2]}`));
  const url = 'https://labs.google/x?prompt=hello&access_token=TOKEN_SECRET_TEST&project=PROJ-TEST';
  assert.equal(redactUrl(url), 'https://labs.google/x?prompt=hello&access_token=[REDACTED]&project=PROJ-TEST');
  assert.equal(redactUrl('?%74oken=TOKEN_SECRET_TEST&ok=yes'), '?%74oken=[REDACTED]&ok=yes');
  for (const headers of [{ CoOkIe: secrets[0], Authorization: secrets[1] }, new Map([['COOKIE', secrets[0]], ['X-Api-Key', secrets[1]]])]) assertClean(JSON.stringify(redactHeaders(headers)));
  for (const key of SENSITIVE_KEYS) assertClean(JSON.stringify(redactObject({ [key.replace('*', 'test')]: secrets[1] })));
  const cycle: Record<string, unknown> = { nested: [{ token: secrets[1] }], error: new Error(`token=${secrets[1]}`) };
  cycle.self = cycle;
  assertClean(JSON.stringify(redactObject(cycle)));
  const cookies: unknown[] = [];
  cookies.push({ name: 'TEST', value: secrets[0], cookies });
  assertClean(JSON.stringify(redactCookies(cookies)));
  assertClean(JSON.stringify(redactCookies([{ name: 'ordinary', value: secrets[0] }])));
  assert.equal(redactString('prompt: a garden PROJ-TEST C:\\data\\project.png'), 'prompt: a garden PROJ-TEST C:\\data\\project.png');
});

test('logger and evidence files retain no fake secrets; paths are contained', t => {
  const home = mkdtempSync(join(process.cwd(), 'test', '.redaction-'));
  const previous = process.env.VIDFLOW_HOME;
  process.env.VIDFLOW_HOME = home;
  t.after(() => { if (previous === undefined) delete process.env.VIDFLOW_HOME; else process.env.VIDFLOW_HOME = previous; rmSync(home, { recursive: true, force: true }); });
  const logger = createLogger();
  logger.info(`Bearer ${secrets[1]}`, { cookie: secrets[0], error: new Error(`token=${secrets[1]}`), nested: { password: secrets[2] } });
  logger.flush(); logger.close();
  assertClean(readFileSync(join(home, 'logs', 'vidflow.log'), 'utf8'));
  saveHtml('TEST-run', 'page', `<script>document.cookie="SID=${secrets[0]}"</script><input value="${secrets[2]}" type=password><input type='hidden' value='${secrets[1]}'>`);
  saveNetworkLog('TEST-run', [{ request: { url: `https://labs.google/x?access_token=${secrets[1]}`, headers: { Cookie: secrets[0], Authorization: secrets[1] }, cookies: [{ name: 'other', value: secrets[0] }], postData: { text: `password=${secrets[2]}`, params: [{ name: 'password', value: secrets[2] }] } }, response: { headers: [{ name: 'Set-Cookie', value: secrets[0] }], content: { text: secrets[0] }, body: secrets[1] } }]);
  saveNote('TEST-run', `Basic ${secrets[1]}\ntoken=${secrets[1]}`);
  assert.equal(saveScreenshot('TEST-run', 'login', Buffer.from('TEST'), { loginPage: true }), undefined);
  const screenshot = saveScreenshot('TEST-run', 'masked', Buffer.from('TEST'), { loginPage: true, maskedBuffer: Buffer.from('MASKED_TEST') });
  assert.ok(screenshot?.startsWith(home));
  for (const entry of readdirSync(getEvidenceDir(), { recursive: true, withFileTypes: true })) {
    if (entry.isFile()) assertClean(readFileSync(join(entry.parentPath, entry.name), 'utf8'));
  }
  for (const directory of [getProfilesDir(), getEvidenceDir(), getScreenshotsDir('TEST-run')]) assert.ok(!relative(home, directory).startsWith('..'));
  for (const action of [() => saveNote('../escape', ''), () => saveHtml('TEST-run', '../escape', ''), () => getScreenshotsDir('../escape')]) assert.throws(action);
});

test('runtime evidence and browser state are ignored by Git', t => {
  const ignore = readFileSync(new URL('../.gitignore', import.meta.url), 'utf8');
  for (const pattern of ['profiles/', '**/profiles/', 'evidence/', 'screenshots/', '*.har', '*.cookies.json', 'storage-state*.json', '.env', '.env.*', '!.env.example']) assert.ok(ignore.split(/\r?\n/).includes(pattern), pattern);
  const available = spawnSync('git', ['rev-parse', '--is-inside-work-tree'], { timeout: 5000, encoding: 'utf8' });
  if (available.status !== 0) { t.skip('Git unavailable or workspace has no Git metadata; patterns checked'); return; }
  for (const filename of ['profiles/TEST/state', 'evidence/TEST/page.html', 'screenshots/TEST.png']) {
    const result = spawnSync('git', ['check-ignore', '--no-index', filename], { timeout: 5000, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
  }
});
