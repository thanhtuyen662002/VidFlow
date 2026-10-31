import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import React from 'react';
import { JSDOM } from 'jsdom';
import { build } from 'vite';

test('M9 CSV acceptance, template creation and prune confirmation dialog', async t => {
  const folder = await mkdtemp(resolve('test/renderer/.m9-'));
  const oldHome = process.env.VIDFLOW_HOME;
  process.env.VIDFLOW_HOME = folder;
  const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost' });
  const globals = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator, HTMLElement: dom.window.HTMLElement, IS_REACT_ACT_ENVIRONMENT: true })) {
    globals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const { createRoot } = await import('react-dom/client');
  const { flushSync } = await import('react-dom');
  const root = createRoot(dom.window.document.getElementById('root')!);
  t.after(async () => {
    await act(() => root.unmount()); dom.window.close();
    for (const [key, descriptor] of globals) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
    if (oldHome === undefined) delete process.env.VIDFLOW_HOME; else process.env.VIDFLOW_HOME = oldHome;
    await rm(folder, { recursive: true, force: true });
  });
  async function act(work: () => unknown) {
    const drain = async () => { for (let i = 0; i < 4; i++) { await new Promise(resolve => setTimeout(resolve, 0)); flushSync(() => {}); } };
    if (React.act) await React.act(async () => { await work(); await drain(); });
    else { flushSync(() => { work(); }); await drain(); }
  }
  await build({ configFile: false, logLevel: 'silent', build: { outDir: folder, emptyOutDir: false, lib: { entry: resolve('renderer/src/M9.tsx'), formats: ['es'], fileName: () => 'm9.mjs' }, rollupOptions: { external: ['react'] } } });
  const { M9Panels } = await import(pathToFileURL(resolve(folder, 'm9.mjs')).href);
  let status = 'pending';
  const calls: { command: string; input: Record<string, unknown> }[] = [];
  const execute = async (command: string, input: Record<string, unknown>) => {
    calls.push({ command, input });
    if (command === 'analytics.accept') status = 'accepted';
    if (command === 'analytics.list') return [{ id: 'suggestion-1', status }];
    if (command === 'template.list') return [{ id: 'series-1', name: 'Series' }];
    if (command === 'template.createProject') return { id: 'new-project', name: input.name };
    if (command === 'takes.prunePreview') return { planId: 'reviewed', totalSize: 8, takes: [{ takeId: 'take-1', path: 'renders/take-1.mp4' }] };
    return {};
  };
  // Match the real preload's named methods and ServiceResult envelope.
  const api = Object.fromEntries(['analytics', 'template', 'archive', 'takes', 'update'].map(group => [group,
    Object.fromEntries(({
      analytics: ['import', 'list', 'accept', 'reject'],
      template: ['list', 'save', 'createProject'], archive: ['backup', 'restore'],
      takes: ['prunePreview', 'pruneApply'], update: ['check'],
    }[group]!).map(method => [method, async (input: Record<string, unknown>) => ({ ok: true, data: await execute(`${group}.${method}`, input) })]))
  ]));
  function Harness() {
    const [project, setProject] = React.useState({ id: 'project-1', name: 'Original' });
    return React.createElement(React.Fragment, null, React.createElement('p', { id: 'project' }, project.name), React.createElement(M9Panels, { api, projectId: project.id, onProject: setProject }));
  }
  await act(() => root.render(React.createElement(Harness)));
  const doc = dom.window.document;
  for (const control of doc.querySelectorAll('input,select,button')) assert.ok(control.getAttribute('data-testid'));
  const click = async (label: string) => {
    const button = [...doc.querySelectorAll('button')].find(b => b.textContent === label);
    assert.ok(button, label); await act(() => button.click());
  };
  const fill = async (label: string, value: string) => {
    const field = [...doc.querySelectorAll('label')].find(l => l.textContent?.startsWith(label))?.querySelector('input,select') as HTMLInputElement | HTMLSelectElement;
    assert.ok(field, label);
    await act(() => { field.value = value; field.dispatchEvent(new dom.window.Event(field.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true })); });
  };
  await fill('Đường dẫn CSV', 'retention.csv'); await fill('Timeline ID', 'timeline-1'); await click('Nhập CSV');
  assert.match(doc.body.textContent!, /suggestion-1/);
  assert.deepEqual(calls.find(c => c.command === 'analytics.import')?.input, { projectId: 'project-1', timelineId: 'timeline-1', csvPath: 'retention.csv' });
  await click('Chấp nhận');
  assert.deepEqual(calls.find(c => c.command === 'analytics.accept')?.input, { id: 'suggestion-1' });
  assert.match(doc.body.textContent!, /accepted/);
  await click('Tải mẫu'); await fill('Mẫu', 'series-1'); await fill('Tên dự án từ mẫu', 'Tập mới'); await click('Tạo dự án từ mẫu');
  assert.deepEqual(calls.find(c => c.command === 'template.createProject')?.input, { templateId: 'series-1', name: 'Tập mới' });
  assert.equal(doc.querySelector('#project')?.textContent, 'Tập mới');
  const deletes = () => calls.filter(c => c.command === 'takes.pruneApply');
  await click('Xem trước'); assert.equal(deletes().length, 0);
  assert.ok(doc.querySelector('[data-testid="cleanup-confirm"]'));
  assert.match(doc.querySelector('[role=dialog]')!.textContent!, /renders\/take-1.mp4/);
  await click('Hủy'); assert.equal(deletes().length, 0); assert.equal(doc.querySelector('[role=dialog]'), null);
  await click('Xem trước'); await click('Xác nhận xóa');
  assert.equal(deletes().length, 1);
  assert.deepEqual(deletes()[0].input, { projectId: 'new-project', planId: 'reviewed', confirm: true });
});
