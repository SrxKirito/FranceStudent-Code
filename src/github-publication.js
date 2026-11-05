"use strict";
const fs=require('node:fs/promises'),path=require('node:path'),crypto=require('node:crypto');
const github=require('./github'),security=require('./tools/security');
const READ_ACTIONS=['publication_status','publication_changes','publication_diff'];
const WRITE_ACTIONS=['prepare_publication','sync_publication','copy_publication_asset'];
const ACTIONS=new Set([...READ_ACTIONS,...WRITE_ACTIONS]);
const root=()=>path.resolve(require('./config').CONFIG.dataDir,'github-publications');
const sourceKey=workspace=>crypto.createHash('sha256').update(process.platform==='win32'?path.resolve(workspace).toLowerCase():path.resolve(workspace)).digest('hex');
const bindingFile=workspace=>path.join(root(),sourceKey(workspace)+'.json');
function repository(value){
 if(typeof value!=='string')throw Error('Dépôt GitHub obligatoire (owner/repo ou URL HTTPS).');
 let name=value.trim();
 if(name.startsWith('https://')){const url=new URL(name);if(url.hostname!=='github.com'||url.username||url.password||url.search||url.hash)throw Error('URL de dépôt GitHub invalide.');name=url.pathname.replace(/^\//,'').replace(/\/$/,'').replace(/\.git$/,'');}
 if(!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(name)||name.split('/').some(v=>v==='.'||v==='..'))throw Error('Dépôt GitHub invalide.');
 return name;
}
function managed(directory){const relative=path.relative(root(),path.resolve(directory||''));if(!relative||relative.startsWith('..')||path.isAbsolute(relative))throw Error('Copie de publication hors du répertoire géré.');return path.resolve(directory);}
async function binding(workspace,opts={}){
 let saved;try{saved=JSON.parse(await fs.readFile(bindingFile(workspace),'utf8'));}catch(e){if(e.code==='ENOENT')return null;throw e;}
 if(saved.source!==path.resolve(workspace))throw Error('Association de publication invalide.');
 managed(saved.directory);repository(saved.repository);
 await security.assertRealInside(root(),saved.directory);
 const remote=github.parseGithubRemote(await github.remoteUrl(saved.directory,'origin',opts));
 if(!remote||`${remote.owner}/${remote.repo}`.toLowerCase()!==saved.repository.toLowerCase())throw Error('Le dépôt de la copie de publication a changé.');
 return saved;
}
function allowed(relative,asset=false){
 const rel=security.normalizeRelative(relative),parts=rel.split('/');
 const sensitive=parts.some(v=>/^(?:\.env(?:\..*)?|\.npmrc|\.netrc|\.ssh|\.aws|\.azure|\.config|\.kube|\.git|\.frst|\.codex|\.local|node_modules|credentials.*|secrets.*|session\.json|history\.json|projects\.json|id_rsa|id_ed25519)$/i.test(v))||/\.(?:pem|key|pfx|p12)$/i.test(rel);
 const generated=parts.some(v=>/^(?:release|dist|build|coverage|vendor-effectcraft|backups|trash|library-cache|generated-images)$/i.test(v))||/\.(?:exe|ipa|apk|dmg|zip|asar|blockmap)$/i.test(rel);
 if(rel==='.'||sensitive||!asset&&generated)throw Error('Fichier sensible ou généré exclu de la copie des sources : '+rel);
 return rel;
}
async function prepare(workspace,args,opts){
 const requested=repository(args.repository),existing=await binding(workspace,opts);
 if(existing){if(existing.repository.toLowerCase()!==requested.toLowerCase()||args.branch&&args.branch!==existing.branch)throw Error('Une copie est déjà associée à un autre dépôt ou une autre branche.');return {...existing,reused:true,message:'Copie existante conservée ; utilise publication_changes puis sync_publication avec des fichiers explicites.'};}
 const {data:repo}=await github.request('GET',`${github.API}/repos/${requested.split('/').map(encodeURIComponent).join('/')}`,opts);
 const canonical=repository(repo.full_name),branch=args.branch||repo.default_branch;
 if(typeof branch!=='string'||!branch||branch.startsWith('-')||branch.length>200||/[\0\r\n]/.test(branch))throw Error('Branche de publication invalide.');
 await fs.mkdir(root(),{recursive:true});const directory=await fs.mkdtemp(path.join(root(),'checkout-'));
 const gitArgs=['clone','--no-local','--single-branch','--branch',branch,'--',`https://github.com/${canonical}.git`,directory];
 await github.runGit(root(),process.platform==='win32'?['-c','http.sslBackend=schannel',...gitArgs]:gitArgs,opts);
 const saved={source:path.resolve(workspace),directory,repository:canonical,branch,createdAt:new Date().toISOString()};
 await fs.writeFile(bindingFile(workspace),JSON.stringify(saved),{flag:'wx',mode:0o600});
 return {...saved,message:'Copie Git séparée créée depuis le dépôt distant. Aucun fichier du dossier source n’a été modifié ni copié. Examine publication_changes, puis choisis les paths de sync_publication. Aucun commit ni push effectué.'};
}
async function changes(workspace,saved,opts){
 const candidates=new Set((await github.runGit(saved.directory,['ls-files','-z'],opts)).split('\0').filter(Boolean));
 let visited=0,scanTruncated=false;
 async function walk(dir,rel=''){
  for(const item of await fs.readdir(dir,{withFileTypes:true})){
   const name=rel?rel+'/'+item.name:item.name;
   const absolute=path.resolve(dir,item.name);if(absolute===root()||absolute.startsWith(root()+path.sep))continue;
   try{allowed(name);}catch{continue;}
   if(item.isSymbolicLink())continue;
   if(++visited>10000){scanTruncated=true;return;}
   if(item.isDirectory())await walk(path.join(dir,item.name),name);else if(item.isFile())candidates.add(name);
   if(scanTruncated)return;
  }
 }
 await walk(workspace);
 const offset=argsOffset(opts.offset),rows=[];let found=0;
 for(const rel of candidates){
  try{allowed(rel);}catch{continue;}
  const src=await security.resolveInWorkspace(workspace,rel),dst=await security.resolveInWorkspace(saved.directory,rel);
  let left,right;try{left=await fs.stat(src.target);}catch(e){if(e.code!=='ENOENT')throw e;}
  try{right=await fs.stat(dst.target);}catch(e){if(e.code!=='ENOENT')throw e;}
  if(!left){if(right?.isFile()){if(found++>=offset&&rows.length<200)rows.push({path:rel,status:'absent_locally',message:'Conservé dans la copie ; aucune suppression automatique.'});}continue;}
  if(!left.isFile())continue;
  let status=!right?'new':null;
  if(left.size>8*1024*1024){status='large_file';}else if(right?.isFile()){
   if(right.size>8*1024*1024)status='modified';else{
    const text=bytes=>bytes.includes(0)?bytes:Buffer.from(bytes.toString('utf8').replace(/\r\n/g,'\n'));
    if(!text(await fs.readFile(src.target)).equals(text(await fs.readFile(dst.target))))status='modified';
   }
  }else if(right)status='conflict';
  if(status&&found++>=offset&&rows.length<200)rows.push({path:rel,status});
 }
 return {changes:rows,total:found,scanTruncated,next_offset:found>offset+rows.length?offset+rows.length:null,message:'Différences locales, pas une liste de fichiers autorisés à publier. Les fichiers absents localement sont conservés. Choisis des fichiers explicites et vérifie le diff avant commit.'};
}
function argsOffset(v){if(v===undefined)return 0;if(!Number.isSafeInteger(v)||v<0)throw Error('Décalage invalide.');return v;}
async function sync(workspace,saved,args,opts,asset=false){
 const paths=asset?[args.path]:args.paths;
 if(!Array.isArray(paths)||!paths.length||paths.length>200)throw Error('Choisis explicitement de 1 à 200 fichiers.');
 if((await github.runGit(saved.directory,['status','--porcelain'],opts)).trim())throw Error('La copie contient déjà des changements. Examine-les et traite-les avant une nouvelle copie.');
 const entries=[];let total=0;
 for(const value of [...new Set(paths)]){
  const rel=allowed(value,asset);
  const source=await security.resolveInWorkspace(workspace,rel);
  const stat=await fs.stat(source.target);
  if(!stat.isFile()||stat.size>(asset?1024*1024*1024:8*1024*1024))throw Error('Fichier non pris en charge ou trop volumineux : '+rel);
  total+=stat.size;if(total>(asset?1024*1024*1024:64*1024*1024))throw Error('Copie trop volumineuse.');
  // Assets are kept below an ignored release directory, never staged as sources.
  const destination=asset?'release/'+path.basename(rel):rel;
  const target=await security.resolveInWorkspace(saved.directory,destination);
  if(asset){try{await fs.lstat(target.target);throw Error('Le fichier de publication existe déjà.');}catch(e){if(e.code!=='ENOENT')throw e;}}
  entries.push({rel,source:source.target,destination,target:target.target});
 }
 if(asset){const ignore=path.join(saved.directory,'.git','info','exclude');const content=await fs.readFile(ignore,'utf8').catch(()=> '');if(!content.split(/\r?\n/).includes('/release/'))await fs.appendFile(ignore,'\n/release/\n');}
 const copied=[];
 try{for(const entry of entries){await security.assertRealInside(workspace,entry.source);await fs.mkdir(path.dirname(entry.target),{recursive:true});await security.assertRealInside(saved.directory,entry.target);if(asset)await fs.copyFile(entry.source,entry.target,require('node:fs').constants.COPYFILE_EXCL);
   else{const temporary=entry.target+'.frst-copy-'+crypto.randomUUID();try{
    const previous=await fs.stat(entry.target).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
    await fs.copyFile(entry.source,temporary,require('node:fs').constants.COPYFILE_EXCL);
    // Windows can report an unchanged size and coarse timestamp for a rapid copy;
    // ensure Git notices same-length edits instead of trusting its cached stat.
    const changedAt=new Date(Math.max(Date.now(),previous?.mtimeMs||0)+2000);
    await fs.utimes(temporary,changedAt,changedAt);
    await security.assertRealInside(saved.directory,entry.target);await fs.rename(temporary,entry.target);
   }finally{await fs.unlink(temporary).catch(()=>{});}}
   copied.push(entry.destination);}}
 catch(cause){throw new Error('Copie interrompue ; fichiers déjà copiés : '+copied.join(', ')+'. Inspecte publication_status avant de recommencer.',{cause});}
 return {copied,repository:saved.repository,branch:saved.branch,message:asset?'Fichier de release copié sous release/ et exclu de Git. Utilise upload_asset avec publication:true et le path retourné.':'Sources copiées sans suppression. Aucun commit ni push effectué. Examine publication_status puis commit et push avec publication:true.'};
}
async function execute(workspace,args,opts){
 if(!workspace)throw Error('Ouvre le dossier source.');
 if(args.action==='prepare_publication')return prepare(workspace,args,opts);
 const saved=await binding(workspace,opts);if(!saved)throw Error('Aucune copie associée. Utilise prepare_publication avec le dépôt explicite.');
 if(args.action==='publication_status')return {...saved,status:await github.runGit(saved.directory,['status','--short','--branch'],opts),diff:await github.runGit(saved.directory,['diff','--stat'],opts)};
 if(args.action==='publication_diff'){
  if(!Array.isArray(args.paths)||!args.paths.length||args.paths.length>100)throw Error('Choisis de 1 à 100 fichiers à examiner.');
  const files=args.paths.map(value=>allowed(value));
  const diff=await github.runGit(saved.directory,['diff','--no-ext-diff','--no-textconv','--',...files],opts);
  return {diff:diff.slice(0,100000),truncated:diff.length>100000,message:'Diff de fichiers déjà suivis ; les nouveaux fichiers sont à relire dans le dossier source avant leur ajout explicite.'};
 }
 if(args.action==='publication_changes')return changes(workspace,saved,{...opts,offset:args.offset});
 return sync(workspace,saved,args,opts,args.action==='copy_publication_asset');
}
module.exports={READ_ACTIONS,WRITE_ACTIONS,ACTIONS,execute,binding};
