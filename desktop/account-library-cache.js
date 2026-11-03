'use strict';
const fs=require('node:fs/promises'),path=require('node:path'),{createHash,randomUUID}=require('node:crypto');
const {CONFIG}=require('../src/config');
const hash=value=>createHash('sha256').update(value).digest('hex');
const TTL=30*24*60*60*1000,MAX=64*1024*1024;
async function owner(){
 if(require('../src/state').state.incognito)return null;
 const auth=require('../src/api/auth');if(auth.auth.signedOut)return null;
 const token=await auth.getAccessToken();let identity;
 try{const payload=JSON.parse(Buffer.from(token.split('.')[1],'base64url'));identity=payload.sub??payload.userId??payload.id??payload.email;}catch{}
 if(identity==null)return null;
 return hash(CONFIG.apiUrl+'\0'+String(identity));
}
function directory(scope){if(!/^[a-f0-9]{64}$/.test(scope))throw Error('Profil de cache invalide.');return path.join(CONFIG.dataDir,'library-cache',scope);}
function file(scope,kind,key){return path.join(directory(scope),kind+'-'+hash(String(key))+'.json');}
async function read(scope,kind,key){
 if(!scope)return null;
 try{const target=file(scope,kind,key),stat=await fs.stat(target);if(stat.size>16*1024*1024||Date.now()-stat.mtimeMs>TTL)return null;return JSON.parse(await fs.readFile(target,'utf8')).value;}catch{return null;}
}
async function write(scope,kind,key,value){
 if(!scope||scope!==await owner())return;
 const text=JSON.stringify({value});if(Buffer.byteLength(text)>16*1024*1024)return;
 const dir=directory(scope);await fs.mkdir(dir,{recursive:true});const target=file(scope,kind,key),temp=target+'.'+randomUUID()+'.tmp';
 await fs.writeFile(temp,text,{mode:0o600});await fs.rename(temp,target);
 const entries=await Promise.all((await fs.readdir(dir)).filter(name=>/^(?:page|image)-[a-f0-9]{64}\.json$/.test(name)).map(async name=>{const entry=path.join(dir,name),stat=await fs.stat(entry);return {entry,...stat};}));
 let size=entries.reduce((sum,entry)=>sum+entry.size,0);
 for(const entry of entries.sort((a,b)=>a.mtimeMs-b.mtimeMs))if(size>MAX||Date.now()-entry.mtimeMs>TTL){await fs.unlink(entry.entry).catch(()=>{});size-=entry.size;}
}
async function clearPages(scope){if(!scope)return;const dir=directory(scope);for(const name of await fs.readdir(dir).catch(()=>[]))if(/^page-[a-f0-9]{64}\.json$/.test(name))await fs.unlink(path.join(dir,name)).catch(()=>{});}
module.exports={owner,read,write,clearPages};
