import { test } from 'node:test';
import assert from 'node:assert/strict';
import { temporaryDatabase } from './helpers.ts';
import { migrate } from '../src/migrations.ts';
import { createProject } from '../src/repo/projects.ts';
import { BibleService } from '../src/prompt/bible.ts';
import { listScenes } from '../src/repo/scenes.ts';
import { run } from '../src/cli.ts';

test('all five script CLI commands use temporary home and configured fake LLM', async t => {
  const db = temporaryDatabase(t); migrate(db);
  const project = createProject(db, 'CLI Script', '16:9', null);
  new BibleService(db).add(project.id, { name: 'Lan', kind: 'character', images: ['refs/lan.png'],
    description: 'Lan in blue', priority: 1 });
  const previous = [process.env.VIDFLOW_LLM, process.env.VIDFLOW_LLM_RESPONSES];
  t.after(() => {
    for (const [index, key] of ['VIDFLOW_LLM', 'VIDFLOW_LLM_RESPONSES'].entries()) {
      if (previous[index] === undefined) delete process.env[key]; else process.env[key] = previous[index];
    }
  });
  process.env.VIDFLOW_LLM = 'fake';
  const scenes = [{ sceneIndex: 1, durationSec: 5, description: '@Lan waves', dialogue: [{ speaker: 'Lan', text: 'Hello' }] }];
  const score = { score: 9, comment: 'Clear scene', issues: [] };
  async function command(args: string[], responses: unknown[] = []) {
    process.env.VIDFLOW_LLM_RESPONSES = JSON.stringify(responses.map(value => JSON.stringify(value)));
    let output = '', errors = '';
    const code = await run(['script', ...args], { stdout: { write(text: string) { output += text; return true; } },
      stderr: { write(text: string) { errors += text; return true; } } });
    assert.equal(code, 0, errors);
    return JSON.parse(output);
  }
  const [base] = await command(['generate', project.id, '--brief', 'Greeting'], [{ variants: [{ scenes }] }]);
  const reviews = await command(['score', base.id], [score]);
  assert.equal(reviews[0].score, 9);
  const revised = await command(['revise', base.id, '--feedback', 'Improve greeting'], [{ scenes }, score]);
  const versionId = revised.version.id;
  await command(['approve', base.id, versionId]);
  const rows = await command(['split', versionId]);
  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].charactersPresent, ['Lan']);
  assert.deepEqual(listScenes(db, project.id, versionId), rows);
});
