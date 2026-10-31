import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Server } from 'node:http';
import { stat } from 'node:fs/promises';
import { createMcpServer } from '../src/app/mcp/server.ts';
import { motionControlFixture } from './motion-control-fixture.ts';
import { browserAvailable, BROWSER_SKIP_REASON } from './support/browser.ts';
import { detectFfmpeg } from './helpers/media.ts';

test('M10.7: full motion workflow exclusively through authenticated MCP HTTP tools', { skip: !browserAvailable ? BROWSER_SKIP_REASON : !detectFfmpeg().available ? 'ffmpeg/ffprobe unavailable' : false }, async t => {
  const f = await motionControlFixture(t);
  const listen = t.mock.method(Server.prototype, 'listen');
  const server = createMcpServer({ services: f.service, getSettings: () => ({ mcp: { enabled: true, port: 0, token: 'motion-test-private' } }) });
  const address = await server.start(); t.after(() => server.stop());
  assert.equal(listen.mock.calls[0].arguments[1], '127.0.0.1');
  const url = `http://127.0.0.1:${address.port}/mcp`;
  assert.equal((await fetch(url, { method: 'POST' })).status, 401);
  assert.equal((await fetch(url, { method: 'POST', headers: { authorization: 'Bearer wrong' } })).status, 401);
  async function call(name: string, args: Record<string, unknown>, fails = false): Promise<any> {
    const response = await fetch(url, { method: 'POST', headers: { authorization: 'Bearer motion-test-private', 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }) });
    const body = await response.json();
    assert.equal(body.result.isError, fails, JSON.stringify(body));
    return JSON.parse(body.result.content[0].text);
  }
  await call('motion_import', { projectId: f.project.id, filePath: f.filePath, rights_confirmed: false }, true);
  const video = await call('motion_import', { projectId: f.project.id, filePath: f.filePath, rights_confirmed: true });
  const source = { sourceVideoId: video.id };
  const segments = await call('motion_segment', source); assert.ok(segments.length);
  await call('motion_list_segments', source);
  await call('motion_update_segment', { ...source, cuts: [] });
  const subjects = await call('motion_analyze', source);
  for (const subject of subjects) await call('motion_map_subjects', { subjectId: subject.id, target: subject.has_human_face ? 'faceless' : 'keep' });
  assert.ok((await call('motion_presets', {})).length);
  const estimate = await call('motion_set_preset', { ...source, presetKey: 'cartoon_faceless' });
  assert.ok(estimate.credit_estimate > 0);
  await call('motion_render', source, true);
  const preview = await call('motion_style_preview', { ...source, accountId: f.accountId });
  assert.equal(JSON.parse(preview.summary).visualPreview.status, 'ready');
  await call('motion_style_reject', source);
  await call('motion_set_preset', { ...source, presetKey: 'cartoon_faceless' });
  await call('motion_style_preview', { ...source, accountId: f.accountId });
  await call('motion_style_approve', { ...source, approver: 'Chủ sở hữu' });
  const rendered = await call('motion_render', source);
  for (const segment of rendered.segments) {
    assert.equal(segment.state.status, 'done');
    await call('motion_select_take', { segmentId: segment.id, variantId: segment.state.selectedVariantId });
  }
  await call('motion_status', source);
  const result = await call('motion_export', source);
  assert.ok((await stat(result.path)).size > 0);
  assert.ok(f.fake.state.jobs.some(j => j.mode === 'videoEdit'));
});
