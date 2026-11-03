'use strict';
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const {spawn}=require('node:child_process');
const root=path.resolve(__dirname,'..'),profile=path.resolve(root,'../francestudent-ide-codex-data');
const core=path.join(profile,'core'),state=path.join(profile,'state');
fs.mkdirSync(core,{recursive:true});fs.mkdirSync(state,{recursive:true});
const destination=path.join(core,'session.json');
// Import initial des connexions Code de l’IDE, jamais du profil de Codex desktop.
// Les données restent locales ; une configuration déjà présente est conservée.
const previousCore=path.join(os.homedir(),'.francestudent-cli');
for(const name of ['mcp.json','github.json']){
 const from=path.join(previousCore,name),to=path.join(core,name);
 if(!fs.existsSync(to)&&fs.existsSync(from)){
  const value=JSON.parse(fs.readFileSync(from,'utf8'));
  if(name!=='github.json'||value.secret)fs.copyFileSync(from,to,fs.constants.COPYFILE_EXCL);
 }
}
const previousSkills=path.join(previousCore,'skills'),copySkills=path.join(core,'skills');
if(!fs.existsSync(copySkills)&&fs.existsSync(previousSkills))fs.cpSync(previousSkills,copySkills,{recursive:true,filter:file=>!fs.lstatSync(file).isSymbolicLink()});
if(!fs.existsSync(destination)){
 const candidates=[path.resolve(root,'../francestudent-codex-prototype/.local/france/session.json'),path.join(os.homedir(),'.francestudent-cli/session.json')];
 const source=candidates.find(f=>fs.existsSync(f));
 if(source){const session=JSON.parse(fs.readFileSync(source,'utf8'));if(session.cookies){const storage=require('../src/secret-storage');const secret=storage.protect(JSON.stringify(session.cookies));if(!secret)throw Error('Le coffre système est indisponible. Connecte-toi depuis la copie.');delete session.cookies;session.protectedCookies=secret;}fs.writeFileSync(destination,JSON.stringify(session),{mode:0o600});}
}
const executable=require('electron');
const env={...process.env,FS_CODEX_COPY_DATA:profile,FS_DATA_DIR:core,FS_STATE_DIR:state,FS_AGENT_ENGINE:process.env.FS_AGENT_ENGINE||'codex'};
if(!env.NODE_EXTRA_CA_CERTS){const tls=require('node:tls');const certificates=tls.getCACertificates?.('system')||[];if(certificates.length){const file=path.join(profile,'system-ca.pem');fs.writeFileSync(file,certificates.join('\n'));env.NODE_EXTRA_CA_CERTS=file;}}
delete env.ELECTRON_RUN_AS_NODE;
const child=spawn(executable,[path.join(root,'desktop/main.js')],{cwd:root,env,windowsHide:false,stdio:'inherit'});
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill());
child.on('error',e=>{console.error(e.message);process.exitCode=1;});child.on('exit',code=>{process.exitCode=code||0;});
