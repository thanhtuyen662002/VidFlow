import { after, afterEach, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import * as React from 'react';
let act: (callback: () => unknown) => Promise<void>;
import type { Root } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import { build } from 'vite';
import { mockApi } from './mockApi.ts';
import { workflowFake } from './workflowFake.ts';

let folder: string;
let App: any;
let getClient: any;
let dom: JSDOM;
let root: Root | undefined;
let oldHome: string | undefined;
const originalGlobals = new Map<string, PropertyDescriptor | undefined>();
before(async () => {
  folder = await mkdtemp(resolve('test/renderer/.run-'));
  oldHome = process.env.VIDFLOW_HOME;
  process.env.VIDFLOW_HOME = folder;
  // Vite compiles JSX; Node remains the repository's test runner.
  await build({ configFile: false, logLevel: 'silent', build: { outDir: folder, emptyOutDir: false, lib: { entry: resolve('renderer/src/App.tsx'), formats: ['es'], fileName: () => 'app.mjs' }, rollupOptions: { external: ['react'] } } });
  // Import the renderer only after jsdom globals are installed in mount().
});
afterEach(async () => {
  if (root) await act(async () => root.unmount());
  root = undefined;
  dom?.window.close();
  for (const [key, descriptor] of originalGlobals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
});
after(async () => { if (oldHome === undefined) delete process.env.VIDFLOW_HOME; else process.env.VIDFLOW_HOME = oldHome; if (folder) await rm(folder, { recursive: true, force: true }); });
async function mount(api?: ReturnType<typeof mockApi>) {
  dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, FormData: dom.window.FormData, IS_REACT_ACT_ENVIRONMENT: true })) {
    if (!originalGlobals.has(key)) originalGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  let resolvedAct = React.act;
  if (!resolvedAct) { try { resolvedAct = (await import('react-dom/test-utils')).act; } catch {} }
  const { flushSync } = await import('react-dom');
  // DOM events do not return their async submit handlers' promises. Drain the
  // follow-up preload reads and React commits before returning to assertions.
  // The fallback also needs multiple turns: a mount commit starts effects,
  // whose promises enqueue another commit (and possibly mount child panels).
  const flushUpdates = async () => {
    for (let turn = 0; turn < 4; turn++) {
      await new Promise<void>(resolve => setTimeout(resolve, 0));
      flushSync(() => {});
    }
  };
  act = typeof resolvedAct === 'function'
    ? async callback => { await resolvedAct(async () => { await callback(); await flushUpdates(); }); }
    : async callback => {
      let pending: unknown;
      flushSync(() => { pending = callback(); });
      await pending;
      await flushUpdates();
    };
  App = (await import(pathToFileURL(resolve(folder, 'app.mjs')).href)).App;
  getClient = (await import('../../renderer/src/api/client.ts')).getClient;
  const { createRoot } = await import('react-dom/client');
  root = createRoot(document.getElementById('root')!);
  if (api) Object.defineProperty(dom.window, 'vidflow', { value: api, configurable: true });
  await act(async () => root!.render(React.createElement(App)));
  // Flush the mount effects' API promises before callers query the project list.
  await act(async () => {});
}
async function waitFor<T>(read: () => T | undefined | null): Promise<T> {
  const deadline = Date.now() + 2000;
  while (Date.now() < deadline) {
    let value: T | undefined | null;
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); value = read(); });
    if (value) return value;
  }
  assert.fail('Hết thời gian chờ giao diện');
}
async function button(text: string): Promise<HTMLButtonElement> {
  return waitFor(() => [...document.querySelectorAll('button')].find(b => b.textContent?.trim() === text));
}
async function click(text: string) { const element = await button(text); await act(async () => element.click()); }
async function fill(label: string, value: string) {
  const element = await waitFor(() => [...document.querySelectorAll('label')].find(l => l.textContent === label)?.querySelector('input,textarea')) as HTMLInputElement;
  assert.ok(element, label);
  const prototype = element.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
  await act(async () => { Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value); element.dispatchEvent(new dom.window.Event('input', { bubbles: true })); element.dispatchEvent(new dom.window.Event('change', { bubbles: true })); });
}
test('tạo dự án và đọc lại danh sách', async () => {
  const api = mockApi(); await mount(api); await fill('Tên dự án', 'Phim mới'); await click('Tạo dự án');
  assert.deepEqual(api.projects.create.mock.calls[0].arguments, [{ name: 'Phim mới' }]); assert.ok(await button('Phim mới'));
  assert.equal(api.projects.list.mock.callCount(), 2);
  assert.equal((await button('Phim mới')).childElementCount, 0);
});
test('thêm, hiển thị dữ liệu lõi và xóa tham chiếu; lưu Bible', async () => {
  const api = mockApi(); await mount(api); await click('Dự án mẫu');
  assert.equal(api.projects.list.mock.callCount(), 1);
  assert.equal((await button('Dự án mẫu')).childElementCount, 0);
  await fill('Tên tham chiếu', 'Lan'); await fill('Đường dẫn ảnh (mỗi dòng một ảnh)', 'refs/lan.png'); await click('Thêm tham chiếu');
  assert.deepEqual(api.references.add.mock.calls[0].arguments, ['p1', { name: 'Lan', role: 'character', description: '', images: ['refs/lan.png'], priority: 0 }]);
  assert.match(document.body.textContent!, /@Tên từ lõi/); await click('Xóa'); assert.equal(api.references.remove.mock.callCount(), 1);
  await fill('Phong cách', 'Điện ảnh'); await click('Lưu Bible'); assert.equal(api.bible.update.mock.calls[0].arguments[1].style, 'Điện ảnh');
});
test('duyệt gửi phương án, nhận xét và đọc lại cổng', async () => {
  const api = mockApi(); await mount(api); await click('Dự án mẫu');
  const radio = await waitFor(() => document.querySelector('input[type=radio]')) as HTMLInputElement;
  await act(async () => radio.click());
  assert.match(document.body.textContent!, /Phương án một/);
  assert.match(document.body.textContent!, /Điểm: 10/);
  assert.match(document.body.textContent!, /Nhận xét mẫu/);
  await fill('Nhận xét', 'Đồng ý'); await click('Duyệt phương án');
  assert.deepEqual(api.script.approve.mock.calls[0].arguments, ['p1', { scriptId: 's1', versionId: 'o1' }]);
  assert.match(document.body.textContent!, /Đã duyệt từ lõi/); assert.equal(api.script.getGate.mock.callCount(), 2);
});
test('bỏ qua bắt buộc lý do và đọc lại cổng', async () => {
  const api = mockApi(); await mount(api); await click('Dự án mẫu'); await click('Bỏ qua'); assert.equal(api.script.skip.mock.callCount(), 0);
  await fill('Lý do bỏ qua', 'Đã có quyền sử dụng'); await click('Bỏ qua');
  assert.deepEqual(api.script.skip.mock.calls[0].arguments, ['p1', { reason: 'Đã có quyền sử dụng' }]); assert.match(document.body.textContent!, /Đã bỏ qua từ lõi/);
});
test('điểm cao không mở khóa khi lõi khóa', async () => {
  await mount(mockApi({ canApprove: false, canSkip: false, lockReason: 'Cần chủ sở hữu xử lý' })); await click('Dự án mẫu');
  assert.equal((await button('Duyệt phương án')).disabled, true); assert.equal((await button('Bỏ qua')).disabled, true); assert.match(document.body.textContent!, /Cần chủ sở hữu xử lý/);
});
test('rủi ro cao không tự khóa khi lõi cho phép', async () => {
  await mount(mockApi({ canApprove: true })); await click('Dự án mẫu');
  assert.equal((await button('Duyệt phương án')).disabled, false); assert.match(document.body.textContent!, /Nội dung nhạy cảm/);
});
test('thiếu preload báo tiếng Việt', async () => { await mount(); assert.throws(() => getClient(), /Không tìm thấy API VidFlow/); assert.match(document.querySelector('[role=alert]')!.textContent!, /Không tìm thấy API VidFlow/); });
test('hiển thị nguyên thông báo lỗi lõi', async () => { const api = mockApi(); api.projects.list.mock.mockImplementation(async () => { throw new Error('Lỗi do lõi trả về'); }); await mount(api); assert.match(document.querySelector('[role=alert]')!.textContent!, /Lỗi do lõi trả về/); });


