#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { constants, copyFileSync, lstatSync, unlinkSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { openDatabase } from './db.ts';
import { createReference, findReferenceByName, listReferences } from './repo/references.ts';
import { referenceFilename, referenceInput } from './validate.ts';
import { createProjectDirectories, dataDirectory, resolveInside } from './paths.ts';
import { createProject, findProject, listProjects } from './repo/projects.ts';
import { projectAspect, projectBudget, projectName } from './validate.ts';
import type { Project } from './repo/projects.ts';
import { BibleDuplicateError } from './prompt/bible-errors.ts';
import { normalizeRefName } from './ref-name.ts';

type IO = { stdout: Pick<NodeJS.WriteStream, 'write'>; stderr: Pick<NodeJS.WriteStream, 'write'> };
const usage = `Usage: vidflow init
       vidflow project create <name> --aspect <W:H> [--budget N]
       vidflow project list
       vidflow project show <id|name>
       vidflow ref add <project> <image> --name <n> --role <character|location|prop|style> --description <d> --priority <integer>
       vidflow ref list <project> (priority ascending, then name)
`;

function details(project: Project): string {
  return `ID: ${project.id}\nTên: ${project.name}\nAspect: ${project.aspect}\nBudget: ${project.budget ?? 'chưa đặt'}\nTrạng thái: ${project.status}\nThư mục: ${project.directory}\nNgày tạo: ${project.created_at}\n`;
}

export function run(argv: string[], io: IO = process): number {
  let usageError = true;
  try {
    const command = argv[0];
    const action = argv[1];
    const addRef = command === 'ref' && action === 'add';
    const create = command === 'project' && action === 'create';
    const { positionals, values } = parseArgs({ args: argv, allowPositionals: true, strict: true,
      options: { ...(addRef ? { name: { type: 'string' as const }, role: { type: 'string' as const }, description: { type: 'string' as const }, priority: { type: 'string' as const } } : {}), help: { type: 'boolean' }, ...(create ? { aspect: { type: 'string' as const }, budget: { type: 'string' as const } } : {}) } });
    if (!command || values.help) { io.stdout.write(usage); return 0; }
    if (command !== 'init' && command !== 'project' && command !== 'ref') throw new Error('Lệnh không hợp lệ');
    let input: { name: string; aspect: string; budget: number | null } | undefined;
    if (command === 'ref') {
      if ((addRef && positionals.length !== 4) || (action === 'list' && positionals.length !== 3) || (!addRef && action !== 'list')) throw new Error('Usage: ref add <project> <image> --name --role --description --priority | ref list <project>');
      if (addRef) {
        referenceInput(values);
        referenceFilename(basename(positionals[3]));
        if (!lstatSync(positionals[3]).isFile()) throw new Error('Source image must be a regular file');
      }
    } else if (command === 'init') {
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
      if (command === 'ref') {
        const project = findProject(db, positionals[2]);
        if (!project) throw new Error('Project not found');
        if (addRef) {
          const input = referenceInput(values);
          if (findReferenceByName(db, project.id, input.name)) throw new BibleDuplicateError(input.name, normalizeRefName(input.name));
          const directory = createProjectDirectories(project.id);
          const refs = resolveInside(directory, 'refs');
          const destination = resolveInside(refs, referenceFilename(basename(positionals[3])));
          // Exclusive copy: an existing destination is an error, never overwritten.
          copyFileSync(positionals[3], destination, constants.COPYFILE_EXCL);
          try {
            createReference(db, { ...input, project_id: project.id, images: [destination] });
          } catch (error) {
            try { unlinkSync(destination); } catch (cleanupError) {
              throw new Error('Reference insert failed and copied image could not be removed', { cause: new AggregateError([error, cleanupError]) });
            }
            throw error;
          }
          io.stdout.write(`Added reference: ${input.name}\n`);
        } else {
          const references = listReferences(db, project.id);
          io.stdout.write(references.length ? 'Name\tRole\tPriority\tImages\tDescription\n' + references.map(r => [r.name, r.role, r.priority, r.images.join(', '), r.description].join('\t')).join('\n') + '\n' : 'No references\n');
        }
      } else if (command === 'init') io.stdout.write(`Đã khởi tạo: ${dataDirectory()}\n`);
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
