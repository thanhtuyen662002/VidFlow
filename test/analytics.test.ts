import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { temporaryDatabase } from './helpers.ts';
import { migrate } from '../src/migrations.ts';
import { createScene } from '../src/repo/scenes.ts';
import { createRenderJob, createTake, createSelection } from '../src/repo/renders.ts';
import { buildTimelineFromSelectedTakes } from '../src/edit/timeline.ts';
import { importAnalyticsCsv, acceptProposal, rejectProposal, listProposals, ProposalConflictError } from '../src/script/analytics.ts';
import { getWeights } from '../src/script/weights.ts';
import { parseAnalyticsCsv, parseTimestamp, normalizePercentage, CsvImportError } from '../src/script/analytics-csv.ts';
const fixture = (name: string) => new URL(`./fixtures/analytics/${name}`, import.meta.url);

test('timestamps and percentages, BOM, CRLF, quotes and aggregated errors', () => {
  for (const [s, n] of [['12.5',12.5],['01:02',62],['1:02:03',3723]] as const) assert.equal(parseTimestamp(s), n);
  for (const s of ['', 'abc', '-1', '1:60', '1:2:3:4']) assert.ok(Number.isNaN(parseTimestamp(s)));
  for (const [s,n] of [['90',.9],['0.9',.9],['90%',.9],['1%',.01],['0',0],['100',1]] as const) assert.equal(normalizePercentage(s),n);
  for (const s of ['', '-1', '101', 'NaN']) assert.ok(Number.isNaN(normalizePercentage(s)));
  assert.deepEqual(parseAnalyticsCsv('\uFEFFTimestamp,RETENTION\r\n"00:00","100%"\r\n1,0.9\r\n').map(s=>s.retention), [1,.9]);
  for (const [name, lines] of [['wrong-header.csv',[1]],['bad-timestamp.csv',[2]],['out-of-range.csv',[2]],['wrong-fields.csv',[2]]] as const) {
    assert.throws(()=>parseAnalyticsCsv(readFileSync(fixture(name),'utf8')), e => {
      assert.ok(e instanceof CsvImportError); assert.deepEqual(e.issues.map(i=>i.line),lines);
      for (const line of lines) assert.match(e.message, new RegExp(`\\b${line}:`));
      assert.ok(e.issues.every(i=>i.message.includes(`Dòng ${i.line}`))); return true;
    });
  }
  assert.throws(()=>parseAnalyticsCsv('timestamp,retention\n0,100\n0,99\nabc,no\n-1,200'), e => {
    assert.ok(e instanceof CsvImportError); assert.deepEqual(e.issues.map(i=>i.line),[3,4,4,5,5]); return true;
  });
  assert.throws(()=>parseAnalyticsCsv(''), CsvImportError);
});

test('real timeline report; proposals persist, accept atomically, reject and conflict', t => {
  const db = temporaryDatabase(t); migrate(db);
  const directory = join(process.env.VIDFLOW_HOME!, 'projects', 'p'); mkdirSync(directory,{recursive:true});
  db.prepare('INSERT INTO projects(id,name,aspect,directory,created_at) VALUES (?,?,?,?,?)').run('p','Sample','16:9',directory,'now');
  const sample = JSON.parse(readFileSync(fixture('timeline.json'),'utf8'));
  for (const item of sample.scenes) {
    const scene = createScene(db,{projectId:'p',title:item.title,beat:item.beat,durationUsed:99});
    const job = createRenderJob(db,{projectId:'p',sceneId:scene.id});
    const take = createTake(db,{sceneId:scene.id,renderJobId:job.id,file:join(directory,'take.mp4'),durationSec:20});
    createSelection(db,{sceneId:scene.id,takeId:take.id,in:2,out:2+item.duration});
  }
  const timeline = buildTimelineFromSelectedTakes(db,'p'), path = join(directory,'analytics.csv');
  copyFileSync(fixture('sample-retention.csv'),path);
  const before = getWeights(db,'p');
  const result = importAnalyticsCsv(db,'p',timeline.id,path);
  assert.deepEqual(result.report.filter(b=>b.flagged).map(b=>b.name),sample.flaggedBeats);
  assert.equal(result.report[0].start,10); assert.equal(result.report[0].end,20);
  assert.ok(Math.abs(result.report[0].dropRate! - 45/95)<1e-12);
  assert.equal(result.mappedSamples[1].beatId,result.report[0].id);
  assert.equal(result.mappedSamples[1].sceneId,result.report[0].sceneIds[0]);
  assert.equal(result.mappedSamples.at(-1)!.beatId,null); assert.ok(result.warnings.length);
  assert.equal(result.proposal.status,'pending'); assert.notDeepEqual(result.proposal.proposedWeights,before);
  assert.deepEqual(getWeights(db,'p'),before); assert.equal(listProposals(db,'p').length,1);
  const other = importAnalyticsCsv(db,'p',timeline.id,path).proposal;
  acceptProposal(db,result.proposal.id);
  assert.deepEqual(getWeights(db,'p'),result.proposal.proposedWeights);
  assert.throws(()=>acceptProposal(db,result.proposal.id),ProposalConflictError);
  assert.throws(()=>acceptProposal(db,other.id),ProposalConflictError);
  rejectProposal(db,other.id); assert.throws(()=>acceptProposal(db,other.id),ProposalConflictError);
  assert.deepEqual(getWeights(db,'p'),result.proposal.proposedWeights);
  copyFileSync(fixture('bad-timestamp.csv'),path);
  assert.throws(()=>importAnalyticsCsv(db,'p',timeline.id,path),CsvImportError);
  assert.equal(listProposals(db,'p').length,2);
});

test('analytics modules have no network clients', () => {
  for (const name of ['analytics.ts','analytics-csv.ts','weights.ts']) {
    const source = readFileSync(new URL(`../src/script/${name}`,import.meta.url),'utf8');
    assert.doesNotMatch(source,/\bfetch\s*\(|node:https?|axios|undici|XMLHttpRequest/);
  }
});
