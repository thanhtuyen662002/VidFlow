import { test } from 'node:test';
import type { TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { migrate, migrations } from '../src/migrations.ts';
import { openDatabase } from '../src/db.ts';
import { createProject, deleteProject } from '../src/repo/projects.ts';
import * as scripts from '../src/repo/scripts.ts';
import * as scenes from '../src/repo/scenes.ts';
import * as chains from '../src/repo/chains.ts';
import * as renders from '../src/repo/renders.ts';
function fixture(t: TestContext, legacy = false) {
 const home=mkdtempSync(join(tmpdir(),'vidflow-')); const previous=process.env.VIDFLOW_HOME; process.env.VIDFLOW_HOME=home;
 const db=legacy ? new DatabaseSync(join(home,'vidflow.db')) : openDatabase(); if(legacy) { db.exec('PRAGMA foreign_keys=ON'); migrate(db,[migrations[0]]); } t.after(()=>{db.close(); if(previous===undefined) delete process.env.VIDFLOW_HOME; else process.env.VIDFLOW_HOME=previous; rmSync(home,{recursive:true,force:true});});
 const project=createProject(db,'Demo','16:9',null); return {db,project};
}
test('CRUD for every script, scene, chain, job, take and selection',t=>{
 const {db,project}=fixture(t);
 const script=scripts.createScriptVariant(db,{projectId:project.id,name:'A',beats:['opening']}); assert.deepEqual(scripts.getScriptVariant(db,script.id),script);
 const revised=scripts.updateScriptVariant(db,script.id,{content:'revised'}); assert.deepEqual(scripts.getScriptVariant(db,script.id),revised); assert.equal(revised?.content,'revised');
 const other=scripts.createScriptVariant(db,{projectId:project.id,name:'B'}); scripts.setActive(db,script.id); scripts.setActive(db,other.id); assert.equal(scripts.listByProject(db,project.id).filter(s=>s.isActive).length,1);
 const scene=scenes.createScene(db,{projectId:project.id,scriptVariantId:script.id,charactersPresent:['Hero']}); assert.deepEqual(scenes.getScene(db,scene.id),scene);
 const sceneUpdated=scenes.updateScene(db,scene.id,{title:'Opening',durationUsed:3}); assert.deepEqual(scenes.getScene(db,scene.id),sceneUpdated); assert.equal(sceneUpdated?.title,'Opening');
 const chain=chains.createChain(db,{projectId:project.id,name:'First'}); assert.deepEqual(chains.getChain(db,chain.id),chain);
 const chainUpdated=chains.updateChain(db,chain.id,{name:'Revised'}); assert.deepEqual(chains.getChain(db,chain.id),chainUpdated); assert.equal(chainUpdated?.name,'Revised');
 chains.addScene(db,chain.id,scene.id); assert.deepEqual(chains.listChainScenes(db,chain.id).map(r=>r.sceneId),[scene.id]); assert.equal(chains.removeScene(db,chain.id,scene.id),true);
 const job=renders.createRenderJob(db,{projectId:project.id,sceneId:scene.id,paramsJson:{seed:42}}); assert.deepEqual(renders.getRenderJob(db,job.id),job);
 const jobUpdated=renders.updateRenderJob(db,job.id,{prompt:'Updated'}); assert.deepEqual(renders.getRenderJob(db,job.id),jobUpdated); assert.equal(jobUpdated?.prompt,'Updated');
 for(const status of ['queued','running','succeeded','failed','cancelled'] as const) { renders.updateStatus(db,job.id,status); assert.equal(renders.getRenderJob(db,job.id)?.status,status); }
 assert.throws(()=>renders.updateStatus(db,job.id,'invalid' as never)); assert.throws(()=>db.prepare('UPDATE render_jobs SET status=? WHERE id=?').run('invalid',job.id));
 const take=renders.createTake(db,{renderJobId:job.id,sceneId:scene.id,file:'renders/take.mp4',durationSec:8}); assert.deepEqual(renders.getTake(db,take.id),take);
 const takeUpdated=renders.updateTake(db,take.id,{durationSec:7}); assert.deepEqual(renders.getTake(db,take.id),takeUpdated); assert.equal(takeUpdated?.durationSec,7);
 assert.deepEqual(renders.listByScene(db,scene.id),[takeUpdated]); assert.deepEqual(renders.listByJob(db,job.id),[takeUpdated]);
 const selection=renders.selectTake(db,scene.id,take.id); assert.deepEqual(renders.getSelection(db,selection.id),selection);
 const selUpdated=renders.updateSelection(db,selection.id,{in:1,out:5}); assert.deepEqual(renders.getSelection(db,selection.id),selUpdated); assert.equal(selUpdated?.in,1);
 assert.equal(renders.deleteSelection(db,selection.id),true); assert.equal(renders.getSelection(db,selection.id),undefined);
 assert.equal(renders.deleteTake(db,take.id),true); assert.equal(renders.getTake(db,take.id),undefined);
 assert.equal(renders.deleteRenderJob(db,job.id),true); assert.equal(renders.getRenderJob(db,job.id),undefined);
 assert.equal(chains.deleteChain(db,chain.id),true); assert.equal(chains.getChain(db,chain.id),undefined);
 assert.equal(scenes.deleteScene(db,scene.id),true); assert.equal(scenes.getScene(db,scene.id),undefined);
 assert.equal(scripts.deleteScriptVariant(db,script.id),true); assert.equal(scripts.getScriptVariant(db,script.id),undefined);
});
test('scene ordering, invalid reorder rollback and foreign keys',t=>{
 const {db,project}=fixture(t); const a=scenes.createScene(db,{projectId:project.id}); const b=scenes.createScene(db,{projectId:project.id}); const c=scenes.createScene(db,{projectId:project.id,index:1});
 assert.deepEqual(scenes.listScenes(db,project.id).map(s=>[s.id,s.index]),[[a.id,0],[c.id,1],[b.id,2]]);
 scenes.reorder(db,project.id,[b.id,a.id,c.id]); assert.deepEqual(scenes.listScenes(db,project.id).map(s=>s.id),[b.id,a.id,c.id]);
 assert.throws(()=>scenes.reorder(db,project.id,[a.id,a.id])); assert.deepEqual(scenes.listScenes(db,project.id).map(s=>s.id),[b.id,a.id,c.id]);
 scenes.deleteScene(db,a.id); assert.deepEqual(scenes.listScenes(db,project.id).map(s=>s.index),[0,1]);
 scenes.updateScene(db,c.id,{index:0}); assert.deepEqual(scenes.listScenes(db,project.id).map(s=>s.id),[c.id,b.id]);
 assert.throws(()=>scenes.createScene(db,{projectId:'missing'}));
 assert.throws(()=>db.prepare('INSERT INTO scenes(id,project_id,"index") VALUES (?,?,?)').run('bad','missing',0));
});
for(const target of ['scene','project'] as const) test(target+' deletion cascades all dependent rows; selection is current once',t=>{
 const {db,project}=fixture(t); const script=scripts.createScriptVariant(db,{projectId:project.id}); const scene=scenes.createScene(db,{projectId:project.id,scriptVariantId:script.id});
 const chain=chains.createChain(db,{projectId:project.id}); chains.addScene(db,chain.id,scene.id);
 const job=renders.createRenderJob(db,{projectId:project.id,sceneId:scene.id}); const one=renders.createTake(db,{sceneId:scene.id,renderJobId:job.id,file:'renders/one.mp4'}); const two=renders.createTake(db,{sceneId:scene.id,renderJobId:job.id,file:'renders/two.mp4'});
 renders.selectTake(db,scene.id,one.id); renders.selectTake(db,scene.id,two.id);
 assert.equal(db.prepare('SELECT COUNT(*) AS n FROM selections WHERE scene_id=? AND is_current=1').get(scene.id)!.n,1);
 assert.equal(renders.getCurrentSelection(db,scene.id)?.takeId,two.id);
 const other=scenes.createScene(db,{projectId:project.id}); assert.throws(()=>renders.selectTake(db,other.id,one.id)); assert.equal(renders.getCurrentSelection(db,scene.id)?.takeId,two.id); scenes.deleteScene(db,other.id);
 renders.clearSelection(db,scene.id); assert.equal(renders.getCurrentSelection(db,scene.id),undefined); renders.selectTake(db,scene.id,one.id);
 if(target==='scene') scenes.deleteScene(db,scene.id); else deleteProject(db,project.id);
 const tables=['scenes','takes','selections','render_jobs','chain_scenes',...(target==='project'?['script_variants','chains']:[])];
 for(const table of tables) assert.equal(db.prepare('SELECT COUNT(*) AS n FROM '+table).get()!.n,0,table);
});

test('account and asset deletion sets foreign keys null; paths stay contained',t=>{
 const {db,project}=fixture(t);
 db.prepare('INSERT INTO accounts(id,type,profile) VALUES (?,?,?)').run('account','Pro','profiles/account');
 db.prepare('INSERT INTO assets(id,project_id,type,file) VALUES (?,?,?,?)').run('asset',project.id,'video','renders/asset.mp4');
 const scene=scenes.createScene(db,{projectId:project.id}); const job=renders.createRenderJob(db,{projectId:project.id,sceneId:scene.id,accountId:'account'});
 const take=renders.createTake(db,{sceneId:scene.id,renderJobId:job.id,assetId:'asset',file:'renders/take.mp4'});
 db.prepare('DELETE FROM accounts WHERE id=?').run('account'); assert.equal(renders.getRenderJob(db,job.id)?.accountId,null);
 db.prepare('DELETE FROM assets WHERE id=?').run('asset'); assert.equal(renders.getTake(db,take.id)?.assetId,null);
 assert.throws(()=>renders.createTake(db,{sceneId:scene.id,renderJobId:job.id,file:'../escape.mp4'}));
 renders.selectTake(db,scene.id,take.id); renders.deleteRenderJob(db,job.id); assert.equal(renders.getTake(db,take.id),undefined); assert.equal(renders.getCurrentSelection(db,scene.id),undefined);
});

test('migration 2 preserves populated version 1 render and selection data', t=>{
 const {db,project}=fixture(t,true);
 db.prepare('INSERT INTO script_variants(id,project_id,logline) VALUES (?,?,?)').run('script',project.id,'Legacy story');
 db.prepare('INSERT INTO chains(id,project_id) VALUES (?,?)').run('chain',project.id);
 db.prepare('INSERT INTO scenes(id,project_id,script_variant_id,chain_id,"index") VALUES (?,?,?,?,?)').run('scene',project.id,'script','chain',4);
 db.prepare('INSERT INTO render_jobs(id,project_id,scene_id,type,model,prompt) VALUES (?,?,?,?,?,?)').run('job',project.id,'scene','video','fast','Legacy prompt');
 db.prepare('INSERT INTO takes(id,render_job_id,scene_id,file) VALUES (?,?,?,?)').run('take','job','scene','renders/legacy.mp4');
 db.prepare('INSERT INTO selections(id,scene_id,take_id,"out") VALUES (?,?,?,?)').run('selection','scene','take',8);
 migrate(db); migrate(db);
 assert.equal(scripts.getScriptVariant(db,'script')?.logline,'Legacy story');
 assert.equal(scenes.getScene(db,'scene')?.index,0);
 assert.deepEqual(chains.listChainScenes(db,'chain').map(r=>r.sceneId),['scene']);
 assert.equal(renders.getRenderJob(db,'job')?.status,'queued');
 assert.equal(renders.getCurrentSelection(db,'scene')?.takeId,'take');
 assert.equal(renders.getTake(db,'take')?.file,'renders/legacy.mp4');
 assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(),[]);
});
