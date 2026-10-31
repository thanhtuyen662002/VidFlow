import { get as httpGet } from 'node:http';
import { get as httpsGet } from 'node:https';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import { Transform } from 'node:stream';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { resolveInside } from '../paths.ts';

export interface UpdateConfig { channel: 'dev'; sourceUrl: string }
export interface Manifest { version: string; url: string; sha256: string; size?: number; releaseNotes?: string }
const fail = (code: string) => Object.assign(new Error(code), { code });
function version(value: string) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*))?(?:\+[\da-zA-Z-]+(?:\.[\da-zA-Z-]+)*)?$/.exec(value);
  if (!match || match[4]?.split('.').some(p => /^\d+$/.test(p) && p.length > 1 && p.startsWith('0'))) throw fail('INVALID_VERSION');
  return { main: match.slice(1, 4).map(BigInt), pre: match[4]?.split('.') };
}
export function compareVersions(a: string, b: string): number {
  const x = version(a), y = version(b);
  for (let i = 0; i < 3; i++) if (x.main[i] !== y.main[i]) return x.main[i] > y.main[i] ? 1 : -1;
  if (!x.pre || !y.pre) return x.pre ? -1 : y.pre ? 1 : 0;
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === q) continue;
    if (p === undefined || q === undefined) return p === undefined ? -1 : 1;
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
    if (pn && qn) return BigInt(p) > BigInt(q) ? 1 : -1;
    if (pn !== qn) return pn ? -1 : 1;
    return p > q ? 1 : -1;
  }
  return 0;
}
function safeUrl(value: string) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw fail('INVALID_UPDATE_URL');
  return url;
}
/** Published releases: GitHub serves release files by redirecting to its own download host. */
export const DEFAULT_UPDATE_SOURCE = 'https://github.com/thanhtuyen662002/VidFlow/releases/latest/download/vidflow-update.json';
export const githubRedirect = (url: URL) => url.protocol === 'https:'
  && (url.hostname === 'github.com' || url.hostname.endsWith('.githubusercontent.com'));
/** Follows at most 5 redirects, and only to targets `trusted` accepts. The SHA-256 check still decides integrity. */
export function fetchUpdate(url: string, trusted: (url: URL) => boolean = githubRedirect, redirects = 5): Promise<Readable> {
  const target = safeUrl(url);
  return new Promise((resolve, reject) => {
    const request = (target.protocol === 'https:' ? httpsGet : httpGet)(target, { headers: { 'User-Agent': 'VidFlow-Updater' } }, response => {
      const location = response.headers.location;
      if ([301, 302, 303, 307, 308].includes(response.statusCode ?? 0) && location) {
        response.resume();
        const next = new URL(location, target);
        if (redirects <= 0) { reject(fail('TOO_MANY_REDIRECTS')); return; }
        if (!trusted(next)) { reject(fail('UNTRUSTED_REDIRECT')); return; }
        fetchUpdate(next.href, trusted, redirects - 1).then(resolve, reject); return;
      }
      if (response.statusCode !== 200) { response.resume(); reject(fail('HTTP_ERROR')); return; }
      resolve(response);
    });
    // An idle limit, not a total one: the installer is hundreds of MB and may take minutes on a slow line.
    request.setTimeout(120000, () => request.destroy(fail('UPDATE_TIMEOUT')));
    request.on('error', reject);
  });
}
export function createUpdater(options: {
  config: () => UpdateConfig; currentVersion: string; directory: string;
  fetcher?: (url: string) => Promise<Readable>;
  confirm?: (manifest: Readonly<Manifest>) => Promise<boolean>;
  install: (path: string) => Promise<void>;
}) {
  const fetcher = options.fetcher ?? fetchUpdate;
  let manifest: Readonly<Manifest> | undefined, file: string | undefined;
  let state = 'idle', busy = false, received = 0;
  async function exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (busy) throw fail('UPDATE_BUSY');
    busy = true;
    try { return await operation(); } finally { busy = false; }
  }
  async function verify(path: string, m: Readonly<Manifest>) {
    const hash = createHash('sha256'); let size = 0;
    for await (const chunk of createReadStream(path)) { hash.update(chunk); size += chunk.length; }
    if (hash.digest('hex') !== m.sha256.toLowerCase()) throw fail('CHECKSUM_MISMATCH');
    if (m.size !== undefined && size !== m.size) throw fail('SIZE_MISMATCH');
  }
  return {
    status: thisStatus,
    check: () => exclusive(async () => {
      const config = options.config();
      if (config.channel !== 'dev' || !config.sourceUrl) throw fail('UPDATE_NOT_CONFIGURED');
      const stream = await fetcher(safeUrl(config.sourceUrl).href);
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of stream) {
        size += chunk.length;
        if (size > 1024 * 1024) { stream.destroy(); throw fail('MANIFEST_TOO_LARGE'); }
        chunks.push(Buffer.from(chunk));
      }
      const m = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (typeof m.version !== 'string' || typeof (m.url ?? m.file) !== 'string' || typeof m.sha256 !== 'string' || !/^[a-f\d]{64}$/i.test(m.sha256)
        || (m.size !== undefined && (!Number.isSafeInteger(m.size) || m.size < 0)) || (m.releaseNotes !== undefined && typeof m.releaseNotes !== 'string')) throw fail('INVALID_MANIFEST');
      const url = safeUrl(new URL(m.url ?? m.file, config.sourceUrl).href).href;
      if (compareVersions(m.version, options.currentVersion) <= 0) return null;
      // Rechecking the same release keeps an installer that is already downloaded and verified.
      if (file && manifest?.version === m.version && manifest.sha256.toLowerCase() === m.sha256.toLowerCase()) return manifest;
      manifest = Object.freeze({ version: m.version, url, sha256: m.sha256, size: m.size, releaseNotes: m.releaseNotes });
      file = undefined; state = 'available'; return manifest;
    }),
    download: () => exclusive(async () => {
      if (!manifest) throw fail('UPDATE_NOT_AVAILABLE');
      const m = manifest;
      await mkdir(options.directory, { recursive: true });
      const destination = resolveInside(options.directory, `update-${randomUUID()}.exe`);
      const temporary = `${destination}.part`;
      file = undefined; state = 'downloading'; received = 0;
      try {
        const hash = createHash('sha256'); let size = 0;
        const meter = new Transform({ transform(chunk, _encoding, callback) {
          size += chunk.length; received = size;
          if (size > (m.size ?? 4 * 1024 ** 3)) { callback(fail('SIZE_MISMATCH')); return; }
          hash.update(chunk); callback(null, chunk);
        } });
        await pipeline(await fetcher(m.url), meter, createWriteStream(temporary, { flags: 'wx' }));
        if (hash.digest('hex') !== m.sha256.toLowerCase()) throw fail('CHECKSUM_MISMATCH');
        if (m.size !== undefined && size !== m.size) throw fail('SIZE_MISMATCH');
        await rename(temporary, destination);
        file = destination; state = 'downloaded'; return thisStatus();
      } catch (error) {
        state = 'available'; await rm(temporary, { force: true }); throw error;
      }
    }),
    install: () => exclusive(async () => {
      if (!file || !manifest || state !== 'downloaded') throw fail('UPDATE_NOT_READY');
      if (!options.confirm || await options.confirm(manifest) !== true) return thisStatus();
      try { await verify(file, manifest); } catch (error) {
        await rm(file, { force: true }); file = undefined; state = 'available'; throw error;
      }
      await options.install(file); state = 'installing'; return thisStatus();
    }),
  };
  function thisStatus() { return { state, manifest, file, received }; }
}
