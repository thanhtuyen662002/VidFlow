import React, { useEffect, useState } from 'react';
import type { WorkflowBudget, WorkflowSettings, WorkflowRework } from '../../src/types.ts';
import type { Account, Board, Plan, Take, WorkflowClient } from './workflow.ts';
import { statusLabel, unwrap } from './workflow.ts';

export function OwnerNotice({ accounts, scope }: { accounts: Account[]; scope: string }) {
  return accounts.some(account => account.status === 'needs_owner') ? <aside role="status" data-testid={`${scope}-needs-owner-banner`} className="owner-notice">Cần chủ sở hữu: hãy đăng nhập hoặc xác minh tài khoản Flow trước khi tiếp tục.</aside> : null;
}
export function Workflow({ api, projectId, approvedVersion }: { api: WorkflowClient; projectId: string; approvedVersion?: string }) {
  const [tab, setTab] = useState('storyboard');
  const [variantId, setVariantId] = useState('');
  const [board, setBoard] = useState<Board>();
  const [plan, setPlan] = useState<Plan>();
  const [takes, setTakes] = useState<Take[]>([]);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [budget, setBudget] = useState<WorkflowBudget>();
  const [settings, setSettings] = useState<WorkflowSettings>();
  const [rework, setRework] = useState<WorkflowRework>();
  const [busy, setBusy] = useState(false);
  const [rendering, setRendering] = useState(false);
  const [error, setError] = useState('');
  const [progress, setProgress] = useState('');
  const [timelineId, setTimelineId] = useState('');
  const [aspect, setAspect] = useState('16:9');
  const [audio, setAudio] = useState('');
  const [cover, setCover] = useState('');
  const [model, setModel] = useState('');
  const [path, setPath] = useState('');
  const [videos, setVideos] = useState<{ aspect: string; path: string }[]>([]);
  const [limit, setLimit] = useState('');
  async function action(run: () => Promise<void>) {
    setBusy(true); setError('');
    try { await run(); } catch (failure) { setError(failure instanceof Error ? failure.message : 'Không thể hoàn tất thao tác.'); }
    finally { setBusy(false); }
  }
  useEffect(() => { if (approvedVersion) setVariantId(approvedVersion); }, [approvedVersion]);
  useEffect(() => { void action(async () => {
    setAccounts(await unwrap(api.account.list({})));
    if (api.budget) { const next = await unwrap(api.budget.get({ projectId })); setBudget(next); setLimit(next.limit === null ? '' : String(next.limit)); }
    if (api.settings) setSettings(await unwrap(api.settings.get({})));
  }); }, [api, projectId]);
  useEffect(() => {
    let active = true;
    const stop = api.onRenderProgress?.(event => {
      if (!active) return;
      setProgress(statusLabel(event.status));
      if (plan) void refresh().catch(() => { if (active) setError('Không thể cập nhật tiến độ render.'); });
    });
    return () => { active = false; stop?.(); };
  }, [api, plan?.id]);
  async function refresh() {
    if (plan) { setPlan(await unwrap(api.render.status({ planId: plan.id }))); setTakes(await unwrap(api.take.list({ planId: plan.id }))); }
    setAccounts(await unwrap(api.account.list({})));
    if (api.budget) setBudget(await unwrap(api.budget.get({ projectId })));
  }
  async function runRender() {
    if (!board) return;
    setRendering(true); setError('');
    try {
      const next = await unwrap(api.render.enqueue({ storyboardId: board.id })); setPlan(next);
      setPlan(await unwrap(api.render.run({ storyboardId: board.id, planId: next.id })));
      setTakes(await unwrap(api.take.list({ planId: next.id })));
      if (api.budget) setBudget(await unwrap(api.budget.get({ projectId })));
      setAccounts(await unwrap(api.account.list({})));
    } catch (failure) { setError(failure instanceof Error ? failure.message : 'Không thể render.'); }
    finally { setRendering(false); }
  }
  return <section className="workflow" aria-label="Quy trình video"><nav>{[['storyboard', 'Storyboard'], ['render', 'Render'], ['takes', 'Chọn take'], ['edit', 'Dựng và xuất'], ['settings', 'Cài đặt']].map(([key, title]) => <button key={key} data-testid={`tab-${key}`} aria-pressed={tab === key} onClick={() => setTab(key)}>{title}</button>)}</nav>
    {error && <p role="alert" data-testid="workflow-error">{error}</p>}{busy && <p role="status">Đang xử lý…</p>}
    {tab === 'storyboard' && <section><h2>Storyboard</h2><form data-testid="storyboard-form" onSubmit={e => { e.preventDefault(); void action(async () => { setBoard(await unwrap(api.storyboard.generate({ variantId }))); setPlan(undefined); setTakes([]); setTimelineId(''); setPath(''); setVideos([]); }); }}>
      <label>Phiên bản kịch bản đã duyệt<input data-testid="storyboard-version" required value={variantId} onInput={e => setVariantId(e.currentTarget.value)} /></label><button disabled={busy || rendering}>Tạo storyboard</button></form>
      {board && <><p data-testid="storyboard-status">{statusLabel(board.status)}</p><ol>{board.shots.map(shot => <li key={shot.id} data-testid={`storyboard-shot-${shot.id}`}><h3>Cảnh {shot.sceneId}</h3><p>Chuỗi: {shot.chainId}</p><label>Prompt đã biên dịch<textarea readOnly value={shot.compiledPrompt} /></label></li>)}</ol>
        <button data-testid="storyboard-approve" disabled={busy || rendering} onClick={() => action(async () => { setBoard(await unwrap(api.storyboard.approve({ storyboardId: board.id }))); })}>Duyệt storyboard</button>
        <button data-testid="storyboard-reject" disabled={busy || rendering} onClick={() => action(async () => { setBoard(await unwrap(api.storyboard.reject!({ storyboardId: board.id }))); setPlan(undefined); })}>Yêu cầu sửa storyboard</button></>}
    </section>}
    {tab === 'render' && <section><h2>Render</h2><OwnerNotice accounts={accounts} scope="render" />
      <button data-testid="render-start" disabled={!board || rendering || busy} onClick={() => void runRender()}>Bắt đầu render</button>
      <button data-testid="render-refresh" disabled={busy} onClick={() => action(refresh)}>Cập nhật tiến độ</button>
      <button data-testid="render-cancel" disabled={!plan || busy} onClick={() => action(async () => { setPlan(await unwrap(api.render.cancel!({ planId: plan!.id }))); setProgress('Đã yêu cầu dừng sau lượt đang chạy'); })}>Hủy render</button>
      <p role="status" data-testid="render-progress">{progress}</p>
      {budget && <p data-testid="render-budget">Đã dùng / giới hạn: {budget.used} / {budget.limit ?? 'Không giới hạn'} credit</p>}
      {plan && <><p data-testid="render-status">{statusLabel(plan.status)}</p><p>Ước tính: {plan.estimatedCredits} credit</p><ol>{plan.steps.map(step => <li key={step.id} data-testid={`render-shot-${step.id}`}>Cảnh {step.sceneId}: {statusLabel(step.status)} <button data-testid={`redo-${step.id}`} disabled={rendering || busy} onClick={() => action(async () => { setRework(await unwrap(api.render.redo!({ planId: plan.id, sceneId: step.sceneId }))); })}>Làm lại cảnh</button></li>)}</ol></>}
      {rework && <aside data-testid="redo-confirmation"><p>Cảnh bị ảnh hưởng: {rework.sceneIds.join(', ')}; ước tính {rework.estimatedCredits} credit</p>{[true, false].map(accept => <button key={String(accept)} data-testid={`redo-${accept ? 'approve' : 'reject'}`} disabled={busy} onClick={() => action(async () => { await unwrap(api.render.decideRedo!({ requestId: rework.id, accept })); setRework(undefined); await refresh(); })}>{accept ? 'Duyệt làm lại' : 'Không làm lại'}</button>)}</aside>}
    </section>}
    {tab === 'takes' && <section><h2>Chọn take và điểm vào/ra</h2><button disabled={busy || rendering} onClick={() => action(refresh)}>Tải take</button>{board?.shots.map(shot => <section key={shot.id}><h3>Cảnh {shot.sceneId}</h3><div className="take-grid">{takes.filter(take => take.sceneId === shot.sceneId).map(take => <article key={take.id} data-testid={`take-${take.id}`}><video controls preload="none" src={take.file} aria-label={`Xem take ${take.id}`} /><p data-testid={`take-status-${take.id}`}>{take.selected ? 'Đã chọn' : 'Chưa chọn'}</p><form data-testid={`take-form-${take.id}`} onSubmit={e => {
      e.preventDefault(); const fields = new FormData(e.currentTarget);
      void action(async () => { await unwrap(api.take.select({ stepId: shot.id, takeId: take.id, inPoint: Number(fields.get('in')), outPoint: Number(fields.get('out')) })); setTimelineId(''); setPath(''); setVideos([]); await refresh(); });
    }}><label>Điểm vào (giây)<input data-testid={`take-in-${take.id}`} name="in" required type="number" step="any" defaultValue="0" /></label><label>Điểm ra (giây)<input data-testid={`take-out-${take.id}`} name="out" required type="number" step="any" defaultValue={take.durationSec} /></label><button disabled={busy || rendering}>Chọn take</button></form></article>)}</div></section>)}</section>}
    {tab === 'edit' && <section><h2>Dựng và xuất</h2><label>Tỷ lệ khung hình<select data-testid="export-aspect" value={aspect} onChange={e => setAspect(e.target.value)}><option>16:9</option><option>9:16</option></select></label><label>Đường dẫn âm thanh đã trộn<input data-testid="export-audio" value={audio} onInput={e => setAudio(e.currentTarget.value)} /></label>
      <button data-testid="edit-build" disabled={busy || rendering} onClick={() => action(async () => { const timeline = await unwrap(api.edit.assemble({ projectId })); setTimelineId(timeline.id); setPath(''); setVideos([]); })}>Dựng timeline</button>{timelineId && <p data-testid="timeline-ready">Timeline đã sẵn sàng</p>}
      <button data-testid="export-capcut" disabled={busy || !timelineId} onClick={() => action(async () => { setPath((await unwrap(api.edit.capcut({ timelineId, aspect }))).path); })}>Xuất draft CapCut</button>
      <button data-testid="export-video" disabled={busy || !timelineId || !audio} onClick={() => action(async () => { const video = await unwrap(api.edit.export({ timelineId, aspect, mixedAudioPath: audio })); setPath(video.path); setVideos(previous => [...previous.filter(v => v.aspect !== aspect), { aspect, path: video.path }]); })}>Xuất video</button>
      <label>Ảnh bìa<input data-testid="package-cover" value={cover} onInput={e => setCover(e.currentTarget.value)} /></label><label>Mô hình viết mô tả<input data-testid="package-model" value={model} onInput={e => setModel(e.currentTarget.value)} /></label>
      <button data-testid="export-package" disabled={busy || !timelineId || !videos.length || !cover || !model} onClick={() => action(async () => { setPath((await unwrap(api.export!.package({ timelineId, videos, coverPath: cover, llmModel: model }))).directory); })}>Xuất gói đăng tải</button>{path && <p data-testid="export-path">{path}</p>}
    </section>}
    {tab === 'settings' && <section><h2>Cài đặt</h2><OwnerNotice accounts={accounts} scope="settings" /><button disabled={busy} onClick={() => action(refresh)}>Cập nhật tài khoản</button><ul>{accounts.map(account => <li key={account.id}>{account.label} · Credit: {account.remainingCredits} · {statusLabel(account.status)}{account.status === 'needs_owner' && <><strong className="owner-notice" data-testid="account-needs-owner">Cần chủ sở hữu</strong><p>Hãy đăng nhập hoặc xác minh trong hồ sơ Flow của tài khoản này.</p></>}</li>)}</ul>
      {settings && <section><h3>MCP</h3><p data-testid="mcp-enabled">{settings.enabled ? 'Đang bật' : 'Đang tắt'}</p><p data-testid="mcp-credential-status">{settings.credentialConfigured ? 'Đã thiết lập' : 'Chưa thiết lập'}</p><p>Token được lưu tại: {settings.credentialLocation}. Giá trị không hiển thị trong giao diện.</p><button data-testid="mcp-toggle" disabled={busy} onClick={() => action(async () => { setSettings(await unwrap(api.settings!.configure({ enabled: !settings.enabled }))); })}>{settings.enabled ? 'Tắt MCP' : 'Bật MCP'}</button><button data-testid="mcp-rotate" disabled={busy} onClick={() => action(async () => { setSettings(await unwrap(api.settings!.rotate({}))); })}>Tạo / xoay token</button><button data-testid="mcp-revoke" disabled={busy} onClick={() => action(async () => { setSettings(await unwrap(api.settings!.revoke({}))); })}>Thu hồi token</button></section>}
      {budget && <form data-testid="budget-form" onSubmit={e => { e.preventDefault(); void action(async () => { const next = await unwrap(api.budget!.set({ projectId, limit: limit === '' ? null : Number(limit) })); setBudget(next); setLimit(next.limit === null ? '' : String(next.limit)); }); }}><label>Giới hạn credit (để trống nếu không giới hạn)<input data-testid="budget-limit" type="number" step="any" value={limit} onInput={e => setLimit(e.currentTarget.value)} /></label><button disabled={busy}>Lưu ngân sách</button><p data-testid="settings-budget">Đã dùng: {budget.used}; giới hạn: {budget.limit ?? 'Không giới hạn'}</p></form>}
    </section>}
  </section>;
}
