// 20-studio.js — favoris de prompts, brouillon par projet, export Markdown de la conversation.
// Portage adapté de extraopaa/francestudents-ide. Onglet Activité construit à partir des
// entrées en direct (plan, outils, sources, commandes), du compteur status.jobs et des points
// de reprise (undoList/undoEntry). Badge d'accès et mode focus. Export côté renderer (Blob).

const studioEntries = [];
let studioWorkspace = undefined;
let studioLastDraft = null;
let favoritePrompts = readStudioStorage("frst.prompt-favorites", []);
if (!Array.isArray(favoritePrompts)) favoritePrompts = [];

const starterFavorites = [
    { title: "Revue des changements", prompt: "Inspecte le diff Git local et recherche les bugs et régressions. Donne les fichiers et lignes concernés, le niveau de gravité et les vérifications utiles, sans modifier le code." },
    { title: "Corriger un bug", prompt: "Reproduis le problème suivant, identifie sa cause, corrige-le puis vérifie la correction : " },
    { title: "Écrire les tests utiles", prompt: "Inspecte le code et les tests existants. Identifie les comportements importants non couverts, ajoute les tests pertinents et lance-les." },
    { title: "Améliorer les performances", prompt: "Cherche un problème de performance mesurable. Établis une mesure de référence, propose et implémente une amélioration puis compare les résultats." },
    { title: "Documenter le projet", prompt: "Vérifie les commandes et le fonctionnement réel du projet, puis mets à jour sa documentation d'installation, d'utilisation et de test." }
];

function readStudioStorage(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        return raw === null ? fallback : JSON.parse(raw);
    } catch {
        return fallback;
    }
}

function writeStudioStorage(key, value) {
    try {
        localStorage.setItem(key, JSON.stringify(value));
    } catch {
        studioFeedback("Le stockage local est indisponible.");
    }
}

function studioFeedback(message) {
    const host = $("composer-feedback");
    if (!host) return;
    host.textContent = message || "";
    clearTimeout(studioFeedback.timer);
    if (message) studioFeedback.timer = setTimeout(() => { host.textContent = ""; }, 8000);
}

function studioDraftKey(workspace) {
    return `frst.draft:${workspace || "global"}`;
}

function saveStudioDraft() {
    if (studioWorkspace === undefined) return;
    studioLastDraft = input.value;
    writeStudioStorage(studioDraftKey(studioWorkspace), input.value);
}

function syncStudioWorkspace() {
    const workspace = (ui && ui.workspace) || null;
    if (studioWorkspace !== workspace) {
        const first = studioWorkspace === undefined;
        if (!first) saveStudioDraft();
        studioWorkspace = workspace;
        const stored = readStudioStorage(studioDraftKey(workspace), "");
        // Au premier passage, on n'écrase pas un texte déjà saisi.
        if (!first || !input.value) input.value = typeof stored === "string" ? stored : "";
        studioLastDraft = input.value;
        if (typeof autosizeInput === "function") autosizeInput();
        if (!first) studioEntries.length = 0;
        return;
    }
    // Rattrape les vidages de l'input sans événement « input » (envoi, import…).
    if (input.value !== studioLastDraft) saveStudioDraft();
}

function recordStudioEntry(entry) {
    if (!entry || typeof entry !== "object") return;
    if (entry.type === "user" && /^\/(new|clear)\b/.test(entry.text || "")) studioEntries.length = 0;
    if (["user", "assistant", "tool", "result", "error", "warn", "plan"].includes(entry.type)) {
        studioEntries.push({ ...entry, at: new Date().toISOString() });
        if (studioEntries.length > 3000) studioEntries.shift();
    }
}

function exportStudioMarkdown() {
    const header = `# Conversation FranceStudent Code\n\nProjet : ${studioWorkspace || "Aucun"}\nExport : ${new Date().toISOString()}\n\n`;
    return header + studioEntries.map((entry) => {
        if (entry.type === "user" || entry.type === "assistant") {
            return `## ${entry.type === "user" ? "Vous" : "Agent"}\n\n${entry.text || ""}\n`;
        }
        if (entry.type === "tool") {
            const label = typeof toolLabel === "function" ? toolLabel(entry.name) : entry.name;
            return `**${label}**\n\n\`\`\`text\n${entry.arg || ""}\n\`\`\`\n`;
        }
        if (entry.type === "plan") return `### Plan\n${(entry.items || []).map((item) => `- ${item}`).join("\n")}\n`;
        return `> ${String(entry.text || "").replace(/\n/g, "\n> ")}\n`;
    }).join("\n");
}

