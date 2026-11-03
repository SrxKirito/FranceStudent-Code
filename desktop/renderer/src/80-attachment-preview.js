/* Aperçus locaux des pièces jointes et documents générés. */
let previewDbPromise = null;
const sessionPreviewFiles = new Map();
function openAttachmentPreviewDb() {
    if (!previewDbPromise) previewDbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open("francestudent-desktop-previews", 1);
        request.onupgradeneeded = () => request.result.createObjectStore("files", { keyPath:"id" });
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
    return previewDbPromise;
}
async function rememberAttachmentPreview(file, name) {
    const id = crypto.randomUUID();
    if (ui.status.incognito) { sessionPreviewFiles.set(id, { blob:file, name }); return id; }
    try {
        const db = await openAttachmentPreviewDb();
        await new Promise((resolve, reject) => {
            const transaction = db.transaction("files", "readwrite"), store = transaction.objectStore("files");
            store.put({ id, name, blob:file, size:file.size, created:Date.now() });
            const request = store.getAll();
            request.onsuccess = () => {
                const records = request.result.sort((a,b) => a.created - b.created);
                let total = records.reduce((sum, item) => sum + (item.size || 0), 0);
                for (const item of records) { if (total <= 200 * 1024 * 1024) break; if (item.id !== id) { store.delete(item.id); total -= item.size || 0; } }
            };
            transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error); transaction.onabort = () => reject(transaction.error);
        });
        return id;
    } catch { studioFeedback("L’aperçu local ne peut pas être conservé après l’envoi."); return null; }
}
async function attachmentPreviewBlob(item) {
    if (item.previewId) {
        const memory = sessionPreviewFiles.get(item.previewId); if (memory) return memory.blob;
        try {
            const db = await openAttachmentPreviewDb();
            const saved = await new Promise((resolve,reject) => { const r=db.transaction("files").objectStore("files").get(item.previewId); r.onsuccess=()=>resolve(r.result); r.onerror=()=>reject(r.error); });
            if (saved?.blob) return saved.blob;
        } catch { /* données anciennes ou stockage indisponible */ }
    }
    if (typeof item.data === "string" && /^data:/i.test(item.data)) {
        const match = /^data:([^;,]*)(?:;[^,]*)?;base64,([a-z0-9+/=\s]+)$/i.exec(item.data);
        if (!match || item.data.length > 36 * 1024 * 1024) throw new Error("Pièce jointe illisible ou trop volumineuse.");
        const raw = atob(match[2].replace(/\s/g, "")), bytes = new Uint8Array(raw.length);
        for (let i=0;i<raw.length;i++) bytes[i]=raw.charCodeAt(i);
        return new Blob([bytes], {type:match[1] || "application/octet-stream"});
    }
    if (item.kind === "text" && typeof item.data === "string") return new Blob([item.data], {type:"text/plain"});
    throw new Error("L’original n’est plus disponible sur cet ordinateur. Joins-le à nouveau.");
}
async function openAttachmentPreview(item) {
    try { await showAttachmentBlob(item.name || "Fichier", await attachmentPreviewBlob(item)); }
    catch (error) { studioFeedback(`Aperçu impossible : ${error.message}`); }
}
function previewButtonFor(item, content) {
    const button = document.createElement("button"); button.type="button"; button.className="attachment-preview-button";
    button.title=`Aperçu de ${item.name}`; button.setAttribute("aria-label", `Aperçu de ${item.name}`);
    button.append(content); button.onclick=()=>openAttachmentPreview(item); return button;
}
async function showAttachmentBlob(name, blob, options = {}) {
    const dialog = document.createElement("dialog"); dialog.className="fs-dialog attachment-preview-dialog"; dialog.setAttribute("aria-label", `Aperçu de ${name}`);
    const title=document.createElement("h2"); title.textContent=name;
    const close=document.createElement("button"); close.type="button"; close.textContent="Fermer"; close.onclick=()=>dialog.close();
    const head=document.createElement("header"); head.append(title,close);
    const body=document.createElement("div"); body.className="attachment-preview-body";
    const status=document.createElement("p"); status.setAttribute("role","status"); status.textContent="Chargement de l’aperçu…"; body.append(status);
    dialog.append(head,body); document.body.append(dialog); let objectUrl=null, pdf=null;
    dialog.addEventListener("close",()=>{ pdf?.destroy().catch(()=>{}); if(objectUrl) URL.revokeObjectURL(objectUrl); dialog.remove(); options.returnFocus?.focus(); },{once:true});
    dialog.showModal(); close.focus();
    try {
        const ext = fileExtension(name);
        if (options.presentation) {
            const presentation=parsePowerPoint(options.presentation); body.replaceChildren();
            const note=document.createElement("p"); note.className="settings-help"; note.textContent="Aperçu du contenu des diapositives ; la mise en page du fichier téléchargé peut différer."; body.append(note);
            presentation.slides.forEach((slide,index)=>{ const card=document.createElement("section"); card.className="attachment-preview-slide"; const heading=document.createElement("h3"); heading.textContent=`${index+1}. ${slide.title}`; card.append(heading); const list=document.createElement("ul"); for(const value of slide.bullets){const li=document.createElement("li");li.textContent=value;list.append(li);} card.append(list); body.append(card); });
        } else if (blob.type === "application/pdf" || ext === "pdf") {
            const pdfjs=await import(new URL("vendor/pdf.min.mjs", location.href).href);
            pdfjs.GlobalWorkerOptions.workerSrc=new URL("vendor/pdf.worker.min.mjs", location.href).href;
            pdf=await pdfjs.getDocument({ data:new Uint8Array(await blob.arrayBuffer()), isEvalSupported:false }).promise;
            if (!dialog.open) { await pdf.destroy(); pdf=null; return; }
            body.replaceChildren();
            for(let pageNo=1;pageNo<=Math.min(pdf.numPages,20);pageNo++) {
                const page=await pdf.getPage(pageNo), base=page.getViewport({scale:1});
                const scale=Math.min(1.3,1200/Math.max(base.width,base.height),Math.sqrt(2000000/(base.width*base.height)));
                const viewport=page.getViewport({scale});
                const canvas=document.createElement("canvas"); canvas.width=Math.max(1,Math.ceil(viewport.width));canvas.height=Math.max(1,Math.ceil(viewport.height));canvas.setAttribute("aria-label",`Page ${pageNo}`);body.append(canvas);
                await page.render({canvasContext:canvas.getContext("2d"),viewport}).promise; if(!dialog.open)return; page.cleanup();
            }
            if(pdf.numPages>20){const more=document.createElement("p");more.textContent=`20 pages affichées sur ${pdf.numPages}.`;body.append(more);}
        } else if (/^image\/(?:png|jpeg|webp|gif|svg\+xml)$/i.test(blob.type) || /^(?:png|jpg|jpeg|webp|gif|svg)$/.test(ext)) {
            const imageType = ({jpg:"image/jpeg",jpeg:"image/jpeg",png:"image/png",webp:"image/webp",gif:"image/gif",svg:"image/svg+xml"})[ext];
            objectUrl=URL.createObjectURL(imageType && !blob.type.startsWith("image/") ? new Blob([blob],{type:imageType}) : blob); const img=document.createElement("img"); img.src=objectUrl; img.alt=`Aperçu de ${name}`; body.replaceChildren(img);
        } else if (["docx","pptx","xlsx","odt","odp","ods"].includes(ext)) {
            const extracted=await api.previewOffice(name, await readAsDataUrl(blob));
            const note=document.createElement("p");note.className="settings-help";note.textContent="Texte extrait localement ; la mise en page et les images peuvent différer.";
            const pre=document.createElement("pre");pre.textContent=extracted || "Aucun texte disponible.";body.replaceChildren(note,pre);
        } else if (/^(txt|md|csv|json|js|ts|py|html|css|xml|yml|yaml|log|sql|sh|java|c|cpp|rs|go|tex)$/.test(ext) || blob.type.startsWith("text/")) {
            const pre=document.createElement("pre"); pre.textContent=(await blob.text()).slice(0,1000000); body.replaceChildren(pre);
        } else { status.textContent="Aperçu indisponible pour ce format. Le fichier peut être téléchargé ou ouvert dans une application compatible."; }
    } catch(error) { if(dialog.open) { status.textContent=`Aperçu impossible : ${error.message}`; body.replaceChildren(status); } }
}