test('whitespace skip reasons are not submitted', async () => {
  const api = mockApi();
  await mount(api);
  await click('Dự án mẫu');
  await fill('Lý do bỏ qua', '   ');
  await click('Bỏ qua');
  assert.equal(api.script.skip.mock.callCount(), 0);
});

test('reference mutations render the list response rather than the add response', async () => {
  const api = mockApi();
  let reads = 0;
  api.references.list.mock.mockImplementation(async () => {
    reads++;
    return reads === 1 ? [] : [{ id: 'listed', project_id: 'p1', name: 'ReadFromCore', role: 'character', description: '', images: [], priority: 0 }];
  });
  await mount(api);
  await click('Dự án mẫu');
  await fill('Tên tham chiếu', 'InputName');
  await click('Thêm tham chiếu');
  await waitFor(() => document.body.textContent?.includes('@ReadFromCore'));
  assert.equal(api.references.list.mock.callCount(), 2);
  assert.doesNotMatch(document.body.textContent!, /@Tên từ lõi|@InputName/);
});

test('a failed gate refresh clears loading and displays the preload error', async () => {
  const api = mockApi();
  await mount(api);
  await click('Dự án mẫu');
  await button('Bỏ qua');
  api.script.getGate.mock.mockImplementation(async () => { throw new Error('Gate refresh failed'); });
  await fill('Lý do bỏ qua', 'Owner reason');
  await click('Bỏ qua');
  await waitFor(() => document.querySelector('.gate [role=alert]'));
  assert.equal(document.querySelector('.gate [role=alert]')!.textContent, 'Gate refresh failed');
  assert.equal(document.querySelector('.gate [role=status]'), null);
  assert.equal(document.querySelector('[data-testid=gate-status]'), null);
});


