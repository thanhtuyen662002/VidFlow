import React, { useState } from 'react';
import type { CleanupPlan } from '../../src/service/maintenance.ts';

export interface M9Api {
  m9?: { execute(command: string, input: Record<string, unknown>): Promise<unknown>; pathForFile?(file: File): string };
}
type Suggestion = { id: string; status: string; proposedWeights?: unknown };
export function M9Panels({ api, projectId, onProject }: { api: M9Api; projectId: string; onProject: (project: { id: string; name: string }) => void }) {
  const [csvPath, setCsv] = useState(''), [timelineId, setTimeline] = useState('');
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [templates, setTemplates] = useState<{ id: string; name: string }[]>([]);
  const [templateId, setTemplate] = useState(''), [name, setName] = useState('');
  const [file, setFile] = useState(''), [targetDir, setTarget] = useState('');
  const [plan, setPlan] = useState<(CleanupPlan & { planId: string }) | null>(null);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [result, setResult] = useState('');
  async function perform(work: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError('');
    try { await work(); } catch (e) { setError(e instanceof Error ? e.message : String(e)); } finally { setBusy(false); }
  }
  const call = async (command: string, input: Record<string, unknown>) => {
    if (api.m9) return api.m9.execute(command, input);
    const [group, method] = command.split('.');
    const bridge = api as unknown as Record<string, Record<string, (input: Record<string, unknown>) => Promise<{ ok: boolean; data?: unknown; error?: { message: string } }>>>;
    const response = await bridge[group][method](input);
    if (!response.ok) throw new Error(response.error?.message ?? 'Không thể thực hiện lệnh');
    return response.data;
  };
  const refresh = async () => setSuggestions(await call('analytics.list', { projectId }) as Suggestion[]);
  return <section aria-label="Tiện ích M9" className="tools"><fieldset disabled={busy}>
    {error && <p role="alert">{error}</p>}{result && <output>{result}</output>}
    <div className="tool-grid"><div className="card"><h2>Học từ kết quả</h2>
    <label>Đường dẫn CSV<input data-testid="csv-path" value={csvPath} onInput={e => setCsv(e.currentTarget.value)} /></label>
    <label>Timeline ID<input data-testid="timeline-id" value={timelineId} onInput={e => setTimeline(e.currentTarget.value)} /></label>
    <button data-testid="csv-import" className="primary" onClick={() => perform(async () => { await call('analytics.import', { projectId, timelineId, csvPath }); await refresh(); })}>Nhập CSV</button>
    <button data-testid="suggestions-refresh" onClick={() => perform(refresh)}>Tải đề xuất</button>
    <ul data-testid="suggestions">{suggestions.map(s => <li key={s.id}>{s.id}: {s.status}<pre>{JSON.stringify(s.proposedWeights)}</pre>{s.status === 'pending' && <>{(['accept', 'reject'] as const).map(action => <button data-testid={`suggestion-${action}-${s.id}`} key={action} onClick={() => perform(async () => { await call(`analytics.${action}`, { id: s.id }); await refresh(); })}>{action === 'accept' ? 'Chấp nhận' : 'Từ chối'}</button>)}</>}</li>)}</ul>
    </div><div className="card"><h2>Mẫu series</h2>
    <button data-testid="templates-refresh" onClick={() => perform(async () => setTemplates(await call('template.list', {}) as typeof templates))}>Tải mẫu</button>
    <label>Mẫu<select data-testid="template-select" value={templateId} onChange={e => setTemplate(e.currentTarget.value)}><option value="">Chọn mẫu</option>{templates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
    <label>Tên dự án từ mẫu<input data-testid="template-name" value={name} onInput={e => setName(e.currentTarget.value)} /></label>
    <button data-testid="template-save" disabled={!name.trim() || !projectId} onClick={() => perform(async () => { await call('template.save', { projectId, name }); setTemplates(await call('template.list', {}) as typeof templates); })}>Lưu dự án thành mẫu</button>
    <button data-testid="template-create" disabled={!templateId || !name.trim()} onClick={() => perform(async () => onProject(await call('template.createProject', { templateId, name }) as { id: string; name: string }))}>Tạo dự án từ mẫu</button>
    </div><div className="card"><h2>Sao lưu &amp; khôi phục</h2>
    <label>File sao lưu<input data-testid="archive-file" value={file} onInput={e => setFile(e.currentTarget.value)} /></label>
    <label>Thư mục đích<input data-testid="archive-target" value={targetDir} onInput={e => setTarget(e.currentTarget.value)} /></label>
    <button data-testid="archive-backup" onClick={() => perform(async () => setResult(JSON.stringify(await call('archive.backup', { file }))))}>Sao lưu</button>
    <button data-testid="archive-restore" onClick={() => perform(async () => setResult(JSON.stringify(await call('archive.restore', { file, targetDir }))))}>Khôi phục</button>
    </div><div className="card"><h2>Dọn take</h2>
    <button data-testid="cleanup-preview" disabled={!projectId} onClick={() => perform(async () => setPlan(await call('takes.prunePreview', { projectId }) as typeof plan))}>Xem trước</button>
    {plan && <div data-testid="cleanup-dialog" role="dialog" aria-modal="true" aria-label="Xác nhận dọn take"><p>Các take sẽ bị xóa ({plan.totalSize} byte):</p><ul>{plan.takes.map(t => <li key={t.takeId}>{t.takeId}: {t.path}</li>)}</ul>
      <button data-testid="cleanup-cancel" onClick={() => setPlan(null)}>Hủy</button><button data-testid="cleanup-confirm" className="danger" onClick={() => perform(async () => { setResult(JSON.stringify(await call('takes.pruneApply', { projectId, planId: plan.planId, confirm: true }))); setPlan(null); })}>Xác nhận xóa</button></div>}
    </div><div className="card"><h2>Kiểm tra cập nhật</h2><button data-testid="update-check" onClick={() => perform(async () => setResult(JSON.stringify(await call('update.check', {}))))}>Kiểm tra cập nhật</button></div></div>
  </fieldset></section>;
}
