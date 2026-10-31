import { parseArgs } from 'node:util';
import { openDatabase } from '../db.ts';
import { createCoreService } from '../service/index.ts';
import type { Services } from '../app/ipc.ts';
import { configuredLlm } from '../script/config.ts';
import { browserMotion } from './runtime.ts';
import { createPageDriver } from '../flow/pageDriver.ts';
import { launchFlowContext } from '../flow/driver.ts';

export async function runMotionCommand(args: string[], io: { stdout: { write(text: string): unknown }; stderr: { write(text: string): unknown } } = process, service?: Services): Promise<number> {
  let db: ReturnType<typeof openDatabase> | undefined;
  try {
    const { positionals: p, values } = parseArgs({ args, allowPositionals: true, options: { 'rights-confirmed': { type: 'boolean' }, help: { type: 'boolean' } } });
    const commands: Record<string, [string, string[]]> = {
      import: ['import', ['projectId', 'filePath']], segment: ['segment', ['sourceVideoId']], status: ['status', ['sourceVideoId']],
      analyze: ['analyze', ['sourceVideoId']], map: ['map_subjects', ['subjectId', 'target']], preset: ['set_preset', ['sourceVideoId', 'presetKey']],
      preview: ['style_preview', ['sourceVideoId', 'accountId']], 'approve-style': ['style_approve', ['sourceVideoId', 'approver']],
      'reject-style': ['style_reject', ['sourceVideoId']], presets: ['presets', []], 'list-segments': ['list_segments', ['sourceVideoId']],
      'update-segments': ['update_segment', ['sourceVideoId', 'cuts']],
      render: ['render', ['sourceVideoId']], select: ['select_take', ['segmentId', 'variantId']], export: ['export', ['sourceVideoId']],
    };
    if (values.help) { io.stdout.write('motion ' + Object.keys(commands).join('|') + '\nNhập: motion import <dự án> <video> --rights-confirmed\n'); return 0; }
    const command = commands[p[0]];
    if (!command || p.length !== command[1].length + 1) throw new Error('Đối số lệnh chuyển động không hợp lệ');
    if (!service) {
      db = openDatabase();
      const store = db;
      service = createCoreService({ db, motion: browserMotion(db), llm: { complete: r => configuredLlm().complete(r) }, flowDriver: createPageDriver(async accountId => ({ db: store, browser: await launchFlowContext(accountId), url: 'https://labs.google/fx/tools/flow', timeoutMs: 30000 })) });
    }
    const input = Object.fromEntries(command[1].map((key, n) => [key, p[n + 1]])) as Record<string, unknown>;
    if (p[0] === 'import') input.rights_confirmed = values['rights-confirmed'] === true;
    if (p[0] === 'update-segments') input.cuts = JSON.parse(String(input.cuts));
    const result = await service.execute('motion.' + command[0], input);
    if (!result.ok) throw new Error(result.error.message);
    io.stdout.write(JSON.stringify(result.data) + '\n'); return 0;
  } catch (error) { io.stderr.write((error instanceof Error ? error.message : 'Lỗi chuyển động') + '\n'); return 1; }
  finally { db?.close(); }
}
