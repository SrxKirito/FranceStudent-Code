/* ---------- Vues latérales : explorateur et recherche ---------- */

ui.sideView = "explorer";

function setActivity(view) {
    for (const b of document.querySelectorAll('[data-view="explorer"], [data-view="search"], [data-view="git"], [data-view="worktrees"], [data-view="extensions"], [data-view="market"], [data-view="settings"]')) {
        b.classList.toggle("active", b.dataset.view === view);
    }
}

function showSideView(view) {
    const app = $("app");
    ui.sideView = view;
    app.classList.remove("no-sidebar");
    app.classList.toggle("view-search", view === "search");
    app.classList.toggle("view-ext", view === "extensions");
    app.classList.toggle("view-settings", view === "settings");
    app.classList.toggle("view-git", view === "git");
    app.classList.toggle("view-worktrees", view === "worktrees");
    app.classList.toggle("view-market", view === "market");
    setActivity(view);
    if (view === "git") refreshGit();
    if (view === "worktrees") refreshWorktrees();
    if (view === "extensions") refreshExtensions();
    if (view === "settings") refreshSettings();
    if (view === "market") openMarketView();
    if (view === "search") {
        setTimeout(() => {
            $("search-input").focus();
            $("search-input").select();
        }, 0);
    }
}

function hideSidebar() {
    $("app").classList.add("no-sidebar");
    setActivity(null);
}

function toggleSideView(view) {
    if (!$("app").classList.contains("no-sidebar") && ui.sideView === view) hideSidebar();
    else showSideView(view);
}

function focusSearch() {
    const selected = code.value.slice(code.selectionStart, code.selectionEnd);
    if (code.hasFocus() && selected && !selected.includes("\n")) $("search-input").value = selected;
    showSideView("search");
}

document.querySelector('[data-view="explorer"]').onclick = () => toggleSideView("explorer");
document.querySelector('[data-view="search"]').onclick = () => toggleSideView("search");
document.querySelector('[data-view="git"]').onclick = () => toggleSideView("git");
document.querySelector('[data-view="worktrees"]').onclick = () => toggleSideView("worktrees");
document.querySelector('[data-view="extensions"]').onclick = () => toggleSideView("extensions");
document.querySelector('[data-view="market"]').onclick = () => toggleSideView("market");
document.querySelector('[data-view="settings"]').onclick = () => toggleSideView("settings");

/* ---------- Vue Paramètres : auto-approbation des écritures et des commandes ---------- */

function applySettings(s) {
    if (!s || typeof s !== "object") return;
    // Choix unique : Toujours (persistant) > Session (cette session) > Demander.
    $("set-perm-writes").value = s.always ? "always" : s.autoApprove ? "session" : "ask";
    $("set-perm-commands").value = s.commandsAlways ? "always" : s.autoApproveCommands ? "session" : "ask";
    // Les anciennes cases set-auto-* sont remplacées par les menus set-perm-writes et set-perm-commands.
    // Le menu reflète l'état réel renvoyé par main.js (pas de cases contradictoires possibles).
    if (s.webSearch !== undefined) $("set-web-search").checked = Boolean(s.webSearch);
    if (s.extensionsMode !== undefined) {
        $("set-extensions-auto").checked = s.extensionsMode !== "manual";
        $("set-extensions-manual").checked = s.extensionsMode === "manual";
    }
    $("st-auto").textContent = s.autoApprove ? "auto-approbation" : "";
    // Avertissement : commandes lancées sans confirmation, y compris aux prochains démarrages.
    if (s.commandsAlways !== undefined) $("st-cmd-always").classList.toggle("hidden", !s.commandsAlways);
}

$("st-cmd-always").onclick = () => toggleSideView("settings");

