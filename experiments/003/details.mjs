import {act,canvas} from './client.mjs';
const A='source-3481817c-bec',S='source-b628863c-ec8';
const result=await act([
 {type:'cut',sourceId:A,pieceId:'observer-west',polygon:[[501,469],[513,471],[517,486],[531,490],[525,504],[520,530],[521,552],[517,586],[526,589],[526,595],[506,594],[506,562],[502,542],[495,589],[481,591],[485,536]]},
 {type:'place',pieceId:'observer-west',x:202,y:1042,scale:0.89,rotation:0},
 {type:'cut',sourceId:A,pieceId:'observer-east',polygon:[[675,482],[687,480],[691,492],[700,501],[700,523],[697,539],[702,587],[700,594],[689,593],[685,559],[681,542],[679,584],[668,584],[670,541],[665,513],[669,496]]},
 {type:'place',pieceId:'observer-east',x:774,y:1034,scale:1.04,rotation:0},
 {type:'cut',sourceId:S,pieceId:'shell-satellite-east',polygon:[[160,207],[171,224],[191,219],[206,229],[197,244],[205,251],[218,250],[207,263],[198,272],[197,287],[177,305],[164,316],[146,299],[143,278],[133,265],[140,240]]},
 {type:'place',pieceId:'shell-satellite-east',x:806,y:171,scale:1.06,rotation:24},
 {type:'cut',sourceId:S,pieceId:'shell-satellite-west',polygon:[[245,535],[277,530],[309,538],[319,547],[336,550],[332,563],[336,574],[313,580],[288,586],[253,580],[229,570],[220,553],[228,542]]},
 {type:'place',pieceId:'shell-satellite-west',x:154,y:696,scale:1.14,rotation:-29}
],'Add two human observers and two drifting shell specimens to give the imagined harbor a human scale.');
console.log(JSON.stringify({ok:result.ok,error:result.error,actions:result.state?.actionCount,pieces:result.state?.pieces.length}));
if(result.ok)console.log(await canvas('observers-and-satellites'));
