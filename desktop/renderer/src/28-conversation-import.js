// 28-conversation-import.js — reprise d'une conversation Codex (lien chatgpt.com/s/cx_…, export ou texte collé).
// Seul le contexte est importé : il devient une pièce jointe Markdown du composer, rien n'est exécuté.

const conversationImport = { preview: null, sequence: 0, working: false };

function conversationImportUnwrap(result) {
    if (result && typeof result === "object" && "ok" in result && ("value" in result || "error" in result || "reason" in result)) {
        if (!result.ok) throw new Error(result.error || result.reason || "Import impossible.");
        return result.value;
    }
    return result;
}

function conversationImportFeedback(text) {
    if (typeof studioFeedback === "function") return studioFeedback(text);
    const hint = document.querySelector(".composer-hint");
    if (!hint) return undefined;
    if (hint.dataset.defaultText === undefined) hint.dataset.defaultText = hint.textContent;
    hint.textContent = text;
    clearTimeout(conversationImportFeedback.timer);
    conversationImportFeedback.timer = setTimeout(() => {
        hint.textContent = hint.dataset.defaultText || "";
    }, 8000);
    return undefined;
}

function buildConversationImportDialog() {
    const existing = $("conversation-import-dialog");
    if (existing) return existing;
    const dialog = document.createElement("dialog");
    dialog.id = "conversation-import-dialog";
    dialog.className = "conversation-import-dialog";
    dialog.innerHTML = `
        <h2>Reprendre une conversation Codex <span class="ci-beta">bêta</span></h2>
        <div class="ci-row">
            <span>Projet : <strong id="conversation-import-project">—</strong></span>
            <button type="button" id="conversation-import-open-project">Ouvrir un projet…</button>
        </div>
        <label class="ci-field">Lien partagé (chatgpt.com/s/cx_…)
            <input id="conversation-import-url" type="url" placeholder="https://chatgpt.com/s/cx_..." spellcheck="false">
        </label>
        <label class="ci-field">… ou colle un export (Markdown, JSON, HTML)
            <textarea id="conversation-import-text" rows="5" spellcheck="false"></textarea>
        </label>
        <div class="ci-actions">
            <button type="button" id="conversation-import-file">Choisir un fichier d'export…</button>
            <button type="button" id="conversation-import-source" class="primary">Analyser</button>
        </div>
        <section id="conversation-import-preview" class="ci-preview hidden">
            <div id="conversation-import-result" class="ci-result"></div>
            <ul id="conversation-import-warnings" class="ci-warnings"></ul>
            <div id="conversation-import-excerpt" class="ci-excerpt"></div>
            <div class="ci-choices">
                <label class="ci-field">Modèle <select id="conversation-import-model"></select></label>
                <label class="ci-field">Mode
                    <select id="conversation-import-mode">
                        <option value="agent">Agent</option>
                        <option value="chat">Chat</option>
                    </select>
                </label>
            </div>
        </section>
        <div class="ci-footer">
            <span id="conversation-import-status" class="ci-status" role="status"></span>
            <button type="button" id="conversation-import-close">Fermer</button>
            <button type="button" id="conversation-import-apply" class="primary" disabled>Reprendre ici</button>
        </div>`;
    document.body.append(dialog);
    return dialog;
}

function conversationImportControls() {
    return {
        dialog: $("conversation-import-dialog"),
        project: $("conversation-import-project"),
        openProject: $("conversation-import-open-project"),
        url: $("conversation-import-url"),
        file: $("conversation-import-file"),
        source: $("conversation-import-source"),
        text: $("conversation-import-text"),
        preview: $("conversation-import-preview"),
        status: $("conversation-import-status"),
        warnings: $("conversation-import-warnings"),
        result: $("conversation-import-result"),
        excerpt: $("conversation-import-excerpt"),
        model: $("conversation-import-model"),
        mode: $("conversation-import-mode"),
        close: $("conversation-import-close"),
        apply: $("conversation-import-apply")
    };
}

function setConversationImportStatus(text, isError = false) {
    const c = conversationImportControls();
    if (!c.status) return;
    c.status.textContent = text || "";
    c.status.classList.toggle("error", Boolean(isError));
}

function setConversationImportBusy(working) {
    conversationImport.working = working;
    const c = conversationImportControls();
    for (const button of [c.file, c.source, c.openProject]) if (button) button.disabled = working;
    if (c.apply) c.apply.disabled = working || !conversationImport.preview;
}

function invalidateConversationImport() {
    conversationImport.sequence += 1;
    conversationImport.preview = null;
    const c = conversationImportControls();
    if (c.preview) c.preview.classList.add("hidden");
    if (c.apply) c.apply.disabled = true;
    setConversationImportStatus("");
}

function renderConversationImportProject() {
    const c = conversationImportControls();
    if (c.project) c.project.textContent = (ui && ui.workspace) || "aucun projet ouvert";
}

function renderConversationImportPreview(preview) {
    const c = conversationImportControls();
    c.result.textContent = `${preview.title} — ${preview.messageCount} message(s), ${preview.chars} caractères · ${preview.source}`;
    c.warnings.replaceChildren(...(preview.warnings || []).map((warning) => {
        const li = document.createElement("li");
        li.textContent = warning;
        return li;
    }));
    c.excerpt.replaceChildren(...(preview.excerpt || []).map((message) => {
        const item = document.createElement("div");
        item.className = `ci-message ci-${message.role === "user" ? "user" : "assistant"}`;
        const role = document.createElement("strong");
        role.textContent = message.role === "user" ? "Toi" : "Assistant";
        const body = document.createElement("pre");
        body.textContent = message.text;
        item.append(role, body);
        return item;
    }));
    c.preview.classList.remove("hidden");
    c.apply.disabled = false;
}

