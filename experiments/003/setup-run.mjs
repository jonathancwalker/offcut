import { mkdir, writeFile, access } from 'node:fs/promises';
import { randomInt, randomUUID, createHash } from 'node:crypto';
import { createState } from '../../lib/engine.mjs';
const base='http://127.0.0.1:4317';
try { await access('experiments/003/initial-project.json'); throw new Error('This run is already initialized; never redraw its materials.'); } catch(error) { if(error.code!=='ENOENT')throw error; }
const project=await(await fetch(base+'/api/project')).json();
if(project.sources.length<6)throw Error('Need at least six source images.');
const candidates=project.sources.map(({dataUrl,...metadata})=>({...metadata,sha256:createHash('sha256').update(Buffer.from(dataUrl.split(',')[1],'base64')).digest('hex')}));
const pool=[...project.sources];const draws=[];const sources=[];
for(let draw=0;draw<6;draw++){
 const index=randomInt(pool.length);const source=pool.splice(index,1)[0];
 draws.push({draw:draw+1,remainingPoolSize:pool.length+1,index,sourceId:source.id});sources.push(source);
}
const createdAt=new Date().toISOString();const id=randomUUID();
const initialState=createState({id,sources,rules:{maxPieces:24,maxActions:120}});
const initial={format:'offcut-project',version:1,id,createdAt,updatedAt:createdAt,sources:initialState.sources,canvas:initialState.canvas,rules:initialState.rules,actions:[],cursor:0};
await mkdir('.data/experiment-003',{recursive:true});
await writeFile('.data/experiment-003/session.json',JSON.stringify(initial));
await writeFile('.data/experiment-003/main-before.json',JSON.stringify(project));
await writeFile('experiments/003/initial-project.json',JSON.stringify(initial,null,2));
const selected=candidates.filter(s=>sources.some(t=>t.id===s.id));
const setup={createdAt,kind:'fresh-context-codex-subagent',forkTurns:'none',modelOverride:null,exactModelId:null,selection:{method:'Six uniform crypto.randomInt draws without replacement; no rerolls.',candidateCount:candidates.length,candidates,draws,selectedIds:sources.map(s=>s.id),selectedHashes:Object.fromEntries(selected.map(s=>[s.id,s.sha256]))},constraints:{canvas:initial.canvas,rules:initial.rules,maxActionsPerBatch:12,maxBatches:12,modelCallTokenLimit:null,wallClockLimit:null},mainProjectSha256:createHash('sha256').update(JSON.stringify(project)).digest('hex')};
await writeFile('experiments/003/setup.json',JSON.stringify(setup,null,2));
console.log(JSON.stringify({sourceCount:sources.length,sources:sources.map(s=>({id:s.id,name:s.name,width:s.width,height:s.height})),startingActions:initial.cursor}));
