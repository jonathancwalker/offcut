import {act,canvas} from './client.mjs';
const a=[
 {type:'transform',pieceId:'yellow-crown',x:272,y:246,rotation:-28,scale:0.97},
 {type:'transform',pieceId:'earth-seed',x:527,y:287,rotation:-18,scale:0.96},
 {type:'transform',pieceId:'left-leaf',x:326,y:553,rotation:16,scale:0.91},
 {type:'transform',pieceId:'right-leaf',x:671,y:652,rotation:-20,scale:0.83},
];
const add=(pieceId,sourceId,polygon,x,y,rotation=0,scale=1)=>a.push({type:'cut',sourceId,pieceId,polygon},{type:'place',pieceId,x,y,rotation,scale});
add('seed-cup','botanical',[[13,1195],[65,1195],[137,1233],[159,1175],[209,1134],[244,1130],[283,1159],[321,1233],[372,1195],[433,1191],[475,1227],[451,1300],[384,1350],[278,1384],[270,1454],[235,1459]],519,388,0,0.79);
add('flower-stem','botanical',[[518,209],[545,207],[602,402],[579,414],[557,344],[539,282]],398,349,-32,1.32);
a.push({type:'reorder',pieceId:'flower-stem',index:3},{type:'reorder',pieceId:'earth-seed',index:8});
const result=await act(a,'Join the floating forms into a specimen: cradle Earth in a cut flower, link the outlying bloom, and bring the leaves toward the tower.');
console.log(JSON.stringify({ok:result.ok,error:result.error,actions:result.state?.actionCount,pieces:result.state?.pieces.length}));
if(result.ok) console.log(await canvas('connected-specimen'));
