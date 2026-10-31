import { randomUUID } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { extname } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Bible, Reference } from '../types.ts';
import { dataDirectory, resolveInside } from '../paths.ts';
import { assertInsideDataDir } from '../media/paths.ts';
import { projectName, projectAspect, ValidationError } from '../validate.ts';
import { createProject, deleteProject, getProject } from './projects.ts';
import { getBible, setBible } from './bibles.ts';
import { createReference, listReferences } from './references.ts';

type TemplateBible = Omit<Bible, 'id' | 'project_id'>;
type TemplateReference = Omit<Reference, 'id' | 'project_id'>;
export type SeriesTemplate = {
  id: string; name: string; created_at: string; source_project_id: string; schema_version: 1;
  bible: TemplateBible | null; references: TemplateReference[]; style: string;
  config: { aspect: string };
};
function root(): string { return resolveInside(dataDirectory(), 'templates'); }
function folder(id: string): string {
  if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(id)) throw new ValidationError('ID mẫu series không hợp lệ');
  return resolveInside(root(), id);
}
function image(file: string): string {
  const safe = assertInsideDataDir(file, dataDirectory());
  let bytes: Buffer;
  try { bytes = readFileSync(safe); } catch { throw new ValidationError('Ảnh tham chiếu không tồn tại hoặc không đọc được'); }
  if (!(bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) ||
    (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) ||
    (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP'))) {
    throw new ValidationError('Ảnh tham chiếu không hợp lệ: cần PNG, JPEG hoặc WEBP');
  }
  return safe;
}
function copyImage(source: string, directory: string, part: string): string {
  source = image(source);
  const extension = extname(source).toLowerCase();
  const suffix = /^\.(png|jpe?g|webp)$/.test(extension) ? extension : '.png';
  const relative = `${part}/${randomUUID()}${suffix}`;
  const target = resolveInside(directory, relative);
  assertInsideDataDir(target, dataDirectory());
  copyFileSync(source, target);
  return relative;
}
export function saveProjectAsTemplate(db: DatabaseSync, projectId: string, options: { name: string }): SeriesTemplate {
  const project = getProject(db, projectId);
  if (!project) throw new ValidationError('Không tìm thấy dự án');
  assertInsideDataDir(project.directory, dataDirectory());
  const name = projectName(options.name);
  const savedBible = getBible(db, projectId);
  const bible = savedBible ? (({ id, project_id, ...fields }) => fields)(savedBible) : null;
  const references = listReferences(db, projectId);
  const id = randomUUID(), directory = folder(id);
  try {
    mkdirSync(resolveInside(directory, 'images'), { recursive: true });
    const template: SeriesTemplate = structuredClone({ id, name, created_at: new Date().toISOString(), source_project_id: projectId,
      schema_version: 1, bible, style: bible?.style ?? '', config: { aspect: project.aspect }, references: references.map(({ id, project_id, ...ref }) => ({
        ...ref, images: ref.images.map(file => copyImage(file, directory, 'images')),
      })) });
    const temporary = resolveInside(directory, 'template.json.partial');
    writeFileSync(temporary, JSON.stringify(template, null, 2), { flag: 'wx' });
    renameSync(temporary, resolveInside(directory, 'template.json'));
    return structuredClone(template);
  } catch (error) { rmSync(folder(id), { recursive: true, force: true }); throw error; }
}
export function getTemplate(id: string): SeriesTemplate {
  const directory = folder(id);
  const template = JSON.parse(readFileSync(resolveInside(directory, 'template.json'), 'utf8')) as SeriesTemplate;
  if (template.id !== id || template.schema_version !== 1 || !Array.isArray(template.references)) throw new ValidationError('Mẫu series không hợp lệ');
  projectAspect(template.config?.aspect);
  for (const ref of template.references) for (const file of ref.images) {
    if (!file.startsWith('images/')) throw new ValidationError('Ảnh mẫu phải nằm trong images/');
    resolveInside(directory, file);
  }
  return structuredClone(template);
}
export function listTemplates(): SeriesTemplate[] {
  if (!existsSync(root())) return [];
  return readdirSync(root()).sort().map(id => getTemplate(id));
}
export function deleteTemplate(id: string): boolean {
  const directory = folder(id);
  if (!existsSync(directory)) return false;
  rmSync(directory, { recursive: true });
  return true;
}
export function createProjectFromTemplate(db: DatabaseSync, templateId: string, options: { name: string }) {
  const template = getTemplate(templateId), directory = folder(templateId);
  // Validate all inputs before creating the destination project.
  for (const ref of template.references) for (const file of ref.images) image(resolveInside(directory, file));
  const project = createProject(db, options.name, template.config.aspect, null);
  try {
    if (template.bible) setBible(db, project.id, structuredClone(template.bible));
    for (const ref of template.references) createReference(db, { ...structuredClone(ref), project_id: project.id,
      images: ref.images.map(file => copyImage(resolveInside(directory, file), project.directory, 'refs')) });
    return project;
  } catch (error) {
    deleteProject(db, project.id);
    rmSync(assertInsideDataDir(project.directory, dataDirectory()), { recursive: true, force: true });
    throw error;
  }
}
