/* ---------- Transcript ---------- */

const transcriptBottomButton = $("transcript-bottom");
let transcriptFollowing = true;
let transcriptScrollFrame = null;
const transcriptAtBottom = () => transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight <= 24;
function updateTranscriptScrollControl() {
    transcriptBottomButton.hidden = transcriptFollowing;
}
function resetTranscriptFollow() {
    transcriptFollowing = true;
    updateTranscriptScrollControl();
}
transcript.addEventListener("scroll", () => {
    if (!transcript.clientHeight || transcriptScrollFrame !== null) return;
    transcriptFollowing = transcriptAtBottom();
    updateTranscriptScrollControl();
}, { passive: true });
transcript.addEventListener("wheel", event => {
    if (event.target.closest?.(".chat-tool-result pre")) return;
    if (event.deltaY < 0 && transcript.scrollHeight > transcript.clientHeight) {
        transcriptFollowing = false;
        updateTranscriptScrollControl();
    }
}, { passive: true });
transcript.addEventListener("click", event => {
    if (!event.target.closest?.(".tool-group summary") || event.target.closest("button")) return;
    transcriptFollowing = false;
    updateTranscriptScrollControl();
});
transcriptBottomButton.addEventListener("click", () => {
    resetTranscriptFollow();
    scrollDown();
});
function scrollDown() {
    if (ui.replayingConversation || !transcriptFollowing) return;
    if (transcriptScrollFrame !== null) return;
    transcriptScrollFrame = requestAnimationFrame(() => {
        transcriptScrollFrame = null;
        if (!ui.replayingConversation && transcriptFollowing) transcript.scrollTop = transcript.scrollHeight;
    });
}
// Messages, images and the available viewport can change size after rendering.
// Keep following only while the user has not chosen to read further up.
const transcriptResizeObserver = new ResizeObserver(() => scrollDown());
transcriptResizeObserver.observe(transcript);
for (const child of transcript.children) transcriptResizeObserver.observe(child);
new MutationObserver(records => {
    for (const record of records) {
        for (const node of record.removedNodes) if (node.nodeType === Node.ELEMENT_NODE) transcriptResizeObserver.unobserve(node);
        for (const node of record.addedNodes) if (node.nodeType === Node.ELEMENT_NODE) transcriptResizeObserver.observe(node);
    }
    scrollDown();
}).observe(transcript, { childList: true });

let toolGroup = null;
let pendingToolCards = [];
let livePaintTimer = null;
let livePaintedText = null, livePaintedPlain = false;

function renderAssistantText(text) {
    const value = String(text ?? "");
    // Large replies remain complete, but avoid expensive Markdown highlighting.
    return value.length > 64000 ? `<div class="fs-long-message">${escapeHtml(value)}</div>` : renderMarkdown(value);
}

function toolRowHtml(e) {
    return `<span class="tdot"></span><span class="name">${escapeHtml(toolLabel(e.name))}</span><span class="arg" title="${escapeHtml(e.arg || "")}">${escapeHtml(e.arg || "")}</span>`;
}

function codexSubagentAction(value) {
    return ({ spawnAgent: "Lancer", wait: "Attendre", closeAgent: "Fermer", sendInput: "Transmettre une consigne", resumeAgent: "Reprendre" })[value] || value || "Action";
}

function plural(n, word) {
    return `${n} ${word}${n > 1 ? "s" : ""}`;
}

