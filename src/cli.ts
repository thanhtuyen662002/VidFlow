#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { resolve } from 'node:path';
import { openDatabase } from './db.ts';
import { dataDirectory } from './paths.ts';
import { createProject, findProject, listProjects } from './repo/projects.ts';
import { projectAspect, projectBudget, projectName } from './validate.ts';
import type { Project } from './repo/projects.ts';

type IO = { stdout: Pick<NodeJS.WriteStream, 'write'>; stderr: Pick<NodeJS.WriteStream, 'write'> };
const usage = `Usage: vidflow init
       vidflow project create <name> --aspect <W:H> [--budget N]
       vidflow project list
       vidflow project show <id|name>
       vidflow ref add|list (chưa hỗ trợ)
`;

function details(project: Project): string {
  return `ID: ${project.id}\nTên: ${project.name}\nAspect: ${project.aspect}\nBudget: ${project.budget ?? 'chưa đặt'}\nTrạng thái: ${project.status}\nThư mục: ${project.directory}\nNgày tạo: ${project.created_at}\n`;
}

export function run(argv: string[], io: IO = process): number {
  let usageError = true;
  try {
    const command = argv[0];
    const action = argv[1];
    const create = command === 'project' && action === 'create';
    const { positionals, values } = parseArgs({ args: argv, allowPositionals: true, strict: true,
      options: { help: { type: 'boolean' }, ...(create ? { aspect: { type: 'string' as const }, budget: { type: 'string' as const } } : {}) } });
    if (!command || values.help) { io.stdout.write(usage); return 0; }
    if (command === 'ref') throw new Error('ref add|list: chưa hỗ trợ');
    if (command !== 'init' && command !== 'project') throw new Error('Lệnh không hợp lệ');
    let input: { name: string; aspect: string; budget: number | null } | undefined;
    if (command === 'init') {
      if (positionals.length !== 1) throw new Error('init không nhận đối số');
    } else if (create) {
      if (positionals.length !== 3) throw new Error('Cần project create <name> --aspect <W:H>');
      input = { name: projectName(positionals[2]), aspect: projectAspect(values.aspect as string | undefined), budget: projectBudget(values.budget as string | undefined) };
    } else if (action === 'list') {
      if (positionals.length !== 2) throw new Error('project list không nhận đối số');
    } else if (action === 'show') {
      if (positionals.length !== 3) throw new Error('Cần project show <id|name>');
    } else throw new Error('Lệnh project không hợp lệ');
    usageError = false;
    const db = openDatabase();
    try {
      if (command === 'init') io.stdout.write(`Đã khởi tạo: ${dataDirectory()}\n`);
      else if (input) io.stdout.write(details(createProject(db, input.name, input.aspect, input.budget)));
      else if (action === 'list') {
        const projects = listProjects(db);
        io.stdout.write(projects.length ? 'ID\tTên\tAspect\tBudget\tNgày tạo\n' + projects.map(p => `${p.id}\t${p.name}\t${p.aspect}\t${p.budget ?? 'chưa đặt'}\t${p.created_at}`).join('\n') + '\n' : 'chưa có dự án\n');
      } else {
        const project = findProject(db, positionals[2]);
        if (!project) throw new Error('Không tìm thấy dự án');
        io.stdout.write(details(project));
      }
    } finally { db.close(); }
    return 0;
  } catch (error) {
    io.stderr.write(`vidflow: ${error instanceof Error ? error.message : String(error)}\n`);
    return usageError ? 2 : 1;
  }
}

if (process.argv[1] && import.meta.filename === resolve(process.argv[1])) process.exitCode = run(process.argv.slice(2));