function byTestId(id: string): HTMLElement {
  const element = document.querySelector(`[data-testid="${id}"]`);
  assert.ok(element, id); return element as HTMLElement;
}
async function clickId(id: string) { await act(async () => byTestId(id).click()); }
async function inputId(id: string, value: string) {
  const element = byTestId(id) as HTMLInputElement;
  const prototype = element.tagName === 'TEXTAREA' ? dom.window.HTMLTextAreaElement.prototype : dom.window.HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(prototype, 'value')!.set!.call(element, value);
    element.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
    element.dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });
}
async function submitId(id: string) {
  await act(async () => byTestId(id).dispatchEvent(new dom.window.Event('submit', { bubbles: true, cancelable: true })));
}
async function createWorkflowProject(fake: ReturnType<typeof workflowFake>) {
  await mount(fake.api);
  await inputId('project-name', 'Phim thử nghiệm'); await submitId('project-form');
  await waitFor(() => document.querySelector('[data-testid=tab-storyboard]'));
}
async function prepareRender(fake: ReturnType<typeof workflowFake>) {
  await createWorkflowProject(fake);
  await inputId('storyboard-version', 'o1'); await submitId('storyboard-form');
  await clickId('storyboard-approve'); await clickId('tab-render'); await clickId('render-start');
  await act(async () => fake.finishRender());
}

test('jsdom full flow: create project, reference, script, storyboard, render, select interval and export', async () => {
  const fake = workflowFake(); await createWorkflowProject(fake);
  assert.match(document.body.textContent!, /Phim thử nghiệm/);
  await inputId('reference-name', 'Lan'); await inputId('reference-images', 'refs/lan.png'); await submitId('reference-form');
  assert.match(document.body.textContent!, /@Lan/);
  await clickId('script-option-o1'); await submitId('script-approve-form');
  assert.equal(byTestId('gate-status').textContent, 'Đã duyệt');
  assert.equal((byTestId('storyboard-version') as HTMLInputElement).value, 'o1');
  await submitId('storyboard-form');
  assert.match(byTestId('storyboard-shot-step').textContent!, /Lan đi qua khu vườn/);
  await clickId('storyboard-approve'); assert.equal(byTestId('storyboard-status').textContent, 'Đã duyệt');
  await clickId('tab-render'); await clickId('render-start'); await clickId('render-refresh');
  assert.equal(byTestId('render-status').textContent, 'Đang chạy');
  assert.match(byTestId('render-shot-step').textContent!, /Đang chạy/);
  assert.equal((byTestId('render-cancel') as HTMLButtonElement).disabled, false);
  await act(async () => fake.finishRender());
  assert.equal(byTestId('render-status').textContent, 'Hoàn tất');
  assert.match(byTestId('render-budget').textContent!, /20 \/ 100/);
  await clickId('tab-takes');
  assert.equal(byTestId('take-status-take').textContent, 'Chưa chọn');
  await inputId('take-in-take', '1'); await inputId('take-out-take', '4'); await submitId('take-form-take');
  assert.equal(byTestId('take-status-take').textContent, 'Đã chọn');
  await clickId('tab-edit'); await clickId('edit-build');
  assert.equal(byTestId('timeline-ready').textContent, 'Timeline đã sẵn sàng');
  await act(async () => {
    (byTestId('export-aspect') as HTMLSelectElement).value = '9:16';
    byTestId('export-aspect').dispatchEvent(new dom.window.Event('change', { bubbles: true }));
  });
  await inputId('export-audio', 'exports/audio.wav'); await clickId('export-video');
  assert.equal(byTestId('export-path').textContent, 'exports/final.mp4');
  await clickId('export-capcut'); assert.equal(byTestId('export-path').textContent, 'exports/cc');
  await inputId('package-cover', 'frames/cover.png'); await inputId('package-model', 'fake'); await clickId('export-package');
  assert.equal(byTestId('export-path').textContent, 'exports/publish');
  const mutations = ['project.create', 'reference.add', 'script.approve', 'storyboard.generate', 'storyboard.approve', 'render.enqueue', 'render.run', 'take.select', 'edit.assemble', 'edit.export', 'edit.capcut', 'export.package'];
  assert.deepEqual(fake.calls.filter(call => mutations.includes(call.name)).map(call => call.name), mutations);
  assert.deepEqual(fake.calls.find(call => call.name === 'take.select')!.input, { stepId: 'step', takeId: 'take', inPoint: 1, outPoint: 4 });
  assert.deepEqual(fake.calls.find(call => call.name === 'render.run')!.input, { storyboardId: 'board', planId: 'plan' });
  assert.deepEqual(fake.calls.find(call => call.name === 'edit.export')!.input, { timelineId: 'timeline', aspect: '9:16', mixedAudioPath: 'exports/audio.wav' });
});

