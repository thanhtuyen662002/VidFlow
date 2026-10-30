import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, readdir, stat } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { temporaryDatabase } from './helpers.ts';
import { buildCapcutDraft, writeCapcutDraft } from '../src/edit/capcut.ts';
import type { Timeline, TimelineClip } from '../src/edit/timeline.ts';

test('M7.4 draft JSON, three trims, audio placement, immutable sources and fresh destinations', async t => {
  temporaryDatabase(t);
  const projectDir = join(process.env.VIDFLOW_HOME!, 'projects', 'p');
  await mkdir(join(projectDir, 'renders'), { recursive: true });
  const clips: TimelineClip[] = [];
  let position = 0;
  for (const [i, [inPoint, outPoint]] of [[0.25, 1.75], [2, 2.75], [0.125, 2.625]].entries()) {
    const sourcePath = join(projectDir, 'renders', `${i}.mp4`);
    await writeFile(sourcePath, `unchanged source ${i}`);
    clips.push({ id: `${i}`, trackId: 'v', sceneId: null, takeId: null, sourceAssetId: null,
      sourcePath, inPoint, outPoint, timelineStart: position, duration: outPoint - inPoint, order: i });
    position += outPoint - inPoint;
  }
  const before = await Promise.all(clips.map(async c => ({ bytes: await readFile(c.sourcePath), info: await stat(c.sourcePath) })));
  const input: Timeline = { id: 't', projectId: 'p', revision: 1, createdAt: '', status: 'draft', tracks: [
    { id: 'v', timelineId: 't', kind: 'video', order: 0, muted: false, clips, subtitles: [] },
    { id: 'a', timelineId: 't', kind: 'dialogue', order: 1, muted: true,
      clips: [{ ...clips[1], timelineStart: 2 }], subtitles: [] },
  ] };
  const draft = buildCapcutDraft(input, { projectDir, aspect: '16:9' });
  assert.deepEqual(draft, buildCapcutDraft(input, { projectDir, aspect: '16:9' }));
  const out = join(projectDir, 'exports', '16x9', 'capcut_draft');
  const destination = await writeCapcutDraft(draft, out, { projectDir });
  assert.equal(basename(destination), 'capcut_draft');
  assert.deepEqual((await readdir(destination)).sort(), ['draft_content.json', 'draft_meta_info.json']);
  const content = JSON.parse(await readFile(join(destination, 'draft_content.json'), 'utf8'));
  const meta = JSON.parse(await readFile(join(destination, 'draft_meta_info.json'), 'utf8'));
  assert.deepEqual(content, draft.content);
  assert.deepEqual(content.canvas_config, { width: 1920, height: 1080, ratio: '16:9' });
  assert.equal(content.duration, 4_750_000);
  assert.equal(meta.draft_duration, content.duration);
  assert.equal(meta.draft_id, input.id);
  assert.equal(meta.draft_name, 'VidFlow t');
  assert.equal(content.tracks[0].segments.length, clips.length);
  let target = 0;
  clips.forEach((c, i) => {
    const segment = content.tracks[0].segments[i];
    const duration = Math.round((c.outPoint - c.inPoint) * 1e6);
    assert.deepEqual(segment.source_timerange, { start: Math.round(c.inPoint * 1e6), duration });
    assert.deepEqual(segment.target_timerange, { start: target, duration });
    target += duration;
    const material = content.materials.videos.find((m: { id: string }) => m.id === segment.material_id);
    assert.equal(material.path, c.sourcePath);
    assert.equal(material.duration, Math.round(c.outPoint * 1e6));
  });
  assert.equal(content.tracks[1].type, 'audio');
  assert.equal(content.tracks[1].segments[0].target_timerange.start, 2_000_000);
  assert.equal(content.tracks[1].segments[0].volume, 0);
  assert.equal(content.tracks[1].segments[0].material_id, content.materials.audios[0].id);
  assert.notEqual(await writeCapcutDraft(draft, out, { projectDir }), destination);
  for (const [i, c] of clips.entries()) {
    assert.deepEqual(await readFile(c.sourcePath), before[i].bytes);
    assert.equal((await stat(c.sourcePath)).mtimeMs, before[i].info.mtimeMs);
  }
  assert.throws(() => buildCapcutDraft({ ...input, tracks: [{ ...input.tracks[0], clips: [{ ...clips[0], outPoint: 0 }] }] },
    { projectDir, aspect: '16:9' }), /Invalid draft/);
});
