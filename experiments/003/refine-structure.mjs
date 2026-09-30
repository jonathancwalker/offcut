import {act,canvas} from './client.mjs';
const result=await act([
 {type:'transform',pieceId:'printed-foundation',x:493,y:1000,scale:1.55,rotation:0},
 {type:'transform',pieceId:'lace-observatory',x:470,y:733,scale:1.15,rotation:0},
 {type:'transform',pieceId:'observatory-column',x:474,y:1020,scale:1.15,rotation:0},
 {type:'transform',pieceId:'bridge-pier-east',x:693,y:827,scale:1.43,rotation:0},
 {type:'transform',pieceId:'bridge-pier-west',x:263,y:1008,scale:1.9,rotation:0},
 {type:'cut',sourceId:'source-fad2f0a0-2c3',pieceId:'bridge-deck',polygon:[[572,241],[758,237],[758,274],[709,275],[659,285],[572,288]]},
 {type:'place',pieceId:'bridge-deck',x:483,y:974,scale:2.3,rotation:0},
 {type:'reorder',pieceId:'bridge-deck',index:2}
],'Raise and narrow the foundation for a full paper margin, then connect the masonry with a bridge deck.');
console.log(JSON.stringify({ok:result.ok,error:result.error,actions:result.state?.actionCount,pieces:result.state?.pieces.length}));
if(result.ok)console.log(await canvas('harbor-revised'));