function updateToolGroup(group) {
    const { running, errors, missing } = group;
    const parts = [];
    if (group.codex) {
        if (group.completedFiles.size) parts.push(`A ${group.completedFiles.size === group.createdFiles.size ? "créé" : "modifié"} ${plural(group.completedFiles.size, "fichier")}`);
        if (group.completedCommands) parts.push(`A exécuté ${plural(group.completedCommands, "commande")}`);
        if (group.completedWeb) parts.push(`A consulté ${plural(group.completedWeb, "source")}`);
        if (group.completedAgents) parts.push(`${plural(group.completedAgents, "action")} de sous-agent`);
        if (group.completedTools) parts.push(`A utilisé ${plural(group.completedTools, "outil")}`);
        group.summary.textContent = (parts.join(" · ") || "Actions de l’agent") + (running ? ` · ${running} en cours` : "") + (errors ? ` · ${plural(errors, "échec")}` : "") + (missing ? " · résultat manquant" : "");
        group.el.classList.toggle("has-error", errors > 0); group.el.classList.toggle("is-running", running > 0);
        return;
    }
    if (group.reads) parts.push(`${plural(group.reads, "fichier")} consulté${group.reads > 1 ? "s" : ""}`);
    if (group.searches) parts.push(`${plural(group.searches, "recherche")} effectuée${group.searches > 1 ? "s" : ""}`);
    if (group.lists) parts.push(`${plural(group.lists, "dossier")} listé${group.lists > 1 ? "s" : ""}`);
    if (group.actions) parts.push(`${plural(group.actions, "action")} lancée${group.actions > 1 ? "s" : ""}`);
    const states = [running ? `${running} en cours` : "", errors ? plural(errors, "erreur") : "", missing ? "résultat manquant" : ""].filter(Boolean);
    group.summary.textContent = parts.join(" · ") + (states.length ? " · " + states.join(" · ") : "");
    group.el.classList.toggle("has-error", errors > 0);
    group.el.classList.toggle("is-running", running > 0);
}

/** Consecutive calls share a summary; full results are mounted on demand. */
function addToolActivity(e) {
    if (!toolGroup) {
        const el = addEntry("tool-group", "<details><summary></summary><div class=\"tool-group-body\"></div></details>");
        toolGroup = { el, summary: el.querySelector("summary"), body: el.querySelector(".tool-group-body"), reads: 0, searches: 0, lists: 0, actions: 0, running: 0, errors: 0, missing: 0, codex: !!e.codex, completedFiles: new Set(), createdFiles: new Set(), completedCommands: 0, completedWeb: 0, completedAgents: 0, completedTools: 0 };
        if (e.codex) el.classList.add("codex-action-group");
    }
    const g = toolGroup;
    if (e.name === "read_file") g.reads++;
    else if (e.name === "search_files") g.searches++;
    else if (e.name === "list_directory") g.lists++;
    else g.actions++;
    const row = document.createElement("details");
    row.className = "chat-tool-call is-running";
    const heading = document.createElement("summary");
    heading.innerHTML = toolRowHtml(e);
    if(e.codex){
        heading.replaceChildren();
        const mark = document.createElement("span");
        mark.className = "codex-action-mark";
        mark.setAttribute("aria-hidden", "true");
        mark.innerHTML = e.name === "run_command"
            ? '<svg viewBox="0 0 20 20"><rect x="2" y="3" width="16" height="14" rx="2"/><path d="m5 7 3 3-3 3m6 0h4"/></svg>'
            : e.name === "write_file"
                ? '<svg viewBox="0 0 20 20"><path d="m3 13 9-9 4 4-9 9-5 1zM11 5l4 4"/></svg>'
                : '<svg viewBox="0 0 20 20"><path d="M8 5 3 10l5 5m4-10 5 5-5 5"/></svg>';
        const label=document.createElement("span");label.className="codex-action-label";label.textContent=e.name==="run_command"?"Exécution d’une commande":e.name==="write_file"?({add:"Création de",delete:"Suppression de"}[e.fileKind]||"Modification de"):e.name==="subagent"?"Sous-agent · "+codexSubagentAction(e.arg):e.name==="web_source"?"Consultation d’une source":"Outil · "+(e.arg||toolLabel(e.name));
        heading.append(mark,label);heading.title=e.arg||"";
        if(e.path){const link=document.createElement("button");link.type="button";link.className="codex-action-file";link.textContent=e.path.split('/').pop();link.title=e.path;link.onclick=event=>{event.preventDefault();event.stopPropagation();if(!e.path.startsWith('../')&&!/^(?:[a-z]:|\/)/i.test(e.path))openFile(e.path);};heading.append(link);}
    }
    const badge = document.createElement("span"); badge.className = "chat-tool-state"; badge.textContent = "En cours";
    heading.append(badge);
    const result = document.createElement("div"); result.className = "chat-tool-result";
    row.append(heading, result);
    const call = { group: g, row, badge, result, status: "running", text: null, mounted: false, event: e, heading };
    const mount = () => {
        if (!row.open || call.text === null || call.mounted) return;
        const pre = document.createElement("pre");
        pre.tabIndex = 0;
        pre.setAttribute("aria-label", "Résultat de l’outil");
        pre.textContent = call.text;
        result.replaceChildren(pre);
        call.mounted = true;
    };
    row.addEventListener("toggle", mount);
    call.mount = mount;
    g.running++; pendingToolCards.push(call);
    g.body.appendChild(row);
    updateToolGroup(g);
    scrollDown();
    return row;
}

