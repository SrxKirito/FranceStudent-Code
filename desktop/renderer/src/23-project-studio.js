// 23-project-studio.js — cockpit du projet : vue d'ensemble, commandes, qualité et boîte à outils.
// Portage adapté de extraopaa/francestudents-ide. Le cockpit est un panneau superposé ouvert
// depuis la barre d'activité (pas de nouvelle vue latérale). API : api.projectStudio.
// Préfixe pstudio : les noms studio* sont déjà utilisés par 20-studio.js et 24-editor-studio.js.

const PSTUDIO_ICON = `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><path d="M14 17.5h7M17.5 14v7"/></svg>`;

const PSTUDIO_KINDS = { dev: "Développement", test: "Tests", build: "Build", quality: "Qualité", custom: "Personnelle", other: "Autre" };
const PSTUDIO_STATUS = { running: "En cours", passed: "Réussi", failed: "Échec", stopped: "Arrêté" };
const PSTUDIO_PROMPTS = [
    ["Revue de code", "Fais une revue de code des changements récents du projet : bugs, sécurité, lisibilité. Propose des corrections concrètes."],
    ["Ajouter des tests", "Repère les parties du projet les moins testées, puis propose et écris des tests pertinents."],
    ["Audit de sécurité", "Fais un audit de sécurité du projet (dépendances, secrets, entrées utilisateur, commandes lancées) et classe les risques par gravité."],
    ["Performance", "Analyse les points de lenteur probables du projet et propose des optimisations mesurables."],
    ["Documentation", "Mets à jour ou rédige le README : installation, commandes utiles, architecture et contribution."],
    ["Expliquer le projet", "Explique l'architecture de ce projet : dossiers principaux, flux de données et points d'entrée."]
];
const PSTUDIO_TRANSFORMS = [
    ["json", "Formater du JSON"],
    ["json-min", "Minifier du JSON"],
    ["base64-encode", "Encoder en Base64"],
    ["base64-decode", "Décoder du Base64"],
    ["url-encode", "Encoder une URL"],
    ["url-decode", "Décoder une URL"],
    ["sha256", "Empreinte SHA-256"],
    ["uuid", "Générer un UUID"],
    ["sort", "Trier les lignes"],
    ["unique", "Dédupliquer les lignes"]
];

const pstudioState = { data: null, selectedRun: null, filter: "", kind: "all", tab: "overview", timer: null, loading: false };

document.body.insertAdjacentHTML("beforeend", `<section id="project-studio" class="studio-page hidden" aria-labelledby="pstudio-title"><header class="studio-head"><div><h2 id="pstudio-title">Cockpit du projet</h2><p id="pstudio-subtitle" class="studio-muted"></p></div><div class="studio-head-actions"><button type="button" id="pstudio-refresh">Actualiser</button><button type="button" id="pstudio-close" aria-label="Fermer">×</button></div></header><nav class="studio-tabs" role="tablist"><button type="button" data-studio-tab="overview" class="active">Vue d'ensemble</button><button type="button" data-studio-tab="tasks">Commandes</button><button type="button" data-studio-tab="quality">Qualité</button><button type="button" data-studio-tab="tools">Outils</button></nav><p id="pstudio-message" class="studio-message" role="status"></p><div class="studio-body"><div class="studio-tab-page" data-studio-page="overview"><div id="pstudio-stats" class="studio-stats"></div><p id="pstudio-description" class="studio-muted"></p><div id="pstudio-stack" class="studio-pills"></div><div class="studio-two-columns"><section class="studio-card"><h3>Actions rapides</h3><div id="pstudio-quick" class="studio-quick-grid"></div></section><section class="studio-card"><h3>Documentation</h3><div id="pstudio-docs" class="studio-doc-list"></div></section></div></div><div class="studio-tab-page hidden" data-studio-page="tasks"><div class="center-filters"><input id="pstudio-filter" placeholder="Filtrer les commandes" aria-label="Filtrer les commandes" spellcheck="false"><select id="pstudio-kind" aria-label="Type de commande"><option value="all">Tous les types</option><option value="dev">Développement</option><option value="test">Tests</option><option value="build">Build</option><option value="quality">Qualité</option><option value="custom">Personnelles</option><option value="other">Autres</option></select><button type="button" id="pstudio-add">Ajouter une commande</button></div><div id="pstudio-tasks" class="studio-task-grid"></div><div class="studio-two-columns"><section class="studio-card"><div class="studio-card-head"><h3>Exécutions</h3><button type="button" id="pstudio-clear">Effacer les terminées</button></div><div id="pstudio-runs"></div></section><section class="studio-card"><h3 id="pstudio-log-title">Journal</h3><pre id="pstudio-log" class="studio-log"></pre></section></div></div><div class="studio-tab-page hidden" data-studio-page="quality"><div class="studio-two-columns"><section class="studio-card"><h3>Demander à l'agent</h3><div id="pstudio-quality" class="studio-quick-grid"></div></section><section class="studio-card"><div class="studio-card-head"><h3>Environnement</h3><button type="button" id="pstudio-diagnose">Diagnostiquer</button></div><div id="pstudio-env"><p class="studio-muted">Cliquez sur « Diagnostiquer » pour vérifier Node.js, npm et Git.</p></div></section></div></div><div class="studio-tab-page hidden" data-studio-page="tools"><section class="studio-card"><h3>Boîte à outils</h3><div class="center-filters"><select id="pstudio-transform" aria-label="Transformation"></select><button type="button" id="pstudio-transform-run" class="primary">Appliquer</button><button type="button" id="pstudio-transform-copy">Copier le résultat</button></div><div class="studio-two-columns"><label class="center-code-label">Entrée<textarea id="pstudio-tool-in" rows="12" spellcheck="false"></textarea></label><label class="center-code-label">Résultat<textarea id="pstudio-tool-out" rows="12" spellcheck="false" readonly></textarea></label></div></section></div></div></section><dialog id="studio-task-dialog" class="center-dialog" aria-labelledby="studio-task-title"><form id="studio-task-form"><div class="center-dialog-head"><h2 id="studio-task-title">Nouvelle commande</h2><button type="button" id="studio-task-close" aria-label="Fermer">×</button></div><label class="center-code-label">Nom<input id="studio-task-name" maxlength="100" spellcheck="false"></label><label class="center-code-label">Commande<textarea id="studio-task-command" rows="4" maxlength="8000" spellcheck="false"></textarea></label><p id="studio-task-message" class="studio-message" role="status"></p><div class="center-dialog-actions"><button type="button" id="studio-task-cancel">Annuler</button><button type="submit" class="primary">Ajouter</button></div></form></dialog>`);

