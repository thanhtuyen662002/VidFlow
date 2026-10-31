import React, { useState } from 'react';
import { motionCall, motionStyleReference } from './api/client.ts';

export function MotionControl({ projectId }: { projectId: string }) {
  const [rights, setRights] = useState(false), [filePath, setFile] = useState('');
  const [sourceVideoId, setSource] = useState(''), [cuts, setCuts] = useState('');
  const [subjectId, setSubject] = useState(''), [target, setTarget] = useState('');
  const [presetKey, setPreset] = useState(''), [accountId, setAccount] = useState('');
  const [styleReference, setStyleReference] = useState('');
  const [segmentId, setSegment] = useState(''), [variantId, setVariant] = useState('');
  const [data, setData] = useState<any>(), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [presets, setPresets] = useState<{ key: string; name: string }[]>([]);
  const [segments, setSegments] = useState<any[]>([]), [subjects, setSubjects] = useState<any[]>([]);
  async function call(action: string, input: Record<string, unknown> = { sourceVideoId }) {
    setBusy(true); setError('');
    try {
      const value = await motionCall(action, input); setData(value);
      if (action === 'import') { setSource(value.id); setSegments([]); setSubjects([]); }
      if (action === 'presets') setPresets(value);
      if (['segment', 'list_segments', 'update_segment'].includes(action)) setSegments(value);
      if (action === 'analyze') setSubjects(value);
      if (value?.segments) setSegments(value.segments);
      if (value?.subjects) setSubjects(value.subjects);
    }
    catch (e) { setError(e instanceof Error ? e.message : 'Không thể hoàn tất'); }
    finally { setBusy(false); }
  }
  const button = (label: string, action: string, input?: Record<string, unknown>) => <button type="button" disabled={busy || !sourceVideoId} onClick={() => void call(action, input)}>{label}</button>;
  let preview: any;
  try { preview = data?.summary ? JSON.parse(data.summary).visualPreview : undefined; } catch {}
  const imageUrl = (path: string) => 'file:///' + path.replaceAll('\\', '/').replace(/^\//, '');
  const labels: Record<string, string> = { pending: 'Đang chờ', rendering: 'Đang render', done: 'Hoàn tất', awaiting_budget_approval: 'Chờ duyệt ngân sách', needs_rerender: 'Cần duyệt render lại' };
  return <section aria-label="Điều khiển chuyển động"><h2>Điều khiển chuyển động</h2>
    {error && <p role="alert">{error}</p>}{busy && <p role="status">Đang xử lý</p>}
    <fieldset><legend>Nhập video</legend><label>Đường dẫn video<input value={filePath} onChange={e => setFile(e.target.value)} /></label>
      <label><input type="checkbox" checked={rights} onChange={e => setRights(e.target.checked)} />Tôi có quyền sử dụng video này</label>
      <button disabled={busy || !rights || !filePath} onClick={() => void call('import', { projectId, filePath, rights_confirmed: rights })}>Nhập video</button>
      <label>Mã video<input value={sourceVideoId} onChange={e => setSource(e.target.value)} /></label></fieldset>
    <fieldset><legend>Xem và sửa đoạn</legend>{button('Tách đoạn', 'segment')}{button('Xem các đoạn', 'list_segments')}
      <label>Điểm cắt (mảng giây)<input value={cuts} onChange={e => setCuts(e.target.value)} /></label>
      <button disabled={busy || !sourceVideoId} onClick={() => { try { void call('update_segment', { sourceVideoId, cuts: JSON.parse(cuts) }); } catch { setError('Nhập mảng số hợp lệ'); } }}>Lưu điểm cắt</button>
      {button('Phân tích chủ thể', 'analyze')}</fieldset>
    <fieldset><legend>Ánh xạ nhân vật và bối cảnh</legend><label>Mã chủ thể<input value={subjectId} onChange={e => setSubject(e.target.value)} /></label>
      <label>Tham chiếu @Tên, giữ nguyên hoặc không lộ mặt<input value={target} onChange={e => setTarget(e.target.value)} /></label>
      <p>Chọn ảnh nhân vật hoặc bối cảnh từ thư viện bằng @Tên. Tham chiếu phong cách được đặt trong Bible của dự án.</p>
      <label>Tham chiếu phong cách @Tên<input value={styleReference} onChange={e => setStyleReference(e.target.value)} /></label>
      <button disabled={busy || !styleReference} onClick={async () => { setBusy(true); setError(''); try { await motionStyleReference(projectId, styleReference); } catch (e) { setError(e instanceof Error ? e.message : 'Không thể lưu phong cách'); } finally { setBusy(false); } }}>Lưu tham chiếu phong cách</button>
      {subjects.map((s: any) => <p key={s.id}><button onClick={() => setSubject(s.id)}>Chọn chủ thể {s.subject_key}</button> {s.description}</p>)}
      {button('Lưu ánh xạ', 'map_subjects', { subjectId, target })}</fieldset>
    <fieldset><legend>Phong cách và ước tính credit</legend>{button('Danh sách phong cách', 'presets', {})}
      <label>Mã phong cách<input list="motion-presets" value={presetKey} onChange={e => setPreset(e.target.value)} /></label><datalist id="motion-presets">{presets.map(p => <option key={p.key} value={p.key}>{p.name}</option>)}</datalist>{button('Chọn phong cách', 'set_preset', { sourceVideoId, presetKey })}
      <label>Mã tài khoản<input value={accountId} onChange={e => setAccount(e.target.value)} /></label>{button('Xem trước phong cách', 'style_preview', { sourceVideoId, accountId })}
      {data?.credit_estimate !== undefined && <p>Ước tính credit: {data.credit_estimate}</p>}
      {preview?.original && <figure><img alt="Khung hình gốc" src={imageUrl(preview.original)} /><img alt="Khung hình theo phong cách mới" src={imageUrl(preview.transformed)} /><figcaption>Nội dung mới được tạo bằng AI</figcaption></figure>}
      {button('Duyệt phong cách', 'style_approve', { sourceVideoId, approver: 'Chủ sở hữu' })}
      {button('Từ chối bản xem trước', 'style_reject')}</fieldset>
    <fieldset><legend>Tiến độ render</legend>{button('Render video', 'render')}<button disabled={!sourceVideoId} onClick={() => void motionCall('status', { sourceVideoId }).then(value => { setData(value); setSegments(value.segments); setSubjects(value.subjects); }).catch(e => setError(e.message))}>Cập nhật trạng thái</button>
      {segments.map((s: any) => <article key={s.id}><p>Đoạn {s.idx + 1}: {s.start_sec} – {s.end_sec} giây. {labels[s.state?.status] ?? 'Chưa render'}</p><button onClick={() => setSegment(s.id)}>Chọn đoạn {s.idx + 1}</button>
        {s.state?.variants.map((v: any, i: number) => <button key={v.id} onClick={() => { setSegment(s.id); setVariant(v.id); }}>Bản {i + 1}</button>)}</article>)}</fieldset>
    <fieldset><legend>Chọn bản và xuất</legend><label>Mã đoạn<input value={segmentId} onChange={e => setSegment(e.target.value)} /></label>
      <label>Mã bản<input value={variantId} onChange={e => setVariant(e.target.value)} /></label>{button('Chọn bản', 'select_take', { segmentId, variantId })}{button('Xuất video', 'export')}</fieldset>
    {data?.path && <p>Đã xuất video: {data.path}</p>}
  </section>;
}