function appendToolResult(e) {
    const index = e.callId ? pendingToolCards.findIndex(item => item.event.callId === e.callId) : 0;
    const call = index < 0 ? null : pendingToolCards.splice(index, 1)[0];
    if (!call || !call.row.isConnected) return null;
    call.status = e.tone === "error" || e.tone === "err" ? "error" : "done";
    call.group.running--;
    if (call.status === "error") call.group.errors++;
    if(call.event.codex&&call.status==="done"){
        const event=call.event,label=call.heading.querySelector(".codex-action-label");
        if(event.name==="run_command"){call.group.completedCommands++;label.textContent="Commande exécutée";}
        else if(event.name==="write_file"){call.group.completedFiles.add(event.path||event.arg);if(event.fileKind==="add")call.group.createdFiles.add(event.path||event.arg);label.textContent=({add:"Créé",delete:"Supprimé"}[event.fileKind]||"Modifié");}
        else if(event.name==="web_source"){call.group.completedWeb++;label.textContent="Source consultée";}
        else if(event.name==="subagent"){call.group.completedAgents++;label.textContent="Sous-agent · "+codexSubagentAction(event.arg)+" · terminé";}
        else{call.group.completedTools++;label.textContent="Outil utilisé · "+(event.arg||toolLabel(event.name));}
    }
    call.text = (call.event.codex&&call.event.name==="run_command"?call.event.arg+"\n\n":"")+String(e.text ?? "");
    call.badge.textContent = call.status === "error" ? "Échec" : "Terminé";
    call.row.classList.remove("is-running"); call.row.classList.add(call.status);
    if (call.status === "error") { call.group.el.querySelector("details").open = true; call.row.open = true; }
    call.mount(); updateToolGroup(call.group); scrollDown(); return call.result;
}

function finishToolActivity(preserveRunningCodex = false) {
    for (const call of pendingToolCards) {
        if (preserveRunningCodex && call.event.codex && call.event.callId) continue;
        call.status = "missing"; call.group.running--; call.group.missing++; call.badge.textContent = "Résultat non reçu"; call.row.classList.remove("is-running"); call.row.classList.add("missing"); updateToolGroup(call.group);
    }
    pendingToolCards = preserveRunningCodex ? pendingToolCards.filter(call => call.event.codex && call.event.callId) : []; toolGroup = null;
}

function resetToolActivity() { pendingToolCards = []; toolGroup = null; }

function addEntry(cls, html) {
    toolGroup = null;
    const div = document.createElement("div");
    div.className = `entry ${cls}`;
    if (cls === "user") { div.setAttribute("role", "group"); div.setAttribute("aria-label", "Votre message"); }
    div.innerHTML = html;
    transcript.appendChild(div);
    scrollDown();
    return div;
}

function appendOutput(text) {
    output.textContent += `${text}\n`;
    if (output.textContent.length > 200000) output.textContent = output.textContent.slice(-150000);
    output.scrollTop = output.scrollHeight;
}

let requestFileChanges = new Map();
let requestDiffPreviews = new Map();

function resetRequestFileChanges() {
    requestFileChanges = new Map();
    requestDiffPreviews = new Map();
}