async function refreshSettings() {
    try {
        // Mode vide : main.js ne change rien et renvoie l'état actuel.
        applySettings(await api.setAutoApprove(""));
        $("settings-message").textContent = "";
    } catch (error) {
        $("settings-message").textContent = `Paramètres : ${error.message}`;
    }
    await refreshDefaultModel();
    await refreshIndexing();
    await refreshSkillsmpKey();
}

/* ---------- Vue Paramètres : clé API SkillsMP (jamais renvoyée en clair) ---------- */

function applySkillsmpKey(r) {
    if (!r || typeof r !== "object") return;
    $("set-skillsmp-key").value = "";
    $("set-skillsmp-key").placeholder = r.saved ? r.masked : "aucune clé enregistrée";
    $("set-skillsmp-key-status").textContent = r.saved
        ? `Clé enregistrée (${r.masked}).`
        : r.fromEnv
            ? "Aucune clé enregistrée : la variable d'environnement SKILLSMP_API_KEY est utilisée."
            : "Aucune clé : 50 recherches par jour au maximum.";
}

async function refreshSkillsmpKey() {
    try {
        applySkillsmpKey(await api.skillsmpKey());
    } catch (error) {
        $("set-skillsmp-key-status").textContent = `Clé SkillsMP : ${error.message}`;
    }
}

async function changeSkillsmpKey(value) {
    try {
        applySkillsmpKey(await api.skillsmpKey(value));
        $("settings-message").textContent = value ? "Clé SkillsMP enregistrée." : "Clé SkillsMP effacée.";
    } catch (error) {
        $("settings-message").textContent = `Clé non enregistrée : ${error.message}`;
    }
}

$("set-skillsmp-key-save").onclick = () => {
    const value = $("set-skillsmp-key").value.trim();
    if (!value) {
        $("settings-message").textContent = "Saisis une clé SkillsMP avant d'enregistrer.";
        return;
    }
    changeSkillsmpKey(value);
};
$("set-skillsmp-key").addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
        ev.preventDefault();
        $("set-skillsmp-key-save").click();
    }
});
$("set-skillsmp-key-clear").onclick = () => changeSkillsmpKey("");

/* ---------- Vue Paramètres : modèle par défaut (persistant) ---------- */

async function refreshDefaultModel() {
    const select = $("set-default-model");
    try {
        const [data, saved] = await Promise.all([api.models(), api.defaultModel()]);
        const agents = (data && data.agents) || [];
        select.innerHTML = "";
        const fallback = agents.find((a) => a.id === saved.fallback);
        const none = document.createElement("option");
        none.value = "";
        none.textContent = fallback ? `Par défaut (configuration : ${fallback.name})` : "Par défaut (configuration)";
        select.appendChild(none);
        for (const agent of agents) {
            const opt = document.createElement("option");
            opt.value = String(agent.id);
            opt.textContent = agent.provider ? `${agent.name} (${agent.provider})` : agent.name;
            select.appendChild(opt);
        }
        if (saved.saved != null && !agents.some((a) => a.id === saved.saved)) {
            const missing = document.createElement("option");
            missing.value = String(saved.saved);
            missing.textContent = `Agent n° ${saved.saved} (indisponible)`;
            select.appendChild(missing);
        }
        select.value = saved.saved != null ? String(saved.saved) : "";
        if (data && data.error) $("settings-message").textContent = `Modèles : ${data.error}`;
    } catch (error) {
        $("settings-message").textContent = `Modèle par défaut : ${error.message}`;
    }
}

$("set-default-model").onchange = async (e) => {
    try {
        await api.defaultModel(e.target.value === "" ? null : Number(e.target.value));
        $("settings-message").textContent = "Modèle par défaut enregistré (appliqué au prochain démarrage).";
    } catch (error) {
        $("settings-message").textContent = `Modèle non enregistré : ${error.message}`;
        await refreshDefaultModel();
    }
};

