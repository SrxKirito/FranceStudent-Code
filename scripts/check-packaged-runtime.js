'use strict';
// Démarre le vrai pont depuis le paquet, sans node ni codex dans le PATH.
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawn}=require('node:child_process');
const http=require('node:http');
const executable=path.resolve(process.argv[2]||'');
if(!fs.existsSync(executable))throw Error('Exécutable empaqueté absent : '+executable);
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'frst-packaged-smoke-'));
const code=`const p=require('node:path');const r=require(p.join(process.resourcesPath,'app.asar/src/agent/codex-runtime'));r.ensure().then(async c=>{await c.request('/economy');console.log('Pont Codex empaqueté démarré');await r.stop()}).catch(e=>{console.error(e.message);process.exitCode=1});`;
const server=http.createServer((req,res)=>{res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({accessToken:'local-test-token',expiresIn:300}));});
server.listen(0,'127.0.0.1',()=>{
 const origin=`http://127.0.0.1:${server.address().port}`;
 const env={...process.env,ELECTRON_RUN_AS_NODE:'1',FS_SESSION_TOKEN:'local-test-cookie',FS_ORIGIN:origin,FS_API_URL:origin,FS_DATA_DIR:path.join(temp,'data'),FS_STATE_DIR:path.join(temp,'state'),FS_CODEX_COPY_DATA:path.join(temp,'profile'),HOME:temp,USERPROFILE:temp,PATH:process.platform==='win32'?path.join(process.env.SystemRoot||'C:\\Windows','System32'):'/usr/bin:/bin'};
 delete env.CODEX_BINARY;delete env.FS_CODEX_NODE_BINARY;
 const child=spawn(executable,['-e',code],{env,windowsHide:true,stdio:['ignore','pipe','pipe']});let out='',err='';
 child.stdout.on('data',x=>out+=x);child.stderr.on('data',x=>err+=x);
 const timer=setTimeout(()=>{child.kill();console.error('Délai de démarrage dépassé.');process.exitCode=1;server.close();},90000);
 child.on('error',error=>{clearTimeout(timer);console.error(error.message);process.exitCode=1;server.close();});
 child.on('exit',status=>{clearTimeout(timer);server.close();if(out)process.stdout.write(out);if(err)process.stderr.write(err);if(status!==0||!out.includes('Pont Codex empaqueté démarré')){console.error('Le moteur embarqué ne démarre pas.');process.exitCode=1;}});
});