function recordRequestFileChange(e) {
    if (!e.path) return;
    const item = requestFileChanges.get(e.path) || { path: e.path, added: 0, removed: 0, unknown: false, diffs: [] };
    if (Number.isFinite(e.added) && Number.isFinite(e.removed)) {
        item.added += e.added;
        item.removed += e.removed;
        const preview = requestDiffPreviews.get(e.path);
        if (preview) item.diffs.push(preview);
    } else item.unknown = true;
    requestDiffPreviews.delete(e.path);
    requestFileChanges.set(e.path, item);
}

function appendRequestFileSummary(message) {
    const files = [...requestFileChanges.values()];
    if (!files.length) return;
    resetRequestFileChanges();
    const card = document.createElement("section");
    card.className = "request-file-summary";
    card.setAttribute("aria-label", "Fichiers modifiés pendant cette demande");
    const head = document.createElement("div");
    head.className = "request-file-head";
    const title = document.createElement("strong");
    title.textContent = `${files.length} fichier${files.length > 1 ? "s" : ""} modifié${files.length > 1 ? "s" : ""}`;
    head.append(title);
    const undo = document.createElement("button");
    undo.type = "button";
    undo.textContent = "Gérer les annulations";
    undo.title = "Ouvrir le panneau des modifications et des annulations";
    undo.onclick = () => selectPanel("changes");
    head.appendChild(undo);
    const diffs = document.createElement("div");
    diffs.className = "request-file-diffs";
    diffs.hidden = true;
    for (const file of files) for (const diff of file.diffs) diffs.appendChild(buildDiffCard(diff));
    if (diffs.childNodes.length) {
        const view = document.createElement("button");
        view.type = "button";
        view.textContent = "Voir les modifications";
        view.setAttribute("aria-expanded", "false");
        view.onclick = () => {
            diffs.hidden = !diffs.hidden;
            view.setAttribute("aria-expanded", String(!diffs.hidden));
            view.textContent = diffs.hidden ? "Voir les modifications" : "Masquer les modifications";
        };
        head.appendChild(view);
    }
    card.appendChild(head);
    const totals = document.createElement("div");
    totals.className = "request-file-totals";
    totals.title = "Total cumulé des opérations dont le nombre de lignes est disponible";
    const addedTotal = document.createElement("span");
    addedTotal.className = "request-file-added";
    addedTotal.textContent = `+${files.reduce((n, file) => n + file.added, 0)}`;
    const removedTotal = document.createElement("span");
    removedTotal.className = "request-file-removed";
    removedTotal.textContent = ` −${files.reduce((n, file) => n + file.removed, 0)}`;
    totals.append(addedTotal, removedTotal);
    if (files.some(file => file.unknown)) totals.append(document.createTextNode(" · statistiques partielles"));
    card.appendChild(totals);
    const list = document.createElement("div");
    list.className = "request-file-list";
    const extra = document.createElement("div");
    extra.hidden = true;
    files.forEach((file, index) => {
        const row = document.createElement("div");
        row.className = "request-file-row";
        const name = document.createElement("span");
        name.textContent = file.path;
        name.title = file.path;
        const stats = document.createElement("span");
        if (file.unknown) stats.textContent = "Statistiques partielles";
        else {
            const added = document.createElement("span");
            added.className = "request-file-added";
            added.textContent = `+${file.added}`;
            const removed = document.createElement("span");
            removed.className = "request-file-removed";
            removed.textContent = ` −${file.removed}`;
            stats.append(added, removed);
        }
        row.append(name, stats);
        (index < 3 ? list : extra).appendChild(row);
    });
    card.appendChild(list);
    if (files.length > 3) {
        const more = document.createElement("button");
        more.type = "button";
        more.className = "request-file-more";
        more.textContent = `Afficher ${files.length - 3} fichier(s) de plus`;
        more.setAttribute("aria-expanded", "false");
        more.onclick = () => {
            extra.hidden = !extra.hidden;
            more.setAttribute("aria-expanded", String(!extra.hidden));
            more.textContent = extra.hidden ? `Afficher ${files.length - 3} fichier(s) de plus` : "Afficher moins";
        };
        card.append(extra, more);
    }
    card.appendChild(diffs);
    message.appendChild(card);
    scrollDown();
}

