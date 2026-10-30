import { parseArgs } from 'node:util';
import { openDatabase } from '../db.ts';
import { findProject } from '../repo/projects.ts';
import { generateVariants, scoreVariants, revise, reviewRisks, approve } from './variants.ts';
import { split } from './split.ts';
import { configuredLlm } from './config.ts';

type IO = { stdout: { write(text: string): unknown }; stderr: { write(text: string): unknown } };
export async function runScript(argv: string[], io: IO = process): Promise<number> {
  let parsed = false;
  try {
    const { positionals: args, values } = parseArgs({ args: argv, allowPositionals: true,
      options: { brief: { type: 'string' }, count: { type: 'string', default: '1' },
        feedback: { type: 'string' }, model: { type: 'string', default: 'local' } } });
    const [action, id, version = id] = args;
    if (!['generate', 'score', 'revise', 'approve', 'split'].includes(action) || !id ||
      args.length > (action === 'revise' || action === 'approve' ? 3 : 2) ||
      (action === 'generate' && !values.brief) || (action === 'revise' && !values.feedback))
      throw new Error('Usage: script generate <project> --brief TEXT [--count N] | score <variant> | revise <script> [version] --feedback TEXT | approve <script> [version] | split <variant>');
    parsed = true;
    const db = openDatabase();
    try {
      let result: unknown;
      if (action === 'generate') {
        const project = findProject(db, id);
        if (!project) throw new Error('Project not found');
        result = await generateVariants({ db, llm: configuredLlm(), projectId: project.id,
          brief: values.brief!, count: Number(values.count) });
      } else if (action === 'score') result = await scoreVariants({ db, llm: configuredLlm(), variantIds: [id], reviewerModel: values.model! });
      else if (action === 'revise') result = await revise({ db, llm: configuredLlm(), scriptId: id,
        baseVersionId: version, feedback: [values.feedback!], reviewerModel: values.model! });
      else if (action === 'approve') {
        await reviewRisks({ db, scriptId: id, versionId: version });
        result = approve(db, id, version);
      } else result = split(db, id);
      io.stdout.write(JSON.stringify(result) + '\n');
    } finally { db.close(); }
    return 0;
  } catch (error) {
    io.stderr.write(`vidflow: ${error instanceof Error ? error.message : String(error)}\n`);
    return parsed ? 1 : 2;
  }
}
