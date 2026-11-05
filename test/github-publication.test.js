"use strict";
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),fsp=require('node:fs/promises'),os=require('node:os'),path=require('node:path'),cp=require('node:child_process');
const base=fs.mkdtempSync(path.join(os.tmpdir(),'frst-publication-'));process.env.FS_DATA_DIR=path.join(base,'data');
const source=path.join(base,'source'),template=path.join(base,'remote');fs.mkdirSync(source);fs.mkdirSync(template);
function git(dir,args){return cp.execFileSync('git',args,{cwd:dir,encoding:'utf8',windowsHide:true});}
git(template,['init','-b','main']);git(template,['config','user.name','Test']);git(template,['config','user.email','test@example.invalid']);git(template,['remote','add','origin','https://github.com/example/project.git']);fs.writeFileSync(path.join(template,'app.js'),'original\n');git(template,['add','app.js']);git(template,['commit','-m','Initial']);
fs.writeFileSync(path.join(source,'app.js'),'modified\n');fs.writeFileSync(path.join(source,'.env'),'SECRET');fs.mkdirSync(path.join(source,'release'));fs.writeFileSync(path.join(source,'release','setup.exe'),'artifact');
const gh=require('../src/github'),connector=require('../src/github-connector');const old=gh.getToken;gh.getToken=()=> 'fake';
const deps={fetchImpl:async()=>Response.json({full_name:'example/project',default_branch:'main'}),execFileImpl:(file,args,options,cb)=>{const n=args.indexOf('clone');if(n>=0){fsp.cp(template,args.at(-1),{recursive:true}).then(()=>cb(null,'','')).catch(cb);}else cp.execFile(file,args,options,cb);}};
test.after(()=>{gh.getToken=old;fs.rmSync(base,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
test('copie séparée : sources intactes, choix explicite, pas de secrets ni de commit implicite',async()=>{
 const result=await connector.execute(source,{action:'prepare_publication',repository:'https://github.com/example/project.git'},deps);
 assert.equal(fs.existsSync(path.join(source,'.git')),false);assert.notEqual(result.directory,source);
 const compare=await connector.execute(source,{action:'publication_changes'},deps);
 assert.deepEqual(compare.changes.map(r=>r.path),['app.js']);
 await assert.rejects(connector.execute(source,{action:'sync_publication',paths:['.env']},deps),/sensible/);
 await assert.rejects(connector.execute(source,{action:'sync_publication',paths:['release/setup.exe']},deps),/généré/);
 const before=git(result.directory,['rev-parse','HEAD']).trim();
 await connector.execute(source,{action:'sync_publication',paths:['app.js']},deps);
 assert.equal(fs.readFileSync(path.join(result.directory,'app.js'),'utf8'),'modified\n');
 assert.equal(git(result.directory,['rev-parse','HEAD']).trim(),before);
 const status=await connector.execute(source,{action:'publication_status'},deps);assert.match(status.status,/app.js/);
 const diff=await connector.execute(source,{action:'publication_diff',paths:['app.js']},deps);assert.match(diff.diff,/modified/);
 await assert.rejects(connector.execute(source,{action:'sync_publication',paths:['app.js']},deps),/déjà des changements/);
 await assert.rejects(connector.execute(source,{action:'prepare_publication',repository:'example/other'},deps),/autre dépôt/);
 git(result.directory,['add','app.js']);git(result.directory,['commit','-m','Change']);
 const asset=await connector.execute(source,{action:'copy_publication_asset',path:'release/setup.exe'},deps);
 assert.deepEqual(asset.copied,['release/setup.exe']);assert.equal(git(result.directory,['status','--porcelain']).trim(),'');
 assert.equal(fs.readFileSync(path.join(source,'app.js'),'utf8'),'modified\n');
 assert.equal(fs.existsSync(path.join(source,'.git')),false);
});
test('les chemins externes et les dépôts enrichis d’identifiants sont refusés',async()=>{
 await assert.rejects(connector.execute(source,{action:'prepare_publication',repository:'https://token@github.com/example/project.git'},deps),/invalide/);
 await assert.rejects(connector.execute(source,{action:'sync_publication',paths:['../outside']},deps));
});
