"use strict";

const LIBRARY_CODE = /\.(py|pyw|js|mjs|cjs|jsx|ts|tsx|html?|css|scss|json|ipynb|java|kt|swift|c|cc|cpp|h|hpp|cs|go|rs|rb|php|sql|sh|ps1|ya?ml|toml|xml|vue|svelte|lua|r|dart)$/i;
const libraryOwner = () => store.profile?.email || 'device:' + store.deviceId;
function libraryKind(name, image = false) {
  return image || /\.(png|jpe?g|webp|gif|heic|svg)$/i.test(name) ? 'image' : /\.pptx$/i.test(name) ? 'presentation' : /\.(pdf|docx?|odt|rtf)$/i.test(name) ? 'document' : LIBRARY_CODE.test(name) ? 'code' : 'other';
}
function libraryMatches(record, query, project, kind, direction) {
  const clean = value => String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase();
  return (!query || clean(record.name).includes(clean(query))) && (project === '*' || (record.projectId || '') === project) && (kind === '*' || (kind.startsWith('ext:') ? record.name.toLowerCase().endsWith('.'+kind.slice(4)) : libraryKind(record.name,record.kind==='image') === kind)) && (direction === '*' || record.direction === direction);
}
async function libraryRecords() {
  const db = await openPreviewDatabase();
  return new Promise((resolve,reject)=>{
    const request=db.transaction('library').objectStore('library').getAll();
    request.onsuccess=()=>resolve(request.result.filter(row=>row.owner===libraryOwner()));
    request.onerror=()=>reject(request.error);
  });
}
async function libraryWrite(record, onlyNew = false) {
  const db=await openPreviewDatabase();
  return new Promise((resolve,reject)=>{
    const tx=db.transaction(['library','files'],'readwrite'), entries=tx.objectStore('library');
    const put=()=>{
      entries.put(record);
      if(record.previewId) { const request=tx.objectStore('files').get(record.previewId); request.onsuccess=()=>{ if(request.result) tx.objectStore('files').put({...request.result,saved:true}); }; }
    };
    if(onlyNew) { const request=entries.get(record.id); request.onsuccess=()=>{if(!request.result)put();}; } else put();
    tx.oncomplete=resolve; tx.onerror=()=>reject(tx.error); tx.onabort=()=>reject(tx.error);
  });
}
async function libraryRecord(id) {
  const db=await openPreviewDatabase();
  return new Promise((resolve,reject)=>{const request=db.transaction('library').objectStore('library').get(id);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
}
const libraryImageJobs=new Set();
function cacheLibraryImage(record) {
  if(libraryImageJobs.has(record.id))return;
  libraryImageJobs.add(record.id);
  cacheLibraryImage.queue=(cacheLibraryImage.queue||Promise.resolve()).catch(()=>{}).then(async()=>{
    const current=await libraryRecord(record.id);if(!current || current.previewId)return;
    const src=await resolveGeneratedImage(current.image),response=await fetch(src);if(!response.ok)return;
    const blob=await response.blob();if(blob.size>50*1024*1024)return;
    const ext=blob.type==='image/jpeg'?'jpg':blob.type==='image/webp'?'webp':'png';
    const name=current.name.replace(/\.png$/i,'.'+ext);
    const previewId=await rememberPreview(new File([blob],name,{type:blob.type}));
    const latest=await libraryRecord(record.id);
    if(previewId && latest)await libraryWrite({...latest,name,previewId});
  }).catch(console.warn).finally(()=>libraryImageJobs.delete(record.id));
}
async function indexConversationFiles(conversation, latestImages = null) {
  const owner=libraryOwner();
  for (const [index,message] of conversation.messages.entries()) {
    const common={owner,conversationId:conversation.id,projectId:conversation.projectId||'',created:conversation.updatedAt||Date.now()};
    for(const [i,file] of (message.attachments||[]).entries()) {
      await libraryWrite({...common,id:owner+':sent:'+conversation.id+':'+index+':'+i,name:file.name||'Fichier',direction:'sent',kind:libraryKind(file.name,file.kind==='image'),previewId:file.previewId||null,file},true);
    }
    if(message.role!=='assistant') continue;
    const fences=[...String(message.content||'').matchAll(/```([\w#+.-]+)\s*\n([\s\S]*?)```/g)];
    for(const [i,match] of fences.entries()) {
      const lang=match[1],code=match[2];
      const name=fileNameFromCode(code,lang)||guessFileName(code,lang);
      if(name) await libraryWrite({...common,id:owner+':generated:'+conversation.id+':'+index+':'+i,name,direction:'generated',kind:libraryKind(name),code,lang},true);
    }
    const images = latestImages && index === conversation.messages.length-1 ? latestImages : message.images || [];
    for(const [i,image] of images.entries()) {
      const record={...common,id:owner+':image:'+conversation.id+':'+index+':'+i,name:'Image '+(index+1)+'-'+(i+1)+'.png',direction:'generated',kind:'image',image};
      await libraryWrite(record,true);cacheLibraryImage(record);
    }
  }
}

async function libraryBlob(record) {
  if(record.previewId) { const original=await storedPreview(record.previewId); if(original) return {name:original.name,blob:original.blob}; }
  if(record.code!==undefined) return {name:record.name,blob:new Blob([await generatedFileBytes(record.code,record.name)],{type:FILE_MIME[record.name.split('.').pop()]||'text/plain'})};
  if(record.image) {
    const src=await resolveGeneratedImage(record.image);
    const response=await fetch(src); if(!response.ok) throw new Error('Image indisponible.');
    return {name:record.name,blob:await response.blob()};
  }
  if(record.file && /^data:/.test(record.file.data||'')) return {name:record.name,blob:await (await fetch(record.file.data)).blob()};
  if(record.file?.kind==='text') return {name:record.name+' — texte extrait.txt',blob:new Blob([record.file.data||''],{type:'text/plain'})};
  throw new Error('L’original n’est plus disponible. Joins-le à nouveau.');
}

async function resumeSavedResponse(conversation) {
  if(busy) return;
  const item=conversation || store.conversations.find(c=>c.pendingResponse && (c.chatId || c.pendingResponse.recentChatIds) && (!c.pendingResponse.owner || c.pendingResponse.owner===store.profile?.email));
  if(!item?.pendingResponse) return;
  currentId=item.id;
  renderModels(); renderMessages(); renderHistory();
  await runAssistant(item,item.pendingResponse.text,[],true);
}

async function openLibrary(initialKind = '*') {
  if(typeof initialKind!=='string')initialKind='*';
  closeSidebar();
  document.getElementById('file-library')?.remove();
  const dialog=document.createElement('dialog');dialog.id='file-library';dialog.className='file-library';
  dialog.innerHTML='<header><div><h2>Bibliothèque</h2><p>Touchez un fichier pour afficher son aperçu.</p></div><button type="button" data-close aria-label="Fermer">×</button></header><section data-jobs></section><div class="library-filters"><input type="search" placeholder="Rechercher un fichier" aria-label="Rechercher un fichier"><select data-project aria-label="Filtrer par projet"><option value="*">Tous les projets</option><option value="">Sans projet</option></select><select data-kind aria-label="Type de fichier"><option value="*">Tous les types</option><option value="image">Images</option><option value="document">Documents</option><option value="presentation">PowerPoint</option><option value="ext:py">Python (.py)</option><option value="ext:js">JavaScript (.js)</option><option value="ext:ts">TypeScript (.ts)</option><option value="ext:html">HTML (.html)</option><option value="ext:css">CSS (.css)</option><option value="ext:json">JSON (.json)</option><option value="other">Autres fichiers</option></select><select data-direction aria-label="Origine"><option value="*">Envoyés et générés</option><option value="sent">Envoyés</option><option value="generated">Générés</option></select></div><p data-status role="status">Chargement…</p><div class="library-grid"></div>';
  document.body.append(dialog);dialog.showModal();
  const resources=[];let observer;
  dialog.addEventListener('close',()=>{observer?.disconnect();for(const url of resources)URL.revokeObjectURL(url);},{once:true});
  dialog.querySelector('[data-close]').onclick=()=>{dialog.close();dialog.remove();};
  dialog.addEventListener('close',()=>dialog.remove(),{once:true});
  const jobs=dialog.querySelector('[data-jobs]');
  for(const conversation of store.conversations.filter(c=>c.pendingResponse && (!c.pendingResponse.owner || c.pendingResponse.owner===store.profile?.email))) {
    const row=document.createElement('div');row.className='library-job';
    const label=document.createElement('strong');label.textContent='Réponse en attente · '+conversation.title;
    const resume=document.createElement('button');resume.textContent='Reprendre';resume.disabled=busy||!(conversation.chatId||conversation.pendingResponse.recentChatIds);
    resume.onclick=()=>{dialog.close();resumeSavedResponse(conversation);};
    const cancel=document.createElement('button');cancel.textContent=conversation.chatId?'Annuler':'Retirer le suivi';cancel.disabled=busy;
    cancel.onclick=async()=>{try{if(conversation.chatId){const response=await apiFetch('/chats/'+encodeURIComponent(conversation.chatId)+'/stream/cancel',{method:'POST'});if(!response.ok)throw new Error('Annulation non confirmée par le serveur.');}delete conversation.pendingResponse;saveStore();row.remove();}catch(error){dialog.querySelector('[data-status]').textContent=error.message;}};
    row.append(label,resume,cancel);jobs.append(row);
  }
  try {
    let projects=typeof accountProjects==='undefined'?[]:accountProjects;
    try {const response=await apiFetch('/projects');if(response.ok)projects=settingsItems(await response.json(),'projects');}catch{}
    const projectSelect=dialog.querySelector('[data-project]');
    for(const project of projects) {const option=document.createElement('option');option.value=project.id;option.textContent=project.name;projectSelect.append(option);}
    for(const conversation of store.conversations)await indexConversationFiles(conversation);
    const records=await libraryRecords();
    const search=dialog.querySelector('input'),kind=dialog.querySelector('[data-kind]'),direction=dialog.querySelector('[data-direction]'),grid=dialog.querySelector('.library-grid');
    grid.style.setProperty("--library-columns",String(store.libraryColumns||3));
    kind.value=initialKind;
    const render=()=>{
      observer?.disconnect();for(const url of resources.splice(0))URL.revokeObjectURL(url);
      let queue=Promise.resolve();
      observer=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting){observer.unobserve(entry.target);queue=queue.then(()=>entry.target.isConnected?libraryThumbnail(entry.target,entry.target.libraryRecord,resources):null).catch(console.warn);}},{root:dialog,rootMargin:'120px'});
      grid.replaceChildren();
      const list=records.filter(r=>libraryMatches(r,search.value,projectSelect.value,kind.value,direction.value)).sort((a,b)=>b.created-a.created);
      dialog.querySelector('[data-status]').textContent=list.length+' fichier(s)';
      for(const record of list) {
        const card=document.createElement('article');card.className='library-card';
        const open=document.createElement('button');open.className='library-open';const thumb=document.createElement('span');thumb.className='library-thumbnail';thumb.textContent='Chargement de l’aperçu…';thumb.libraryRecord=record;open.append(thumb);
        const name=document.createElement('strong');name.textContent=record.name;open.append(name);open.title='Aperçu';

        const actions=document.createElement('details');actions.className='library-actions';
        const summary=document.createElement('summary');summary.textContent='•••';summary.setAttribute('aria-label','Actions pour '+record.name);
        const menu=document.createElement('div');menu.className='library-card-menu';
        const preview=document.createElement('button');preview.textContent='Aperçu';
        preview.onclick=async()=>{preview.disabled=true;try{const file=await libraryBlob(record);dialog.close();await previewBlob(file.name,file.blob);}catch(e){dialog.querySelector('[data-status]').textContent=e.message;}finally{preview.disabled=false;}};
        open.onclick=preview.onclick;
        const chat=document.createElement('button');chat.textContent='Ouvrir le chat';chat.onclick=()=>openLibraryChat(record,dialog);
        const dismiss=document.createElement('button');dismiss.textContent='Fermer';dismiss.onclick=()=>{actions.open=false;};
        menu.append(chat,dismiss);actions.append(summary,menu);
        const meta=document.createElement('small');meta.textContent=(record.direction==='sent'?'Envoyé':'Généré')+' · '+new Date(record.created).toLocaleDateString('fr-FR');
        const project=document.createElement('select');project.setAttribute('aria-label','Classer '+record.name+' dans un projet');
        const none=document.createElement('option');none.value='';none.textContent='Sans projet';project.append(none);
        for(const item of projects){const option=document.createElement('option');option.value=item.id;option.textContent=item.name;project.append(option);}project.value=record.projectId||'';
        project.onchange=async()=>{record.projectId=project.value;try{await libraryWrite(record);render();}catch(e){showToast(e.message,true);}};
        const save=document.createElement('button');save.textContent='Enregistrer';save.onclick=async()=>{save.disabled=true;try{const file=await libraryBlob(record);await saveFile(file.name,new Uint8Array(await file.blob.arrayBuffer()));showToast('Fichier enregistré.');}catch(e){showToast(e.message,true);}finally{save.disabled=false;}};
        menu.insertBefore(project,dismiss);menu.insertBefore(save,dismiss);card.append(open,meta,actions);grid.append(card);observer.observe(thumb);
      }
    };
    for(const field of [search,projectSelect,kind,direction])field.addEventListener('input',render);
    render();
  } catch(error){dialog.querySelector('[data-status]').textContent='Bibliothèque indisponible : '+error.message;}
}

