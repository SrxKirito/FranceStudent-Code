'use strict';
// Serveur MCP local : accès aux pages publiques, sans cookies ni session navigateur.
const path=require('node:path');
const readline=require('node:readline');
const source=process.argv[2];
process.env.FS_DATA_DIR=process.argv[3];
process.env.FS_STATE_DIR=process.argv[3];
const {setUiBackend,UI_METHODS}=require(path.join(source,'src/ui-bridge'));
const quiet=Object.fromEntries(UI_METHODS.map(n=>[n,()=>{}]));
quiet.spinner=()=>({stop(){},update(){}});setUiBackend(quiet);
const {createPublicWeb,webToolSpecs}=require('./public-web');
const web=createPublicWeb(source);
const tools=webToolSpecs.map(t=>({...t,annotations:{readOnlyHint:true,destructiveHint:false,idempotentHint:true,openWorldHint:true}}));
const running=new Map();
const send=(id,result,error)=>process.stdout.write(JSON.stringify(error?{jsonrpc:'2.0',id,error}:{jsonrpc:'2.0',id,result})+'\n');
readline.createInterface({input:process.stdin,crlfDelay:Infinity}).on('line',async line=>{
 let m;try{m=JSON.parse(line);}catch{return;}
 if(m.method==='notifications/cancelled'){running.get(m.params?.requestId)?.abort();return;}
 if(m.id==null)return;
 try{
 if(m.method==='initialize')return send(m.id,{protocolVersion:m.params?.protocolVersion||'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'francestudent-public-web',version:'0.1.0'}});
 if(m.method==='ping')return send(m.id,{});
 if(m.method==='tools/list')return send(m.id,{tools});
 if(m.method!=='tools/call')return send(m.id,null,{code:-32601,message:'Méthode inconnue'});
 const controller=new AbortController();running.set(m.id,controller);
 try{
 const args=m.params.arguments||{};
 let result;
 if(m.params.name==='search')result=await web.search(args,{signal:controller.signal});
 else if(m.params.name==='fetch_page')result=await web.page(args,{signal:controller.signal});
 else throw Error('Outil inconnu');
 send(m.id,{content:[{type:'text',text:JSON.stringify(result)}],isError:result.denied===true||Number(result.status)>=400});
 }catch(e){send(m.id,{content:[{type:'text',text:e.message}],isError:true});}finally{running.delete(m.id);}
 }catch(e){send(m.id,null,{code:-32603,message:e.message});}
});
process.stdin.on('end',()=>{for(const c of running.values())c.abort();});