async function changeSetting(mode) {
    try {
        applySettings(await api.setAutoApprove(mode));
        $("settings-message").textContent = "Réglage enregistré.";
    } catch (error) {
        $("settings-message").textContent = `Réglage non enregistré : ${error.message}`;
        await refreshSettings();
    }
}

// Choix unique Demander / Session / Toujours traduit en modes main.js (prefix "" = écritures, "commands-" = commandes).
async function changePermission(prefix, choice) {
    if (choice === "always") return changeSetting(`${prefix}always`);
    // Demander ou Session : retirer d'abord le mode persistant, puis régler la session.
    try {
        await api.setAutoApprove(`${prefix}never`);
    } catch {
        /* erreur signalée par changeSetting ci-dessous */
    }
    return changeSetting(`${prefix}${choice === "session" ? "on" : "off"}`);
}

$("set-perm-writes").onchange = (e) => changePermission("", e.target.value);
$("set-perm-commands").onchange = (e) => changePermission("commands-", e.target.value);
// (anciens handlers set-auto-commands / set-auto-commands-always remplacés par set-perm-commands)
// Le badge st-cmd-always (barre d'état) reste piloté par applySettings via commandsAlways.
$("set-web-search").onchange = (e) => changeSetting(e.target.checked ? "web-on" : "web-off");
$("set-extensions-auto").onchange = (e) => { if (e.target.checked) changeSetting("extensions-auto"); };
$("set-extensions-manual").onchange = (e) => { if (e.target.checked) changeSetting("extensions-manual"); };

// Recherche dans les Paramètres : masque les sections sans correspondance et ouvre « Avancé » si besoin.
$("settings-search").addEventListener("input", (ev) => {
    const q = ev.target.value.trim().toLowerCase();
    const view = $("settings-view");
    for (const section of view.querySelectorAll(".ext-section")) {
        const text = section.textContent.toLowerCase();
        section.classList.toggle("search-hidden", Boolean(q) && (!text.trim() || !text.includes(q)));
    }
    const adv = view.querySelector(".settings-advanced");
    if (adv && q) adv.open = Boolean(adv.querySelector(".ext-section:not(.search-hidden)"));
});

/* ---------- Vue Paramètres : indexation du projet (fichiers lus, budget) ---------- */

const INDEX_FIELDS = [
    ["set-index-max-files", "maxFiles"],
    ["set-index-max-listed", "maxListedFiles"],
    ["set-index-budget", "budgetChars"],
    ["set-index-summary-chars", "summaryFileChars"]
];

function formatIndexValue(n) {
    return n === null || n === undefined ? "illimité" : Number(n).toLocaleString("fr-FR");
}

function applyIndexing(r) {
    if (!r || typeof r !== "object") return;
    const saved = r.saved || {};
    const defaults = r.defaults || {};
    const eff = r.effective || {};
    const readAll = Boolean(saved.readAll);
    $("set-index-read-all").checked = readAll;
    for (const [id, key] of INDEX_FIELDS) {
        const input = $(id);
        input.value = saved[key] === null || saved[key] === undefined ? "" : String(saved[key]);
        input.placeholder = defaults[key] === null || defaults[key] === undefined ? "" : `défaut : ${defaults[key]}`;
    }
    // En mode « tout lire », le nombre de fichiers lus suit la limite de listage et le budget est illimité.
    $("set-index-max-files").disabled = readAll;
    $("set-index-budget").disabled = readAll;
    $("set-index-effective").textContent =
        `Effectif : ${formatIndexValue(eff.maxFiles)} fichiers lus, ${formatIndexValue(eff.maxListedFiles)} listés, ` +
        `budget ${formatIndexValue(eff.budgetChars)} caractères, ${formatIndexValue(eff.summaryFileChars)} caractères par fichier.`;
}

async function refreshIndexing() {
    try {
        applyIndexing(await api.indexingSettings(null));
    } catch (error) {
        $("set-index-effective").textContent = `Indexation : ${error.message}`;
    }
}