async function populateConversationImportModels() {
    const c = conversationImportControls();
    try {
        const data = conversationImportUnwrap(await api.models()) || {};
        const agents = Array.isArray(data.agents) ? data.agents : [];
        const current = data.current != null ? data.current : ui.currentModelId;
        c.model.replaceChildren(...agents.map((agent) => {
            const option = document.createElement("option");
            option.value = String(agent.id);
            option.textContent = agent.name || `Modèle ${agent.id}`;
            option.selected = String(agent.id) === String(current);
            return option;
        }));
    } catch {
        c.model.replaceChildren();
    }
    const mode = ui.status && ui.status.mode;
    c.mode.value = mode === "chat" ? "chat" : "agent";
}

async function analyzeConversationImport(kind) {
    if (conversationImport.working) return;
    const c = conversationImportControls();
    invalidateConversationImport();
    const sequence = conversationImport.sequence;
    setConversationImportBusy(true);
    setConversationImportStatus("Analyse en cours…");
    try {
        let preview;
        if (kind === "file") {
            preview = conversationImportUnwrap(await api.importConversation("file"));
            if (!preview || preview.canceled) {
                setConversationImportStatus("");
                return;
            }
        } else {
            const url = c.url.value.trim();
            const text = c.text.value;
            if (url) preview = conversationImportUnwrap(await api.importConversation("preview", { url }));
            else if (text.trim()) preview = conversationImportUnwrap(await api.importConversation("preview", { content: text }));
            else throw new Error("Colle un lien chatgpt.com/s/cx_…, un export, ou choisis un fichier.");
        }
        if (sequence !== conversationImport.sequence) return;
        conversationImport.preview = preview;
        renderConversationImportPreview(preview);
        setConversationImportStatus("Aperçu prêt : vérifie le contenu puis clique sur « Reprendre ici ».");
    } catch (error) {
        if (sequence === conversationImport.sequence) setConversationImportStatus(error.message || String(error), true);
    } finally {
        setConversationImportBusy(false);
    }
}

async function applyConversationImport() {
    const preview = conversationImport.preview;
    if (!preview || conversationImport.working) return;
    const c = conversationImportControls();
    setConversationImportBusy(true);
    setConversationImportStatus("Import…");
    try {
        const modelId = Number(c.model.value);
        const result = conversationImportUnwrap(await api.importConversation("apply", {
            token: preview.token,
            modelId: Number.isFinite(modelId) ? modelId : undefined,
            mode: c.mode.value
        }));
        conversationImport.preview = null;
        pendingAttachments.push(result.attachment);
        const draft = input.value.trimEnd();
        input.value = draft ? `${draft}\n\n${result.prompt}` : result.prompt;
        renderAttachments();
        if (typeof autosizeInput === "function") autosizeInput(input);
        try {
            applyStatus(await api.status());
        } catch { /* statut rafraîchi au prochain push */ }
        c.dialog.close();
        conversationImportFeedback("Conversation importée en pièce jointe : relis le message puis envoie-le.");
        input.focus();
    } catch (error) {
        setConversationImportStatus(error.message || String(error), true);
    } finally {
        setConversationImportBusy(false);
    }
}

async function openProjectFromConversationImport() {
    try {
        if (typeof openProject === "function") await openProject();
        else {
            conversationImportUnwrap(await api.openProject());
            applyStatus(await api.status());
        }
    } catch (error) {
        setConversationImportStatus(error.message || String(error), true);
    }
    renderConversationImportProject();
}

async function openConversationImport() {
    const dialog = buildConversationImportDialog();
    renderConversationImportProject();
    await populateConversationImportModels();
    if (!dialog.open) dialog.showModal();
    conversationImportControls().url.focus();
}

function initConversationImport() {
    const attach = $("btn-attach");
    if (!attach || $("conversation-import")) return;
    const button = document.createElement("button");
    button.type = "button";
    button.id = "conversation-import";
    button.className = "attach-btn conversation-import-btn";
    button.title = "Reprendre une conversation Codex (lien partagé, export ou texte)";
    button.textContent = "⤓ Codex";
    attach.after(button);

    buildConversationImportDialog();
    const c = conversationImportControls();
    button.addEventListener("click", () => { openConversationImport(); });
    c.source.addEventListener("click", () => { analyzeConversationImport("source"); });
    c.file.addEventListener("click", () => { analyzeConversationImport("file"); });
    c.apply.addEventListener("click", () => { applyConversationImport(); });
    c.close.addEventListener("click", () => c.dialog.close());
    c.openProject.addEventListener("click", () => { openProjectFromConversationImport(); });
    for (const field of [c.url, c.text]) {
        field.addEventListener("input", () => {
            if (conversationImport.preview) invalidateConversationImport();
        });
    }
    c.url.addEventListener("keydown", (event) => {
        if (event.key === "Enter") {
            event.preventDefault();
            analyzeConversationImport("source");
        }
    });
}

initConversationImport();
