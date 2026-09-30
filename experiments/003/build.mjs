import { act, canvas, getState } from './client.mjs';
const S = { bridge:'source-fad2f0a0-2c3', fungi:'source-1ec2d5b8-8ca', shells:'source-b628863c-ec8', airship:'source-3481817c-bec', portrait:'source-73216d06-535', fish:'source-64c15ce7-cde' };
const batch = [
 {type:'cut',sourceId:S.airship,pieceId:'airship-moon',polygon:[[560,188],[552,230],[528,266],[492,290],[450,298],[408,290],[372,266],[348,230],[340,188],[348,146],[372,110],[408,86],[450,78],[492,86],[528,110],[552,146]]},
 {type:'place',pieceId:'airship-moon',x:515,y:423,scale:3,rotation:-7},
 {type:'cut',sourceId:S.shells,pieceId:'printed-foundation',polygon:[[480,452],[811,452],[811,610],[480,610]]},
 {type:'place',pieceId:'printed-foundation',x:493,y:1056,scale:1.9,rotation:0},
 {type:'cut',sourceId:S.bridge,pieceId:'bridge-pier-east',polygon:[[363,59],[394,50],[428,62],[442,98],[443,414],[351,414],[355,79]]},
 {type:'place',pieceId:'bridge-pier-east',x:693,y:852,scale:1.49,rotation:0},
 {type:'cut',sourceId:S.bridge,pieceId:'bridge-pier-west',polygon:[[513,202],[559,201],[568,249],[565,295],[513,296]]},
 {type:'place',pieceId:'bridge-pier-west',x:263,y:1004,scale:2.07,rotation:0},
 {type:'cut',sourceId:S.fungi,pieceId:'lace-observatory',polygon:[[310,250],[341,282],[349,309],[386,313],[392,339],[369,354],[426,420],[466,510],[482,592],[463,627],[166,627],[152,602],[162,524],[203,428],[276,350],[261,312]]},
 {type:'place',pieceId:'lace-observatory',x:470,y:767,scale:1.35,rotation:0},
 {type:'cut',sourceId:S.fungi,pieceId:'observatory-column',polygon:[[285,632],[346,632],[345,658],[365,686],[374,716],[349,741],[294,744],[267,722],[271,679]]},
 {type:'place',pieceId:'observatory-column',x:470,y:1097,scale:1.35,rotation:0}
];
const result = await act(batch,'Establish the dark moon, printed ground, bridge piers, and a lace observatory.');
console.log(JSON.stringify(result,null,2));
if(result.ok) console.log('CANVAS',await canvas('structure'));
