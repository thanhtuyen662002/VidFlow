import { parseArgs } from 'node:util';
import { readFileSync } from 'node:fs';
import { openDatabase } from '../db.ts';
import { createCoreService } from './index.ts';
import { createUpdater, DEFAULT_UPDATE_SOURCE } from '../app/updater.ts';
import { withUpdates } from '../app/update-service.ts';
import { dataDirectory, resolveInside } from '../paths.ts';

type IO = { stdout: Pick<NodeJS.WriteStream, 'write'>; stderr: Pick<NodeJS.WriteStream, 'write'> };
const usage = `analytics import <projectId> <timelineId> <csvPath> | list <projectId> | accept|reject <id>
template list | save <projectId> <name> | createProject <templateId> <name>
archive backup <file> | restore <file> <targetDir> [--allow-non-empty]
takes prune <projectId> [--yes --plan-id <planId>]
update check
`;
export async function runM9Command(argv: string[], io: IO): Promise<number> {
  let db: ReturnType<typeof openDatabase> | undefined;
  try {
    const aliases: Record<string, string[]> = { csv: ['analytics'], suggestions: ['analytics'], backup: ['archive', 'backup'], restore: ['archive', 'restore'], 'cleanup-takes': ['takes', 'prune'], 'check-update': ['update', 'check'] };
    let normalized = aliases[argv[0]] ? [...aliases[argv[0]], ...argv.slice(1)] : [...argv];
    if (normalized[0] === 'template' && normalized[1] === 'create-project') normalized[1] = 'createProject';
    const { positionals: p, values } = parseArgs({ args: normalized, allowPositionals: true, options: { yes: { type: 'boolean' }, 'plan-id': { type: 'string' }, help: { type: 'boolean' }, 'allow-non-empty': { type: 'boolean' } } });
    if (values.help) { io.stdout.write(usage); return 0; }
    const [group, action, ...args] = p;
    const commands: Record<string, string[]> = {
      'analytics.import': ['projectId','timelineId','csvPath'], 'analytics.list': ['projectId'], 'analytics.accept': ['id'], 'analytics.reject': ['id'],
      'template.list': [], 'template.save': ['projectId','name'], 'template.createProject': ['templateId','name'],
      'archive.backup': ['file'], 'archive.restore': ['file','targetDir'], 'takes.prune': ['projectId'], 'update.check': [],
    };
    const command = `${group}.${action}`, fields = commands[command];
    if (!fields || args.length !== fields.length) throw new Error(usage);
    if (values.yes && command !== 'takes.prune') throw new Error('--yes chỉ dùng cho dọn take');
    if (values['plan-id'] && command !== 'takes.prune') throw new Error('--plan-id chỉ dùng cho dọn take');
    if (values.yes && !values['plan-id']) throw new Error('CONFIRMATION_REQUIRED: Cần --yes và --plan-id từ lần xem trước');
    if (values['allow-non-empty'] && command !== 'archive.restore') throw new Error('--allow-non-empty chỉ dùng cho khôi phục');
    db = openDatabase();
    const core = createCoreService({ db, llm: { async complete() { throw new Error('Không dùng LLM trong lệnh M9'); } }, flowDriver: { async run() { throw new Error('Không render trong lệnh M9'); } } });
    const updater = createUpdater({ config: () => ({ channel: 'dev', sourceUrl: core.mcpSettingsStore.getSettings().updates?.sourceUrl || DEFAULT_UPDATE_SOURCE }), currentVersion: (JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as { version: string }).version, directory: resolveInside(dataDirectory(), 'updates') });
    const service = withUpdates(core, updater);
    async function execute(name: string, input: Record<string, unknown>) {
      const result = await service.execute(name, input);
      if (!result.ok) throw new Error(result.error.message);
      return result.data;
    }
    const input: Record<string, unknown> = Object.fromEntries(fields.map((field, i) => [field, args[i]]));
    if (command === 'archive.restore' && values['allow-non-empty'] !== undefined) input.allowNonEmpty = values['allow-non-empty'];
    if (command === 'takes.prune') {
      const plan = await execute('takes.prunePreview', input) as { planId: string };
      io.stdout.write(JSON.stringify(plan, null, 2) + '\n');
      if (values.yes === true) io.stdout.write(JSON.stringify(await execute('takes.pruneApply', { ...input, planId: values['plan-id'], confirm: true })) + '\n');
      else io.stdout.write('Chưa xóa take. Dùng --yes --plan-id <planId> để xác nhận xóa danh sách xem trước.\n');
    } else io.stdout.write(JSON.stringify(await execute(command, input), null, 2) + '\n');
    return 0;
  } catch (e) { io.stderr.write(`vidflow: ${e instanceof Error ? e.message : String(e)}\n`); return 1; }
  finally { db?.close(); }
}