/* ---------- Bouton de la barre d'activité ---------- */

const pstudioButton = (() => {
    const bar = $("activity-bar");
    const button = document.createElement("button");
    const model = bar ? bar.querySelector("button") : null;
    if (model) button.className = model.className.replace(/\bactive\b/g, "").trim();
    button.id = "btn-project-studio";
    button.type = "button";
    button.title = "Cockpit du projet";
    button.setAttribute("aria-label", "Cockpit du projet");
    button.innerHTML = PSTUDIO_ICON;
    if (bar) bar.prepend(button);
    return button;
})();

function pstudioIsOpen() {
    return !$("project-studio").classList.contains("hidden");
}

function pstudioOpen(tab) {
    $("project-studio").classList.remove("hidden");
    pstudioButton.classList.add("active");
    if (tab) pstudioSetTab(tab);
    pstudioRefresh();
}

function pstudioClose() {
    $("project-studio").classList.add("hidden");
    pstudioButton.classList.remove("active");
}

pstudioButton.onclick = () => (pstudioIsOpen() ? pstudioClose() : pstudioOpen());

if ($("activity-bar")) {
    $("activity-bar").addEventListener("click", (event) => {
        const button = event.target.closest("button");
        if (button && button !== pstudioButton && pstudioIsOpen()) pstudioClose();
    });
}

/* ---------- Messages et onglets ---------- */

function pstudioMessage(text, isError = false) {
    const node = $("pstudio-message");
    node.textContent = text || "";
    node.classList.toggle("error", Boolean(isError));
}

function pstudioError(error) {
    pstudioMessage(error && error.message ? error.message : String(error), true);
}

function pstudioSetTab(name) {
    pstudioState.tab = name;
    for (const tab of document.querySelectorAll("#project-studio [data-studio-tab]")) {
        const active = tab.dataset.studioTab === name;
        tab.classList.toggle("active", active);
        tab.setAttribute("aria-selected", String(active));
    }
    for (const page of document.querySelectorAll("#project-studio [data-studio-page]")) {
        page.classList.toggle("hidden", page.dataset.studioPage !== name);
    }
    if (name === "tasks") pstudioLoadLog();
}

function pstudioBindTab(tab) {
    tab.setAttribute("role", "tab");
    tab.addEventListener("click", () => pstudioSetTab(tab.dataset.studioTab));
}

document.querySelectorAll("#project-studio [data-studio-tab]").forEach(pstudioBindTab);

/* ---------- Données et rendu ---------- */