async function changeIndexing(patch) {
    try {
        applyIndexing(await api.indexingSettings(patch));
        $("settings-message").textContent = "Réglage enregistré (appliqué au prochain /index).";
    } catch (error) {
        $("settings-message").textContent = `Réglage non enregistré : ${error.message}`;
        await refreshIndexing();
    }
}

$("set-index-read-all").onchange = (e) => changeIndexing({ readAll: e.target.checked });
for (const [id, key] of INDEX_FIELDS) {
    $(id).onchange = (e) => {
        const raw = String(e.target.value ?? "").trim();
        changeIndexing({ [key]: raw === "" ? null : Number(raw) });
    };
}

/* ---------- Vue Extensions : serveurs MCP et skills (modules réels du CLI) ---------- */

function extItem(name, { dot = null, tag = "", sub = "", error = false, title = "" } = {}) {
    const item = document.createElement("div");
    item.className = "ext-item";
    if (title) item.title = title;
    // Clic : déplie ou replie la description (une ligne par défaut). Ignoré sur les interrupteurs, boutons et champs.
    item.addEventListener("click", (ev) => {
        if (ev.target.closest(".skill-toggle, button, input, select, a")) return;
        item.classList.toggle("expanded");
    });
    const head = document.createElement("div");
    head.className = "ext-item-head";
    if (dot) {
        const d = document.createElement("span");
        d.className = `ext-dot ${dot}`;
        head.appendChild(d);
    }
    const n = document.createElement("span");
    n.className = "ext-item-name";
    n.textContent = name;
    head.appendChild(n);
    if (tag) {
        const t = document.createElement("span");
        t.className = "ext-tag";
        t.textContent = tag;
        head.appendChild(t);
    }
    item.appendChild(head);
    if (sub) {
        const s = document.createElement("div");
        s.className = "ext-item-sub" + (error ? " error" : "");
        s.textContent = sub;
        item.appendChild(s);
    }
    return item;
}

function extMessage(list, text) {
    list.innerHTML = "";
    const empty = document.createElement("div");
    empty.className = "ext-empty";
    empty.textContent = text;
    list.appendChild(empty);
}

async function refreshMcp(action = "") {
    const list = $("mcp-list");
    extMessage(list, action === "restart" ? "Redémarrage des serveurs…" : "Démarrage des serveurs…");
    try {
        const data = await api.mcpList(action);
        list.innerHTML = "";
        if (!data.servers.length) {
            extMessage(list, `Aucun serveur configuré. Ajoute-les dans ${data.configFile} (format mcpServers).`);
            return;
        }
        for (const server of data.servers) {
            const sub = server.status === "running"
                ? `${server.tools.length} outil(s) : ${server.tools.join(", ")}`
                : server.error || server.status;
            list.appendChild(extItem(server.name, {
                dot: server.status,
                tag: server.status,
                sub,
                error: server.status === "failed",
                title: data.configFile
            }));
        }
    } catch (error) {
        extMessage(list, `MCP : ${error.message}`);
    }
}

// Interrupteur Activer/Désactiver d'un skill installé (clé disabled du frontmatter SKILL.md).
function skillToggle(skill, item) {
    const label = document.createElement("label");
    label.className = "skill-toggle";
    label.title = skill.disabled ? "Skill désactivé : cliquer pour l'activer" : "Skill activé : cliquer pour le désactiver";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = !skill.disabled;
    input.setAttribute("aria-label", `Activer le skill ${skill.name}`);
    const track = document.createElement("span");
    track.className = "skill-toggle-track";
    label.append(input, track);
    input.onchange = async () => {
        const enabled = input.checked;
        input.disabled = true;
        const old = item.querySelector(".ext-item-sub.error");
        if (old) old.remove();
        try {
            await api.skillsToggle(skill.name, enabled);
            await refreshSkills();
        } catch (error) {
            input.checked = !enabled;
            input.disabled = false;
            const err = document.createElement("div");
            err.className = "ext-item-sub error";
            err.textContent = `${enabled ? "Activation" : "Désactivation"} : ${error.message}`;
            item.appendChild(err);
        }
    };
    return label;
}