function downloadStudioMarkdown() {
    if (!studioEntries.length) {
        studioFeedback("Rien à exporter : la conversation est vide.");
        return;
    }
    const blob = new Blob([exportStudioMarkdown()], { type: "text/markdown;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    link.href = url;
    link.download = `conversation-${stamp}.md`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    studioFeedback("Conversation exportée en Markdown.");
}

function hideFavoritePrompts() {
    const panel = $("agent-favorites");
    if (panel) panel.classList.add("hidden");
}

function useFavoritePrompt(favorite) {
    input.value = favorite.prompt;
    saveStudioDraft();
    if (typeof autosizeInput === "function") autosizeInput();
    hideFavoritePrompts();
    input.focus();
}

function saveDraftAsFavorite() {
    const prompt = input.value.trim();
    if (!prompt) {
        studioFeedback("Écris un prompt avant de l'enregistrer.");
        return;
    }
    if (favoritePrompts.length >= 30) {
        studioFeedback("Tu as déjà 30 favoris. Retire un favori pour en ajouter un.");
        return;
    }
    favoritePrompts.unshift({ title: prompt.replace(/\s+/g, " ").slice(0, 55), prompt: prompt.slice(0, 30000) });
    writeStudioStorage("frst.prompt-favorites", favoritePrompts);
    renderFavoritePrompts();
    studioFeedback("Prompt enregistré en favori.");
}

function renderFavoritePrompts() {
    const list = $("favorite-list");
    if (!list) return;
    list.replaceChildren();
    const all = [...favoritePrompts, ...starterFavorites];
    all.forEach((favorite, index) => {
        const row = document.createElement("div");
        row.className = "favorite-row";
        const use = document.createElement("button");
        use.type = "button";
        use.className = "favorite-use";
        use.textContent = favorite.title;
        use.title = favorite.prompt;
        use.addEventListener("click", () => useFavoritePrompt(favorite));
        row.append(use);
        if (index < favoritePrompts.length) {
            const remove = document.createElement("button");
            remove.type = "button";
            remove.className = "favorite-remove";
            remove.textContent = "×";
            remove.setAttribute("aria-label", `Retirer ${favorite.title}`);
            remove.addEventListener("click", () => {
                favoritePrompts.splice(index, 1);
                writeStudioStorage("frst.prompt-favorites", favoritePrompts);
                renderFavoritePrompts();
            });
            row.append(remove);
        } else {
            row.classList.add("favorite-starter");
        }
        list.append(row);
    });
}

function buildStudioUi() {
    const hint = document.querySelector(".composer-actions .composer-hint") || document.querySelector(".composer-hint");
    if (!hint || $("favorite-open")) return;

    const makeButton = (id, text, title) => {
        const button = document.createElement("button");
        button.type = "button";
        button.id = id;
        button.className = "attach-btn studio-btn";
        button.textContent = text;
        button.title = title;
        button.setAttribute("aria-label", title);
        return button;
    };
    const favorites = makeButton("favorite-open", "☆", "Prompts favoris");
    const exporter = makeButton("conversation-export", "⇩", "Exporter la conversation en Markdown");
    hint.before(favorites, exporter);

    const feedback = document.createElement("span");
    feedback.id = "composer-feedback";
    feedback.className = "composer-feedback";
    feedback.setAttribute("role", "status");
    hint.after(feedback);

    const panel = document.createElement("div");
    panel.id = "agent-favorites";
    panel.className = "agent-favorites hidden";
    panel.innerHTML = `
        <div class="favorites-head">
            <strong>Prompts favoris</strong>
            <button type="button" id="draft-save-favorite" title="Enregistrer le texte du composer en favori">★ Enregistrer le brouillon</button>
            <button type="button" id="favorite-close" aria-label="Fermer">×</button>
        </div>
        <div id="favorite-list" class="favorite-list"></div>`;
    document.body.append(panel);

    favorites.addEventListener("click", (event) => {
        event.stopPropagation();
        renderFavoritePrompts();
        const rect = favorites.getBoundingClientRect();
        panel.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - 380))}px`;
        panel.style.bottom = `${Math.max(8, window.innerHeight - rect.top + 6)}px`;
        panel.classList.toggle("hidden");
    });
    exporter.addEventListener("click", downloadStudioMarkdown);
    $("favorite-close").addEventListener("click", hideFavoritePrompts);
    $("draft-save-favorite").addEventListener("click", saveDraftAsFavorite);
    document.addEventListener("mousedown", (event) => {
        if (!panel.classList.contains("hidden") && !panel.contains(event.target) && event.target !== favorites) hideFavoritePrompts();
    });
    document.addEventListener("keydown", (event) => {
        if (event.key === "Escape") hideFavoritePrompts();
    });
}

/* ---------- Activité, badge d'accès, mode focus ---------- */

let studioRun = null;
let studioBusy = false;
let studioJobs = 0;
let studioAccess = { autoApprove: false, autoApproveCommands: false, fullAccess: false };
let studioCheckpoints = [];
let studioCheckpointError = "";
let studioActivityPending = false;

function studioEsc(value) {
    if (typeof escapeHtml === "function") return escapeHtml(String(value ?? ""));
    return String(value ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

function newStudioRun(prompt) {
    return {
        prompt: String(prompt || "").replace(/\s+/g, " ").slice(0, 200),
        startedAt: Date.now(),
        endedAt: null,
        plan: [],
        actions: [],
        sources: [],
        commands: [],
        diffs: [],
        errors: 0,
        counts: { commands: 0, reads: 0, writes: 0, web: 0 }
    };
}

function trackStudioActivity(entry) {
    if (!entry || typeof entry !== "object") return;
    if (entry.type === "user") {
        studioRun = /^\/(new|clear)\b/.test(entry.text || "") ? null : newStudioRun(entry.text);
        scheduleStudioActivity();
        return;
    }
    if (!["plan", "tool", "result", "diff", "error"].includes(entry.type)) return;
    if (!studioRun) studioRun = newStudioRun("");
    const run = studioRun;
    if (entry.type === "plan") {
        run.plan = Array.isArray(entry.items) ? entry.items.slice(0, 50).map(String) : [];
    } else if (entry.type === "tool") {
        const name = String(entry.name || "");
        const arg = String(entry.arg || "");
        run.actions.push({ name, arg: arg.slice(0, 300), at: Date.now(), tone: null });
        if (run.actions.length > 200) run.actions.shift();
        if (name === "run_command") {
            run.counts.commands += 1;
            run.commands.push({ command: arg.split("\n")[0].slice(0, 200), at: Date.now(), tone: null });
            if (run.commands.length > 50) run.commands.shift();
        } else if (/^(read_file|list_directory|search_files|semantic_search|glob|grep|diagnostics)/.test(name)) {
            run.counts.reads += 1;
        } else if (/^(write_file|edit_file|create_file|delete_file|apply_patch|move_file|rename_file)/.test(name)) {
            run.counts.writes += 1;
        }
        if (/web|fetch|browse/.test(name)) {
            run.counts.web += 1;
            const urls = arg.match(/https?:\/\/[^\s"'<>)\]]+/g) || [];
            const items = urls.length ? urls : (arg.trim() ? [`Recherche : ${arg.trim().slice(0, 120)}`] : []);
            for (const item of items) {
                if (!run.sources.includes(item) && run.sources.length < 50) run.sources.push(item);
            }
        }
    } else if (entry.type === "result") {
        const tone = entry.tone || "ok";
        const last = run.actions[run.actions.length - 1];
        if (last && !last.tone) last.tone = tone;
        const command = run.commands[run.commands.length - 1];
        if (command && !command.tone && last && last.name === "run_command") command.tone = tone;
    } else if (entry.type === "diff") {
        run.diffs.push({ path: String(entry.path || ""), added: entry.added || 0, removed: entry.removed || 0 });
        if (run.diffs.length > 100) run.diffs.shift();
    } else if (entry.type === "error") {
        run.errors += 1;
    }
    scheduleStudioActivity();
}

function studioActivityVisible() {
    const panel = $("agent-activity");
    return Boolean(panel && !panel.classList.contains("hidden"));
}

function scheduleStudioActivity() {
    if (studioActivityPending || !studioActivityVisible()) return;
    studioActivityPending = true;
    requestAnimationFrame(() => {
        studioActivityPending = false;
        renderStudioActivity();
    });
}

function studioDuration(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    return s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, "0")} s`;
}

function studioTime(value) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "" : date.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function studioLabel(name) {
    return typeof toolLabel === "function" ? toolLabel(name) : name;
}

function renderStudioActivity() {
    const panel = $("agent-activity");
    if (!panel) return;
    const run = studioRun;
    const parts = [];
    if (!run) {
        parts.push(`<section class="activity-card"><h3>Exécution</h3><p class="studio-muted">Aucune exécution depuis l'ouverture ou depuis /new.</p></section>`);
    } else {
        const running = studioBusy && !run.endedAt;
        const elapsed = (run.endedAt || Date.now()) - run.startedAt;
        const state = running ? "En cours" : run.errors ? "Terminée avec erreurs" : "Terminée";
        parts.push(`<section class="activity-card">
            <h3>Exécution <span class="activity-state ${running ? "is-running" : run.errors ? "is-error" : "is-done"}">${state}</span></h3>
            ${run.prompt ? `<p class="activity-prompt">${studioEsc(run.prompt)}</p>` : ""}
            <p class="studio-muted">Durée : ${studioDuration(elapsed)} · ${run.counts.reads} lecture(s) · ${run.counts.writes} écriture(s) · ${run.counts.commands} commande(s) · ${run.counts.web} accès web</p>
        </section>`);
        parts.push(`<section class="activity-card"><h3>Plan</h3>${run.plan.length
            ? `<ol class="activity-plan">${run.plan.map((item) => `<li>${studioEsc(item)}</li>`).join("")}</ol>`
            : `<p class="studio-muted">L'agent n'a pas publié de plan pour cette exécution.</p>`}</section>`);
        const actions = run.actions.slice(-25).reverse();
        parts.push(`<section class="activity-card"><h3>Actions récentes</h3>${actions.length
            ? `<ul class="activity-list">${actions.map((a) => `<li class="tone-${studioEsc(a.tone || "pending")}"><span class="activity-time">${studioTime(a.at)}</span> <strong>${studioEsc(studioLabel(a.name))}</strong> <code>${studioEsc(a.arg.split("\n")[0].slice(0, 120))}</code></li>`).join("")}</ul>`
            : `<p class="studio-muted">Aucune action d'outil.</p>`}</section>`);
        if (run.diffs.length) {
            parts.push(`<section class="activity-card"><h3>Fichiers modifiés</h3><ul class="activity-list">${run.diffs.map((d) => `<li><code>${studioEsc(d.path)}</code> <span class="activity-add">+${d.added}</span> <span class="activity-del">−${d.removed}</span></li>`).join("")}</ul></section>`);
        }
        parts.push(`<section class="activity-card"><h3>Sources</h3>${run.sources.length
            ? `<ul class="activity-list">${run.sources.map((s) => `<li>${/^https?:/.test(s) ? `<a href="${studioEsc(s)}" target="_blank" rel="noopener noreferrer">${studioEsc(s)}</a>` : studioEsc(s)}</li>`).join("")}</ul>`
            : `<p class="studio-muted">Aucune source web consultée.</p>`}</section>`);
    }
    const commands = run ? run.commands.slice(-10).reverse() : [];
    parts.push(`<section class="activity-card"><h3>Commandes et tâches en arrière-plan</h3>
        <p class="studio-muted">${studioJobs ? `${studioJobs} commande(s) en arrière-plan en cours.` : "Aucune commande en arrière-plan en cours."}
        <button type="button" class="activity-link" data-activity="jobs">Lister (/jobs)</button></p>
        ${commands.length ? `<ul class="activity-list">${commands.map((c) => `<li class="tone-${studioEsc(c.tone || "pending")}"><span class="activity-time">${studioTime(c.at)}</span> <code>${studioEsc(c.command)}</code></li>`).join("")}</ul>` : ""}
    </section>`);
    parts.push(`<section class="activity-card"><h3>Points de reprise <button type="button" class="activity-link" data-activity="refresh">Actualiser</button></h3>
        ${studioCheckpointError ? `<p class="studio-muted">${studioEsc(studioCheckpointError)}</p>` : ""}
        ${studioCheckpoints.length
            ? `<ul class="activity-list">${studioCheckpoints.slice(0, 30).map((c, i) => `<li><span class="activity-time">${studioTime(c.at)}</span> ${studioEsc(c.label || c.kind || "Modification")} <span class="studio-muted">${studioEsc((c.paths || []).slice(0, 3).join(", "))}${(c.paths || []).length > 3 ? "…" : ""}</span> <button type="button" class="activity-link" data-activity="undo" data-index="${i}" ${studioBusy ? "disabled" : ""}>Annuler</button></li>`).join("")}</ul>`
            : (studioCheckpointError ? "" : `<p class="studio-muted">Aucune modification annulable.</p>`)}
    </section>`);
    panel.innerHTML = parts.join("");
}

async function loadStudioCheckpoints() {
    try {
        const list = await api.undoList();
        studioCheckpoints = Array.isArray(list) ? list : [];
        studioCheckpointError = "";
    } catch (error) {
        studioCheckpoints = [];
        studioCheckpointError = `Points de reprise indisponibles : ${error.message || error}`;
    }
    renderStudioActivity();
}

async function undoStudioCheckpoint(position) {
    const checkpoint = studioCheckpoints[position];
    if (!checkpoint) return;
    if (studioBusy) {
        studioFeedback("Attends la fin de l'exécution pour annuler une modification.");
        return;
    }
    const files = (checkpoint.paths || []).join(", ") || "fichiers concernés";
    if (!window.confirm(`Annuler « ${checkpoint.label || checkpoint.kind || "modification"} » ?\n\n${files}`)) return;
    try {
        await api.undoEntry(checkpoint.index, checkpoint.at);
        studioFeedback("Modification annulée.");
    } catch (error) {
        studioFeedback(`Annulation impossible : ${error.message || error}`);
    }
    await loadStudioCheckpoints();
}

function setAgentTab(name) {
    const activity = name === "activity";
    const transcript = $("transcript");
    const panel = $("agent-activity");
    if (!panel || !transcript) return;
    transcript.classList.toggle("hidden", activity);
    panel.classList.toggle("hidden", !activity);
    document.querySelectorAll("[data-agent-tab]").forEach((tab) => {
        const selected = tab.dataset.agentTab === name;
        tab.classList.toggle("active", selected);
        tab.setAttribute("aria-selected", String(selected));
    });
    if (activity) {
        renderStudioActivity();
        loadStudioCheckpoints();
    }
}

function renderAccessBadge() {
    const badge = $("agent-access");
    if (!badge) return;
    let text = "Sur approbation";
    let level = "ask";
    if (studioAccess.fullAccess) {
        text = "Full accès";
        level = "full";
    } else if (studioAccess.autoApprove && studioAccess.autoApproveCommands) {
        text = "Automatique";
        level = "auto";
    } else if (studioAccess.autoApprove || studioAccess.autoApproveCommands) {
        text = studioAccess.autoApprove ? "Auto (écritures)" : "Auto (commandes)";
        level = "partial";
    }
    badge.textContent = text;
    badge.dataset.level = level;
    badge.title = `Niveau d'accès de l'agent : ${text}. Cliquer pour ouvrir les réglages.`;
}

async function refreshStudioAccess() {
    try {
        const s = await api.setAutoApprove("");
        if (s && typeof s === "object") {
            studioAccess = {
                autoApprove: Boolean(s.autoApprove),
                autoApproveCommands: Boolean(s.autoApproveCommands),
                fullAccess: Boolean(s.fullAccess)
            };
        }
    } catch {
        /* le badge garde les valeurs du dernier statut */
    }
    renderAccessBadge();
}

function applyStudioStatus(s) {
    if (!s || typeof s !== "object") return;
    const wasBusy = studioBusy;
    if (s.busy !== undefined) studioBusy = Boolean(s.busy);
    if (s.jobs !== undefined) studioJobs = Number(s.jobs) || 0;
    if (s.autoApprove !== undefined) studioAccess.autoApprove = Boolean(s.autoApprove);
    if (s.autoApproveCommands !== undefined) studioAccess.autoApproveCommands = Boolean(s.autoApproveCommands);
    if (s.fullAccess !== undefined) studioAccess.fullAccess = Boolean(s.fullAccess);
    renderAccessBadge();
    if (wasBusy && !studioBusy) {
        if (studioRun && !studioRun.endedAt) studioRun.endedAt = Date.now();
        if (studioActivityVisible()) loadStudioCheckpoints();
    }
    scheduleStudioActivity();
}

function setAgentFocus(on) {
    const app = $("app") || document.body;
    app.classList.toggle("focus-agent", on);
    const button = $("agent-focus");
    if (button) {
        button.setAttribute("aria-pressed", String(on));
        button.title = on ? "Quitter le mode focus" : "Mode focus : afficher seulement l'agent";
    }
    writeStudioStorage("frst.agent-focus", on);
}

function buildAgentStudioUi() {
    const agent = $("agent");
    const header = agent && agent.querySelector(".agent-header");
    const transcript = $("transcript");
    if (!agent || !header || !transcript || $("agent-activity")) return;
    const title = header.querySelector(".agent-title") || header;

    const badge = document.createElement("button");
    badge.type = "button";
    badge.id = "agent-access";
    badge.className = "agent-access";
    badge.addEventListener("click", () => {
        if (typeof showSideView === "function") showSideView("settings");
    });
    const focus = document.createElement("button");
    focus.type = "button";
    focus.id = "agent-focus";
    focus.className = "agent-focus";
    focus.textContent = "⛶";
    focus.setAttribute("aria-label", "Mode focus");
    focus.addEventListener("click", () => setAgentFocus(!($("app") || document.body).classList.contains("focus-agent")));
    title.append(badge, focus);

    const tabs = document.createElement("div");
    tabs.className = "agent-tabs";
    tabs.setAttribute("role", "tablist");
    for (const [name, label] of [["conversation", "Conversation"], ["activity", "Activité"]]) {
        const tab = document.createElement("button");
        tab.type = "button";
        tab.className = "agent-tab";
        tab.dataset.agentTab = name;
        tab.setAttribute("role", "tab");
        tab.textContent = label;
        tab.addEventListener("click", () => setAgentTab(name));
        tabs.append(tab);
    }
    // Icônes (historique, analyse, nouvelle conversation, effacer) : à droite de la barre des onglets.
    const tabActions = document.createElement("div");
    tabActions.className = "agent-tabs-actions";
    for (const id of ["btn-history", "btn-analyze", "btn-new", "btn-clear"]) {
        const button = $(id);
        if (button) tabActions.append(button);
    }
    if (tabActions.childElementCount) tabs.append(tabActions);
    header.after(tabs);

    const panel = document.createElement("div");
    panel.id = "agent-activity";
    panel.className = "agent-activity hidden";
    panel.setAttribute("role", "tabpanel");
    panel.addEventListener("click", (event) => {
        const target = event.target.closest("[data-activity]");
        if (!target) return;
        const kind = target.dataset.activity;
        if (kind === "refresh") loadStudioCheckpoints();
        else if (kind === "undo") undoStudioCheckpoint(Number(target.dataset.index));
        else if (kind === "jobs") {
            input.value = "/jobs";
            saveStudioDraft();
            setAgentTab("conversation");
            input.focus();
            studioFeedback("Appuie sur Entrée pour lister les commandes en arrière-plan.");
        }
    });
    transcript.after(panel);

    setAgentTab("conversation");
    setAgentFocus(readStudioStorage("frst.agent-focus", false) === true);
    renderAccessBadge();
    for (const id of ["set-perm-writes", "set-perm-commands"]) {
        const control = $(id);
        if (control) control.addEventListener("change", () => setTimeout(refreshStudioAccess, 300));
    }
}

buildStudioUi();
buildAgentStudioUi();
refreshStudioAccess();
input.addEventListener("input", saveStudioDraft);
window.addEventListener("beforeunload", saveStudioDraft);
api.onEvent((channel, data) => {
    if (channel === "entry") {
        recordStudioEntry(data);
        trackStudioActivity(data);
    } else if (channel === "status") {
        applyStudioStatus(data);
    }
});
setInterval(syncStudioWorkspace, 1500);
setInterval(() => {
    if (studioBusy) scheduleStudioActivity();
}, 1000);
