'use strict';
const fs=require('node:fs'),path=require('node:path');
const ID=/^[a-f0-9-]{36}$/i;
class ConversationStore{
 constructor(directory){this.directory=directory;fs.mkdirSync(directory,{recursive:true});for(const c of this.list()){if(c.status==='running')this.update(c.id,{status:'interrupted',interruptedAt:new Date().toISOString()});}}
 file(id,suffix='.json'){if(!ID.test(String(id)))throw Error('Conversation invalide');return path.join(this.directory,id+suffix);}
 list(){return fs.readdirSync(this.directory).filter(n=>n.endsWith('.json')&&ID.test(n.slice(0,-5))).flatMap(n=>{try{return [JSON.parse(fs.readFileSync(path.join(this.directory,n),'utf8'))];}catch{return [];}}).sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt));}
 get(id){try{return JSON.parse(fs.readFileSync(this.file(id),'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}}
 update(id,fields){const previous=this.get(id);const at=new Date().toISOString();const value={createdAt:at,...previous,...fields,id,updatedAt:at};const target=this.file(id),temp=target+'.tmp';fs.writeFileSync(temp,JSON.stringify(value),{mode:0o600});fs.renameSync(temp,target);return value;}
 events(id){try{return fs.readFileSync(this.file(id,'.jsonl'),'utf8').split('\n').flatMap(l=>{try{return [JSON.parse(l)];}catch{return [];}});}catch(e){if(e.code==='ENOENT')return [];throw e;}}
 append(id,event){if(!this.get(id))return;fs.appendFileSync(this.file(id,'.jsonl'),JSON.stringify(event)+'\n',{mode:0o600});}
 importRollouts(directory){
  if(!fs.existsSync(directory))return;
  const visit=dir=>{for(const entry of fs.readdirSync(dir,{withFileTypes:true})){const file=path.join(dir,entry.name);if(entry.isSymbolicLink())continue;if(entry.isDirectory()){visit(file);continue;}if(!entry.name.endsWith('.jsonl')||fs.statSync(file).size>64*1024*1024)continue;
   let meta,events=[],status='interrupted';
   for(const line of fs.readFileSync(file,'utf8').split('\n')){let e;try{e=JSON.parse(line);}catch{continue;}
    if(e.type==='session_meta')meta=e.payload;
    if(e.type==='event_msg'&&e.payload?.type==='task_complete')status='completed';
    if(e.type!=='event_msg'||e.payload?.type!=='item_completed')continue;
    const native=e.payload.item,kind={UserMessage:'userMessage',AgentMessage:'agentMessage',CommandExecution:'commandExecution',FileChange:'fileChange',McpToolCall:'mcpToolCall'}[native?.type]||native?.type;
    if(!['userMessage','agentMessage','commandExecution','fileChange','mcpToolCall'].includes(kind))continue;
    const text=Array.isArray(native.content)?native.content.filter(c=>/^text$/i.test(c.type)).map(c=>c.text||'').join('\n'):String(native.text||'');
    const item={...native,type:kind,...(kind==='agentMessage'?{text}:kind==='userMessage'?{content:[{type:'text',text,text_elements:[]}]}:{}),aggregatedOutput:native.aggregatedOutput??native.aggregated_output,exitCode:native.exitCode??native.exit_code};
    events.push({method:'item/completed',params:{item},emittedAtMs:Date.parse(e.timestamp)});
   }
   const id=meta?.id||meta?.session_id;if(!ID.test(id||'')||this.get(id)||!meta.cwd||!events.length)continue;
   const first=events.find(e=>e.params.item.type==='userMessage')?.params.item.content[0].text||'Ancienne conversation';
   this.update(id,{cwd:meta.cwd,model:null,readOnly:false,title:first.replace(/\s+/g,' ').slice(0,100),status,legacyImported:true,createdAt:meta.timestamp||new Date().toISOString()});
   for(const e of events){e.params.threadId=id;this.append(id,e);}
  }};visit(directory);
 }
}
module.exports={ConversationStore};