async function refreshSkills() {
    const list = $("skills-list");
    try {
        const data = await api.skillsList();
        list.innerHTML = "";
        if (!data.skills.length) {
            extMessage(
                list,
                `Aucun skill. Un sous-dossier avec SKILL.md dans ${data.userDir}` +
                (data.projectDir ? ` ou ${data.projectDir}` : "") + "."
            );
            return;
        }
        for (const skill of data.skills) {
            const item = extItem(skill.name, {
                tag: skill.disabled ? `${skill.scope}, désactivé` : skill.scope,
                sub: skill.description || "sans description",
                title: skill.file
            });
            if (skill.disabled) item.classList.add("disabled");
            item.querySelector(".ext-item-head").appendChild(skillToggle(skill, item));
            list.appendChild(item);
        }
    } catch (error) {
        extMessage(list, `Skills : ${error.message}`);
    }
}

function refreshExtensions() {
    refreshMcp("");
    refreshSkills();
}

$("btn-ext-refresh").onclick = () => {
    refreshMcp("restart");
    refreshSkills();
};
$("btn-mcp-restart").onclick = () => refreshMcp("restart");
$("btn-mcp-config").onclick = async () => {
    try {
        await api.mcpOpenConfig();
    } catch (error) {
        extMessage($("mcp-list"), `mcp.json : ${error.message}`);
    }
};
/* ---------- Formulaire « Ajouter un serveur MCP » (écrit dans mcp.json via main.js) ---------- */

// Découpe les arguments : un par ligne, ou séparés par des espaces avec "guillemets" pris en compte.
function parseMcpArgs(text) {
    const src = String(text || "").trim();
    if (!src) return [];
    if (/\n/.test(src)) return src.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const out = [];
    const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let m;
    while ((m = re.exec(src))) out.push(m[1] ?? m[2] ?? m[3]);
    return out;
}

// Variables d'environnement : CLE=valeur séparées par des virgules ou des retours à la ligne.
function parseMcpEnv(text) {
    const env = {};
    for (const part of String(text || "").split(/[,\n]/)) {
        const p = part.trim();
        if (!p) continue;
        const eq = p.indexOf("=");
        if (eq <= 0) throw new Error(`Variable invalide : « ${p} » (format CLE=valeur).`);
        env[p.slice(0, eq).trim()] = p.slice(eq + 1).trim();
    }
    return env;
}

function toggleMcpForm(show) {
    const form = $("mcp-add-form");
    form.hidden = show === undefined ? !form.hidden : !show;
    $("mcp-add-status").textContent = "";
    if (!form.hidden) $("mcp-add-name").focus();
}

$("btn-mcp-add").onclick = () => toggleMcpForm();
$("mcp-add-cancel").onclick = () => toggleMcpForm(false);
$("mcp-add-form").addEventListener("submit", async (ev) => {
    ev.preventDefault();
    const status = $("mcp-add-status");
    const name = $("mcp-add-name").value.trim();
    const command = $("mcp-add-command").value.trim();
    if (!name || !command) {
        status.textContent = "Le nom et la commande sont obligatoires.";
        return;
    }
    let env;
    try {
        env = parseMcpEnv($("mcp-add-env").value);
    } catch (error) {
        status.textContent = error.message;
        return;
    }
    $("mcp-add-submit").disabled = true;
    status.textContent = "Ajout et démarrage du serveur…";
    try {
        await api.mcpAddServer(name, command, parseMcpArgs($("mcp-add-args").value), env);
        for (const id of ["mcp-add-name", "mcp-add-command", "mcp-add-args", "mcp-add-env"]) $(id).value = "";
        toggleMcpForm(false);
        await refreshMcp("");
    } catch (error) {
        status.textContent = `Ajout impossible : ${error.message}`;
    } finally {
        $("mcp-add-submit").disabled = false;
    }
});

