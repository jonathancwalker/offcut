import { startServer } from '../../server.mjs';
import { access, mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const directory=fileURLToPath(new URL('../../.data/experiment-003/',import.meta.url));
await mkdir(directory,{recursive:true});
try{await access(join(directory,'session.json'));}catch(error){if(error.code!=='ENOENT')throw error;await copyFile(fileURLToPath(new URL('./initial-project.json',import.meta.url)),join(directory,'session.json'));}
const app=await startServer({port:4319,dataDir:directory});
console.log('Independent worktable ready at http://127.0.0.1:4319');
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>app.close().then(()=>process.exit(0)));
