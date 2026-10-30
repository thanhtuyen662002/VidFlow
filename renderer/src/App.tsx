import React, { useEffect, useMemo, useState } from 'react';
import type { Bible, Gate, Project, Reference, VidflowApi } from './api.ts';
import { getApi } from './api.ts';

const message = (error: unknown) =>
  error !== null && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
    ? error.message : String(error);

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
  return <main><header><p>VIDFLOW</p><h1>Xưởng video của bạn</h1><p>Dự án · Tham chiếu · Kịch bản</p></header>
    <section aria-label="Dự án"><h2>Dự án</h2>{error && <p role="alert">{error}</p>}{busy && <p role="status">Đang tải…</p>}
      <form onSubmit={async e => {
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
        <label>Tên dự án<input required value={name} onInput={e => setName(e.currentTarget.value)} /></label><button disabled={busy}>Tạo dự án</button>
      </form><nav aria-label="Danh sách dự án">{projects.map(p => <button type="button" key={p.id} aria-pressed={selected === p.id} onClick={() => setSelected(p.id)}>{p.name}</button>)}</nav>
    </section>{selected ? <ProjectPanels key={selected} api={api} projectId={selected} /> : <p>Chọn hoặc tạo dự án để bắt đầu.</p>}
  </main>;
}

function ProjectPanels({ api, projectId }: { api: VidflowApi; projectId: string }) {
  return <div className="panels"><BibleView api={api} projectId={projectId} /><ReferencesView api={api} projectId={projectId} /><ScriptGateView api={api} projectId={projectId} /></div>;
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
  return <section><h2>Bible — Định hướng hình ảnh</h2>{error && <p role="alert">{error}</p>}{busy && <p role="status">Đang tải…</p>}{bible && <form onSubmit={async e => { e.preventDefault(); if (busy) return; const patch = bible; setBusy(true); setError(''); setBible(undefined); try { await api.bible.update(projectId, patch); setBible(await api.bible.get(projectId)); } catch (e) { setError(message(e)); } finally { setBusy(false); } }}>
    {(Object.keys(bibleLabels) as (keyof Bible)[]).map(key => <label key={key}>{bibleLabels[key]}<textarea value={bible[key]} onInput={e => setBible({ ...bible, [key]: e.currentTarget.value })} /></label>)}<button disabled={busy}>Lưu Bible</button></form>}</section>;
}

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
  return <section><h2>Thư viện tham chiếu</h2>{error && <p role="alert">{error}</p>}{busy && <p role="status">Đang tải…</p>}
    <ul>{refs.map(ref => <li key={ref.id}><strong>@{ref.name}</strong><p>{ref.role} · {ref.description}</p><p>{ref.images.join(', ')}</p><p>Ưu tiên: {ref.priority}</p><button disabled={busy} aria-label={`Xóa ${ref.name}`} onClick={async () => { if (busy) return; setBusy(true); setError(''); setRefs([]); try { await api.references.remove(projectId, ref.id); setRefs(await api.references.list(projectId)); } catch (e) { setError(message(e)); } finally { setBusy(false); } }}>Xóa</button></li>)}</ul>
    <form onSubmit={async e => { e.preventDefault(); if (busy) return; const form = e.currentTarget; const data = new FormData(form); setBusy(true); setError(''); setRefs([]); try { await api.references.add(projectId, { name: String(data.get('name')), role: String(data.get('role')), description: String(data.get('description')), images: String(data.get('images')).split('\n').filter(Boolean), priority: Number(data.get('priority')) }); setRefs(await api.references.list(projectId)); form.reset(); } catch (e) { setError(message(e)); } finally { setBusy(false); } }}>
      <label>Tên tham chiếu<input name="name" required /></label><label>Vai trò<select name="role"><option value="character">Nhân vật</option><option value="location">Bối cảnh</option><option value="prop">Đạo cụ</option><option value="style">Phong cách</option></select></label>
      <label>Mô tả<textarea name="description" /></label><label>Đường dẫn ảnh (mỗi dòng một ảnh)<textarea name="images" /></label><label>Độ ưu tiên<input name="priority" type="number" defaultValue="0" required /></label><button disabled={busy}>Thêm tham chiếu</button>
    </form></section>;
}

function ScriptGateView({ api, projectId }: { api: VidflowApi; projectId: string }) {
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
  return <section className="gate"><h2>Cổng duyệt kịch bản</h2>{error && <p role="alert">{error}</p>}{busy && <p role="status">Đang tải…</p>}{gate && <>
    <p data-testid="gate-status">{gate.status}</p>{gate.lockReason && <p role="status">{gate.lockReason}</p>}
    {gate.comments?.map((text, i) => <p key={`comment-${i}`}>{text}</p>)}
    {gate.blockingReasons?.map((text, i) => <p role="status" key={`block-${i}`}>{text}</p>)}
    <form onSubmit={async e => { e.preventDefault(); if (gate.canApprove && !busy) { const option = gate.options.find(option => option.id === optionId); if (option) await decide(() => api.script.approve(projectId, { scriptId: option.scriptId, versionId: option.versionId })); }; }}>
      <fieldset disabled={busy}><legend>Chọn phương án</legend>{gate.options.map(option => <article key={option.id}><label><input type="radio" name="option" required value={option.id} checked={optionId === option.id} onChange={() => setOptionId(option.id)} />{option.title}</label><p>Điểm: {option.score ?? 'Chưa có'}</p><p>Nhận xét: {option.notes}</p><ul>{option.risks.map((risk, i) => <li key={i}>Cảnh báo rủi ro ({risk.level}): {risk.message}{risk.id && <><label>Lý do xử lý cảnh báo<textarea value={reason} onInput={e => setReason(e.currentTarget.value)} /></label><button type="button" disabled={busy || !reason.trim()} onClick={() => decide(() => api.script.override(projectId, { scriptId: option.scriptId, versionId: option.versionId, warningId: risk.id!, reason }))}>Bỏ qua cảnh báo</button></>}{risk.suggestedFix && <p>Đề xuất: {risk.suggestedFix}</p>}</li>)}</ul></article>)}</fieldset>
      <label>Nhận xét<textarea value={comment} onInput={e => setComment(e.currentTarget.value)} /></label><button disabled={busy || !gate.canApprove}>Duyệt phương án</button>
    </form><form onSubmit={async e => { e.preventDefault(); if (gate.canSkip && !busy && reason.trim()) await decide(() => api.script.skip(projectId, { reason })); }}>
      <label>Lý do bỏ qua<textarea required value={reason} onInput={e => setReason(e.currentTarget.value)} /></label><button disabled={busy || !gate.canSkip}>Bỏ qua</button>
    </form></>}</section>;
}
