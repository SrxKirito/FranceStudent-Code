const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const calls=[];
const conversation={chatId:'chat',pendingResponse:{output:'Bonjour',lastEventId:'10',baselineIds:[]}};
const context=vm.createContext({
  window:{addEventListener(){},Capacitor:{getPlatform:()=>'ios'}},document:{body:{},hidden:false,addEventListener(){},removeEventListener(){}},
  navigator:{onLine:true},$:()=>null,store:{imageMode:false},stopRequested:false,saveStore(){},Date,
  apiFetch:async(path,options)=>{calls.push({path,options});return {ok:true,status:200,text:async()=> 'id: 11\nevent: response.output_text.delta\ndata: {"delta":" monde"}\n\nid: 12\nevent: completed\ndata: {"message":{"content":"Bonjour monde"}}\n\n'};}
});
vm.runInContext(fs.readFileSync(__dirname+'/www/js/stream.js','utf8'),context);
(async()=>{
  let output;
  const result=await context.streamChatRequest(conversation,'question',[],value=>output=value,null,true);
  assert.equal(result,'Bonjour monde');assert.equal(output,result);
  assert.equal(calls[0].path,'/chats/chat/stream?last_event_id=10');assert.equal(calls[0].options.method,'GET');
  assert.equal(conversation.pendingResponse.lastEventId,'12');
  assert.equal(conversation.pendingResponse.output,result);
  calls.length=0;
  context.apiFetch=async(path,options)=>{
    calls.push({path,options});
    if(path.includes('/stream'))return {ok:false,status:404,text:async()=>''};
    return {ok:true,json:async()=>({chatMessages:[{id:'u',role:'user',content:'question',createdAt:'2026-10-31T00:00:00Z'},{id:'a',role:'assistant',content:'Réponse terminée',createdAt:'2026-10-31T00:01:00Z'}]})};
  };
  const final=await context.streamChat(conversation,'question',[],()=>{},null,true);
  assert.equal(final,'Réponse terminée','Une réponse terminée pendant la fermeture se récupère depuis l’historique');
  assert.ok(calls.every(call=>!call.options||call.options.method==='GET'),'La reprise ne relance jamais une génération');
  console.log('OK : reprise SSE par curseur sans doublon, point de reprise sauvegardé et récupération après fin du flux.');
})().catch(error=>{console.error(error);process.exitCode=1;});
