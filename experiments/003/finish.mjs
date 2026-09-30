import {act,getState,canvas} from './client.mjs';
const state=await getState();
const offsets={
 'mullet-front-sail':[1.66,7.80],
 'mullet-back-sail':[1.42,6.69],
 'mullet-front-fin':[-0.71,-3.35],
 'mullet-back-fin':[-1.18,-5.58],
 'observatory-column':[0,-8]
};
const actions=Object.entries(offsets).map(([pieceId,[dx,dy]])=>{const p=state.state.pieces.find(p=>p.id===pieceId);return {type:'transform',pieceId,x:p.x+dx,y:p.y+dy,scale:p.scale,rotation:p.rotation};});
actions.push({type:'describe',title:'The Tidal Observatory',statement:'A red mullet sails over an observatory built from fungal lace and Brooklyn Bridge masonry. An airship’s skin becomes its moon, while shell specimens drift beyond the chart. Two small figures hold the scene at human scale.'});
const result=await act(actions,'Close the small assembly gaps in the fish and tower, and give the completed work its title and statement.');
console.log(JSON.stringify({ok:result.ok,error:result.error,actions:result.state?.actionCount,pieces:result.state?.pieces.length,title:result.state?.title}));
if(result.ok)console.log(await canvas('final-inspection'));
