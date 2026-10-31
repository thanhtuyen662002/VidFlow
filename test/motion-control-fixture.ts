import type { TestContext } from 'node:test';
import { temporaryDatabase } from './helpers.ts';
import { migrate } from '../src/migrations.ts';
import { createProject } from '../src/repo/projects.ts';
import { createAccount } from '../src/flow/accounts.ts';
import { addEntry } from '../src/flow/credits.ts';
import { MockLlm, SAMPLE_MOTION } from '../src/script/llm/mock.ts';
import { createCoreService } from '../src/service/index.ts';
import { startFakeFlow } from '../src/flow/mock/index.ts';
import { motionSelectors } from '../src/flow/selectors.ts';
import { launchHeadless } from './support/browser.ts';
import { makeTestVideo } from './helpers/media.ts';

export async function motionControlFixture(t: TestContext) {
  const db = temporaryDatabase(t); migrate(db);
  const project = createProject(db, 'Chuyển động thử nghiệm', '16:9', null);
  await makeTestVideo(project.directory);
  const filePath = 'test-video.mp4';
  const accountId = String(createAccount(db, { label: 'Thử nghiệm' }).id);
  addEntry(db, { accountId, amount: 10000, reason: 'Test' });
  const session = await launchHeadless();
  t.after(() => session.close());
  const fake = await startFakeFlow({ credits: 10000, delayMs: 10 });
  t.after(() => fake.close());
  await session.page.goto(fake.url + '/login');
  await session.page.locator('[data-testid="login-email"]').fill('fake');
  await Promise.all([session.page.waitForURL('**/project'), session.page.locator('[data-testid="login-submit"]').click()]);
  const selectors = { ...motionSelectors('mock'), creditCounter: { selector: '[data-testid="credit-balance"]' }, errorBanner: { selector: '[data-testid="error-banner"]' }, 'verify-challenge': { selector: '[data-testid="verify-challenge"]' } };
  const llm = new MockLlm([r => JSON.stringify(r.prompt.includes('"task":"motion_subjects"') ? SAMPLE_MOTION : { score: 95, face_detected: false })]);
  const service = createCoreService({ db, llm, flowDriver: { async run() { throw new Error('Unexpected generic dispatch'); } },
    motion: { context: () => ({ db, browser: session.context, url: fake.url + '/project', timeoutMs: 30000, selectors }) } });
  return { service, project, filePath, accountId, fake };
}
