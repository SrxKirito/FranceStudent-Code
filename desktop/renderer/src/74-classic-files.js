/* Fichiers issus des blocs de code d’une réponse classique. */
async function classicGeneratedBlob(code, ext) {
    if (ext === "pptx") return new Blob([await makePowerPoint(code)], {type:"application/vnd.openxmlformats-officedocument.presentationml.presentation"});
    if (ext === "pdf") { const encoded=await api.createTextPdf(code), raw=atob(encoded); return new Blob([Uint8Array.from(raw, char=>char.charCodeAt(0))], {type:"application/pdf"}); }
    if (ext === "svg") return new Blob([code], {type:"image/svg+xml"});
    return new Blob([code], {type:"text/plain;charset=utf-8"});
}
function appendClassicGeneratedFiles(message, source) {
    const extensions = { python:"py", py:"py", javascript:"js", js:"js", typescript:"ts", ts:"ts", html:"html", css:"css", json:"json", csv:"csv", markdown:"md", md:"md", java:"java", c:"c", cpp:"cpp", "c++":"cpp", csharp:"cs", bash:"sh", sh:"sh", shell:"sh", powershell:"ps1", sql:"sql", xml:"xml", yaml:"yml", yml:"yml", php:"php", ruby:"rb", go:"go", rust:"rs", kotlin:"kt", swift:"swift", latex:"tex", text:"txt", txt:"txt", svg:"svg", pptx:"pptx", powerpoint:"pptx", pdf:"pdf" };
    const files = document.createElement("div"); files.className = "classic-generated-files";
    for (const match of String(source || "").matchAll(/```([^\s`]*)[^\n]*\n([\s\S]*?)```/g)) {
        let ext = extensions[match[1].toLowerCase()];
        let code = match[2]; const first = code.split("\n")[0].trim();
        const named = /^(?:#|\/\/|<!--|\/\*|--|%)/.test(first) ? first.match(/[\w-]+\.[\w]{1,8}/) : null;
        const requested = conversationRequestBefore(message)?.text || "";
        if (named && /\.pdf$/i.test(named[0]) && /\bpdf\b/i.test(requested)) {
            ext = "pdf"; code = code.slice(code.indexOf("\n") + 1);
        }
        if (!ext) continue;
        const name = ext === "pptx" ? powerPointFileName(code) : named && named[0].toLowerCase().endsWith(`.${ext}`) ? named[0] : `fichier.${ext}`;
        const card = document.createElement("div"); card.className = "classic-generated-file";
        const preview = document.createElement("button"); preview.type = "button";
        const icons = { py:"python", js:"javascript", ts:"typescript", html:"html5", css:"css3", java:"java", go:"go", rs:"rust", php:"php" };
        if (icons[ext]) { const icon = document.createElement("img"); icon.className = "classic-file-icon"; icon.src = `assets/filetypes/${icons[ext]}.svg`; icon.alt = ""; preview.append(icon); }
        else preview.append(fileIcon(name, "file"));
        preview.append(document.createTextNode(name)); preview.title = `Aperçu de ${name}`;
        preview.onclick = async () => {
            preview.disabled = true;
            try { const blob=ext === "pptx" ? new Blob() : await classicGeneratedBlob(code,ext); await showAttachmentBlob(name,blob,{ presentation:ext === "pptx" ? code : null, returnFocus:preview }); }
            catch(error) { studioFeedback(`Aperçu impossible : ${error.message}`); }
            finally { preview.disabled = false; }
        };
        const download = document.createElement("button"); download.type = "button"; download.textContent = "Télécharger"; download.setAttribute("aria-label", `Télécharger ${name}`);
        download.onclick = async () => {
            let blob;
            try { blob = await classicGeneratedBlob(code,ext); }
            catch (error) { studioFeedback(`Création impossible : ${error.message}`); return; }
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a"); link.href = url; link.download = name; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000);
        };
        if (ext === "svg") {
            const thumb=document.createElement("img"); thumb.className="classic-generated-thumbnail"; thumb.alt="Aperçu de l’image générée";
            thumb.src=`data:image/svg+xml;charset=utf-8,${encodeURIComponent(code)}`;
            const picture=document.createElement("button"); picture.type="button"; picture.className="classic-generated-image-preview"; picture.setAttribute("aria-label",`Aperçu de ${name}`); picture.append(thumb); picture.onclick=()=>preview.click(); card.append(picture);
        }
        card.append(preview, download); files.append(card);
    }
    if (files.children.length) { message.querySelectorAll(".classic-generating-file").forEach(node=>node.remove()); message.append(files); }
}
