'use strict';
const path=require('node:path');
const {fork,execFileSync}=require('node:child_process');
const {randomBytes}=require('node:crypto');
const {CONFIG}=require('../config');
let starting=null,child=null,client=null;
async function ensure(){
 if(client)return client;if(starting)return starting;
 starting=new Promise((resolve,reject)=>{
  const root=path.resolve(__dirname,'../..'),script=path.join(root,'desktop/codex-runtime/server.js'),key=randomBytes(32).toString('hex');
  const packaged=!!(process.versions.electron&&process.resourcesPath&&root.includes('app.asar'));
  let node;try{node=process.env.FS_CODEX_NODE_BINARY||(packaged?process.execPath:execFileSync(process.platform==='win32'?'where.exe':'which',['node'],{encoding:'utf8',windowsHide:true}).trim().split(/\r?\n/)[0]);}catch{reject(Error('Node.js est nécessaire pour le moteur Codex en développement.'));return;}
  const bundled=packaged?path.join(process.resourcesPath,'codex','bin',process.platform==='win32'?'codex.exe':'codex'):null;
  child=fork(script,[],{execPath:node,execArgv:['--use-system-ca'],cwd:packaged?process.resourcesPath:root,windowsHide:true,stdio:['ignore','pipe','pipe','ipc'],env:{...process.env,...(packaged?{ELECTRON_RUN_AS_NODE:'1',CODEX_BINARY:bundled}:{}),FRANCESTUDENT_SOURCE:root,FS_CODEX_PORT:'0',FS_CODEX_CLIENT_KEY:key,FS_CODEX_RUNTIME_DIR:path.join(CONFIG.dataDir,'codex-runtime'),FS_CODEX_APP_DATA_DIR:CONFIG.dataDir,FS_CODEX_APP_STATE_DIR:require('../project/projects').STATE_DIR}});
  const timer=setTimeout(()=>{child?.kill();reject(Error('Le moteur Codex ne démarre pas. Vérifie la connexion et le binaire Codex.'));},90000);
  child.stdout.resume();child.stderr.resume();
  child.on('message',m=>{if(m?.type==='startupError'){clearTimeout(timer);reject(Error(m.message));}if(m?.type==='ready'){
   clearTimeout(timer);const base='http://127.0.0.1:'+m.port,headers={Origin:base,'x-francestudent-client':key};
   client={async request(route,data){const r=await fetch(base+route,{method:data===undefined?'GET':'POST',headers:{...headers,'Content-Type':'application/json'},...(data===undefined?{}:{body:JSON.stringify(data)})});const v=await r.json();if(!r.ok)throw Error(v.error||'Erreur du moteur Codex');return v;},async events(signal,callback){const r=await fetch(base+'/events',{headers,signal});if(!r.ok)throw Error('Flux Codex indisponible');const decoder=new TextDecoder();let buffer='';for await(const chunk of r.body){buffer+=decoder.decode(chunk,{stream:true});let end;while((end=buffer.indexOf('\n\n'))>=0){const block=buffer.slice(0,end);buffer=buffer.slice(end+2);if(block.startsWith('data: '))await callback(JSON.parse(block.slice(6)));}}}};
   resolve(client);
  }});
  child.on('error',e=>{clearTimeout(timer);reject(e);});child.on('exit',()=>{clearTimeout(timer);client=null;starting=null;child=null;reject(Error('Le moteur Codex a été arrêté.'));});
 }).catch(e=>{starting=null;throw e;});return starting;
}
async function stop(){const target=child;if(!target)return;await new Promise(resolve=>{const timer=setTimeout(()=>{target.kill();resolve();},1500);target.once('exit',()=>{clearTimeout(timer);resolve();});try{target.send({type:'shutdown'});}catch{clearTimeout(timer);target.kill();resolve();}});}
module.exports={ensure,stop};
