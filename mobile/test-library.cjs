const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const records=new Map();
const context=vm.createContext({store:{deviceId:'device',profile:{email:'me@example.com'}},Date});
for(const name of ['render','powerpoint','library'])vm.runInContext(fs.readFileSync(__dirname+'/www/js/'+name+'.js','utf8'),context);
context.libraryWrite=async(record,onlyNew)=>{if(!onlyNew||!records.has(record.id))records.set(record.id,record);};
context.cacheLibraryImage=()=>{};
const conversation={id:'chat',projectId:'project',updatedAt:1,messages:[
  {role:'user',attachments:[{name:'Cours.pdf',kind:'text',data:'texte extrait',previewId:'original'}]},
  {role:'assistant',content:'```pptx\n'+JSON.stringify({filename:'Énergie.pptx',slides:[{title:'Énergie',bullets:[]}]})+'\n```',images:[{id:'image',chatId:'remote',messageId:'message'}]}
]};
(async()=>{
  await context.indexConversationFiles(conversation);
  assert.equal(records.size,3);
  const rows=[...records.values()];
  assert.equal(rows.find(r=>r.direction==='sent').previewId,'original');
  const deck=rows.find(r=>r.kind==='presentation');assert.equal(deck.name,'Énergie.pptx');
  assert.equal(context.libraryMatches(deck,'energie','project','presentation','generated'),true);
  assert.equal(context.libraryMatches(deck,'energie','another','*','*'),false);
  deck.projectId='another';
  await context.indexConversationFiles(conversation);
  assert.equal(records.get(deck.id).projectId,'another','Le classement manuel est conservé pendant la réindexation');
  assert.equal(records.size,3,'Aucun doublon pendant la réindexation');
  const large={data:'data:image/png;base64,'+'A'.repeat(2000000)};
  await context.indexConversationFiles({...conversation,id:'large-image',messages:[{role:'assistant',content:'',images:[]}]},[large]);
  assert.equal([...records.values()].find(r=>r.conversationId==='large-image').image.data,large.data,'Les grandes images exclues du localStorage restent dans la bibliothèque IndexedDB');
  console.log('OK : documents envoyés, PPTX et images générés, recherche et classement par projet sans doublons.');
})().catch(error=>{console.error(error);process.exitCode=1;});
for(const name of ['test.py','main.js','script.cjs','app.tsx','query.sql','main.swift'])assert.equal(context.libraryKind(name),'code');
assert.equal(context.libraryMatches({name:'MAIN.PY',kind:'other'},'main','*','code','*'),true);
assert.equal(context.libraryMatches({name:'MAIN.PY',kind:'other'},'','*','ext:py','*'),true);
assert.equal(context.libraryMatches({name:'main.js',kind:'code'},'','*','ext:py','*'),false);
const urlContext=vm.createContext({URL,URLSearchParams,store:{},Date});
vm.runInContext(fs.readFileSync(__dirname+'/www/js/ide-link.js','utf8'),urlContext);
assert.equal(urlContext.ideLinkAddress('https://example.trycloudflare.com/').origin,'https://example.trycloudflare.com');
for(const url of ['javascript:alert(1)','http://example.com','https://user:secret@example.com','https://example.com/?token=secret'])assert.throws(()=>urlContext.ideLinkAddress(url));
let opened;
const routeContext=vm.createContext({store:{conversations:[{id:'chat'}]},busy:false,showToast(){},openConversation(id){opened=id;}});
vm.runInContext(fs.readFileSync(__dirname+'/www/js/library.js','utf8'),routeContext);
let closed=false;routeContext.openLibraryChat({conversationId:'chat'},{close(){closed=true;}});
assert.equal(closed,true);assert.equal(opened,'chat');
closed=false;routeContext.busy=true;routeContext.openLibraryChat({conversationId:'chat'},{close(){closed=true;}});assert.equal(closed,false);