function conversationRequestBefore(node) {
    let previous = node.previousElementSibling;
    while (previous && !previous.classList.contains("user")) previous = previous.previousElementSibling;
    if (!previous) return null;
    const text = previous.querySelector(".message-content")?.textContent || "";
    const hasFiles = /(?:^|\n)Pièces jointes : /.test(text) || Boolean(previous.querySelector(".chat-message-attachments"));
    return { text: text.replace(/\n?Pièces jointes : [^\n]*$/, ""), hasFiles, node: previous };
}
function addConversationActions(message, text, error = false) {
    if (message.querySelector(".message-actions")) return;
    const actions = document.createElement("div"); actions.className = "message-actions";
    if (!error) {
        const copy = document.createElement("button"); copy.type = "button"; copy.textContent = "Copier";
        copy.onclick = () => api.copyText(text).then(() => { copy.textContent = "Copié ✓"; }).catch(err => studioFeedback(err.message)); actions.append(copy);
    }
    const request = conversationRequestBefore(message);
    if (request && ui.status.mode === "chat") {
        const retry = document.createElement("button"); retry.type = "button"; retry.textContent = error ? "Réessayer" : "Régénérer";
        retry.title = "Renvoyer la demande dans la discussion actuelle";
        retry.onclick = () => {
            if (ui.status.busy) return studioFeedback("Attends la fin de la réponse.");
            if ([...transcript.querySelectorAll(".entry.user")].at(-1) !== request.node) return studioFeedback("Cette réponse appartient à une demande antérieure. Reprends son texte pour continuer.");
            if (request.hasFiles) return studioFeedback("Ajoute à nouveau les fichiers avant de renvoyer cette demande.");
            send(request.text);
        }; actions.append(retry);
        if (error) {
            const edit = document.createElement("button"); edit.type = "button"; edit.textContent = "Modifier la demande";
            edit.onclick = () => {
                if (input.value.trim()) return studioFeedback("Le brouillon actuel n’a pas été remplacé. Vide la saisie avant de reprendre cette demande.");
                input.value = request.text; autosizeInput(); saveStudioDraft(); input.focus();
                if (request.hasFiles) studioFeedback("Ajoute à nouveau les fichiers joints avant l’envoi.");
            }; actions.append(edit);
        }
    }
    message.append(actions);
}

