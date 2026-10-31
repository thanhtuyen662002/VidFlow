import React, { useEffect, useState } from 'react';

type Result = { ok: boolean; data?: unknown; error?: { message: string } };
type Manifest = { version: string; size?: number };
export interface UpdateApi { update: Record<'check' | 'download' | 'install' | 'status', (input: Record<string, never>) => Promise<Result>> }
type Phase = 'idle' | 'checking' | 'latest' | 'error' | 'available' | 'downloading' | 'ready';

async function run(command: Promise<Result>) {
  const result = await command;
  if (!result.ok) throw new Error(result.error?.message ?? 'Không thể cập nhật');
  return result.data;
}
const message = (error: unknown) => {
  const text = error instanceof Error ? error.message : String(error);
  if (/HTTP_ERROR|UPDATE_TIMEOUT|REDIRECT|ENOTFOUND|ECONN|ETIMEDOUT|EAI_AGAIN/.test(text)) return 'Không kết nối được máy chủ cập nhật. Kiểm tra mạng rồi thử lại.';
  if (/CHECKSUM_MISMATCH|SIZE_MISMATCH/.test(text)) return 'File cập nhật tải về bị lỗi. Hãy thử lại.';
  return text;
};

/** Checks the release source on start. Downloading only starts on request, and main still asks before installing. */
export function UpdateBox({ api }: { api: UpdateApi }) {
  const [phase, setPhase] = useState<Phase>('checking');
  const [manifest, setManifest] = useState<Manifest>();
  const [received, setReceived] = useState(0);
  const [error, setError] = useState('');
  async function check(quiet: boolean) {
    setPhase('checking'); setError('');
    try {
      const found = await run(api.update.check({})) as Manifest | null;
      setManifest(found ?? undefined); setPhase(found ? 'available' : 'latest');
    } catch (e) {
      // The start-up check stays silent (offline, development build); a check the user asked for reports why.
      if (quiet) setPhase('idle'); else { setError(message(e)); setPhase('error'); }
    }
  }
  useEffect(() => { void check(true); }, [api]);
  async function update() {
    setError('');
    try {
      if (phase !== 'ready') {
        setPhase('downloading'); setReceived(0);
        const timer = setInterval(() => {
          api.update.status({}).then(r => { if (r.ok) setReceived((r.data as { received?: number }).received ?? 0); }, () => {});
        }, 500);
        try { await run(api.update.download({})); } finally { clearInterval(timer); }
        setPhase('ready');
      }
      // Main shows the install dialog; choosing "Để sau" leaves the verified installer ready.
      await run(api.update.install({}));
    } catch (e) { setError(message(e)); setPhase(current => current === 'ready' ? 'ready' : 'available'); }
  }
  const offered = manifest && (phase === 'available' || phase === 'downloading' || phase === 'ready');
  const percent = manifest?.size ? Math.min(100, Math.floor(received * 100 / manifest.size)) : undefined;
  return <section aria-label="Cập nhật" className={offered ? 'update-box has-update' : 'update-box'}>
    {phase === 'checking' && <p role="status" className="loading">Đang kiểm tra cập nhật…</p>}
    {offered ? <>
      <p className="update-title">Có bản mới {manifest.version}</p>
      {error && <p role="alert">{error}</p>}
      {phase === 'downloading'
        ? <><p role="status" className="loading">Đang tải bản cập nhật{percent === undefined ? '…' : ` ${percent}%`}</p>
          {percent !== undefined && <progress max={100} value={percent} />}</>
        : <button type="button" className="primary" data-testid="update-install" onClick={() => void update()}>{phase === 'ready' ? 'Cài đặt' : 'Cập nhật ngay'}</button>}
    </> : phase !== 'checking' && <>
      {phase === 'latest' && <p className="update-note">Bạn đang dùng bản mới nhất.</p>}
      {error && <p role="alert">{error}</p>}
      <button type="button" data-testid="update-check" onClick={() => void check(false)}>Kiểm tra cập nhật</button>
    </>}
  </section>;
}
