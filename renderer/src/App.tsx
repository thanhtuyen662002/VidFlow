import React, { useEffect, useMemo, useState } from 'react';
import type { Bible, Gate, Project, Reference, VidflowApi } from './api.ts';
import { getApi } from './api.ts';
import { Workflow } from './Workflow.tsx';
import { MotionControl } from './MotionControl.tsx';
import { M9Panels } from './M9.tsx';
import type { M9Api } from './M9.tsx';
import type { WorkflowApi } from './workflow.ts';

const message = (error: unknown) =>
  error !== null && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
    ? error.message : String(error);

/** Same geometry as renderer/public/favicon.svg and the app icon (config/generate-icon.py). */
function BrandMark({ size = 28 }: { size?: number }) {
  return <svg className="brand-mark" viewBox="0 0 512 512" width={size} height={size} aria-hidden="true">
    <defs><linearGradient id="vf-brand" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stopColor="#FF8A3D" /><stop offset="0.5" stopColor="#EC4878" /><stop offset="1" stopColor="#7C3AED" />
    </linearGradient></defs>
    <rect width="512" height="512" rx="116" fill="url(#vf-brand)" />
    <path d="M128 208H178M100 256H186M128 304H178" stroke="#fff" strokeOpacity="0.84" strokeWidth="30" strokeLinecap="round" />
    <polygon points="226,154 226,358 396,256" fill="#fff" stroke="#fff" strokeWidth="26" strokeLinejoin="round" />
  </svg>;
}

export function App() {
  const connection = useMemo(() => {
    try {
      // Preload already unwraps IPC results. Keep its client stable across renders.
      return { api: getApi(), error: null };
    } catch (failure) {
      return { api: null, error: message(failure) };
    }
  }, []);
  const visibleError = connection.error;
  return <>{visibleError !== null && <p role="alert">{visibleError}</p>}{connection.api && <ProjectsView api={connection.api} />}</>;
}

function ProjectsView({ api }: { api: VidflowApi }) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [selected, setSelected] = useState('');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  const [view, setView] = useState<View>('script');
  useEffect(() => {
    async function loadProjects() {
      try {
        const value = await api.projects.list();
        setProjects(value);
      } catch (e) {
        setError(message(e));
      } finally {
        setBusy(false);
      }
    }
    void loadProjects();
  }, [api]);
  const current = projects.find(p => p.id === selected);
  // Every view stays mounted so form input and progress survive switching; only the active one is shown.
  const views: [View, string, boolean][] = [['home', 'Bắt đầu', !selected], ['script', 'Kịch bản & tham chiếu', !!selected],
    ['production', 'Sản xuất video', !!selected], ['motion', 'Chuyển động', !!selected && 'motion' in api], ['tools', 'Tiện ích', 'archive' in api || 'm9' in api]];
  const shown: View = view === 'tools' ? 'tools' : selected ? (view === 'home' ? 'script' : view) : 'home';
  return <div className="app-shell"><aside className="sidebar">
    <p className="brand"><BrandMark /><span>VidFlow</span></p>
    <section aria-label="Dự án" className="sidebar-projects"><h2>Dự án</h2>{error && <p role="alert">{error}</p>}{busy && <p role="status" className="loading">Đang tải…</p>}
      <form data-testid="project-form" className="new-project" onSubmit={async e => {
        e.preventDefault();
        if (busy) return;
        setBusy(true); setError(''); setProjects([]);
        try {
          const project = await api.projects.create({ name });
          const refreshed = await api.projects.list();
          setProjects(refreshed);
          setSelected(project.id);
          setName('');
        } catch (e) { setError(message(e)); } finally { setBusy(false); }
      }}>
        <label>Tên dự án<input data-testid="project-name" required placeholder="Ví dụ: Phim ngắn mùa hè" value={name} onInput={e => setName(e.currentTarget.value)} /></label><button className="primary" disabled={busy}>Tạo dự án</button>
      </form><nav aria-label="Danh sách dự án" className="project-list">{projects.map(p => <button type="button" key={p.id} data-initial={p.name.trim().charAt(0).toUpperCase()} aria-pressed={selected === p.id} onClick={() => { setSelected(p.id); if (view === 'tools' || view === 'home') setView('script'); }}>{p.name}</button>)}</nav>
    </section></aside>
    <main className="workspace"><header className="topbar"><div><p className="eyebrow">{current ? 'Dự án' : 'Xưởng video của bạn'}</p><h1>{current?.name ?? 'VidFlow'}</h1></div>
      <nav className="view-tabs" aria-label="Khu vực làm việc">{views.filter(([, , available]) => available).map(([key, title]) => <button type="button" key={key} aria-pressed={shown === key} onClick={() => setView(key)}>{title}</button>)}</nav></header>
      <div className="workspace-body">{selected ? <ProjectPanels key={selected} api={api} projectId={selected} view={shown} /> : shown === 'home' && <EmptyState />}
        {('archive' in api || 'm9' in api) && <div className="view" hidden={shown !== 'tools'}><M9Panels key={selected} api={api as VidflowApi & M9Api} projectId={selected} onProject={p => { setProjects(previous => [...previous, p]); setSelected(p.id); }} /></div>}</div>
    </main></div>;
}

