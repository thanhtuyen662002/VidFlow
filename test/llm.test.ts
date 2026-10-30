import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { temporaryDatabase } from './helpers.ts';
import { migrate } from '../src/migrations.ts';
import { listScriptVariants } from '../src/repo/scripts.ts';
import { CliLlm, MockLlm, SAMPLE_SCRIPT, SCRIPT_SCHEMA, validateSchema, generateValidated,
  LlmCliError, LlmValidationExhaustedError, redact } from '../src/script/llm/index.ts';

test('retry bad JSON and schema, persist valid content once with feedback', async t => {
  temporaryDatabase(t);
  const persisted: unknown[] = [];
  const llm = new MockLlm(['bad JSON', '{}', request => {
    assert.match(request.prompt, /Required property missing/);
    return '```json\n' + JSON.stringify(SAMPLE_SCRIPT) + '\n```';
  }]);
  const result = await generateValidated({ llm, schema: SCRIPT_SCHEMA, prompt: 'Write', persist: value => { persisted.push(value); } });
  assert.equal(result.attempts, 3); assert.equal(llm.calls, 3);
  assert.deepEqual(persisted, [SAMPLE_SCRIPT]); assert.deepEqual(result.value, SAMPLE_SCRIPT);
});

test('exhaustion is typed and leaves the real script store empty', async t => {
  const db = temporaryDatabase(t); migrate(db);
  let writes = 0;
  await assert.rejects(generateValidated({ llm: new MockLlm(['{}']), schema: SCRIPT_SCHEMA, prompt: 'Write',
    maxAttempts: 2, persist: () => { writes++; } }), error => {
    assert.ok(error instanceof LlmValidationExhaustedError); assert.equal(error.attempts, 2);
    assert.ok(error.errors.length); return true;
  });
  assert.equal(writes, 0); assert.deepEqual(listScriptVariants(db, 'missing'), []);
  assert.equal(db.prepare('SELECT count(*) AS n FROM script_variants').get()!.n, 0);
});

test('validator keywords, nested paths, nullable and type arrays', t => {
  temporaryDatabase(t);
  const cases: [unknown, Parameters<typeof validateSchema>[1]][] = [
    [[], { type: 'object' }], [{}, { type: 'array' }], [1, { type: 'string' }],
    ['1', { type: 'number' }], [1.5, { type: 'integer' }], [0, { type: 'boolean' }], [false, { type: 'null' }],
    [{}, { required: ['x'] }], [{ x: 1 }, { additionalProperties: false }],
    [[false], { items: { type: 'string' } }], ['x', { enum: ['y'] }],
    ['', { minLength: 1 }], ['ab', { maxLength: 1 }], [0, { minimum: 1 }], [2, { maximum: 1 }],
    [[], { minItems: 1 }], [[1, 2], { maxItems: 1 }],
  ];
  for (const [value, schema] of cases) assert.equal(validateSchema(value, schema).valid, false);
  for (const type of ['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'] as const) {
    const value = { object: {}, array: [], string: '', number: 1.5, integer: 1, boolean: true, null: null }[type];
    assert.equal(validateSchema(value, { type }).valid, true);
  }
  assert.equal(validateSchema(null, { type: 'string', nullable: true }).valid, true);
  assert.equal(validateSchema(null, { type: ['string', 'null'] }).valid, true);
  const nested = validateSchema({ scenes: [{ title: 3 }] }, { properties: { scenes: { items: { properties: { title: { type: 'string' } } } } } });
  assert.equal(nested.errors[0].path, '$.scenes[0].title');
  assert.equal(validateSchema(SAMPLE_SCRIPT, SCRIPT_SCHEMA).valid, true);
});

test('CLI preserves arguments and stdin; reports redacted exits, timeout, abort and size limits', async t => {
  temporaryDatabase(t);
  const file = join(process.env.VIDFLOW_HOME!, 'fake-cli.cjs');
  writeFileSync(file, `const mode=process.argv[2]; let input=''; process.stdin.on('data', c=>input+=c); process.stdin.on('end',()=>{
    if(mode==='fail'){process.stderr.write(input+' '+process.env.FAKE_TOKEN);process.exitCode=7;}
    else if(mode==='wait'){if(process.argv[3])require('node:fs').writeFileSync(process.argv[3],String(process.pid));setInterval(()=>{},1000);}
    else if(mode==='large'){process.stdout.write('x'.repeat(10000));}
    else process.stdout.write(JSON.stringify({args:process.argv.slice(3),input}));
  });`);
  const arg = `spaces \"quotes\" ; & |`;
  const result = await new CliLlm({ command: process.execPath, args: [file, 'ok', arg] }).complete({ prompt: arg });
  assert.deepEqual(JSON.parse(result.text), { args: [arg], input: arg });
  const token = 'private-test-value'; const logs: string[] = [];
  await assert.rejects(new CliLlm({ command: process.execPath, args: [file, 'fail'], env: { FAKE_TOKEN: token },
    logger: line => logs.push(line) }).complete({ prompt: token }), error => {
    assert.ok(error instanceof LlmCliError); assert.equal(error.exitCode, 7);
    assert.ok(!error.message.includes(token)); assert.ok(!error.stderr.includes(token)); return true;
  });
  assert.ok(logs.length); assert.ok(logs.every(line => !line.includes(token)));
  const pidFile = join(process.env.VIDFLOW_HOME!, 'child.pid');
  await assert.rejects(new CliLlm({ command: process.execPath, args: [file, 'wait', pidFile], timeoutMs: 1500 }).complete({ prompt: '' }),
    (e: unknown) => e instanceof LlmCliError && e.code === 'LLM_TIMEOUT');
  assert.ok(existsSync(pidFile), 'fake CLI started before timeout');
  assert.throws(() => process.kill(Number(readFileSync(pidFile, 'utf8')), 0), { code: 'ESRCH' });
  await assert.rejects(new CliLlm({ command: process.execPath, args: [file, 'large'], maxOutputBytes: 100 }).complete({ prompt: '' }),
    (e: unknown) => e instanceof LlmCliError && e.code === 'LLM_OUTPUT_LIMIT');
  const controller = new AbortController();
  const pending = new CliLlm({ command: process.execPath, args: [file, 'wait'] }).complete({ prompt: '', signal: controller.signal });
  controller.abort();
  await assert.rejects(pending, (e: unknown) => e instanceof LlmCliError && e.code === 'LLM_ABORTED');
});

test('redact masks secret forms and environment values', t => {
  temporaryDatabase(t);
  for (const source of ['api_key=private', 'token: private', '"secret":"private"', 'password=private',
    'Authorization: Bearer private', 'sk-private', 'a'.repeat(40), 'private']) {
    assert.ok(!redact(source, { CUSTOM_KEY: 'private' }).includes('private'));
  }
});

test('surrounded JSON succeeds immediately and attempt limits reject invalid configuration', async t => {
  temporaryDatabase(t);
  const result = await generateValidated({ llm: new MockLlm([`Here: ${JSON.stringify(SAMPLE_SCRIPT)} end`]), schema: SCRIPT_SCHEMA, prompt: '' });
  assert.equal(result.attempts, 1);
  for (const maxAttempts of [0, 11, 1.5]) await assert.rejects(generateValidated({ llm: new MockLlm(), schema: SCRIPT_SCHEMA, prompt: '', maxAttempts }), RangeError);
});
