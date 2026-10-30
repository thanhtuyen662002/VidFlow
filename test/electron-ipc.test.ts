import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { createCoreService } from '../src/service/index.ts';
import { createIpcHandlers, registerIpc } from '../src/app/ipc.ts';
import { getSecureWebPreferences } from '../src/app/main.ts';
import { createProgressForwarder } from '../src/app/progress.ts';
import { createProgressSource } from '../src/service/progress.ts';
import { temporaryDatabase } from './helpers.ts';
import { migrate } from '../src/migrations.ts';

function setup(t) {
 const db = temporaryDatabase(t); migrate(db);
 return createCoreService({ db, llm: { complete: async () => { throw Error('unused'); } }, flowDriver: { run: async () => { throw Error('unused'); } } });
}
test('IPC validates before service execution and preserves service results', async t => {
 const service = setup(t), calls = [];
 const handlers = createIpcHandlers({ listCommands: service.listCommands, execute: async (name, input) => { calls.push([name,input]); return {ok:true,data:input}; } });
 for (const [channel,input] of [['project:create',{name:'Garden',aspect:'16:9'}],['bible:update',{projectId:'p',fields:{style:'film'}}],['render:status',{planId:'r'}]]) {
  assert.deepEqual(await handlers.handleInvoke(channel,input),{ok:true,data:input});
  assert.deepEqual(calls.at(-1),[channel.replace(':','.'),input]);
 }
 for(const input of [{},{name:42,aspect:'16:9'},{name:'Garden',aspect:'16:9',extra:true},null,[],42]) {
  const before=calls.length, result=await handlers.handleInvoke('project:create',input);
  assert.equal(result.error.code,'VALIDATION_ERROR'); assert.ok(result.error.issues.length); assert.equal(calls.length,before);
 }
 assert.equal((await handlers.handleInvoke('missing',{})).error.code,'UNKNOWN_COMMAND');
 const real=createIpcHandlers(service);
 const created=await real.handleInvoke('project:create',{name:'IPC project',aspect:'16:9'});
 assert.equal(created.ok,true); assert.equal(created.data.name,'IPC project');
 const failed=createIpcHandlers({...service,execute:async()=>{throw Error('secret stack');}});
 assert.deepEqual(await failed.handleInvoke('project:list',{}),{ok:false,error:{code:'INTERNAL_ERROR',message:'Command could not be completed'}});
 const missing=await real.handleInvoke('project:get',{projectId:'missing'});
 assert.equal(missing.error.code,'NOT_FOUND'); assert.equal('stack' in missing.error,false);
 const wired=new Map();const dispose=registerIpc({handle:(c,h)=>wired.set(c,h),removeHandler:c=>wired.delete(c)},service,()=>false);
 assert.equal(wired.get('project:list')({},{}).error.code,'FORBIDDEN');dispose();assert.equal(wired.size,0);
});
test('secure preferences and sandbox preload expose exactly service commands', async t => {
 const prefs=getSecureWebPreferences();
 for(const key of ['contextIsolation','sandbox','webSecurity']) assert.equal(prefs[key],true);
 assert.equal(prefs.nodeIntegration,false);
 const service=setup(t), invocations=[], listeners=new Map();let api;
 runInNewContext(readFileSync('src/app/preload.cjs','utf8'),{require:name=>{
  assert.equal(name,'electron');return {contextBridge:{exposeInMainWorld:(key,value)=>{assert.equal(key,'vidflow');api=value;}},ipcRenderer:{invoke:(...args)=>{invocations.push(args);return Promise.resolve({ok:true,data:42});},on:(c,l)=>listeners.set(c,l),removeListener:(c,l)=>{assert.equal(listeners.get(c),l);listeners.delete(c);}}};
 }});
 const exposed=Object.entries(api).filter(([g])=>g!=='onRenderProgress').flatMap(([g,methods])=>Object.keys(methods).map(m=>`${g}.${m}`));
 assert.deepEqual(exposed.sort(),service.listCommands().map(c=>c.name).sort());
 assert.deepEqual(Object.keys(api).sort(),[...new Set(service.listCommands().map(c=>c.name.split('.')[0])),'onRenderProgress'].sort());
 for(const name of exposed){const [g,m]=name.split('.');await api[g][m]({});assert.equal(invocations.at(-1)[0],name.replace('.',':'));}
 let received;const stop=api.onRenderProgress(p=>received=p),payload={jobId:'j'};listeners.get('render:progress')({secret:'event'},payload);assert.equal(received,payload);stop();assert.equal(listeners.size,0);
});
test('progress is shaped and stops after unsubscribe',()=>{
 const source=createProgressSource(), sent=[];
 const stop=createProgressForwarder(source,(...args)=>sent.push(args));
 const payload={jobId:'j',shotId:'s',chainId:'c',take:2,status:'running',percent:50,message:'token=secret',timestamp:'2026-10-30T00:00:00Z'};
 source.emit(payload); assert.deepEqual(sent,[['render:progress',{...payload,message:'running'}]]);
 source.emit({...payload,status:'invalid'});assert.equal(sent.length,1);
 stop();source.emit(payload);assert.equal(sent.length,1);
});