type View = 'home' | 'script' | 'production' | 'motion' | 'tools';

function EmptyState() {
  return <div className="empty-state"><BrandMark size={56} /><h2>Bắt đầu một video mới</h2><p>Chọn hoặc tạo dự án để bắt đầu.</p>
    <ol><li>Tạo dự án ở cột bên trái.</li><li>Viết Bible, thêm tham chiếu và duyệt kịch bản.</li><li>Tạo storyboard, render bằng Flow, chọn take rồi xuất video.</li></ol></div>;
}

function ProjectPanels({ api, projectId, view }: { api: VidflowApi; projectId: string; view: View }) {
  const [approvedVersion, setApprovedVersion] = useState<string>();
  const workflow = api as VidflowApi & Partial<WorkflowApi>;
  return <>
    <div className="view script-view" hidden={view !== 'script'}><BibleView api={api} projectId={projectId} /><ReferencesView api={api} projectId={projectId} /><ScriptGateView api={api} projectId={projectId} onApproved={setApprovedVersion} /></div>
    <div className="view" hidden={view !== 'production'}>{workflow.storyboard && workflow.render && workflow.take && workflow.edit && workflow.account && workflow.queue
      ? <Workflow api={workflow as WorkflowApi} projectId={projectId} approvedVersion={approvedVersion} /> : <p className="muted">Phiên bản này chưa có quy trình sản xuất.</p>}</div>
    {'motion' in api && <div className="view" hidden={view !== 'motion'}><MotionControl projectId={projectId} /></div>}
  </>;
}

const bibleLabels: Record<keyof Bible, string> = { style: 'Phong cách', lighting: 'Ánh sáng', palette: 'Bảng màu', lens: 'Ống kính', avoid: 'Điều cần tránh', safe_area: 'Vùng an toàn' };
function BibleView({ api, projectId }: { api: VidflowApi; projectId: string }) {
  const [bible, setBible] = useState<Bible>();
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    async function loadBible() {
      try { setBible(await api.bible.get(projectId)); }
      catch (e) { setError(message(e)); }
      finally { setBusy(false); }
    }
    void loadBible();
  }, [api, projectId]);
  return <section className="card bible"><header className="card-head"><h2>Bible — Định hướng hình ảnh</h2><p>Quy tắc hình ảnh chung cho mọi cảnh của dự án.</p></header>{error && <p role="alert">{error}</p>}{busy && <p role="status" className="loading">Đang tải…</p>}{bible && <form data-testid="bible-form" className="field-grid" onSubmit={async e => { e.preventDefault(); if (busy) return; const patch = bible; setBusy(true); setError(''); setBible(undefined); try { await api.bible.update(projectId, patch); setBible(await api.bible.get(projectId)); } catch (e) { setError(message(e)); } finally { setBusy(false); } }}>
    {(Object.keys(bibleLabels) as (keyof Bible)[]).map(key => <label key={key}>{bibleLabels[key]}<textarea value={bible[key]} onInput={e => setBible({ ...bible, [key]: e.currentTarget.value })} /></label>)}<div className="form-actions"><button className="primary" disabled={busy}>Lưu Bible</button></div></form>}</section>;
}