$("btn-skill-dir").onclick = async () => {
    try {
        await api.skillsOpenDir("utilisateur");
    } catch (error) {
        extMessage($("skills-list"), `Dossier : ${error.message}`);
    }
};
$("btn-skill-new").onclick = async () => {
    const name = await inputDialog("Nom du nouveau skill (lettres, chiffres, - et _)");
    if (!name) return;
    const scope = ui.workspace
        ? ((await inputDialog("Portée : utilisateur ou projet", "utilisateur")) || "utilisateur")
        : "utilisateur";
    try {
        await api.skillsCreate(name, scope.trim().toLowerCase() === "projet" ? "projet" : "utilisateur");
        await refreshSkills();
    } catch (error) {
        extMessage($("skills-list"), `Création : ${error.message}`);
    }
};

/* ---------- Vue Marketplace de skills : recherche SkillsMP ou anthropics/skills, bouton Télécharger ---------- */

const market = { query: "", page: 1, seq: 0, loaded: false };

function marketScope() {
    return $("market-scope").value === "project" ? "projet" : "utilisateur";
}

function marketStatus(text, error = false) {
    const status = $("market-status");
    status.textContent = text;
    status.classList.toggle("error", error);
}

async function downloadSkill(skill, item, btn) {
    btn.disabled = true;
    btn.textContent = "Téléchargement…";
    const old = item.querySelector(".ext-item-sub.error");
    if (old) old.remove();
    try {
        const scope = marketScope();
        const force = skill.installed === true;
        const result = skill.kind === "skillsmp"
            ? await api.skillsInstallUrl(skill.githubUrl, skill.installName, scope, force)
            : await api.skillsInstall(skill.name, scope, "", force);
        skill.installed = true;
        btn.textContent = result && result.replaced ? "Mis à jour" : "Installé";
        marketStatus(`Skill « ${skill.installName || skill.name} » installé (${scope}).`);
        await refreshSkills();
    } catch (error) {
        btn.disabled = false;
        btn.textContent = skill.installed ? "Réinstaller" : "Télécharger";
        const err = document.createElement("div");
        err.className = "ext-item-sub error";
        err.textContent = error.message;
        item.appendChild(err);
    }
}

// Carte moderne du marketplace : nom, badges (étoiles, installé), auteur, description, bouton Télécharger.
function marketItem(skill, { stars = null, meta = "", description = "", title = "" } = {}) {
    const card = document.createElement("div");
    card.className = "market-card" + (skill.installed ? " installed" : "");
    if (title) card.title = title;
    const head = document.createElement("div");
    head.className = "market-card-head";
    const name = document.createElement("span");
    name.className = "market-card-name";
    name.textContent = skill.name;
    head.appendChild(name);
    if (stars !== null && stars !== undefined) {
        const badge = document.createElement("span");
        badge.className = "market-badge stars";
        badge.textContent = `★ ${Number(stars || 0).toLocaleString("fr-FR")}`;
        head.appendChild(badge);
    }
    if (skill.installed) {
        const badge = document.createElement("span");
        badge.className = "market-badge installed";
        badge.textContent = "Installé";
        head.appendChild(badge);
    }
    card.appendChild(head);
    if (meta) {
        const m = document.createElement("div");
        m.className = "market-card-meta";
        m.textContent = meta;
        card.appendChild(m);
    }
    const desc = document.createElement("div");
    desc.className = "market-card-desc";
    desc.textContent = description || "sans description";
    card.appendChild(desc);
    const actions = document.createElement("div");
    actions.className = "market-card-actions";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "market-download";
    btn.textContent = skill.installed ? "Réinstaller" : "Télécharger";
    btn.onclick = () => downloadSkill(skill, card, btn);
    actions.appendChild(btn);
    card.appendChild(actions);
    return card;
}