function renderEntry(e) {
    const { previews, ...storedEntry } = e;
    recordStudioEntry(storedEntry);
    if(["info","warn","error"].includes(e.type)){
        const budget=parseBudgetNotice(e.text);
        if(budget){
            if(e.type==="error")$("agent-starter").classList.add("hidden");
            return renderBudgetEntry(budget,e.text,{projectSummary:/Résumé IA indisponible/i.test(String(e.text||""))});
        }
    }
    const sessionPrivacyNotice = e.type === "warn" && /^Le contenu du projet \(fichiers, RESUME\.md\) est envoyé à ton fournisseur API\./.test(String(e.text || ""));
    if (sessionPrivacyNotice || e.type === "info" && /^(?:Connecté \(le token|Projet : |Projet FranceStudent : |Projet existant : |Mémoire : |Résumé du projet |Index local du projet |R[ÉE]SUM[ÉE]\.md |Nouveau projet enregistré)/.test(String(e.text || ""))) {
        let group = transcript.querySelector(".session-notices");
        if (!group) group = addEntry("session-notices", "<details><summary>Informations de session</summary><div class=\"chat-session-lines\"></div></details>");
        const line = document.createElement("div"); line.className = "chat-session-line"; line.textContent = e.text;
        if (sessionPrivacyNotice) { line.classList.add("session-privacy-line"); group.querySelector("summary").textContent = "Session et données transmises"; }
        group.querySelector(".chat-session-lines").append(line);
        return group;
    }
    switch (e.type) {
        case "welcome":
            return null;
        case "user": {
            finishToolActivity();
            resetRequestFileChanges();
            $("agent-starter").classList.add("hidden");
            const hasPreviews = Array.isArray(e.previews) && e.previews.length > 0;
            const text = hasPreviews ? String(e.text || "").replace(/\n?Pièces jointes : [^\n]*$/, "") : e.text;
            const message = addEntry("user", `<div class="message-content">${escapeHtml(text)}</div>`);
            if (hasPreviews) {
                const files = document.createElement("div"); files.className = "chat-message-attachments";
                for (const preview of e.previews) {
                    const label = document.createElement("span"); label.className = "chat-attachment-label"; label.textContent = preview.name || "Fichier";
                    const content = document.createDocumentFragment();
                    if (typeof preview.data === "string" && /^data:image\/(?:png|jpeg|webp|gif);base64,[a-z0-9+/=]+$/i.test(preview.data)) {
                        const image = document.createElement("img"); image.className = "chat-attachment-preview"; image.src = preview.data; image.alt = ""; image.loading = "lazy"; content.append(image);
                    } else content.append(fileIcon(preview.name, "file"));
                    content.append(label); files.append(previewButtonFor(preview,content));
                }
                message.prepend(files);
            }
            return message;
        }
        case "assistant": {
            finishToolActivity(true);
            $("agent-starter").classList.add("hidden");
            const message = addEntry("assistant", `<div class="message-content">${renderAssistantText(e.text)}</div>`);
            addConversationActions(message, e.text);
            if (ui.status.mode === "chat") appendClassicGeneratedFiles(message, e.text);
            attachServerControls(message, e.text);
            appendRequestFileSummary(message);
            return message;
        }
        case "generatedImage": {
            if (typeof e.data !== "string" || !/^data:image\/(?:png|jpeg|webp|gif);base64,[a-z0-9+/=]+$/i.test(e.data) || e.data.length > 8 * 1024 * 1024) return null;
            $("agent-starter").classList.add("hidden");
            const message = addEntry("assistant generated-image-entry", "");
            const image = document.createElement("img"); image.src = e.data; image.alt = "Image générée"; image.loading = "lazy";
            const download = document.createElement("a"); download.href = e.data; download.download = "image-generee" + (e.data.startsWith("data:image/jpeg") ? ".jpg" : e.data.startsWith("data:image/webp") ? ".webp" : e.data.startsWith("data:image/gif") ? ".gif" : ".png"); download.textContent = "Télécharger";
            const imagePreview=previewButtonFor({name:"Image générée",kind:"image",data:e.data},image);
            message.append(imagePreview, download); return message;
        }
        case "reason": {
            const el = addEntry("reason collapsed", `<span class="reason-mark">✻</span><span class="reason-text">${inline(e.text)}</span>`);
            el.title = "Cliquer pour déplier ou replier la réflexion";
            el.tabIndex = 0; el.setAttribute("role", "button"); el.setAttribute("aria-expanded", "false");
            el.onclick = () => {
                if (!String(window.getSelection())) { el.classList.toggle("collapsed"); el.setAttribute("aria-expanded", String(!el.classList.contains("collapsed"))); }
            };
            el.onkeydown = event => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); el.click(); } };
            return el;
        }
        case "info":
        case "warn":
        case "error": {
            if (e.type === "error") {
                $("agent-starter").classList.add("hidden");
                const context=parseContextLimitNotice(e.text);
                if(context){const notice=renderContextLimitEntry(context,e.text); if (!e.replayed) addConversationActions(notice, "", true); return notice;}
                const apiError=parseApiErrorNotice(e.text);
                if(apiError){const notice=renderApiErrorEntry(apiError,e.text); if (!e.replayed) addConversationActions(notice, "", true); return notice;}
            }
            const notice = addEntry(e.type, escapeHtml(e.text));
            if (e.type === "error" && !e.replayed) addConversationActions(notice, "", true);
            return notice;
        }
        case "print":
            return addEntry("print", `<pre>${escapeHtml((e.lines || []).join("\n"))}</pre>`);
        case "plan":
            renderWorkPlan(Array.isArray(e.steps) ? e.steps : workPlanItems(e.items), { status: e.replayed ? "history" : "running" });
            return null;
        case "tool":
            if (e.name === "run_command") appendOutput(`$ ${e.arg}`);
            return addToolActivity(e);
        case "result": {
            const result = appendToolResult(e);
            if (result) return result;
            return addEntry(`result ${e.tone || ""}`, `└ ${escapeHtml(e.text)}`);
        }
        case "fileChange":
            recordRequestFileChange(e);
            if (e.path) recordChange(e.path, e.added, e.removed);
            return null;
        case "diff": {
            if (e.path) requestDiffPreviews.set(e.path, e);
            const el = addEntry("diff-entry", "");
            el.appendChild(buildDiffCard(e));
            return el;
        }
        default:
            return addEntry("info", escapeHtml(JSON.stringify(e)));
    }
}

