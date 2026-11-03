'use strict';
// Parcours manuel dans un dossier de démonstration, sans connexion personnelle.
const fs=require('node:fs'),path=require('node:path');
const profile=path.resolve(__dirname,'../../francestudent-ide-codex-data');
const folder=path.join(profile,'verification/capabilities');fs.mkdirSync(folder,{recursive:true});
process.env.FS_DATA_DIR=path.join(profile,'core');process.env.FS_STATE_DIR=path.join(profile,'state');process.env.FS_AGENT_ENGINE='codex';
const mcp=path.join(folder,'mcp.json');
fs.writeFileSync(mcp,JSON.stringify({mcpServers:{verification:{command:process.execPath,args:[path.resolve(__dirname,'../test/fixtures/fake-mcp-server.js')]}}}));process.env.FS_MCP_CONFIG=mcp;
const {state}=require('../src/state');
const entries=[];
const backend=require('../desktop/backend').createDesktopBackend((channel,data)=>{
 if(channel==='entry'){entries.push(data);if(['tool','assistant','error'].includes(data.type))console.log(data.type,data.type==='tool'?data.arg:data.text);}
 if(channel==='prompt'){
  // Autoriser uniquement l’écho du serveur de démonstration.
  const text=JSON.stringify(data);const accepted=text.includes('verification/echo')||text.includes('verification/capture');
  console.log('confirmation',accepted?'écho autorisé':'refusée');setImmediate(()=>backend.resolvePrompt(data.id,accepted?'o':'n'));
 }
});require('../src/ui-bridge').setUiBackend(backend);
state.workspace=folder;state.model=-2003;state.mode='agent';state.autoApprove=true;state.autoApproveCommands=true;
const scenario=process.argv[2]||'attachments';
if(scenario.startsWith('mcp'))state.autoApprove=false;
(async()=>{
 await require('../src/project/memory').open(folder);
 let task;
 if(scenario==='attachments'){
  const image=await require('sharp')(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="700" height="300"><rect width="700" height="300" fill="white"/><polygon points="80,180 160,40 240,180" fill="#f78112"/><rect x="400" y="60" width="210" height="120" fill="#174ad9"/><text x="190" y="260" font-family="Arial" font-size="40" fill="black">VISUEL 529</text></svg>')).png().toBuffer();
  state.pendingImages=[`data:image/png;base64,${image.toString('base64')}`];
  const archive=Buffer.from(require('fflate').zipSync({'note.txt':Buffer.from('Le code du document est DOCUMENT-638.'),'exclu.txt':Buffer.from('Ce fichier ne doit pas être sélectionné.')}));
  state.pendingFiles=[{name:'documents.zip',dataUrl:'data:application/zip;base64,'+archive.toString('base64'),selectedPaths:['note.txt']}];
  task='Examine l’image jointe : indique le texte visible, les deux formes et leurs couleurs. Puis lis note.txt dans la pièce jointe ZIP avec l’outil read_attachment et indique le code du document. Ne recherche pas ces fichiers sur le disque.';
 }else if(scenario==='documents'){
  const zip=require('fflate').zipSync;
  const docx=Buffer.from(zip({'[Content_Types].xml':Buffer.from('<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'),'word/document.xml':Buffer.from('<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>WORD-286</w:t></w:r></w:p></w:body></w:document>')}));
  const xlsx=require('xlsx'),book=xlsx.utils.book_new();xlsx.utils.book_append_sheet(book,xlsx.utils.aoa_to_sheet([['Code'],['TABLEUR-753']]),'Feuille');
  const sheet=xlsx.write(book,{type:'buffer',bookType:'xlsx'});
  const stream='BT /F1 24 Tf 45 100 Td (PDF-351) Tj ET';
  const objects=['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 500 200] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>','<< /Length '+stream.length+' >>\nstream\n'+stream+'\nendstream'];
  let pdf='%PDF-1.4\n';const offsets=[0];for(const [i,object]of objects.entries()){offsets.push(Buffer.byteLength(pdf));pdf+=(i+1)+' 0 obj\n'+object+'\nendobj\n';}const start=Buffer.byteLength(pdf);pdf+='xref\n0 6\n0000000000 65535 f \n'+offsets.slice(1).map(n=>String(n).padStart(10,'0')+' 00000 n \n').join('')+'trailer\n<< /Root 1 0 R /Size 6 >>\nstartxref\n'+start+'\n%%EOF';
  state.pendingFiles=[['note.docx',docx],['tableau.xlsx',sheet],['note.pdf',Buffer.from(pdf)]].map(([name,bytes])=>({name,dataUrl:'data:application/octet-stream;base64,'+bytes.toString('base64')}));
  task='Lis les trois pièces jointes Word, Excel et PDF. Donne le code présent dans chacun. Pour le PDF utilise read_attachment sur la page 1 avec visual:true afin de vérifier le texte visible. Ne cherche pas les originaux sur le disque.';
 }else if(scenario==='mcp')task='Utilise le connecteur MCP configuré verification, outil echo, avec le texte « MCP-472 ». Découvre son schéma si nécessaire, puis appelle-le réellement. Réponds avec son résultat.';
 else if(scenario==='mcp-image'){
  const image=await require('sharp')(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="600" height="220"><rect width="600" height="220" fill="white"/><circle cx="110" cy="100" r="70" fill="#12a237"/><text x="220" y="120" font-family="Arial" font-size="45" fill="black">CAPTURE 964</text></svg>')).png().toBuffer();
  const fixture=path.join(folder,'image-mcp.cjs');
  fs.writeFileSync(fixture,`const rl=require('node:readline').createInterface({input:process.stdin});rl.on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;let result;if(m.method==='initialize')result={protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'verification-image',version:'1'}};else if(m.method==='tools/list')result={tools:[{name:'capture',description:'Renvoie une image de démonstration',inputSchema:{type:'object',properties:{}}}]};else if(m.method==='tools/call')result={content:[{type:'image',mimeType:'image/png',data:${JSON.stringify(image.toString('base64'))}}]};else result={};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');});`);
  fs.writeFileSync(mcp,JSON.stringify({mcpServers:{verification:{command:process.execPath,args:[fixture]}}}));
  task='Appelle l’outil capture du connecteur MCP verification et examine l’image qu’il renvoie. Indique son texte visible et la forme colorée. Ne lis pas les fichiers du serveur sur le disque.';
 }
 else if(scenario==='subagent'){
  fs.writeFileSync(path.join(folder,'mission.txt'),'Le code à rapporter est DELEGATION-817.');
  task='Lance un sous-agent avec les outils de délégation pour lire mission.txt dans le dossier courant et te rapporter son code. Attends son résultat, ferme le sous-agent, puis donne son code. Ne lis pas toi-même mission.txt et ne remplace pas cette délégation par une commande dans l’agent principal.';
 }else throw Error('Parcours inconnu');
 backend.startRun(task);
 const deadline=Date.now()+180000;
 const result=await require('../src/agent/agent').runAgent(task,{shouldStop:()=>Date.now()>deadline});backend.endRun({ok:result.completed});
 const output={scenario,completed:result.completed,message:result.message,tools:entries.filter(e=>e.type==='tool').map(e=>({name:e.name,arg:e.arg,callId:e.callId})),entries,id:state.chatIds.agent};
 const expected={attachments:'DOCUMENT-638',documents:'PDF-351',mcp:'MCP-472','mcp-image':'CAPTURE 964',subagent:'DELEGATION-817'}[scenario];
 if(!result.completed||!result.message.includes(expected))throw Error('Le résultat attendu du parcours n’a pas été confirmé.');
 fs.writeFileSync(path.join(folder,scenario+'-result.json'),JSON.stringify(output,null,2));
 console.log(JSON.stringify({scenario,completed:result.completed,id:state.chatIds.agent,toolCount:output.tools.length}));
})().catch(error=>{console.error(error.stack);process.exitCode=1;}).finally(async()=>{require('../src/mcp/manager').manager.stopAll();await require('../src/agent/codex-runtime').stop();});
