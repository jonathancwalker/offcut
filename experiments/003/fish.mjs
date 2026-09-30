import {act,canvas} from './client.mjs';
const sourceId='source-64c15ce7-cde';
const cuts=[
 ['red-mullet-body',[[143,287],[167,232],[201,207],[276,193],[374,198],[462,217],[588,234],[652,208],[695,205],[642,262],[694,314],[654,316],[588,282],[469,298],[284,307],[178,300]]],
 ['mullet-front-sail',[[278,189],[307,111],[320,132],[342,167],[365,188]]],
 ['mullet-back-sail',[[418,202],[459,152],[476,176],[508,217]]],
 ['mullet-front-fin',[[269,308],[320,310],[311,375],[289,349]]],
 ['mullet-back-fin',[[419,305],[446,302],[491,298],[480,330],[464,349],[443,344]]]
];
const scale=1.14,rotation=-12,rad=rotation*Math.PI/180,ca=Math.cos(rad),sa=Math.sin(rad);
let actions=[];
for(const [pieceId,polygon] of cuts){
 const xs=polygon.map(p=>p[0]),ys=polygon.map(p=>p[1]);
 const cx=(Math.min(...xs)+Math.max(...xs))/2,cy=(Math.min(...ys)+Math.max(...ys))/2;
 const dx=(cx-419)*scale,dy=(cy-245)*scale;
 actions.push({type:'cut',sourceId,pieceId,polygon},{type:'place',pieceId,x:465+dx*ca-dy*sa,y:342+dx*sa+dy*ca,scale,rotation});
}
const result=await act(actions,'Assemble a red mullet from five adjacent cuts, sailing across the airship moon.');
console.log(JSON.stringify({ok:result.ok,error:result.error,actions:result.state?.actionCount,pieces:result.state?.pieces.length}));
if(result.ok)console.log(await canvas('red-fish'));
