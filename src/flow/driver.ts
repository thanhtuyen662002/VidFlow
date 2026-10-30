import { mkdirSync, existsSync, renameSync } from 'node:fs';
import { relative, extname, isAbsolute } from 'node:path';
import type { BrowserContext, Page } from 'playwright';
import type { DatabaseSync } from 'node:sqlite';
import { dataDirectory, getProfilesDir, projectDirectory, resolveInside } from '../paths.ts';
import { redactObject, redactString } from '../redact.ts';
import { saveNote } from './evidence.ts';
import { setAccountStatus } from './accounts.ts';
import { chargeJob } from './credits.ts';
import { getJob } from './queue.ts';
import { flowPatterns, loadSelectors } from './selectors.ts';
import type { Selectors } from './selectors.ts';
export type { FlowJobDriver } from './jobDriver.ts';

/** Minimal page boundary, implemented by the guarded Playwright adapter below. */
export interface FlowPage {
  goto(url: string): Promise<void>;
  fill(prompt: string): Promise<void>;
  click(name: string): Promise<void>;
  text(name: string): Promise<string>;
  guard(): Promise<void>;
  credits(): Promise<number>;
  upload(files: string[]): Promise<void>;
  download(directory: string, job: FlowJob): Promise<string>;
}

export type FlowJobResult =
  | { kind: 'completed'; files: string[]; creditsBefore: number; creditsAfter: number; creditsCharged: number }
  | { kind: 'rejected'; reason: string; rawMessage?: string }
  | { kind: 'out_of_credits'; creditsSeen?: number }
  | { kind: 'verification_required'; detectedBy: string; url: string }
  | { kind: 'failed'; error: string; retryable: boolean };
export interface FlowJob { id: string; projectId: string; accountId: string; prompt: string; images?: string[]; outputDir: string; takeIndex?: number }
export interface ActionEntry { seq: number; ts: string; action: 'goto' | 'fill' | 'click' | 'upload' | 'download' | 'read'; target: string }
export interface FlowDriverContext {
  db: DatabaseSync; browser: BrowserContext; url: string; timeoutMs: number;
  selectors?: Selectors; record?: (entry: ActionEntry) => void; evidenceRunId?: string;
  page?: FlowPage;
}
export interface FlowDriver { runJob(job: FlowJob, ctx: FlowDriverContext): Promise<FlowJobResult> }

/** Caller owns the context, including closing it after a human has inspected a challenge. */
export async function launchFlowContext(accountId: string, headless = false): Promise<BrowserContext> {
  if (!/^[a-z0-9_-]+$/i.test(accountId)) throw new Error('Invalid account ID');
  const profile = resolveInside(getProfilesDir(), accountId);
  // Prevent accidental storage inside this checkout, even with a misconfigured VIDFLOW_HOME.
  const offset = relative(process.cwd(), profile);
  if (offset !== '..' && !offset.startsWith('../') && !offset.startsWith('..\\') && !isAbsolute(offset)) throw new Error('Browser profiles must be outside the checkout');
  const { chromium } = await import('playwright');
  return chromium.launchPersistentContext(profile, { headless, acceptDownloads: true });
}

class VerificationStop extends Error {
  result: Extract<FlowJobResult, { kind: 'verification_required' }>;
  constructor(detectedBy: string, url: string) {
    super('Verification required'); this.result = { kind: 'verification_required', detectedBy, url };
  }
}

/** Every page operation lives here. Logs contain symbolic targets only, never input values. */
class ActionRecorder implements FlowPage {
  page: Page; ctx: FlowDriverContext; selectors: Selectors; seq = 0; stopped?: VerificationStop;
  constructor(page: Page, ctx: FlowDriverContext) { this.page = page; this.ctx = ctx; this.selectors = ctx.selectors ?? loadSelectors(undefined, 'real'); }
  log(action: ActionEntry['action'], target: string) {
    const entry = redactObject({ seq: ++this.seq, ts: new Date().toISOString(), action, target }) as ActionEntry;
    this.ctx.record?.(entry);
  }
  selector(name: string) {
    const selector = this.selectors[name]?.selector;
    if (!selector) throw new Error('Selector not configured');
    return selector;
  }
  async guard() {
    if (this.stopped) throw this.stopped;
    this.log('read', 'verification-check');
    const configured = this.selectors['verify-challenge']?.selector;
    const challenge = this.page.locator([configured, flowPatterns.verificationSelector].filter(Boolean).join(', '));
    let detectedBy: string | undefined;
    for (let i = 0; i < await challenge.count(); i++) {
      if (await challenge.nth(i).isVisible()) { detectedBy = 'challenge-selector'; break; }
    }
    if (!detectedBy && flowPatterns.verification.test(await this.page.locator('body').innerText({ timeout: this.ctx.timeoutMs }))) detectedBy = 'challenge-text';
    if (!detectedBy && await this.page.locator('input[type="email"], input[type="password"]').first().isVisible()) detectedBy = 'sign-in';
    if (detectedBy) {
      this.log('read', 'verification-detected');
      this.stopped = new VerificationStop(detectedBy, redactString(this.page.url()));
      throw this.stopped;
    }
  }
  async goto(url: string) { await this.guard(); this.log('goto', 'flow-page'); await this.page.goto(url, { timeout: this.ctx.timeoutMs, waitUntil: 'domcontentloaded' }); await this.guard(); }
  async fill(prompt: string) { await this.guard(); this.log('fill', 'promptInput'); await this.page.locator(this.selector('promptInput')).fill(prompt, { timeout: this.ctx.timeoutMs }); }
  async upload(files: string[]) { await this.guard(); this.log('upload', 'referenceUpload'); await this.page.locator(this.selector('referenceUpload')).setInputFiles(files, { timeout: this.ctx.timeoutMs }); }
  async click(name: string) { await this.guard(); this.log('click', name); await this.page.locator(this.selector(name)).click({ timeout: this.ctx.timeoutMs, noWaitAfter: true }); }
  async text(name: string) {
    await this.guard(); this.log('read', name);
    const locator = this.page.locator(this.selector(name)).last();
    return await locator.isVisible() ? (await locator.innerText({ timeout: this.ctx.timeoutMs })).trim() : '';
  }
  async credits() {
    const value = await this.text('creditCounter');
    if (!/^\d+$/.test(value)) throw new Error('Invalid credit counter');
    const credits = Number(value); if (!Number.isSafeInteger(credits)) throw new Error('Invalid credit counter'); return credits;
  }
  async download(directory: string, job: FlowJob) {
    await this.guard();
    // Attach the listener before clicking; consume its rejection even when the click fails.
    const pending = this.page.waitForEvent('download', { timeout: this.ctx.timeoutMs });
    void pending.catch(() => {});
    await this.click('downloadButton');
    const download = await pending;
    await this.guard();
    const extension = extname(download.suggestedFilename());
    if (!/^\.[a-z0-9]{1,8}$/i.test(extension)) throw new Error('Invalid file extension');
    const filename = resolveInside(directory, `${job.id}_${job.takeIndex ?? 0}${extension}`);
    if (existsSync(filename)) throw new Error('Original take already exists');
    this.log('download', 'generated-file'); await download.saveAs(filename + '.partial');
    renameSync(filename + '.partial', filename);
    return filename;
  }
  static async create(ctx: FlowDriverContext) {
    const page = ctx.browser.pages()[0] ?? await ctx.browser.newPage();
    return new ActionRecorder(page, ctx);
  }
}

