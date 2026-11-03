"use strict";

let previewDatabase;
function openPreviewDatabase() {
  if (!previewDatabase) previewDatabase = new Promise((resolve, reject) => {
    const request = indexedDB.open('francestudent-previews', 2);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains('files')) request.result.createObjectStore('files', { keyPath: 'id' });
      if (!request.result.objectStoreNames.contains('library')) request.result.createObjectStore('library', { keyPath: 'id' });
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return previewDatabase;
}

async function rememberPreview(file) {
  try {
    const db = await openPreviewDatabase();
    const id = makeId();
    await new Promise((resolve, reject) => {
      const tx = db.transaction('files', 'readwrite');
      const store = tx.objectStore('files');
      store.put({ id, blob: file, name: file.name, size: file.size, created: Date.now() });
      const request = store.getAll();
      request.onsuccess = () => {
        const list = request.result.sort((a,b) => a.created-b.created);
        let total = list.reduce((n, entry) => n + entry.size, 0);
        for (const entry of list) {
          if (total <= 200*1024*1024) break;
          if (entry.id !== id && !entry.saved) { store.delete(entry.id); total -= entry.size; }
        }
      };
      tx.oncomplete = resolve; tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
    });
    return id;
  } catch (error) { console.warn('Copie locale pour aperçu indisponible', error); return null; }
}

async function storedPreview(id) {
  const db = await openPreviewDatabase();
  return new Promise((resolve, reject) => {
    const request = db.transaction('files').objectStore('files').get(id);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function blobDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = () => reject(reader.error); reader.readAsDataURL(blob);
  });
}

async function previewAttachment(file) {
  try {
    let original = null;
    if (file.previewId) { try { original = await storedPreview(file.previewId); } catch {} }
    if (original) return await previewBlob(original.name, original.blob);
    if (/^data:/.test(file.data || '')) return await previewBlob(file.name || 'image.png', await (await fetch(file.data)).blob());
    if (file.kind === 'image' && /^https:\/\//.test(file.data || '')) {
      const response = await fetch(file.data, {credentials:'omit'});
      if (!response.ok) throw new Error('Image indisponible.');
      return await previewBlob(file.name || 'image.png', await response.blob());
    }
    if (file.kind === 'text') return await previewBlob((file.name || 'document') + ' — texte extrait.txt', new Blob([file.data || ''], {type:'text/plain'}));
    showToast('L’original n’est plus disponible sur ce téléphone. Joins-le à nouveau pour le prévisualiser.', true);
  } catch (error) { showToast('Aperçu impossible : ' + error.message, true); }
}

async function previewGeneratedFile(code, lang, name) {
  try {
    const bytes = await generatedFileBytes(code, name);
    await previewBlob(name, new Blob([bytes], {type: FILE_MIME[name.split('.').pop().toLowerCase()] || 'text/plain'}));
  } catch (error) { showToast('Aperçu impossible : ' + error.message, true); }
}

async function previewBlob(name, blob) {
  if (window.Capacitor?.getPlatform?.() === 'ios') {
    try {
      const data = await blobDataUrl(blob);
      await fileSaverPlugin().preview({name, data: data.slice(data.indexOf(',')+1)});
      return;
    } catch (error) { console.warn('Aperçu natif indisponible', error); }
  }
  if (blob.type.startsWith('image/')) { openImageViewer(await blobDataUrl(blob)); return; }
  document.querySelector('.document-preview')?.remove();
  const overlay = document.createElement('div'); overlay.className = 'document-preview';
  overlay.setAttribute('role','dialog'); overlay.setAttribute('aria-modal','true'); overlay.setAttribute('aria-label',name);
  const header = document.createElement('header');
  const title = document.createElement('strong'); title.textContent = name;
  const close = document.createElement('button'); close.textContent = 'Fermer'; close.type='button';
  header.append(close, title); overlay.append(header);
  let url;
  if (blob.type === 'application/pdf') {
    url = URL.createObjectURL(blob);
    const frame = document.createElement('iframe'); frame.src=url; frame.title=name; overlay.append(frame);
  } else {
    const content = document.createElement('pre');
    content.textContent = blob.type.startsWith('text/') || /\.(txt|md|json|csv|js|py|html|css)$/i.test(name) ? await blob.text() : 'L’aperçu de ce format nécessite la version iPhone. Tu peux télécharger le document pour l’ouvrir dans une application compatible.';
    overlay.append(content);
  }
  const footer = document.createElement('footer');
  const save = document.createElement('button'); save.type='button'; save.textContent='Enregistrer';
  save.onclick = async () => { try { await saveFile(name, new Uint8Array(await blob.arrayBuffer())); showToast('Fichier enregistré.'); } catch(e) { showToast(e.message,true); } };
  const share = document.createElement('button'); share.type='button'; share.textContent='Partager';
  share.onclick = async () => { try { const file = new File([blob],name,{type:blob.type}); if (navigator.canShare?.({files:[file]})) await navigator.share({files:[file]}); else showToast('Partage indisponible : utilise Enregistrer.'); } catch(e) { if(e.name!=='AbortError') showToast(e.message,true); } };
  footer.append(share,save); overlay.append(footer);
  const previous = document.activeElement;
  const dismiss = () => { overlay.remove(); if(url) URL.revokeObjectURL(url); document.removeEventListener('keydown',keys); previous?.focus(); };
  const keys = event => {
    if(event.key==='Escape') dismiss();
    if(event.key==='Tab') { const buttons=[close,share,save]; const i=buttons.indexOf(document.activeElement); event.preventDefault(); buttons[(i+(event.shiftKey?2:1))%3].focus(); }
  };
  close.onclick=dismiss; document.addEventListener('keydown',keys); document.body.append(overlay); close.focus();
}
