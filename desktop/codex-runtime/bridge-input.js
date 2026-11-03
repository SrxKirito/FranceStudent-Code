'use strict';
const {createHash}=require('node:crypto');
const uploaded=new Map();
async function prepare(input,api) {
 const images=[],positions=new Map();
 const contentItem=value=>{
  if(!value||typeof value!=='object')return value;
  if(['input_image','image','inputImage'].includes(value.type)){
   const url=value.image_url?.url||value.image_url||value.url||value.imageUrl;
   if(typeof url!=='string'||!/^data:image\/[a-z0-9.+-]+;base64,/i.test(url))throw Error('Image non transmise : seule une image jointe ou un résultat visuel local est accepté.');
   if(url.length>36*1024*1024)throw Error('Image trop volumineuse.');
   const hash=createHash('sha256').update(url).digest('hex');
   if(!positions.has(hash)){positions.set(hash,images.length+1);images.push({hash,url});}
   return {type:'input_text',text:'[Image jointe '+positions.get(hash)+' — examiner les pixels transmis avec cette requête]'};
  }
  return value;
 };
 const context=input.map(item=>{
  if(item.type==='message'&&Array.isArray(item.content))return {...item,content:item.content.map(contentItem)};
  if(['function_call_output','custom_tool_call_output'].includes(item.type)&&Array.isArray(item.output))return {...item,output:item.output.map(contentItem)};
  return item;
 });
 if(images.length>20)throw Error('Vingt images maximum dans le contexte.');
 const ids=[];
 for(const [index,image]of images.entries()){
  let id=uploaded.get(image.hash);if(!id){id=await api.uploadImage(image.url,index);uploaded.set(image.hash,id);while(uploaded.size>100)uploaded.delete(uploaded.keys().next().value);}ids.push(id);
 }
 return {context,images:ids};
}
module.exports={prepare};
