import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { buildLogoCropFilter, cropLogoImage, cropLogoVideo, probe, runFfmpeg } from '../src/media/index.ts';
import { detectFfmpeg, mediaHome } from './helpers/media.ts';

test('logo config validates percentages and all corners without ffmpeg', () => {
  for (const value of [-1, 0, 0.51, NaN, Infinity]) {
    assert.throws(() => buildLogoCropFilter(1280, 720, { widthPct: value }), RangeError);
    assert.throws(() => buildLogoCropFilter(1280, 720, { heightPct: value }), RangeError);
  }
  assert.throws(() => buildLogoCropFilter(1280, 720, { corner: 'unknown' as never }), RangeError);
  for (const corner of ['top-left', 'top-right', 'bottom-left', 'bottom-right'] as const) {
    const { rectangle, filter } = buildLogoCropFilter(1280, 720, { corner });
    assert.equal(rectangle.width, 192);
    assert.equal(rectangle.height, 58);
    assert.equal(rectangle.x, corner.endsWith('right') ? 1088 : 0);
    assert.equal(rectangle.y, corner.startsWith('bottom') ? 662 : 0);
    assert.match(filter, /scale=1280:720$/);
  }
});

test('Flow crop images and audio video preserve dimensions, source and control marker', async t => {
  const home = mediaHome(t);
  const project = join(home, 'projects', 'logo project');
  mkdirSync(project, { recursive: true });
  const detected = detectFfmpeg();
  if (!detected.available) { t.skip(detected.reason); return; }
  const hash = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');
  let index = 0;
  for (const [width, height, video] of [[1280, 720, false], [720, 1280, false], [1280, 720, true]] as const) {
    const source = join(project, `source-${index++}.${video ? 'mp4' : 'png'}`);
    const { rectangle } = buildLogoCropFilter(width, height);
    const markerX = rectangle.x + Math.floor(rectangle.width / 2);
    const markerY = rectangle.y + Math.floor(rectangle.height / 2);
    await runFfmpeg(['-n', '-f', 'lavfi', '-i', `color=black:s=${width}x${height}:r=25`,
      ...(video ? ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo'] : []),
      '-vf', `drawbox=x=${markerX}:y=${markerY}:w=12:h=12:color=0xFF00FF:t=fill,drawbox=x=200:y=200:w=30:h=30:color=0x00FF00:t=fill`,
      ...(video ? ['-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac'] : ['-frames:v', '1']),
      '-metadata', 'comment=AI generated', source], { timeoutMs: 30000 });
    const before = hash(source);
    const result = await (video ? cropLogoVideo : cropLogoImage)(project, source);
    assert.equal(dirname(result.path), join(project, video ? 'exports' : 'frames'));
    assert.equal(hash(source), before);
    const input = await probe(source);
    const output = await probe(result.path);
    assert.deepEqual([output.width, output.height], [width, height]);
    assert.equal(output.width / output.height, input.width / input.height);
    if (video) {
      assert.ok(Math.abs(output.durationSec - input.durationSec) < 0.1);
      assert.equal(output.fps, input.fps);
      assert.equal(output.pixelFormat, input.pixelFormat);
      assert.equal(output.hasAudio, true);
    }
    const pixelsPath = join(project, `pixels-${index}.rgb`);
    await runFfmpeg(['-n', '-i', result.path, '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', pixelsPath], { timeoutMs: 30000 });
    const pixels = readFileSync(pixelsPath);
    let green = 0;
    for (let i = 0; i < pixels.length; i += 3) {
      assert.ok(!(pixels[i] > 180 && pixels[i + 1] < 80 && pixels[i + 2] > 180), 'magenta absent throughout frame, including logo region');
      if (pixels[i] < 80 && pixels[i + 1] > 180 && pixels[i + 2] < 80) green++;
    }
    assert.ok(green > 100, 'control marker survives');
    await assert.rejects((video ? cropLogoVideo : cropLogoImage)(project, source), { code: 'UNSAFE_PATH' });
    await assert.rejects((video ? cropLogoVideo : cropLogoImage)(project, source, { fileName: '../escape.png' }), { code: 'UNSAFE_PATH' });
  }
});
