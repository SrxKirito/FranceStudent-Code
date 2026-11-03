'use strict';
// Aperçu isolé des vrais composants : aucun compte, aucune commande ni requête modèle.
const fs=require('node:fs'),path=require('node:path'),http=require('node:http');
const root=path.resolve(__dirname,'../desktop/renderer'),read=name=>fs.readFileSync(path.join(root,'src',name),'utf8');
const shared=read('46-shared-surfaces.js'),extensions=read('22-extension-center.js'),rail=read('62-codex-layout.js');
const setup=`
const $=id=>document.getElementById(id),input=$('input'),transcript=$('transcript');
const ui={workspace:'C:/Exemples/MonProjet',status:{busy:false,mode:'agent',booted:true,workspace:'C:/Exemples/MonProjet'},quota:{percent:28},quotaUpdatedAt:new Date().toISOString(),sideView:'explorer',history:[],historyIndex:0};
let pendingAttachments=[],toolGroup=null,transcriptFollowing=true,requestFileChanges=new Map(),requestDiffPreviews=new Map(),studioEntries=[],studioWorkspace=ui.workspace,studioActivitySeq=0,studioTab='conversation',localBrowserState=null;
const localBrowserPanel=$('local-browser-panel');
let franceStudentProjects=[];const installed={roblox:false,blender:false};const codexActivity=document.createElement('nav');$('agent').append(codexActivity);
const api={onEvent:()=>{},agentTools:async()=>({groups:[{id:'files',label:'Fichiers',description:'Lire et modifier le projet'},{id:'terminal',label:'Terminal',description:'Exécuter les commandes'},{id:'skills',label:'Skills',description:'Méthodes de travail'},{id:'web',label:'Web',description:'Rechercher sur Internet'},{id:'mcp',label:'Connexions',description:'Services MCP'}]}),motionConversation:async mode=>({mode}),githubStatus:async()=>({connected:false}),creativePlugins:async(action,kind)=>{if(action==='verify'){installed[kind]=true;return {connected:true,result:{demonstration:true},message:'Connexion de démonstration vérifiée.'};}if(action==='configure')return {configured:true};if(action==='status')return {roblox:{available:true,configured:true,installed:installed.roblox},blender:{available:true,configured:true,installed:installed.blender,sessionFile:'Profil de démonstration'}};throw Error('Aperçu uniquement.');},openExternal:async()=>{}};
function studioFeedback(text){console.log(text)}
function readStudioStorage(key,fallback){return fallback}function studioDraftKey(){return ''}
function finishToolActivity(){}function updateTranscriptScrollControl(){}function renderAttachments(){}function autosizeInput(){}function saveStudioDraft(){}function updateAgentProjectLabel(){}function renderAgentActivity(){}function refreshStudioActivity(){}
function setAgentFocus(active){$('app').classList.toggle('focus-agent',active)}function setActivity(){}
function syncLocalBrowserBounds(){}function hideLocalBrowser(){}function selectPanel(){}
function refreshExtensions(){}function hideModelMenu(){}function refreshQuota(){}function setAgentTab(){}
function renderFranceStudentProjects(){}function renderCodexRail(){}function onWorkspaceChanged(){}

function apiNoticeIcon(){return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 5h14v14H5z"/></svg>'}
function gitErrorText(error){return error?.message||String(error)}
$('startup-loading').hidden=true;$('app').className='focus-agent no-panel no-sidebar';$('agent').dataset.tab='conversation';
window.addEventListener('error',event=>{console.error(event.message)});
`;
const source=setup+'\n'+extensions.slice(0,extensions.indexOf('let githubDeviceSequence'))+'\n'+rail.slice(0,rail.indexOf('$("workspace-new-chat").onclick'))+'\n'+read('36-motion-design.js')+'\n'+read('38-motion-studio.js')+'\n'+read('63-browser-home.js')+'\n'+read('64-browser-panels.js')+'\n'+shared.slice(shared.indexOf('function studioSurfaceHeader'),shared.indexOf('function decorateEcoDialog'))+'\n'+read('84-creative-plugins.js')+'\n'+read('50-chat-composer.js').split('let composerContextKey')[0]+'\n'+read('51-chat-access.js').split('const chatAccessMenu')[0]+'\n'+read('56-chat-layout.js')+'\n'+read('61-chat-tools.js')+'\n'+read('75-classic-composer.js')+'\n'+read('34-workbench.js').replace('captureSettings.dataset.settingsGroup = "access";','').replace('updateSettings.dataset.settingsGroup = "general";','')+'\n'+read('65-workspace-pages.js').split('browserHomeViewTitles.projects')[0]+'\n'+read('85-composer-status.js')+`\n
const previewNav=document.createElement('div');previewNav.id='preview-nav';previewNav.innerHTML='<button id="preview-motion">Motion</button><button id="preview-plugins">Plugins</button><button id="preview-code">Code</button><button id="preview-classic">Chat</button><button id="preview-settings">Paramètres</button>';
$('agent').prepend(previewNav);$('preview-motion').onclick=openMotionDesign;$('preview-plugins').onclick=()=>{browserHomeShowSideView('extensions');setCenterTab('mcp')};$('preview-code').onclick=()=>{if(isMotionOpen())closeMotionDesign();else browserHomeClosePage()};
$('preview-settings').onclick=()=>{browserHomeShow('settings',{page:true});setBrowserHomeOpen(true);};
$('preview-classic').onclick=()=>{$('app').classList.toggle('classic-chat-mode');ui.status.mode=$('app').classList.contains('classic-chat-mode')?'chat':'agent';updateChatToolSelection(ui.status);renderComposerScope();};
setBrowserHomeOpen(false);transcript.innerHTML='<div class="entry session-notices"><details><summary>Session et données transmises</summary>Index local prêt ; aucun appel au modèle.</details></div>';
`;
const server=http.createServer((req,res)=>{
 if(req.url==='/preview.js'){res.writeHead(200,{'Content-Type':'text/javascript; charset=utf-8'});return res.end(source);}
 const requested=decodeURIComponent(req.url.split('?')[0]);const file=path.resolve(root,'.'+requested);
 if(file.startsWith(root+path.sep)&&fs.existsSync(file)&&fs.statSync(file).isFile()){
  res.writeHead(200,{'Content-Type':file.endsWith('.css')?'text/css':file.endsWith('.svg')?'image/svg+xml':'application/octet-stream'});return res.end(fs.readFileSync(file));
 }
 const html=fs.readFileSync(path.join(root,'index.html'),'utf8').replace(/<script\b[^>]*>[\s\S]*?<\/script>/g,'').replace('</head>','<style>#preview-nav{display:flex;gap:12px;padding:8px;flex:none}#preview-nav button{border:1px solid #555;padding:6px}#startup-loading[hidden]{display:none!important}#agent-motion-badge{display:none}</style></head>').replace('</body>','<script src="/preview.js"></script></body>');
 res.writeHead(200,{'Content-Type':'text/html; charset=utf-8'});res.end(html);
});server.listen(18767,'127.0.0.1',()=>console.log('Aperçu isolé : http://127.0.0.1:18767/'));