export async function playwrightFlowPage(ctx: FlowDriverContext): Promise<FlowPage> {
  return ActionRecorder.create(ctx);
}

export const flowDriver: FlowDriver = {
  async runJob(job, ctx) {
    let recorder: FlowPage | undefined;
    try {
      if (!Number.isFinite(ctx.timeoutMs) || ctx.timeoutMs <= 0) throw new Error('Invalid timeout');
      if (!/^[a-z0-9_-]+$/i.test(job.id) || !Number.isSafeInteger(job.takeIndex ?? 0) || (job.takeIndex ?? 0) < 0) throw new Error('Invalid job');
      if (!getJob(ctx.db, job.id)) throw new Error('Queue job not found');
      // A completed charge must never cause another paid generation on retry.
      const previousCharge = ctx.db.prepare('SELECT account_id FROM credit_ledger WHERE job_id=? AND amount IS NOT NULL').get(job.id);
        const payload = JSON.parse(String(getJob(ctx.db, job.id)!.payload));
        const interrupted = payload.interruptedRecovery === true || payload.renderRetry === true;
      if (previousCharge && (!interrupted || previousCharge.account_id !== job.accountId)) {
        return { kind: 'failed', error: 'Job already charged; use the existing take', retryable: false };
      }
      const root = projectDirectory(job.projectId);
      resolveInside(dataDirectory(), relative(dataDirectory(), root));
      const output = resolveInside(root, relative(root, job.outputDir));
      const images = (job.images ?? []).map(file => resolveInside(root, relative(root, file)));
      mkdirSync(output, { recursive: true });
      recorder = ctx.page ?? await playwrightFlowPage(ctx);
      await recorder.goto(ctx.url);
      const creditsBefore = await recorder.credits();
      if (creditsBefore === 0) { setAccountStatus(ctx.db, job.accountId, 'out_of_credit'); return { kind: 'out_of_credits', creditsSeen: 0 }; }
      await recorder.fill(job.prompt);
      if (images.length) await recorder.upload(images);
      await recorder.click('generateButton');
      const deadline = Date.now() + ctx.timeoutMs;
      while (Date.now() < deadline) {
        await recorder.guard();
        const message = await recorder.text('errorBanner');
        if (flowPatterns.noCredit.test(message)) { setAccountStatus(ctx.db, job.accountId, 'out_of_credit'); return { kind: 'out_of_credits', creditsSeen: await recorder.credits() }; }
        if (flowPatterns.rejected.test(message)) return { kind: 'rejected', reason: redactString(message) };
        if (message) return { kind: 'failed', error: 'Flow generation failed', retryable: false };
        if (await recorder.text('downloadButton')) {
          const files = [await recorder.download(output, job)];
          const creditsAfter = await recorder.credits();
          const creditsCharged = creditsBefore - creditsAfter;
          chargeJob(ctx.db, job.accountId, job.id, creditsCharged);
          return { kind: 'completed', files, creditsBefore, creditsAfter, creditsCharged };
        }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      return { kind: 'failed', error: 'Flow generation timed out', retryable: true };
    } catch (error) {
      let failure = error;
      // A challenge can replace a control while Playwright is waiting for that control.
      if (recorder && !(failure instanceof VerificationStop)) {
        try { await recorder.guard(); } catch (detected) { if (detected instanceof VerificationStop) failure = detected; }
      }
      if (failure instanceof VerificationStop) {
        try { setAccountStatus(ctx.db, job.accountId, 'needs_owner', 'Verification required'); } catch { /* Preserve the typed hard stop even if storage is unavailable. */ }
        return failure.result;
      }
      // Never persist Playwright errors: they may contain prompt text, paths or DOM values.
      if (ctx.evidenceRunId) {
        try { saveNote(ctx.evidenceRunId, 'Flow driver failed; page contents and input values omitted.'); } catch { /* Evidence failure must not change the result contract. */ }
      }
      return { kind: 'failed', error: 'Flow driver failed; check configuration and selectors', retryable: true };
    }
  },
};
