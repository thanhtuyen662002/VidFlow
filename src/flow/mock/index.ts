import { createServer } from 'node:http';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Socket } from 'node:net';
import { resolveFfmpeg } from '../../media/discovery.ts';
import { runFfmpeg } from '../../media/runner.ts';
import { runtimeMp4 } from './mp4.ts';
import { motionRoles, motionSelectorNames } from '../selectors.ts';

export const FAKE_FLOW_PRICES = { videoEdit: 12, frameImage: 2 } as const;
/** Pixel coordinates on the 320x240 fixture, shared with M10.6. */
export const FAKE_FLOW_WATERMARK = { x: 272, y: 216, width: 40, height: 16 } as const;
const watermarkFilter = `drawbox=x=${FAKE_FLOW_WATERMARK.x}:y=${FAKE_FLOW_WATERMARK.y}:w=${FAKE_FLOW_WATERMARK.width}:h=${FAKE_FLOW_WATERMARK.height}:color=white:t=fill`;

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
interface Job { id: string; prompt: string; status: 'pending' | 'running' | 'done' | 'failed'; mediaUrl?: string; mode?: string; variants?: number; references?: Record<string, string[]>; sourceVideo?: string; frameKind?: string }

export async function startFakeFlow(options: FakeFlowOptions = {}) {
  const initial = { credits: 100, cost: 10, delayMs: 400, ...options };
  let scenario = { ...initial };
  const tempDir = await mkdtemp(join(process.env.VIDFLOW_HOME || tmpdir(), 'vidflow fake '));
  const state = { tempDir, credits: initial.credits, jobs: [] as Job[], uploadedFiles: [] as string[],
    sessions: new Set<string>(), mediaSource: '', submitAttempts: 0 };
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
            '-vf', watermarkFilter, '-pix_fmt', 'yuv420p', '-c:v', codec, file], { timeoutMs: 15000, signal: abort.signal });
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
    state.uploadedFiles.length = 0; state.jobs.length = 0; state.sessions.clear(); state.submitAttempts = 0;
    scenario = { ...initial }; state.credits = initial.credits;
  }
  function page() {
    if (scenario.verification) return `<h1 data-testid="verify-challenge">Verify it's you</h1><form method="post" action="/__verify"><button data-testid="verify-clear">Clear fake verification</button></form>`;
    const changed = scenario.domVariant === 'changed';
    return `<h1>Fake Flow</h1><span data-testid="credit-balance">${state.credits}</span>${motionPage()}
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
  function motionPage() {
    return ['videoEdit', 'frameImage'].map(group => `
      <button data-testid="${group}.entry" type="button">${group}</button>
      <section id="${group}">
      ${group === 'videoEdit' ? `<input type="file" data-testid="${group}.video">` : `<select data-testid="${group}.kind"><option>first_frame</option><option>last_frame</option></select>`}
      ${motionRoles.map(role => `<input type="file" multiple data-testid="${group}.${role}">`).join('')}
      <textarea data-testid="${group}.prompt"></textarea>
      ${group === 'videoEdit' ? `<input type="number" min="1" value="1" data-testid="${group}.variants">` : ''}
      <button data-testid="${group}.submit">Generate ${group}</button>
      <span data-testid="${group}.progress" hidden>running</span>
      <span data-testid="${group}.finished" hidden>done</span><div id="${group}-downloads"></div></section>
      <script>(()=>{
        const group=${JSON.stringify(group)};
        const el=name=>document.querySelector('[data-testid="'+group+'.'+name+'"]');
        const encode=file=>new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result.split(',')[1]);reader.onerror=reject;reader.readAsDataURL(file)});
        el('submit').onclick=async()=>{try{
          el('progress').hidden=false;el('finished').hidden=true;document.getElementById(group+'-downloads').replaceChildren();
          const references={};
          for(const role of ${JSON.stringify(motionRoles)}) references[role]=await Promise.all([...el(role).files].map(encode));
          const sourceVideo=group==='videoEdit'&&el('video').files[0]?await encode(el('video').files[0]):undefined;
          const response=await fetch('/api/generate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({mode:group,prompt:el('prompt').value,references,sourceVideo,variants:group==='videoEdit'?Number(el('variants').value):1,frameKind:group==='frameImage'?el('kind').value:undefined})});
          const job=await response.json();if(job.code==='VERIFICATION_REQUIRED'){location.reload();return}if(!response.ok)throw Error(job.message);
          document.querySelector('[data-testid="credit-balance"]').textContent=job.credits;
          async function poll(){const current=await(await fetch('/api/jobs/'+job.id)).json();
            if(current.code==='VERIFICATION_REQUIRED'){location.reload();return}
            if(current.status==='failed')throw Error('Job failed');
            if(current.status!=='done'){setTimeout(()=>poll().catch(fail),50);return}
            for(let i=0;i<job.variants;i++){const a=document.createElement('a');a.dataset.testid=group+'.download';a.href=current.mediaUrl+'?variant='+i;a.download='result.'+(group==='videoEdit'?'mp4':'png');a.textContent='Download';document.getElementById(group+'-downloads').append(a)}
            el('progress').hidden=true;el('finished').hidden=false;
          }await poll();
        }catch(e){fail(e)}};
        function fail(e){const error=document.getElementById('error');error.textContent=e.message;error.hidden=false}
      })()</script>`).join('');
  }
  const server = createServer((req, res) => {
    const task = (async () => {
      const path = new URL(req.url || '/', 'http://127.0.0.1').pathname;
      const send = (code: number, body: unknown) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); };
      const html = (body: string) => { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end('<!doctype html><meta charset="utf-8">' + body); };
      const redirect = (target: string) => { res.writeHead(303, { Location: target }); res.end(); };
      // DOM inventory for selftest: includes controls from login and completed jobs.
      if (path === '/selftest' && req.method === 'GET') return html(page() + `
        ${motionSelectorNames.filter(name => name.endsWith('.download')).map(name => `<a data-testid="${name}">Download</a>`).join('')}
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
        state.submitAttempts++;
        if (closed) return;
        if (scenario.verification) return send(403, { code: 'VERIFICATION_REQUIRED', message: "Verify it's you" });
        const prompt = String(input.prompt || '');
        const reject = scenario.rejectPrompt;
        if (reject === true || (Array.isArray(reject) && reject.some(rule => typeof rule === 'string' ? prompt.includes(rule) : new RegExp(rule.source, rule.flags.replace(/[gy]/g, '')).test(prompt))))
          return send(422, { code: 'POLICY_REJECTION', message: 'Prompt rejected by policy' });
        const mode = input.mode;
        const variants = mode ? Number(input.variants) : 1;
        if (mode && (!['videoEdit', 'frameImage'].includes(mode) || !Number.isSafeInteger(variants) || variants < 1 || variants > 16 || (mode === 'videoEdit' && !input.sourceVideo) || (mode === 'frameImage' && (variants !== 1 || !['first_frame', 'last_frame'].includes(input.frameKind))))) return send(400, { message: 'Invalid motion request' });
        const cost = mode ? FAKE_FLOW_PRICES[mode as keyof typeof FAKE_FLOW_PRICES] * variants : scenario.cost;
        if (state.credits < cost) return send(402, { code: 'OUT_OF_CREDITS', message: 'Out of credits' });
        for (const bytes of [input.sourceVideo, ...Object.values(input.references ?? {}).flat()]) {
          if (typeof bytes !== 'string') continue;
          const file = join(tempDir, randomUUID()); await writeFile(file, Buffer.from(bytes, 'base64')); state.uploadedFiles.push(file);
        }
        if (input.image) {
          const file = join(tempDir, `${randomUUID()}.png`);
          await writeFile(file, Buffer.from(String(input.image), 'base64')); state.uploadedFiles.push(file);
        }
        if (closed) return;
        // Another upload may have completed while this request was writing its image.
        if (state.credits < cost) return send(402, { code: 'OUT_OF_CREDITS', message: 'Out of credits' });
        scenario.onGenerate?.();
        state.credits -= cost;
        const job: Job = { id: randomUUID(), prompt, status: 'pending', mode, variants, references: input.references, sourceVideo: input.sourceVideo, frameKind: input.frameKind }; state.jobs.push(job);
        const epoch = generation; const fails = scenario.jobFails;
        later(() => { job.status = 'running'; }, scenario.delayMs / 2);
        later(() => {
          const finish = (async () => {
            try { if (fails) job.status = 'failed'; else {
              if (mode === 'frameImage') await runFfmpeg(['-f', 'lavfi', '-i', `color=c=${input.frameKind === 'first_frame' ? 'blue' : 'green'}:s=320x240`, '-vf', watermarkFilter, '-frames:v', '1', join(tempDir, `${job.id}.png`)], { timeoutMs: 15000, signal: abort.signal });
              else { if (mode) resolveFfmpeg(); await video(); }
              if (!closed && epoch === generation) { job.status = 'done'; job.mediaUrl = `/media/${job.id}.${mode === 'frameImage' ? 'png' : 'mp4'}`; }
            } }
            catch { job.status = 'failed'; }
          })(); work.add(finish); void finish.finally(() => work.delete(finish));
        }, scenario.delayMs);
        return send(202, { ...job, credits: state.credits });
      }
      const job = state.jobs.find(job => path === `/api/jobs/${job.id}` || path === job.mediaUrl);
      if (job && req.method === 'GET') {
        if (job.mode && scenario.verification) return send(403, { code: 'VERIFICATION_REQUIRED' });
        if (path.startsWith('/api/')) return send(200, job);
        if (job.status !== 'done') return send(409, { message: 'Not ready' });
        const bytes = job.mode === 'frameImage' ? await readFile(join(tempDir, `${job.id}.png`)) : await video(); res.writeHead(200, { 'Content-Type': job.mode === 'frameImage' ? 'image/png' : 'video/mp4', 'Content-Length': bytes.length }); return res.end(bytes);
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
