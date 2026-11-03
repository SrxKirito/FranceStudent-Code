'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {collectImageReferences,collectGeneratedImages}=require('../src/api/generated-images');
const messageId='11111111-1111-4111-8111-111111111111',imageId='22222222-2222-4222-8222-222222222222';
test('une image du service dans parts/output est retrouvée sans utiliser son URL',()=>{
 const message={id:messageId,role:'assistant',parts:[{type:'tool-imageGeneration',input:{imageId:'33333333-3333-4333-8333-333333333333'},state:'output-available',output:{id:imageId,kind:'image',status:'COMPLETED',contentUrl:'https://example.invalid/private.png'}}]};
 assert.deepEqual(collectImageReferences(message),[{messageId,id:imageId}]);
 assert.deepEqual(collectGeneratedImages(message),[]);
 assert.deepEqual(collectImageReferences({...message,role:'user'}),[]);
});
test('une génération en attente ou une URL seule ne prouve pas une image terminée',()=>{
 assert.deepEqual(collectImageReferences({id:messageId,parts:[{type:'tool-imageGeneration',output:{id:imageId,kind:'image',status:'PENDING'}}]}),[]);
 assert.deepEqual(collectImageReferences({id:messageId,contentUrl:'https://example.invalid/'+imageId}),[]);
});
