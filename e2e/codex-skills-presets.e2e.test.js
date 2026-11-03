'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {_electron}=require('playwright-core');
const electron=require('electron');
const root=path.resolve(__dirname,'..');
test('skills installés : domaines automatiques et filtre', {timeout:90000},async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'frst-skill-preset-e2e-'));
 const project=path.join(dir,'project'),skill=path.join(project,'.frst','skills','budget-qa');
 fs.mkdirSync(skill,{recursive:true});fs.writeFileSync(path.join(skill,'SKILL.md'),'---\nname: budget-qa\ndescription: Analyse de budget et finance\n---\n\nContrôle les totaux.\n');
 const harness=path.join(dir,'launch.cjs');
 fs.writeFileSync(harness,`const {app}=require('electron');app.setPath('userData',${JSON.stringify(path.join(dir,'electron'))});require(${JSON.stringify(path.join(root,'src/core/session'))}).bootstrap=async()=>({ok:true});require(${JSON.stringify(path.join(root,'src/api/agents'))}).listAgents=async()=>({agents:[],source:'local'});require(${JSON.stringify(path.join(root,'desktop/main.js'))});`);
 const app=await _electron.launch({executablePath:electron,args:[harness],cwd:root,env:{...process.env,FS_DATA_DIR:dir,FS_STATE_DIR:dir,FS_SKILLS_DIR:path.join(dir,'skills'),FS_CODEX_COPY_DATA:path.join(dir,'electron'),ELECTRON_DISABLE_SECURITY_WARNINGS:'1'},timeout:30000});
 try{
  const page=await app.firstWindow();await page.waitForFunction(async()=>(await window.frst.status()).booted);
  await page.evaluate(p=>window.frst.openProject(p),project);
  await page.locator('#codex-activity [data-action="plugins"]').click();
  await page.locator('[data-center-tab="installed"]').click();
  const card=page.locator('[data-skill-key="projet:budget-qa"]');await card.waitFor();
  assert.match(await card.innerText(),/finance/);
  await page.locator('#skills-filter').selectOption('domain:finance');assert.equal(await card.count(),1);
  await page.locator('#skills-filter').selectOption('domain:design');assert.equal(await card.count(),0);
 }finally{await app.close();}
});