async function pstudioRefresh() {
    if (pstudioState.loading) return;
    pstudioState.loading = true;
    try {
        pstudioState.data = await api.projectStudio("overview");
        if (pstudioState.selectedRun && !pstudioState.data.runs.some((run) => run.id === pstudioState.selectedRun)) pstudioState.selectedRun = null;
        pstudioRender();
        pstudioMessage("");
    } catch (error) {
        pstudioError(error);
    } finally {
        pstudioState.loading = false;
    }
}

function pstudioQuick(title, detail, handler) {
    const button = centerButton("", handler);
    button.className = "studio-quick";
    button.append(centerNode("strong", "", title), centerNode("span", "studio-muted", detail));
    return button;
}

function pstudioRender() {
    const data = pstudioState.data;
    if (!data) return;
    $("pstudio-title").textContent = data.workspace ? `Cockpit — ${data.name}` : "Cockpit du projet";
    $("pstudio-subtitle").textContent = data.workspace || "Ouvrez un projet pour utiliser le cockpit.";
    pstudioRenderOverview(data);
    pstudioRenderTasks();
    pstudioRenderRuns(data.runs);
}

function pstudioRenderOverview(data) {
    const stats = $("pstudio-stats");
    stats.replaceChildren();
    const running = data.runs.filter((run) => run.status === "running").length;
    const failed = data.runs.filter((run) => run.status === "failed").length;
    for (const [label, value] of [["Commandes", data.tasks.length], ["En cours", running], ["Échecs", failed], ["Gestionnaire", data.packageManager || "—"]]) {
        const stat = centerNode("div", "studio-stat");
        stat.append(centerNode("strong", "", String(value)), centerNode("span", "studio-muted", label));
        stats.append(stat);
    }
    $("pstudio-description").textContent = data.description || "";
    $("pstudio-stack").replaceChildren(...data.stack.map((item) => centerNode("span", "studio-pill", item)));

    const quick = $("pstudio-quick");
    quick.replaceChildren();
    if (!data.workspace) {
        quick.append(centerNode("p", "studio-muted", "Aucun projet ouvert."));
    } else {
        for (const kind of ["dev", "test", "build", "quality"]) {
            const task = data.tasks.find((item) => item.kind === kind);
            if (task) quick.append(pstudioQuick(`${PSTUDIO_KINDS[kind]} : ${task.name}`, task.command, () => pstudioStart(task.id)));
        }
        quick.append(pstudioQuick("Toutes les commandes", `${data.tasks.length} détectée(s)`, () => pstudioSetTab("tasks")));
        quick.append(pstudioQuick("Nouvelle commande", "Enregistrée dans .frst/tasks.json", () => pstudioOpenTaskDialog()));
    }

    const docs = $("pstudio-docs");
    docs.replaceChildren();
    if (!data.docs.length) docs.append(centerNode("p", "studio-muted", "Aucun document (README, CONTRIBUTING…) à la racine."));
    for (const doc of data.docs) {
        docs.append(centerButton(doc, async () => {
            pstudioClose();
            await openFile(doc);
        }));
    }
}

function pstudioRenderTasks() {
    const box = $("pstudio-tasks");
    box.replaceChildren();
    const data = pstudioState.data;
    if (!data || !data.workspace) {
        box.append(centerNode("p", "studio-muted", "Aucun projet ouvert."));
        return;
    }
    const filter = pstudioState.filter.toLowerCase();
    const list = data.tasks.filter((task) => (pstudioState.kind === "all" || task.kind === pstudioState.kind)
        && (!filter || `${task.name} ${task.command} ${task.description}`.toLowerCase().includes(filter)));
    if (!list.length) {
        box.append(centerNode("p", "studio-muted", data.tasks.length ? "Aucune commande ne correspond au filtre." : "Aucune commande détectée : ajoutez-en une."));
        return;
    }
    for (const task of list) {
        const card = centerNode("article", "studio-card studio-task");
        const head = centerNode("div", "studio-card-head");
        head.append(centerNode("strong", "", task.name), centerNode("span", "studio-pill", PSTUDIO_KINDS[task.kind] || task.kind));
        card.append(head, centerNode("code", "studio-command", task.command));
        if (task.description && task.description !== task.command) card.append(centerNode("p", "studio-muted", task.description));
        const actions = centerNode("div", "center-item-actions");
        const running = data.runs.find((run) => run.taskId === task.id && run.status === "running");
        if (running) actions.append(centerButton("Arrêter", () => pstudioStop(running.id)));
        else actions.append(centerButton("Exécuter", () => pstudioStart(task.id), true));
        if (task.id.startsWith("custom:")) actions.append(centerButton("Retirer", () => pstudioRemove(task)));
        card.append(actions);
        box.append(card);
    }
}