async function libraryThumbnail(node, record, resources) {
  const text = value => {node.textContent='';const pre=document.createElement('pre');pre.textContent=String(value||'Fichier vide').slice(0,1800);node.append(pre);};
  try {
    if(record.code!==undefined && /\.pptx$/i.test(record.name)) {
      const deck=parsePowerPoint(record.code),slide=deck.slides[0];
      node.classList.add('library-slide');node.textContent='';
      const title=document.createElement('b');title.textContent=slide.title;
      const body=document.createElement('span');body.textContent=slide.bullets.slice(0,4).join('\n');
      const number=document.createElement('small');number.textContent='1 / '+deck.slides.length;
      node.append(title,body,number);return;
    }
    if(record.code!==undefined){text(record.code);return;}
    const file=await libraryBlob(record);
    if(!node.isConnected)return;
    if(file.blob.type.startsWith('image/')){
      const url=URL.createObjectURL(file.blob);resources.push(url);
      const image=document.createElement('img');image.src=url;image.alt='Aperçu de '+record.name;node.replaceChildren(image);return;
    }
    if(/\.pdf$/i.test(record.name) && window.pdfjsLib){
      const task=pdfjsLib.getDocument({data:new Uint8Array(await file.blob.arrayBuffer())});
      const pdf=await task.promise;
      try {const page=await pdf.getPage(1),base=page.getViewport({scale:1}),view=page.getViewport({scale:Math.min(1,480/base.width)}),canvas=document.createElement('canvas');canvas.width=view.width;canvas.height=view.height;await page.render({canvasContext:canvas.getContext('2d'),viewport:view}).promise;if(node.isConnected)node.replaceChildren(canvas);}
      finally{await pdf.destroy();}return;
    }
    if(LIBRARY_CODE.test(record.name)||/\.(txt|md|csv|log)$/i.test(record.name)){text(await file.blob.slice(0,6000).text());return;}
    const bytes=new Uint8Array(await file.blob.arrayBuffer());
    const embedded=await FileConvert.embeddedThumbnail(bytes);
    if(embedded && node.isConnected){const url=URL.createObjectURL(embedded);resources.push(url);const image=document.createElement('img');image.src=url;image.alt='Première page de '+record.name;node.replaceChildren(image);return;}
    const result=await FileConvert.extractText(bytes,record.name,file.blob.type);
    text(result?.text||'Aperçu indisponible pour ce format');
  }catch{node.textContent='Aperçu indisponible · toucher pour ouvrir';}
}
function openLibraryChat(record,dialog) {
  if(busy){showToast('Attends la fin de la réponse avant de changer de chat.');return;}
  if(!store.conversations.some(item=>item.id===record.conversationId)){showToast('Le chat d’origine n’est plus disponible sur ce téléphone.',true);return;}
  dialog.close();
  openConversation(record.conversationId);
}
function renderLibrarySettings() {
  const button=$('completion-notifications');
  for(const choice of document.querySelectorAll('[data-library-columns]')){
    const selected=Number(choice.dataset.libraryColumns)===(store.libraryColumns||3);
    choice.setAttribute('aria-checked',String(selected));choice.tabIndex=selected?0:-1;
  }
  if(button){button.textContent=store.completionNotifications?'Désactiver les notifications':'Activer les notifications';button.disabled=window.Capacitor?.getPlatform?.()!=='ios';}
}
async function toggleCompletionNotifications() {
  const button=$('completion-notifications'),status=$('completion-notifications-status');button.disabled=true;
  try{
    const result=await window.Capacitor.Plugins.ChatStream.configureNotifications({enabled:!store.completionNotifications});
    store.completionNotifications=result.enabled===true;saveStore();
    status.textContent=result.enabled?'Notifications locales activées en arrière-plan.':'Notifications désactivées. Si nécessaire, autorise-les dans les réglages iOS.';
  }catch(error){status.textContent=error.message;}finally{renderLibrarySettings();}
}

function setLibraryColumns(columns) {
  if(![1,2,3,4].includes(columns))return;
  store.libraryColumns=columns;saveStore();renderLibrarySettings();
}
