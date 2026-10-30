import { parseArgs } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { openDatabase } from '../db.ts';
import { findProject } from '../repo/projects.ts';
import { buildTimelineFromSelectedTakes, getTimeline } from './timeline.ts';
import { exportFinal } from './export.ts';
import { configuredLlm } from '../script/config.ts';
import { buildPublishPackage, collectMusicLicenses, markReadyToPublish } from './package.ts';
import { resolveInside } from '../paths.ts';
import { getMusicTrack } from '../repo/music.ts';

type IO = { stdout: { write(text: string): unknown }; stderr: { write(text: string): unknown } };
const help = `Cách dùng:
  vidflow timeline <dự-án> [--timeline ID] [--music ID] [--voice audio/voice.wav]
    Dựng và lưu timeline từ các take đã chọn; có ID thì hiển thị bản đã lưu.
  vidflow export <dự-án> --timeline ID --audio exports/mixed.wav [--aspect 16:9,9:16]
    Xuất video bằng cấu hình dự án; --audio là kết quả trộn âm M7.1.
  vidflow package <dự-án> --timeline ID --result exports/result.json [--cover frames/cover.png] [--model TÊN] [--tts-model TÊN] [--ready]
    Tạo gói cục bộ; dùng VIDFLOW_LLM và VIDFLOW_LLM_RESPONSES như lệnh script.
  vidflow package <dự-án> --ready --directory exports/slug/phiên-bản
    Kiểm tra khai báo AI và giấy phép trước khi đánh dấu sẵn sàng đăng. Đăng thủ công.
`;
export async function runEditCommand(command: string, argv: string[], io: IO = process): Promise<number> {
  try {
    const { positionals, values } = parseArgs({ args: argv, allowPositionals: true, options: {
      help: { type: 'boolean' }, timeline: { type: 'string' }, audio: { type: 'string' },
      aspect: { type: 'string' }, result: { type: 'string' }, cover: { type: 'string' },
      model: { type: 'string' }, 'tts-model': { type: 'string' }, ready: { type: 'boolean' }, directory: { type: 'string' },
      music: { type: 'string' }, voice: { type: 'string' },
    } });
    if (values.help) { io.stdout.write(help); return 0; }
    if (positionals.length !== 1) throw new Error(help);
    const db = openDatabase();
    try {
      const project = findProject(db, positionals[0]);
      if (!project) throw new Error('Không tìm thấy dự án');
      if (command === 'package' && values.directory && values.ready) {
        io.stdout.write(JSON.stringify(await markReadyToPublish(project.directory, resolveInside(project.directory, values.directory))) + '\n'); return 0;
      }
      const timeline = values.timeline ? getTimeline(db, values.timeline) : command === 'timeline' ? buildTimelineFromSelectedTakes(db, project.id) : undefined;
      if (!timeline || timeline.projectId !== project.id) throw new Error('Cần timeline thuộc dự án (--timeline ID)');
      if (command === 'timeline') {
        if (values.music || values.voice) {
          const duration = Math.max(0, ...timeline.tracks.filter(t => t.kind === 'video').flatMap(t => t.clips).map(c => c.timelineStart + c.duration));
          if (!duration) throw new Error('Timeline không có video');
          const music = values.music ? getMusicTrack(db, values.music) : undefined;
          if (values.music && (!music || music.projectId !== project.id)) throw new Error('Không tìm thấy nhạc trong dự án');
          const additions = [
            ...(music ? [{ kind: 'music', file: music.file }] : []),
            ...(values.voice ? [{ kind: 'dialogue', file: values.voice }] : []),
          ].map(a => ({ ...a, path: resolveInside(project.directory, a.file) }));
          db.exec('BEGIN IMMEDIATE');
          try {
            for (const item of additions) {
              const track = timeline.tracks.find(t => t.kind === item.kind)!;
              db.prepare('UPDATE timeline_track SET muted=0 WHERE id=?').run(track.id);
              db.prepare('INSERT INTO timeline_clip VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(), track.id, null, null, null, item.path, 0, duration, 0, duration, track.clips.length);
            }
            db.exec('COMMIT');
          } catch (error) { db.exec('ROLLBACK'); throw error; }
          Object.assign(timeline, getTimeline(db, timeline.id)!);
        }
        const path = resolveInside(project.directory, `exports/timeline-${timeline.id}.json`);
        await writeFile(path, JSON.stringify(timeline, null, 2), { flag: 'wx' }).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'EEXIST') throw error; });
        io.stdout.write(JSON.stringify({ timeline, path }) + '\n'); return 0;
      }
      if (command === 'export') {
        if (!values.audio) throw new Error('Cần --audio là kết quả trộn âm');
        const aspects = (values.aspect ?? project.aspect).split(',');
        if (aspects.some(a => a !== '16:9' && a !== '9:16')) throw new Error('Tỉ lệ phải là 16:9 hoặc 9:16');
        const videos = [];
        for (const aspect of new Set(aspects)) {
          const result = await exportFinal(timeline, { projectDir: project.directory, mixedAudioPath: resolveInside(project.directory, values.audio), aspect: aspect as '16:9' | '9:16' });
          videos.push({ aspect, path: result.path });
        }
        const path = resolveInside(project.directory, `exports/result-${randomUUID()}.json`);
        await writeFile(path, JSON.stringify({ timelineId: timeline.id, videos }, null, 2), { flag: 'wx' });
        io.stdout.write(JSON.stringify({ path, videos }) + '\n'); return 0;
      }
      if (!values.result) throw new Error('Cần --result là tệp kết quả xuất');
      const result = JSON.parse(await readFile(resolveInside(project.directory, values.result), 'utf8'));
      if (result.timelineId !== timeline.id) throw new Error('Kết quả xuất không thuộc timeline');
      const pkg = await buildPublishPackage({ project, timeline, videos: result.videos,
        licenses: collectMusicLicenses(db, project, timeline), llm: configuredLlm(),
        llmModel: values.model ?? process.env.VIDFLOW_LLM ?? 'local', ttsModel: values['tts-model'],
        coverPath: values.cover ? resolveInside(project.directory, values.cover) : undefined });
      if (values.ready) pkg.manifest = await markReadyToPublish(project.directory, pkg.directory);
      io.stdout.write(JSON.stringify(pkg) + '\n'); return 0;
    } finally { db.close(); }
  } catch (error) { io.stderr.write(`vidflow: ${error instanceof Error ? error.message : String(error)}\n`); return 1; }
}