function pstudioRunDetail(run) {
    const end = run.endedAt || Date.now();
    const seconds = Math.max(0, Math.round((end - run.startedAt) / 1000));
    const time = new Date(run.startedAt).toLocaleTimeString();
    const code = run.exitCode === null || run.exitCode === undefined ? "" : ` · code ${run.exitCode}`;
    return `${time} · ${seconds} s${code}`;
}

function pstudioRenderRuns(runs) {
    const box = $("pstudio-runs");
    box.replaceChildren();
    if (!runs || !runs.length) {
        box.append(centerNode("p", "studio-muted", "Aucune exécution pour l'instant."));
        return;
    }
    for (const run of runs.slice().reverse()) {
        const item = centerNode("div", run.id === pstudioState.selectedRun ? "studio-run selected" : "studio-run");
        item.dataset.status = run.status;
        item.tabIndex = 0;
        item.setAttribute("role", "button");
        const label = centerNode("div");
        label.append(centerNode("strong", "", run.name), centerNode("span", "studio-muted", pstudioRunDetail(run)));
        item.append(label, centerNode("span", "studio-pill", PSTUDIO_STATUS[run.status] || run.status));
        if (run.status === "running") item.append(centerButton("Arrêter", () => pstudioStop(run.id)));
        const select = () => {
            pstudioState.selectedRun = run.id;
            pstudioRenderRuns(pstudioState.data ? pstudioState.data.runs : runs);
            pstudioLoadLog();
        };
        item.onclick = select;
        item.onkeydown = (event) => {
            if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                select();
            }
        };
        box.append(item);
    }
}

async function pstudioRefreshRuns() {
    try {
        const runs = await api.projectStudio("runs");
        if (pstudioState.data) {
            pstudioState.data.runs = runs;
            pstudioRender();
        } else {
            pstudioRenderRuns(runs);
        }
    } catch (error) {
        pstudioError(error);
    }
}

async function pstudioLoadLog() {
    const pre = $("pstudio-log");
    const id = pstudioState.selectedRun;
    if (!id) {
        $("pstudio-log-title").textContent = "Journal";
        pre.textContent = "Sélectionnez une exécution pour voir son journal.";
        return;
    }
    try {
        const run = await api.projectStudio("log", { id });
        const atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 20;
        $("pstudio-log-title").textContent = `Journal — ${run.name}`;
        pre.textContent = run.log || "(aucune sortie pour l'instant)";
        if (atBottom) pre.scrollTop = pre.scrollHeight;
    } catch (error) {
        pstudioState.selectedRun = null;
        pre.textContent = error.message || String(error);
    }
}

/* ---------- Actions sur les commandes ---------- */

async function pstudioStart(id) {
    try {
        const run = await api.projectStudio("start", { id });
        pstudioState.selectedRun = run.id;
        pstudioMessage(`Commande lancée : ${run.command}`);
        if (pstudioState.tab !== "tasks") pstudioSetTab("tasks");
        await pstudioRefreshRuns();
        await pstudioLoadLog();
    } catch (error) {
        pstudioError(error);
    }
}

async function pstudioStop(id) {
    try {
        await api.projectStudio("stop", { id });
        pstudioMessage("Exécution arrêtée.");
        await pstudioRefreshRuns();
    } catch (error) {
        pstudioError(error);
    }
}

async function pstudioRemove(task) {
    if (!window.confirm(`Retirer la commande « ${task.name} » ?`)) return;
    try {
        await api.projectStudio("remove", { id: task.id });
        pstudioMessage("Commande retirée.");
        await pstudioRefresh();
    } catch (error) {
        pstudioError(error);
    }
}

function pstudioOpenTaskDialog() {
    if (!pstudioState.data || !pstudioState.data.workspace) {
        pstudioMessage("Ouvrez d'abord un projet.", true);
        return;
    }
    $("studio-task-name").value = "";
    $("studio-task-command").value = "";
    $("studio-task-message").textContent = "";
    $("studio-task-dialog").showModal();
    $("studio-task-name").focus();
}

$("studio-task-close").onclick = () => $("studio-task-dialog").close();
$("studio-task-cancel").onclick = () => $("studio-task-dialog").close();
$("studio-task-form").onsubmit = async (event) => {
    event.preventDefault();
    const name = $("studio-task-name").value.trim();
    const command = $("studio-task-command").value.trim();
    if (!name || !command) {
        $("studio-task-message").textContent = "Nom et commande obligatoires.";
        return;
    }
    try {
        await api.projectStudio("add", { name, command });
        $("studio-task-dialog").close();
        await pstudioRefresh();
        pstudioMessage(`Commande « ${name} » ajoutée.`);
    } catch (error) {
        $("studio-task-message").textContent = error.message || String(error);
    }
};

