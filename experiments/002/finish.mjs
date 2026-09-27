import {act,exportWork} from './client.mjs';
const result=await act({
 type:'describe',
 title:'Rootstock for a Small Planet',
 statement:'An inverted tower supports a flower whose seed is Earth. A lunar shelf crosses the specimen like a soil section; the fine roots below it make architecture briefly behave like something that can grow.'
},'Give the finished specimen its title and artist statement.');
console.log(JSON.stringify({ok:result.ok,error:result.error,actions:result.state?.actionCount,pieces:result.state?.pieces.length}));
if(result.ok) console.log(JSON.stringify(await exportWork(),null,2));
