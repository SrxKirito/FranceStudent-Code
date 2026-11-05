"use strict";
const fs=require('node:fs/promises');
const READ_ACTIONS=['workflows','workflow','workflow_runs','workflow_run','workflow_jobs','job_annotations','artifacts','branches','tags','commits','compare','pull_request','pull_files','pull_checks','issue','comments','release','release_assets','list_files'];
const WRITE_ACTIONS=['dispatch_workflow','rerun_workflow','cancel_workflow','download_artifact','download_asset','download_logs','create_branch','create_tag','create_file','update_issue','update_pull_request','comment','merge_pull_request','update_release'];
const ACTIONS=new Set([...READ_ACTIONS,...WRITE_ACTIONS]);
function text(v,label='Valeur',max=1000){if(typeof v!=='string'||!v.trim()||v.length>max||v.includes('\0'))throw Error(label+' invalide.');return v;}
function id(v){if(!Number.isSafeInteger(Number(v))||Number(v)<1)throw Error('Identifiant invalide.');return Number(v);}
const seg=v=>encodeURIComponent(text(String(v??''),'Référence'));
const workflow=v=>typeof v==='number'?id(v):seg(text(v,'Workflow',200));
function query(a){const p=a.page??1,n=a.per_page??30;if(!Number.isSafeInteger(p)||p<1||!Number.isSafeInteger(n)||n<1||n>100)throw Error('Pagination invalide.');return new URLSearchParams({page:String(p),per_page:String(n)});}
const pick=(o,keys)=>Object.fromEntries(keys.filter(k=>o[k]!==undefined).map(k=>[k,o[k]]));
async function download(workspace,route,a,{token,fetchImpl}){
 const destination=text(a.path,'Destination relative');
 if(require('node:path').isAbsolute(destination)||require('node:path').win32.isAbsolute(destination)||destination.split(/[\\/]/).includes('..'))throw Error('Destination hors projet refusée.');
 const {target}=await require('./tools/security').resolveInWorkspace(workspace,destination);
 const file=await fs.open(target,'wx');let done=false;
 try{
  const f=fetchImpl||fetch,signal=require('./tools/action-control').signal()||AbortSignal.timeout(300000);
  const headers={Authorization:`Bearer ${token}`,Accept:'application/octet-stream','User-Agent':'francestudent-cli'};
  let r=await f('https://api.github.com'+route,{headers,signal,redirect:'manual'});
  for(let n=0;[301,302,303,307,308].includes(r.status);n++){
   const location=r.headers.get('location');await r.body?.cancel();if(!location||n>=4)throw Error('Redirection invalide.');
   const url=new URL(location,'https://api.github.com');
   if(url.protocol!=='https:'||url.username||url.password||!(url.hostname==='api.github.com'||url.hostname.endsWith('.githubusercontent.com')||url.hostname.endsWith('.blob.core.windows.net')||url.hostname.endsWith('.amazonaws.com')))throw Error('Destination de téléchargement refusée.');
   r=await f(url.href,{headers:url.origin==='https://api.github.com'?headers:{},signal,redirect:'manual'});
  }
  if(!r.ok||!r.body){await r.body?.cancel();throw Error(`Téléchargement refusé (HTTP ${r.status}).`);}
  let size=0;for await(const bytes of r.body){size+=bytes.length;if(size>1024*1024*1024)throw Error('Téléchargement supérieur à 1 Go.');await file.writeFile(bytes);}
  await file.close();done=true;return {path:a.path,size,message:'Archive enregistrée dans le projet, sans extraction ni écrasement.'};
 }finally{if(!done){await file.close().catch(()=>{});await fs.unlink(target).catch(()=>{});}}
}
async function execute(workspace,a,{api,base,token,fetchImpl}){
 const get=p=>api('GET',base+p),write=(method,p,body)=>api(method,base+p,body),q=()=>query(a);
 switch(a.action){
 case 'workflows':{const r=await get('/actions/workflows?'+q());return {total_count:r.total_count,workflows:r.workflows.map(w=>pick(w,['id','name','path','state','html_url']))};}
 case 'workflow':return get('/actions/workflows/'+workflow(a.workflow));
 case 'dispatch_workflow':{
  const ref=text(a.ref,'Branche ou tag',200),inputs=a.inputs??{};
  if(!inputs||typeof inputs!=='object'||Array.isArray(inputs)||Object.keys(inputs).length>25||JSON.stringify(inputs).length>30000||Object.values(inputs).some(v=>!['string','boolean','number'].includes(typeof v)||typeof v==='number'&&!Number.isFinite(v)))throw Error('Entrées du workflow invalides.');
  const r=await write('POST',`/actions/workflows/${workflow(a.workflow)}/dispatches`,{ref,inputs});
  return {dispatched:true,ref,workflow:a.workflow,...(r?pick(r,['workflow_run_id','run_url','html_url']):{}),message:'Déclenchement accepté. Compilation et publication non confirmées. Consulte workflow_runs, workflow_run et workflow_jobs ; vérifie head_sha. Ne redéclenche pas automatiquement.'};
 }
 case 'workflow_runs':{const params=q();for(const k of ['branch','event','status','head_sha'])if(a[k]!==undefined)params.set(k,text(a[k],k,200));const r=await get((a.workflow?`/actions/workflows/${workflow(a.workflow)}/runs`:'/actions/runs')+'?'+params);return {total_count:r.total_count,runs:r.workflow_runs.map(r=>pick(r,['id','name','event','status','conclusion','head_sha','head_branch','run_number','run_attempt','created_at','html_url']))};}
 case 'workflow_run':return pick(await get(`/actions/runs/${id(a.id)}`),['id','name','event','status','conclusion','head_sha','head_branch','run_number','run_attempt','created_at','updated_at','html_url']);
 case 'workflow_jobs':{const r=await get(`/actions/runs/${id(a.id)}/jobs?${q()}`);return {total_count:r.total_count,jobs:r.jobs.map(j=>({...pick(j,['id','name','status','conclusion','runner_name','html_url']),steps:j.steps.map(s=>pick(s,['name','number','status','conclusion']))}))};}
 case 'job_annotations':{const r=await get(`/check-runs/${id(a.id)}/annotations?${q()}`);return r.map(v=>({...pick(v,['path','start_line','end_line','annotation_level','title']),message:String(v.message||'').slice(0,5000)}));}
 case 'rerun_workflow':await write('POST',`/actions/runs/${id(a.id)}/${a.failed_only===true?'rerun-failed-jobs':'rerun'}`);return {requested:true,message:'Relance demandée. Vérifie workflow_run ; ne répète pas automatiquement.'};
 case 'cancel_workflow':await write('POST',`/actions/runs/${id(a.id)}/cancel`);return {requested:true,message:'Annulation demandée. Vérifie workflow_run.'};
 case 'artifacts':{const r=await get((a.id?`/actions/runs/${id(a.id)}/artifacts`:'/actions/artifacts')+'?'+q());return {total_count:r.total_count,artifacts:r.artifacts.map(v=>pick(v,['id','name','size_in_bytes','digest','expired','created_at','workflow_run']))};}
 case 'download_artifact':return download(workspace,base+`/actions/artifacts/${id(a.id)}/zip`,a,{token,fetchImpl});
 case 'download_logs':return download(workspace,base+`/actions/runs/${id(a.id)}/logs`,a,{token,fetchImpl});
 case 'download_asset':return download(workspace,base+`/releases/assets/${id(a.id)}`,a,{token,fetchImpl});
 case 'branches':case 'tags':{const r=await get('/'+a.action+'?'+q());return {items:r.map(v=>({...pick(v,['name','protected']),sha:v.commit?.sha}))};}
 case 'commits':{const params=q();if(a.ref)params.set('sha',text(a.ref));const r=await get('/commits?'+params);return {commits:r.map(c=>({sha:c.sha,message:String(c.commit?.message||'').slice(0,16000),url:c.html_url}))};}
 case 'compare':{const r=await get(`/compare/${seg(a.base)}...${seg(a.head)}?${q()}`);return {...pick(r,['status','ahead_by','behind_by','total_commits','html_url']),files:r.files?.slice(0,100).map(f=>pick(f,['filename','status','additions','deletions']))};}
 case 'create_branch':case 'create_tag':{const sha=text(a.sha,'SHA',40);if(!/^[a-f0-9]{40}$/i.test(sha))throw Error('SHA complet obligatoire.');const name=text(a.branch??a.tag,'Nom',200);if(!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(name)||name.includes('..')||name.includes('//')||name.endsWith('/')||name.endsWith('.lock'))throw Error('Nom de référence invalide.');return write('POST','/git/refs',{ref:`refs/${a.action==='create_branch'?'heads':'tags'}/${name}`,sha});}
 case 'list_files':{const parts=a.path?text(a.path,'Chemin').split('/'):[];if(parts.some(p=>!p||p==='.'||p==='..')||a.path?.includes('\\'))throw Error('Chemin distant invalide.');const r=await get('/contents/'+parts.map(seg).join('/')+(a.ref?'?ref='+seg(a.ref):''));if(!Array.isArray(r))throw Error('Ce chemin n’est pas un dossier. Utilise read_file.');return {entries:r.slice(0,100).map(v=>pick(v,['name','path','type','size','sha','html_url'])),truncated:r.length>100};}
 case 'create_file':{text(a.path,'Chemin');const parts=a.path.split('/');if(parts.some(p=>!p||p==='.'||p==='..')||a.path.includes('\\'))throw Error('Chemin invalide.');if(typeof a.content!=='string'||a.content.length>1000000)throw Error('Contenu invalide.');return write('PUT','/contents/'+parts.map(seg).join('/'),{message:text(a.message,'Message'),branch:text(a.branch,'Branche'),content:Buffer.from(a.content).toString('base64')});}
 case 'pull_request':{const r=await get(`/pulls/${id(a.id)}`);return {...pick(r,['number','title','state','draft','mergeable','mergeable_state','merged','html_url']),body:String(r.body||'').slice(0,16000),head:r.head?{ref:r.head.ref,sha:r.head.sha}:null,base:r.base?{ref:r.base.ref,sha:r.base.sha}:null};}
 case 'pull_files':{const r=await get(`/pulls/${id(a.id)}/files?${q()}`);return r.map(f=>({...pick(f,['filename','status','additions','deletions','sha']),patch:String(f.patch||'').slice(0,6000)}));}
 case 'pull_checks':{const pr=await get(`/pulls/${id(a.id)}`);const r=await get(`/commits/${seg(pr.head.sha)}/check-runs?${q()}`);return {total_count:r.total_count,checks:r.check_runs.map(c=>({...pick(c,['id','name','status','conclusion','details_url']),summary:String(c.output?.summary||'').slice(0,4000)}))};}
 case 'issue':{const r=await get(`/issues/${id(a.id)}`);return {...pick(r,['number','title','state','html_url']),body:String(r.body||'').slice(0,16000)};}
 case 'comments':{const r=await get(`/issues/${id(a.id)}/comments?${q()}`);return r.map(c=>({...pick(c,['id','created_at','html_url']),body:String(c.body||'').slice(0,5000)}));}
 case 'comment':return write('POST',`/issues/${id(a.id)}/comments`,{body:text(a.body,'Commentaire',60000)});
 case 'update_issue':case 'update_pull_request':{const body={};if(a.title!==undefined)body.title=text(a.title,'Titre',300);if(a.body!==undefined){if(typeof a.body!=='string'||a.body.length>60000)throw Error('Description invalide.');body.body=a.body;}if(a.state!==undefined){if(!['open','closed'].includes(a.state))throw Error('État invalide.');body.state=a.state;}if(!Object.keys(body).length)throw Error('Aucun changement demandé.');return write('PATCH',`/${a.action==='update_issue'?'issues':'pulls'}/${id(a.id)}`,body);}
 case 'merge_pull_request':{const sha=text(a.sha,'SHA de la PR',40);if(!/^[a-f0-9]{40}$/i.test(sha)||!['merge','squash','rebase'].includes(a.merge_method))throw Error('SHA ou méthode de fusion invalide.');return write('PUT',`/pulls/${id(a.id)}/merge`,{sha,merge_method:a.merge_method});}
 case 'release':return get(a.tag?`/releases/tags/${seg(a.tag)}`:`/releases/${id(a.id)}`);
 case 'release_assets':return get(`/releases/${id(a.id)}/assets?${q()}`);
 case 'update_release':{const current=await get(`/releases/${id(a.id)}`);if(!current.draft)throw Error('Seul un brouillon est modifiable par cette action.');const body={};if(a.title!==undefined)body.name=text(a.title,'Titre',300);if(a.body!==undefined){if(typeof a.body!=='string'||a.body.length>60000)throw Error('Notes invalides.');body.body=a.body;}if(a.prerelease!==undefined)body.prerelease=a.prerelease===true;return write('PATCH',`/releases/${id(a.id)}`,body);}
 default:throw Error('Action complémentaire inconnue.');
 }
}
module.exports={READ_ACTIONS,WRITE_ACTIONS,ACTIONS,execute};