const roleLabels: Record<string, string> = { character: 'Nhân vật', location: 'Bối cảnh', prop: 'Đạo cụ', style: 'Phong cách' };
function ReferencesView({ api, projectId }: { api: VidflowApi; projectId: string }) {
  const [refs, setRefs] = useState<Reference[]>([]);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    setBusy(true);
    setError('');
    setRefs([]);
    async function loadReferences() {
      try {
        const references = await api.references.list(projectId);
        setRefs(references);
      } catch (error) {
        setError(message(error));
      } finally {
        setBusy(false);
      }
    }
    void loadReferences();
  }, [api, projectId]);
  return <section className="card references"><header className="card-head"><h2>Thư viện tham chiếu</h2><p>Nhân vật, bối cảnh và đạo cụ, gọi trong kịch bản bằng @Tên.</p></header>{error && <p role="alert">{error}</p>}{busy && <p role="status" className="loading">Đang tải…</p>}
    <ul className="ref-list">{refs.map(ref => <li key={ref.id}><strong>@{ref.name}</strong><p>{roleLabels[ref.role] ?? ref.role}{ref.description && ` · ${ref.description}`}</p><p className="muted" title={ref.images.join('\n')}>{ref.images.map(image => image.split(/[\\/]/).pop()).join(', ')}</p><p className="chip">Ưu tiên: {ref.priority}</p><button className="danger ghost" disabled={busy} aria-label={`Xóa ${ref.name}`} onClick={async () => { if (busy) return; setBusy(true); setError(''); setRefs([]); try { await api.references.remove(projectId, ref.id); setRefs(await api.references.list(projectId)); } catch (e) { setError(message(e)); } finally { setBusy(false); } }}>Xóa</button></li>)}</ul>
    <form data-testid="reference-form" className="ref-form" onSubmit={async e => { e.preventDefault(); if (busy) return; const form = e.currentTarget; const data = new FormData(form); setBusy(true); setError(''); setRefs([]); try { await api.references.add(projectId, { name: String(data.get('name')), role: String(data.get('role')), description: String(data.get('description')), images: String(data.get('images')).split('\n').filter(Boolean), priority: Number(data.get('priority')) }); setRefs(await api.references.list(projectId)); form.reset(); } catch (e) { setError(message(e)); } finally { setBusy(false); } }}>
      <label>Tên tham chiếu<input data-testid="reference-name" name="name" required /></label><label>Vai trò<select name="role"><option value="character">Nhân vật</option><option value="location">Bối cảnh</option><option value="prop">Đạo cụ</option><option value="style">Phong cách</option></select></label>
      <label>Mô tả<textarea name="description" /></label><label>Đường dẫn ảnh (mỗi dòng một ảnh)<textarea data-testid="reference-images" name="images" /></label><label>Độ ưu tiên<input name="priority" type="number" defaultValue="0" required /></label><button className="primary" disabled={busy}>Thêm tham chiếu</button>
    </form></section>;
}

function ScriptGateView({ api, projectId, onApproved }: { api: VidflowApi; projectId: string; onApproved: (version: string) => void }) {
  const [gate, setGate] = useState<Gate>();
  const [optionId, setOptionId] = useState('');
  const [comment, setComment] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState('');
  useEffect(() => {
    async function loadGate() {
      try { setGate(await api.script.getGate(projectId)); }
      catch (e) { setError(message(e)); }
      finally { setBusy(false); }
    }
    void loadGate();
  }, [api, projectId]);
  async function decide(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true); setError(''); setGate(undefined);
    try { await action(); setGate(await api.script.getGate(projectId)); } catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  return <section className="card gate"><header className="card-head"><h2>Cổng duyệt kịch bản</h2><p>So sánh các phương án và duyệt một bản trước khi làm storyboard.</p></header>{error && <p role="alert">{error}</p>}{busy && <p role="status" className="loading">Đang tải…</p>}{gate && <>
    <p data-testid="gate-status" className="badge">{gate.status}</p>{gate.lockReason && <p role="status">{gate.lockReason}</p>}
    {gate.comments?.map((text, i) => <p key={`comment-${i}`}>{text}</p>)}
    {gate.blockingReasons?.map((text, i) => <p role="status" key={`block-${i}`}>{text}</p>)}
    <form data-testid="script-approve-form" onSubmit={async e => { e.preventDefault(); if (gate.canApprove && !busy) { const option = gate.options.find(option => option.id === optionId); if (option) await decide(async () => { await api.script.approve(projectId, { scriptId: option.scriptId, versionId: option.versionId }); onApproved(option.versionId); }); }; }}>
      <fieldset disabled={busy}><legend>Chọn phương án</legend>{gate.options.map(option => <article key={option.id} className="option"><label><input data-testid={`script-option-${option.id}`} type="radio" name="option" required value={option.id} checked={optionId === option.id} onChange={() => setOptionId(option.id)} />{option.title}</label><p>Điểm: {option.score ?? 'Chưa có'}</p><p>Nhận xét: {option.notes}</p><ul>{option.risks.map((risk, i) => <li key={i}>Cảnh báo rủi ro ({risk.level}): {risk.message}{risk.id && <><label>Lý do xử lý cảnh báo<textarea value={reason} onInput={e => setReason(e.currentTarget.value)} /></label><button type="button" disabled={busy || !reason.trim()} onClick={() => decide(() => api.script.override(projectId, { scriptId: option.scriptId, versionId: option.versionId, warningId: risk.id!, reason }))}>Bỏ qua cảnh báo</button></>}{risk.suggestedFix && <p>Đề xuất: {risk.suggestedFix}</p>}</li>)}</ul></article>)}</fieldset>
      <label>Nhận xét<textarea value={comment} onInput={e => setComment(e.currentTarget.value)} /></label><button className="primary" disabled={busy || !gate.canApprove}>Duyệt phương án</button>
    </form><form data-testid="script-skip-form" onSubmit={async e => { e.preventDefault(); if (gate.canSkip && !busy && reason.trim()) await decide(() => api.script.skip(projectId, { reason })); }}>
      <label>Lý do bỏ qua<textarea required value={reason} onInput={e => setReason(e.currentTarget.value)} /></label><button disabled={busy || !gate.canSkip}>Bỏ qua</button>
    </form></>}</section>;
}