test('Settings clearly marks needs_owner and never renders secret fields, including token rotation', async () => {
  const fake = workflowFake(); await createWorkflowProject(fake); await clickId('tab-settings');
  assert.equal(byTestId('account-needs-owner').textContent, 'Cần chủ sở hữu');
  assert.match(document.body.textContent!, /đăng nhập hoặc xác minh/);
  const assertPrivate = () => {
    for (const secret of ['PRIVATE_COOKIE_SENTINEL', 'PRIVATE_TOKEN_SENTINEL', 'PRIVATE_SESSION_SENTINEL', 'PRIVATE_MCP_SENTINEL', 'PRIVATE_ROTATED_SENTINEL']) {
      assert.ok(!document.body.textContent!.includes(secret), secret);
      assert.ok(!document.body.innerHTML.includes(secret), secret);
    }
  };
  assertPrivate(); assert.equal(byTestId('mcp-credential-status').textContent, 'Chưa thiết lập');
  await clickId('mcp-toggle'); assert.equal(byTestId('mcp-enabled').textContent, 'Đang bật');
  await clickId('mcp-rotate'); assert.equal(byTestId('mcp-credential-status').textContent, 'Đã thiết lập'); assertPrivate();
  await clickId('mcp-revoke'); assert.equal(byTestId('mcp-credential-status').textContent, 'Chưa thiết lập');
  await inputId('budget-limit', '250'); await submitId('budget-form'); assert.match(byTestId('settings-budget').textContent!, /250/);
  assert.deepEqual(fake.calls.find(call => call.name === 'budget.set')!.input, { projectId: 'p2', limit: 250 });
  for (const tab of ['storyboard', 'render', 'takes', 'edit', 'settings']) { await clickId(`tab-${tab}`); assertPrivate(); }
});

test('take interval errors are returned by service; storyboard rejection, cancellation and redo delegate', async () => {
  const fake = workflowFake(); await prepareRender(fake);
  await clickId('redo-step'); assert.match(byTestId('redo-confirmation').textContent!, /scene, next-scene.*40/);
  await clickId('redo-approve'); assert.deepEqual(fake.calls.find(call => call.name === 'render.decideRedo')!.input, { requestId: 'rework', accept: true });
  await clickId('tab-takes'); await inputId('take-in-take', '4'); await inputId('take-out-take', '1'); await submitId('take-form-take');
  assert.equal(byTestId('workflow-error').textContent, 'Điểm ra phải lớn hơn điểm vào');
  await clickId('tab-storyboard'); await clickId('storyboard-reject'); assert.equal(byTestId('storyboard-status').textContent, 'Bản nháp');
  await clickId('storyboard-approve'); await clickId('tab-render'); await clickId('render-start'); await clickId('render-cancel');
  assert.ok(fake.calls.some(call => call.name === 'render.cancel'));
  assert.ok(fake.calls.some(call => call.name === 'storyboard.reject'));
  await act(async () => root!.unmount()); root = undefined; assert.equal(fake.listeners.size, 0);
});
