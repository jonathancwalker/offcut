import {act,canvas} from './client.mjs';
const a=[
 {type:'transform',pieceId:'lunar-shelf',x:500,y:887,rotation:-5,scale:0.55},
 {type:'transform',pieceId:'right-leaf',x:656,y:642,rotation:-20,scale:0.76},
 {type:'transform',pieceId:'earth-seed',x:520,y:305,rotation:-9,scale:1.02},
 {type:'cut',sourceId:'botanical',pieceId:'fine-roots',polygon:[[480,1237],[546,1237],[574,1260],[620,1280],[685,1370],[681,1406],[639,1375],[605,1320],[612,1418],[589,1418],[562,1355],[539,1415],[515,1396],[499,1340]]},
 {type:'place',pieceId:'fine-roots',x:520,y:1035,rotation:0,scale:0.98},
 {type:'reorder',pieceId:'fine-roots',index:2},
 {type:'reorder',pieceId:'lunar-shelf',index:9}
];
const result=await act(a,'Raise the soil line over the inverted tower, add surviving fine roots below it, and settle the blue seed deeper into its yellow cup.');
console.log(JSON.stringify({ok:result.ok,error:result.error,actions:result.state?.actionCount,pieces:result.state?.pieces.length}));
if(result.ok) console.log(await canvas('roots-below-soil'));