async function searchMarket(append = false) {
    const source = $("market-source").value;
    const list = $("market-list");
    const more = $("market-more");
    const seq = ++market.seq;
    if (!append) {
        list.innerHTML = "";
        market.page = 1;
    }
    more.hidden = true;
    if (source === "anthropics") {
        marketStatus("Lecture du marketplace anthropics/skills…");
        try {
            const data = await api.skillsMarket("");
            if (seq !== market.seq) return;
            const q = market.query.toLowerCase();
            const skills = data.skills.filter((s) => !q || `${s.name} ${s.description || ""}`.toLowerCase().includes(q));
            list.innerHTML = "";
            for (const skill of skills) {
                skill.kind = "anthropics";
                list.appendChild(marketItem(skill, {
                    meta: skill.plugin || "",
                    description: skill.description,
                    title: `${data.source} : ${skill.path}`
                }));
            }
            if (!skills.length) extMessage(list, "Aucun résultat.");
            marketStatus(`${skills.length} skill(s) dans ${data.source}. Vérifie la licence de chaque skill.`);
        } catch (error) {
            if (seq === market.seq) marketStatus(`Marketplace : ${error.message}`, true);
        }
        return;
    }
    // Sans mot-clé : top des skills SkillsMP triés par étoiles.
    const top = !market.query;
    marketStatus(top ? "Chargement du top des skills SkillsMP…" : "Recherche sur SkillsMP…");
    try {
        const data = await api.skillsmpSearch(market.query, market.page, top ? "stars" : "");
        if (seq !== market.seq) return;
        for (const skill of data.skills) {
            skill.kind = "skillsmp";
            list.appendChild(marketItem(skill, {
                stars: skill.stars ?? 0,
                meta: skill.author ? `par ${skill.author}` : "",
                description: skill.description,
                title: skill.githubUrl || ""
            }));
        }
        const shown = list.querySelectorAll(".market-card").length;
        const p = data.pagination || {};
        if (!shown) extMessage(list, "Aucun résultat.");
        marketStatus(top
            ? `Top des skills SkillsMP (par étoiles) : ${shown} affiché(s). Skills communautaires, vérifie le contenu et la licence.`
            : `${shown} sur ${p.total ?? shown} résultat(s). Vérifie le contenu et la licence avant usage.`);
        more.hidden = !p.hasNext;
    } catch (error) {
        if (seq === market.seq) marketStatus(error.message, true);
    }
}

function openMarketView() {
    if (!market.loaded) {
        market.loaded = true;
        searchMarket();
    }
    setTimeout(() => $("market-input").focus(), 0);
}

$("market-input").addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
        ev.preventDefault();
        market.query = $("market-input").value.trim();
        searchMarket();
    }
});
$("market-source").onchange = () => searchMarket();
$("market-more").onclick = () => {
    market.page++;
    searchMarket(true);
};

let searchSeq = 0;