function liveStart() {
    liveEnd();
    ui.liveText = "";
    livePaintedText = null;
    ui.live = addEntry("assistant", "");
}

function paintLiveMessage(final = false) {
    livePaintTimer = null;
    if (!ui.live?.isConnected) return;
    if (document.hidden && !final) return;
    const plain = !final && ui.liveText.length > 12000;
    if (livePaintedText === ui.liveText && livePaintedPlain === plain) return;
    const html = plain ? `<div class="fs-long-message">${escapeHtml(ui.liveText)}</div>` : renderAssistantText(ui.liveText);
    ui.live.innerHTML = `<div class="message-content">${html}</div>`;
    livePaintedText = ui.liveText; livePaintedPlain = plain;
    scrollDown();
}

function liveAppend(text) {
    if (!ui.live) liveStart();
    ui.liveText += text;
    if (document.hidden) return;
    if (livePaintTimer === null) livePaintTimer = setTimeout(paintLiveMessage, ui.liveText.length > 12000 ? 180 : 80);
}

function liveEnd() {
    if (livePaintTimer !== null) clearTimeout(livePaintTimer);
    paintLiveMessage(true);
    if (ui.live?.isConnected && ui.liveText) {
        addConversationActions(ui.live, ui.liveText);
        if (ui.status.mode === "chat") appendClassicGeneratedFiles(ui.live, ui.liveText);
        attachServerControls(ui.live, ui.liveText);
        appendRequestFileSummary(ui.live);
    }
    ui.live = null;
    ui.liveText = "";
    livePaintedText = null;
}
document.addEventListener?.("visibilitychange", () => { if (!document.hidden && ui.live) { if (livePaintTimer !== null) clearTimeout(livePaintTimer); paintLiveMessage(); } });

function setSpinner(data) {
    if (data.stop) {
        if (ui.spinnerId === data.id) {
            $("spinner").classList.add("hidden");
            ui.spinnerId = null;
            ui.spinnerStart = 0;
            if (ui.spinnerTimer) clearInterval(ui.spinnerTimer);
            ui.spinnerTimer = null;
        }
        return;
    }
    if (ui.spinnerId !== data.id || !ui.spinnerStart) {
        ui.spinnerStart = Date.now();
        const spinner = $("spinner");
        if (spinner.parentNode !== transcript || spinner !== transcript.lastElementChild) transcript.append(spinner);
        scrollDown();
    }
    ui.spinnerId = data.id;
    ui.spinnerLabel = data.label || "";
    const paint = () => {
        const secs = Math.floor((Date.now() - ui.spinnerStart) / 1000);
        const elapsed = secs >= 60 ? `${Math.floor(secs / 60)} min ${String(secs % 60).padStart(2, "0")} s` : `${secs} s`;
        $("spinner-label").textContent = ui.spinnerLabel ? `${ui.spinnerLabel} · ${elapsed}` : elapsed;
    };
    paint();
    if (!ui.spinnerTimer) ui.spinnerTimer = setInterval(() => { if (ui.spinnerId) paint(); }, 1000);
    $("spinner").classList.remove("hidden");
}