/* ---------- Qualité : demandes préparées et environnement ---------- */

function pstudioDraftPrompt(text) {
    if (typeof input === "undefined" || !input) {
        pstudioMessage("Zone de saisie introuvable.", true);
        return;
    }
    input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    pstudioClose();
    input.focus();
}

for (const [title, prompt] of PSTUDIO_PROMPTS) {
    $("pstudio-quality").append(pstudioQuick(title, "Préparer la demande dans le composeur", () => pstudioDraftPrompt(prompt)));
}

async function pstudioDiagnose() {
    const box = $("pstudio-env");
    box.replaceChildren(centerNode("p", "studio-muted", "Vérification en cours…"));
    try {
        const list = await api.projectStudio("environment");
        box.replaceChildren();
        for (const item of list) {
            const row = centerNode("div", "studio-env-row");
            row.dataset.ok = item.ok ? "true" : "false";
            row.append(centerNode("strong", "", item.name), centerNode("span", item.ok ? "studio-pill" : "studio-pill error", item.value));
            box.append(row);
        }
    } catch (error) {
        box.replaceChildren(centerNode("p", "studio-muted", error.message || String(error)));
    }
}

/* ---------- Boîte à outils ---------- */

function pstudioToBase64(text) {
    const bytes = new TextEncoder().encode(text);
    let binary = "";
    for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
    return btoa(binary);
}

function pstudioFromBase64(text) {
    const binary = atob(text.replace(/\s+/g, ""));
    return new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
}

async function pstudioTransform(kind, text) {
    switch (kind) {
    case "json": return JSON.stringify(JSON.parse(text), null, 2);
    case "json-min": return JSON.stringify(JSON.parse(text));
    case "base64-encode": return pstudioToBase64(text);
    case "base64-decode": return pstudioFromBase64(text);
    case "url-encode": return encodeURIComponent(text);
    case "url-decode": return decodeURIComponent(text);
    case "sha256": {
        const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
        return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
    }
    case "uuid": return crypto.randomUUID();
    case "sort": return text.split(/\r?\n/).sort((a, b) => a.localeCompare(b)).join("\n");
    case "unique": return [...new Set(text.split(/\r?\n/))].join("\n");
    default: throw new Error(`Transformation inconnue : ${kind}`);
    }
}

for (const [value, label] of PSTUDIO_TRANSFORMS) {
    const option = centerNode("option", "", label);
    option.value = value;
    $("pstudio-transform").append(option);
}

$("pstudio-transform-run").onclick = async () => {
    try {
        $("pstudio-tool-out").value = await pstudioTransform($("pstudio-transform").value, $("pstudio-tool-in").value);
        pstudioMessage("");
    } catch (error) {
        pstudioError(error);
    }
};

$("pstudio-transform-copy").onclick = async () => {
    try {
        await navigator.clipboard.writeText($("pstudio-tool-out").value);
        pstudioMessage("Résultat copié.");
    } catch (error) {
        pstudioError(error);
    }
};

/* ---------- Liaisons ---------- */

$("pstudio-close").onclick = () => pstudioClose();
$("pstudio-refresh").onclick = () => pstudioRefresh();
$("pstudio-add").onclick = () => pstudioOpenTaskDialog();
$("pstudio-diagnose").onclick = () => pstudioDiagnose();
$("pstudio-filter").oninput = (event) => {
    pstudioState.filter = event.target.value;
    pstudioRenderTasks();
};
$("pstudio-kind").onchange = (event) => {
    pstudioState.kind = event.target.value;
    pstudioRenderTasks();
};
$("pstudio-clear").onclick = async () => {
    try {
        const runs = await api.projectStudio("clear");
        if (pstudioState.selectedRun && !runs.some((run) => run.id === pstudioState.selectedRun)) pstudioState.selectedRun = null;
        if (pstudioState.data) pstudioState.data.runs = runs;
        pstudioRender();
        pstudioLoadLog();
    } catch (error) {
        pstudioError(error);
    }
};

document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !pstudioIsOpen()) return;
    if (document.querySelector("dialog[open]")) return;
    pstudioClose();
});

if (api && typeof api.onEvent === "function") {
    api.onEvent((channel) => {
        if (channel !== "projectStudio" || !pstudioIsOpen()) return;
        clearTimeout(pstudioState.timer);
        pstudioState.timer = setTimeout(async () => {
            await pstudioRefreshRuns();
            if (pstudioState.selectedRun) await pstudioLoadLog();
        }, 250);
    });
}
