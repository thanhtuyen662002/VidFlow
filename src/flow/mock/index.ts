import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Socket } from 'node:net';
import { resolveFfmpeg } from '../../media/discovery.ts';
import { runFfmpeg } from '../../media/runner.ts';
import { runtimeMp4 } from './mp4.ts';

export const FAKE_FLOW_SELECTORS = Object.fromEntries(
  ['login-email', 'login-submit', 'prompt-input', 'image-input', 'generate-button', 'credit-balance',
    'job-item', 'job-status', 'video-result', 'download-link', 'error-banner', 'verify-challenge',
    'verify-clear', 'prompt-textarea-v2', 'generate-button-v2'].map(name => [name, `[data-testid="${name}"]`]),
) as Record<string, string>;

export interface FakeFlowOptions {
  onGenerate?: () => void;
  credits?: number; cost?: number; delayMs?: number;
  rejectPrompt?: boolean | (string | RegExp)[];
  verification?: boolean; domVariant?: 'default' | 'changed'; jobFails?: boolean;
}
interface Job { id: string; prompt: string; status: 'pending' | 'running' | 'done' | 'failed'; mediaUrl?: string }

export async function startFakeFlow(options: FakeFlowOptions = {}) {
  const initial = { credits: 100, cost: 10, delayMs: 400, ...options };
  let scenario = { ...initial };
  const tempDir = await mkdtemp(join(tmpdir(), 'vidflow fake '));
  const state = { tempDir, credits: initial.credits, jobs: [] as Job[], uploadedFiles: [] as string[],
    sessions: new Set<string>(), mediaSource: '' };
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const sockets = new Set<Socket>();
  const abort = new AbortController();
  let media: Promise<Buffer> | undefined;
  let closed = false;
  let generation = 0;
  const work = new Set<Promise<void>>();
  const later = (fn: () => void, ms: number) => {
    const timer = setTimeout(() => { timers.delete(timer); fn(); }, ms); timers.add(timer);
  };
  async function video() {
    if (!media) media = (async () => {
      const file = join(tempDir, 'sample.mp4');
      let binary: string;
      try { binary = resolveFfmpeg(); }
      catch { state.mediaSource = 'runtime MP4 fallback (raw RGB)'; return runtimeMp4(); }
      for (const codec of ['libx264', 'mpeg4']) {
        try {
          await runFfmpeg(['-y', '-f', 'lavfi', '-i', 'testsrc=duration=2:size=320x240:rate=24',
            '-pix_fmt', 'yuv420p', '-c:v', codec, file], { timeoutMs: 15000, signal: abort.signal });
          state.mediaSource = `${binary} (${codec})`; return await readFile(file);
        } catch (error) { if (closed || codec === 'mpeg4') throw error; }
      }
      throw new Error('No video codec');
    })();
    return media;
  }
  function setScenario(partial: FakeFlowOptions) {
    scenario = { ...scenario, ...partial };
    if (partial.credits !== undefined) state.credits = partial.credits;
  }
  async function reset() {
    generation++; for (const timer of timers) clearTimeout(timer); timers.clear();
    await Promise.allSettled([...work]);
    await Promise.all(state.uploadedFiles.map(file => rm(file, { force: true })));
    state.uploadedFiles.length = 0; state.jobs.length = 0; state.sessions.clear();
    scenario = { ...initial }; state.credits = initial.credits;
  }
  function page() {
    if (scenario.verification) return `<h1 data-testid="verify-challenge">Verify it's you</h1><form method="post" action="/__verify"><button data-testid="verify-clear">Clear fake verification</button></form>`;
    const changed = scenario.domVariant === 'changed';
    return `<h1>Fake Flow</h1><span data-testid="credit-balance">${state.credits}</span>
      <textarea data-testid="${changed ? 'prompt-textarea-v2' : 'prompt-input'}" id="prompt"></textarea>
      <input type="file" data-testid="image-input" id="image" accept="image/*">
      <${changed ? 'aside' : 'div'} class="${changed ? 'toolbar-v2' : 'toolbar'}"><button id="generate" data-testid="${changed ? 'generate-button-v2' : 'generate-button'}">Generate</button></${changed ? 'aside' : 'div'}>
      <p data-testid="error-banner" id="error" hidden></p><ul id="results"></ul>
      <script>
      const error = document.getElementById('error');
      const generate = document.getElementById('generate');
      const results = document.getElementById('results');
      generate.onclick = async () => { try {
        error.hidden = true;
        const file = document.getElementById('image').files[0];
        let image;
        if (file) image = await new Promise((resolve,reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result.split(',')[1]); reader.onerror = reject; reader.readAsDataURL(file); });
        const response = await fetch('/api/generate', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({prompt:document.getElementById('prompt').value,image})});
        const job = await response.json();
        if (job.code === 'VERIFICATION_REQUIRED') { location.reload(); return; }
        if (!response.ok) throw new Error(job.message);
        document.querySelector(${JSON.stringify(FAKE_FLOW_SELECTORS['credit-balance'])}).textContent = job.credits;
        const item = document.createElement('li'); item.dataset.testid='job-item';
        const status = document.createElement('span'); status.dataset.testid='job-status'; item.append(status); results.append(item);
        async function poll() {
          const current = await (await fetch('/api/jobs/'+job.id)).json(); status.textContent=current.status;
          if(current.status==='done') {
            const video=document.createElement('video'); video.dataset.testid='video-result'; video.src=current.mediaUrl; video.controls=true;
            const link=document.createElement('a'); link.dataset.testid='download-link'; link.href=current.mediaUrl; link.download='result.mp4'; link.textContent='Download'; item.append(video,link);
          } else if(current.status==='failed') { error.textContent='Job failed'; error.hidden=false; }
          else setTimeout(poll,50);
        } await poll();
      } catch(e) { error.textContent=e.message; error.hidden=false; } };
      </script>`;
  }
  const server = createServer((req, res) => {
    const task = (async () => {
      const path = new URL(req.url || '/', 'http://127.0.0.1').pathname;
      const send = (code: number, body: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
      const html = (body: string) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end('<!doctype html><meta charset="utf-8">' + body); };
      const redirect = (target: string) => { res.writeHead(303, { Location: target }); res.end(); };
      // DOM inventory for selftest: includes controls from login and completed jobs.
      if (path === '/selftest' && req.method === 'GET') return html(page() + `
        <input data-testid="login-email"><button data-testid="login-submit">Login</button>
        <select data-testid="model-select"></select><select data-testid="aspect-ratio-select"></select>
        <button data-testid="account-menu">Account</button>
        <li data-testid="job-item"><span data-testid="job-status">done</span>
        <video data-testid="video-result"></video><a data-testid="download-link">Download</a></li>
        <div hidden data-testid="verify-challenge"></div><button hidden data-testid="verify-clear"></button>
        <textarea hidden data-testid="prompt-textarea-v2"></textarea><button hidden data-testid="generate-button-v2"></button>`);
      if (path === '/login' && req.method === 'GET') return html('<form method="post"><input name="email" data-testid="login-email"><button data-testid="login-submit">Login</button></form>');
      // Bound request bodies, including uploads, before parsing or writing to disk.
      const body = async () => {
        const chunks: Buffer[] = []; let size = 0;
        for await (const chunk of req) { size += chunk.length; if (size > 8 * 1024 * 1024) throw new Error('Body too large'); chunks.push(chunk); }
        return Buffer.concat(chunks).toString('utf8');
      };
      if (path === '/login' && req.method === 'POST') {
        await body(); const session = randomUUID(); state.sessions.add(session);
        res.setHeader('Set-Cookie', `fake_session=${session}; HttpOnly; SameSite=Strict; Path=/`); return redirect('/project');
      }
      const session = /(?:^|;\s*)fake_session=([^;]+)/.exec(req.headers.cookie || '')?.[1];
      if (!session || !state.sessions.has(session)) return redirect('/login');
      if (path === '/__verify' && req.method === 'POST') { scenario.verification = false; return redirect('/project'); }
      if ((path === '/project' || path === '/') && req.method === 'GET') return html(page());
      if (path === '/api/generate' && req.method === 'POST') {
        const input = JSON.parse(await body());
        if (closed) return;
        if (scenario.verification) return send(403, { code: 'VERIFICATION_REQUIRED', message: "Verify it's you" });
        const prompt = String(input.prompt || '');
        const reject = scenario.rejectPrompt;
        if (reject === true || (Array.isArray(reject) && reject.some(rule => typeof rule === 'string' ? prompt.includes(rule) : new RegExp(rule.source, rule.flags.replace(/[gy]/g, '')).test(prompt))))
          return send(422, { code: 'POLICY_REJECTION', message: 'Prompt rejected by policy' });
        if (state.credits < scenario.cost) return send(402, { code: 'OUT_OF_CREDITS', message: 'Out of credits' });
        if (input.image) {
          const file = join(tempDir, `${randomUUID()}.png`);
          await writeFile(file, Buffer.from(String(input.image), 'base64')); state.uploadedFiles.push(file);
        }
        if (closed) return;
        // Another upload may have completed while this request was writing its image.
        if (state.credits < scenario.cost) return send(402, { code: 'OUT_OF_CREDITS', message: 'Out of credits' });
        scenario.onGenerate?.();
        state.credits -= scenario.cost;
        const job: Job = { id: randomUUID(), prompt, status: 'pending' }; state.jobs.push(job);
        const epoch = generation; const fails = scenario.jobFails;
        later(() => { job.status = 'running'; }, scenario.delayMs / 2);
        later(() => {
          const finish = (async () => {
            try { if (fails) job.status = 'failed'; else { await video(); if (!closed && epoch === generation) { job.status = 'done'; job.mediaUrl = `/media/${job.id}.mp4`; } } }
            catch { job.status = 'failed'; }
          })(); work.add(finish); void finish.finally(() => work.delete(finish));
        }, scenario.delayMs);
        return send(202, { ...job, credits: state.credits });
      }
      const job = state.jobs.find(job => path === `/api/jobs/${job.id}` || path === `/media/${job.id}.mp4`);
      if (job && req.method === 'GET') {
        if (path.startsWith('/api/')) return send(200, job);
        if (job.status !== 'done') return send(409, { message: 'Not ready' });
        const bytes = await video(); res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': bytes.length }); return res.end(bytes);
      }
      send(404, { message: 'Not found' });
    })().catch(() => { if (!res.headersSent) res.writeHead(400); res.end(); });
    work.add(task); void task.finally(() => work.delete(task));
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  try { await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); }
  catch (error) { await rm(tempDir, { recursive: true, force: true }); throw error; }
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing server address');
  let closing: Promise<void> | undefined;
  function close(): Promise<void> {
    if (!closing) closing = (async () => {
      closed = true; abort.abort(); for (const timer of timers) clearTimeout(timer); timers.clear();
      const stopped = new Promise<void>(resolve => server.close(() => resolve()));
      for (const socket of sockets) socket.destroy();
      await stopped; await Promise.allSettled([...work]);
      await rm(tempDir, { recursive: true, force: true });
    })();
    return closing;
  }
  return { url: `http://127.0.0.1:${address.port}`, port: address.port, state, setScenario, reset, close };
}