async function runSearch() {
    const query = $("search-input").value;
    const results = $("search-results");
    const summary = $("search-summary");
    const seq = ++searchSeq;
    results.innerHTML = "";
    if (!query.trim()) {
        summary.textContent = "";
        return;
    }
    if (!ui.workspace) {
        summary.textContent = "Aucun projet ouvert.";
        return;
    }
    summary.textContent = "Recherche…";
    let res;
    try {
        res = await api.searchText(query, { regex: $("search-regex").checked, caseSensitive: $("search-case").checked });
    } catch (err) {
        if (seq === searchSeq) summary.textContent = err.message;
        return;
    }
    if (seq !== searchSeq) return;

    const matches = (res && res.matches) || [];
    const groups = new Map();
    for (const m of matches) {
        if (!groups.has(m.path)) groups.set(m.path, []);
        groups.get(m.path).push(m);
    }
    summary.textContent = matches.length
        ? `${matches.length} résultat(s) dans ${groups.size} fichier(s)${res.truncated ? " (liste limitée)" : ""}`
        : "Aucun résultat.";

    for (const [file, list] of groups) {
        const head = document.createElement("div");
        head.className = "search-file";
        head.textContent = `${file} (${list.length})`;
        head.title = file;
        head.onclick = () => openFile(file);
        results.appendChild(head);
        for (const m of list) {
            const row = document.createElement("div");
            row.className = "search-match";
            row.title = `${file}:${m.line}`;
            const ln = document.createElement("span");
            ln.className = "ln";
            ln.textContent = String(m.line);
            const text = document.createElement("span");
            text.textContent = String(m.text ?? "").trim().slice(0, 300);
            row.append(ln, text);
            row.onclick = () => openFile(file).then(() => goToLine(m.line));
            results.appendChild(row);
        }
    }
}

$("search-input").addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
        ev.preventDefault();
        runSearch();
    }
});
$("search-case").onchange = runSearch;
$("search-regex").onchange = runSearch;

/* ---------- Remplacer dans le projet ---------- */

function buildSearchRegex(query, isRegex, caseSensitive) {
    const source = isRegex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(source, caseSensitive ? "g" : "gi");
}

async function replaceAllInProject() {
    const query = $("search-input").value;
    const replacement = $("replace-input").value;
    const summary = $("search-summary");
    if (!query.trim() || !ui.workspace) return;
    const isRegex = $("search-regex").checked;
    const caseSensitive = $("search-case").checked;
    let pattern;
    try {
        pattern = buildSearchRegex(query, isRegex, caseSensitive);
    } catch (err) {
        summary.textContent = `Expression invalide : ${err.message}`;
        return;
    }

    let res;
    try {
        res = await api.searchText(query, { regex: isRegex, caseSensitive });
    } catch (err) {
        summary.textContent = err.message;
        return;
    }
    const files = [...new Set(((res && res.matches) || []).map((m) => m.path))];
    if (!files.length) {
        summary.textContent = "Aucun résultat à remplacer.";
        return;
    }
    const limited = res.truncated ? "\n(Liste de résultats limitée : relance ensuite pour traiter le reste.)" : "";
    if (!window.confirm(`Remplacer « ${query} » par « ${replacement} » dans ${files.length} fichier(s) ?${limited}`)) return;

    let changedFiles = 0;
    let total = 0;
    const skipped = [];
    for (const file of files) {
        const tab = ui.tabs.find((t) => t.path === file);
        if (tab && tab.dirty) {
            skipped.push(file);
            continue;
        }
        try {
            const data = await api.readFile(file);
            const before = data.content;
            let count = 0;
            pattern.lastIndex = 0;
            const after = before.replace(pattern, (...args) => {
                count++;
                if (!isRegex) return replacement;
                return args[0].replace(buildSearchRegex(query, true, caseSensitive), replacement);
            });
            if (!count || after === before) continue;
            await api.writeFile(file, after);
            changedFiles++;
            total += count;
            if (tab) {
                const text = normalize(after);
                tab.content = text;
                tab.saved = text;
                if (ui.active === file) {
                    code.value = text;
                    updateGutter();
                    syncHighlight();
                }
            }
        } catch (err) {
            skipped.push(`${file} (${err.message})`);
        }
    }
    renderTabs();
    await runSearch();
    summary.textContent = `${total} remplacement(s) dans ${changedFiles} fichier(s).` +
        (skipped.length ? ` Ignorés : ${skipped.join(", ")} (modifications non enregistrées ou erreur).` : "");
scheduleRefresh();
}

$("btn-replace-all").onclick = () => replaceAllInProject();
$("replace-input").addEventListener("keydown", (ev) => {
    if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
        ev.preventDefault();
        replaceAllInProject();
    }
});

