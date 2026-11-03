'use strict';
module.exports=function saveGeneratedImage(data){
 const match=/^data:image\/(png|jpeg|webp|gif);base64,([a-z0-9+/=]+)$/i.exec(String(data||''));
 if(!match||data.length>8*1024*1024)throw Error('Image générée invalide ou trop volumineuse.');
 const fs=require('node:fs'),path=require('node:path'),directory=path.join(require('../config').CONFIG.dataDir,'generated-images');
 fs.mkdirSync(directory,{recursive:true});const file=path.join(directory,require('node:crypto').randomUUID()+'.'+(match[1]==='jpeg'?'jpg':match[1]));
 fs.writeFileSync(file,Buffer.from(match[2],'base64'),{mode:0o600});return file;
};
