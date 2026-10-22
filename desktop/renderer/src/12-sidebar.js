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
// Import Codex : AGENTS.md et prompts de ~/.codex copiés en skills utilisateur.
$("btn-import-codex").onclick = async () => {
    const btn = $("btn-import-codex");
    btn.disabled = true;
    try {
        const r = await api.importCodex();
        const parts = [];
        if (r.imported && r.imported.length) parts.push(`importé(s) : ${r.imported.join(", ")}`);
        if (r.skipped && r.skipped.length) parts.push(`déjà présent(s) : ${r.skipped.join(", ")}`);
        window.alert(parts.length ? `Import Codex — ${parts.join(" ; ")}` : "Import Codex : rien à importer.");
    } catch (err) {
        window.alert(`Import Codex impossible : ${err.message}`);
    } finally {
        btn.disabled = false;
    }
};
// Mises à jour : comparaison avec la dernière release GitHub, ouverture de la page si plus récente.
$("btn-check-updates").onclick = async () => {
    const status = $("update-status");
    status.textContent = "Vérification…";
    try {
        const r = await api.checkUpdates();
        if (r.newer) {
            status.textContent = `Version ${r.latest} disponible (actuelle : ${r.current}).`;
            if (r.url && window.confirm(`La version ${r.latest} est disponible. Ouvrir la page de téléchargement ?`)) {
                api.openExternal(r.url).catch(() => {});
            }
        } else {
            status.textContent = `À jour (version ${r.current}).`;
        }
    } catch (err) {
        status.textContent = `Vérification impossible : ${err.message}`;
    }
};
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

// Presets de skills : état reçu de main.js et filtre texte.
let skillsCache = { skills: [], userDir: "", projectDir: null };
let skillsPresetState = { active: null, presets: {} };

function skillsStatus(text) {
    $("skills-status").textContent = text;
}

function skillsUpdateStatus(shownCount) {
    const all = skillsCache.skills;
    const enabled = all.filter((s) => !s.disabled).length;
    const active = skillsPresetState.active;
    const mode = !active
        ? "tous les skills activés sont proposés"
        : active === "auto"
            ? "sélection automatique selon la demande"
            : active === "manual"
                ? `mode Manuel : ${(skillsPresetState.manual || []).length} skill(s) cochés à la main, les autres sont désactivés`
                : `preset « ${active} » : ${((skillsPresetState.presets || {})[active] || []).length} skill(s), les autres sont désactivés`;
    const filtered = $("skills-filter").value.trim() ? ` · ${shownCount} affiché(s)` : "";
    skillsStatus(`${all.length} installé(s), ${enabled} activé(s) · ${mode}${filtered}`);
}

// Même liste de presets dans la vue Extensions et dans la barre d'envoi des messages (composer-preset).
function fillSkillsPresetSelect() {
    fillPresetSelect($("skills-preset"));
    // Case « Tous » : visible uniquement en mode Manuel ; cochée quand tous les skills activés sont cochés à la main.
    const allMode = !skillsPresetState.active;
    const manualMode = skillsPresetState.active === "manual";
    const manualKeys = new Set((skillsPresetState.manual || []).map((n) => String(n).toLowerCase()));
    const enabledSkills = (skillsCache.skills || []).filter((s) => !s.disabled);
    const allPicked = manualMode && enabledSkills.length > 0 && enabledSkills.every((s) => manualKeys.has(s.name.toLowerCase()));
    for (const id of ["skills-all", "composer-all"]) {
        const box = $(id);
        if (!box) continue;
        box.checked = allPicked;
        const label = box.closest(".preset-all");
        if (label) {
            label.classList.toggle("hidden", !manualMode);
            label.classList.toggle("checked", allPicked);
            label.title = "Mode Manuel : cocher ou décocher tous les skills activés d'un coup";
        }
    }
    for (const id of ["skills-preset", "composer-preset"]) {
        const sel = $(id);
        if (sel) sel.classList.toggle("is-idle", allMode);
    }
    // Bouton Enregistrer : seulement en mode Manuel ; il enregistre les skills activés avec l'interrupteur bleu.
    const saveBtn = $("btn-skill-preset-save");
    if (saveBtn) {
        saveBtn.classList.toggle("hidden", !manualMode);
        saveBtn.disabled = !manualMode;
        saveBtn.title = "Enregistrer comme preset les skills activés avec l'interrupteur bleu";
    }
    const composer = $("composer-preset");
    if (composer) {
        fillPresetSelect(composer);
        const active = skillsPresetState.active;
        composer.classList.toggle("forced", !!active && active !== "auto");
        composer.dataset.mode = !active ? "all" : active === "auto" ? "auto" : active === "manual" ? "manual" : "preset";
        composer.title = active === "manual"
            ? "Mode Manuel : seuls les skills cochés à la main (vue Extensions) sont proposés"
            : active && active !== "auto"
                ? `Preset « ${active} » imposé à l'IA : seuls ses skills sont proposés, les autres sont désactivés`
                : "Preset de skills imposé à l'IA pour les prochains messages";
    }
}

// Sélecteur de la barre d'envoi : active (impose) le preset choisi pour les prochains messages.
if ($("composer-preset")) {
    $("composer-preset").onchange = async () => {
        try {
            await api.skillsPresetActivate($("composer-preset").value || null);
            await refreshSkills();
        } catch (error) {
            skillsStatus(`Preset : ${error.message}`);
            fillSkillsPresetSelect();
        }
    };
    // Remplit la liste dès le démarrage, sans attendre l'ouverture de la vue Extensions.
    api.skillsPresets().then((presets) => {
        skillsPresetState = presets || { active: null, presets: {} };
        fillSkillsPresetSelect();
    }).catch(() => {});
}

// Case « Tous » (mode Manuel uniquement) : cochée = tous les skills activés sont cochés ; décochée = aucun.
for (const id of ["skills-all", "composer-all"]) {
    const box = $(id);
    if (!box) continue;
    box.onchange = async () => {
        try {
            if (skillsPresetState.active !== "manual") return;
            if (!(skillsCache.skills || []).length) skillsCache = await api.skillsList();
            const names = box.checked ? (skillsCache.skills || []).filter((s) => !s.disabled).map((s) => s.name) : [];
            await api.skillsManualSet(names);
            await refreshSkills();
        } catch (error) {
            skillsStatus(`Preset : ${error.message}`);
            fillSkillsPresetSelect();
        }
    };
}

function fillPresetSelect(select) {
    if (!select) return;
    select.innerHTML = "";
    const add = (value, label) => {
        const opt = document.createElement("option");
        opt.value = value;
        opt.textContent = label;
        select.appendChild(opt);
    };
    // « Tous les skills » n'est plus une option : c'est la case à cocher « Tous ». Sans preset actif, le menu affiche un libellé d'attente.
    if (!skillsPresetState.active) {
        add("", "Choisir un preset…");
        select.firstChild.disabled = true;
        select.firstChild.hidden = true;
    }
    add("auto", "Auto (selon la demande)");
    const manualCount = (skillsPresetState.manual || []).length;
    add("manual", `Manuel (${manualCount} coché${manualCount > 1 ? "s" : ""})`);
    for (const [name, list] of Object.entries(skillsPresetState.presets || {})) add(name, `${name} (${list.length})`);
    select.value = skillsPresetState.active || "";
}

/* ---------- Menu arrondi des presets (remplace la liste native, carrée sous Windows) ---------- */
// Le <select> reste la source de vérité (value + onchange) ; seul son popup natif est remplacé.
let presetMenuEl = null;
let presetMenuFor = null;

function closePresetMenu() {
    if (presetMenuEl) presetMenuEl.remove();
    if (presetMenuFor) presetMenuFor.classList.remove("menu-open");
    presetMenuEl = null;
    presetMenuFor = null;
}

function choosePresetMenuItem(select, opt) {
    if (opt.disabled) return;
    closePresetMenu();
    select.focus();
    if (select.value === opt.value) return;
    select.value = opt.value;
    select.dispatchEvent(new Event("change", { bubbles: true }));
}

function openPresetMenu(select) {
    closePresetMenu();
    if (!select || select.disabled) return;
    const menu = document.createElement("div");
    menu.className = "preset-menu";
    menu.setAttribute("role", "listbox");
    let count = 0;
    let sepDone = false;
    for (const opt of Array.from(select.options)) {
        if (opt.hidden) continue;
        // Séparateur entre les modes (Auto, Manuel) et les presets enregistrés.
        if (!sepDone && count > 0 && opt.value !== "auto" && opt.value !== "manual") {
            const sep = document.createElement("div");
            sep.className = "preset-menu-sep";
            menu.appendChild(sep);
            sepDone = true;
        }
        const selected = opt.value === select.value;
        const item = document.createElement("div");
        item.className = "preset-menu-item";
        item.classList.toggle("selected", selected);
        item.classList.toggle("disabled", opt.disabled);
        item.setAttribute("role", "option");
        item.setAttribute("aria-selected", String(selected));
        item.tabIndex = -1;
        const check = document.createElement("span");
        check.className = "preset-menu-check";
        check.textContent = selected ? "✓" : "";
        const label = document.createElement("span");
        label.className = "preset-menu-label";
        label.textContent = opt.textContent;
        item.title = opt.textContent;
        item.append(check, label);
        item.onclick = () => choosePresetMenuItem(select, opt);
        item.onkeydown = (ev) => {
            if (ev.key === "Enter" || ev.key === " ") {
                ev.preventDefault();
                choosePresetMenuItem(select, opt);
            }
        };
        menu.appendChild(item);
        count++;
    }
    // Navigation clavier : flèches, Début/Fin, Échap, Tab.
    menu.onkeydown = (ev) => {
        const items = Array.from(menu.querySelectorAll(".preset-menu-item:not(.disabled)"));
        const idx = items.indexOf(document.activeElement);
        let next = null;
        if (ev.key === "ArrowDown") next = items[Math.min(items.length - 1, idx + 1)];
        else if (ev.key === "ArrowUp") next = items[Math.max(0, idx - 1)];
        else if (ev.key === "Home") next = items[0];
        else if (ev.key === "End") next = items[items.length - 1];
        else if (ev.key === "Escape" || ev.key === "Tab") {
            ev.preventDefault();
            closePresetMenu();
            select.focus();
            return;
        }
        if (next) {
            ev.preventDefault();
            next.focus();
        }
    };
    document.body.appendChild(menu);
    presetMenuEl = menu;
    presetMenuFor = select;
    select.classList.add("menu-open");
    // Position : sous le sélecteur, ou au-dessus s'il manque de place (barre d'envoi en bas de fenêtre).
    const r = select.getBoundingClientRect();
    const spaceBelow = window.innerHeight - r.bottom - 8;
    const spaceAbove = r.top - 8;
    menu.style.minWidth = `${Math.round(r.width)}px`;
    menu.style.maxHeight = `${Math.max(80, Math.min(320, Math.max(spaceBelow, spaceAbove)))}px`;
    const mh = menu.offsetHeight;
    const mw = menu.offsetWidth;
    const top = mh <= spaceBelow || spaceBelow >= spaceAbove ? r.bottom + 4 : r.top - mh - 4;
    menu.style.top = `${Math.max(4, Math.round(top))}px`;
    menu.style.left = `${Math.max(4, Math.round(Math.min(r.left, window.innerWidth - mw - 4)))}px`;
    const current = menu.querySelector(".preset-menu-item.selected") || menu.querySelector(".preset-menu-item:not(.disabled)");
    if (current) {
        current.focus({ preventScroll: true });
        current.scrollIntoView({ block: "nearest" });
    }
}

for (const id of ["skills-preset", "composer-preset"]) {
    const sel = $(id);
    if (!sel) continue;
    // Empêche l'ouverture de la liste native et ouvre le menu arrondi à la place.
    sel.addEventListener("mousedown", (ev) => {
        if (ev.button !== 0) return;
        ev.preventDefault();
        if (presetMenuFor === sel) {
            closePresetMenu();
        } else {
            sel.focus();
            openPresetMenu(sel);
        }
    });
    sel.addEventListener("keydown", (ev) => {
        if (["Enter", " ", "ArrowDown", "ArrowUp", "F4"].includes(ev.key)) {
            ev.preventDefault();
            openPresetMenu(sel);
        }
    });
}
// Fermeture : clic en dehors, Échap, redimensionnement, perte de focus de la fenêtre, défilement extérieur.
document.addEventListener("mousedown", (ev) => {
    if (presetMenuEl && !presetMenuEl.contains(ev.target) && ev.target !== presetMenuFor) closePresetMenu();
}, true);
document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && presetMenuEl) closePresetMenu();
});
window.addEventListener("resize", () => closePresetMenu());
window.addEventListener("blur", () => closePresetMenu());
document.addEventListener("scroll", (ev) => {
    if (presetMenuEl && !presetMenuEl.contains(ev.target)) closePresetMenu();
}, true);

// Le skill est-il proposé à l'IA avec le preset actif ? null/auto = oui, preset = membre, manual = coché à la main.
function skillInPresetScope(skill) {
    const active = skillsPresetState.active;
    if (!active || active === "auto") return true;
    const key = skill.name.toLowerCase();
    const list = active === "manual" ? skillsPresetState.manual || [] : (skillsPresetState.presets || {})[active] || [];
    return list.some((n) => String(n).toLowerCase() === key);
}

// Interrupteur du mode Manuel : coche/décoche le skill dans manualSkills (settings.json), sans toucher au SKILL.md.
function skillManualToggle(skill, item) {
    const label = document.createElement("label");
    label.className = "skill-toggle manual";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = skillInPresetScope(skill);
    input.disabled = !!skill.disabled;
    label.title = skill.disabled
        ? "Skill désactivé globalement : impossible de le proposer"
        : input.checked ? "Proposé en mode Manuel : cliquer pour le retirer" : "Non proposé : cliquer pour l'ajouter au mode Manuel";
    input.setAttribute("aria-label", `Proposer le skill ${skill.name} en mode Manuel`);
    const track = document.createElement("span");
    track.className = "skill-toggle-track";
    label.append(input, track);
    input.onchange = async () => {
        const key = skill.name.toLowerCase();
        const current = (skillsPresetState.manual || []).filter((n) => String(n).toLowerCase() !== key);
        if (input.checked) current.push(skill.name);
        input.disabled = true;
        try {
            await api.skillsManualSet(current);
            await refreshSkills();
        } catch (error) {
            input.checked = !input.checked;
            input.disabled = false;
            const err = document.createElement("div");
            err.className = "ext-item-sub error";
            err.textContent = `Mode Manuel : ${error.message}`;
            item.appendChild(err);
        }
    };
    return label;
}

function renderSkillsList() {
    const list = $("skills-list");
    const data = skillsCache;
    list.innerHTML = "";
    if (!data.skills.length) {
        skillsStatus("");
        extMessage(
            list,
            `Aucun skill. Un sous-dossier avec SKILL.md dans ${data.userDir}` +
            (data.projectDir ? ` ou ${data.projectDir}` : "") + "."
        );
        return;
    }
    const query = $("skills-filter").value.trim().toLowerCase();
    const shown = query
        ? data.skills.filter((s) => `${s.name} ${s.description || ""}`.toLowerCase().includes(query))
        : data.skills;
    skillsUpdateStatus(shown.length);
    if (!shown.length) {
        extMessage(list, "Aucun skill ne correspond au filtre.");
        return;
    }
    for (const skill of shown) {
        const item = extItem(skill.name, {
            tag: [skill.scope !== "utilisateur" ? skill.scope : "", skill.disabled ? "désactivé" : ""].filter(Boolean).join(", "),
            sub: skill.description || "sans description",
            title: skill.file
        });
        if (skill.disabled) item.classList.add("disabled");
        const head = item.querySelector(".ext-item-head");
        // Preset actif : les skills hors preset apparaissent désactivés (non proposés à l'IA), sans toucher au SKILL.md.
        const presetActive = skillsPresetState.active;
        const outOfScope = !skill.disabled && !skillInPresetScope(skill);
        if (outOfScope) {
            item.classList.add("out-of-preset");
            const badge = document.createElement("span");
            badge.className = "skill-scope-badge off";
            badge.textContent = presetActive === "manual" ? "non coché" : "hors preset";
            head.appendChild(badge);
        } else if (!skill.disabled && presetActive && presetActive !== "auto") {
            item.classList.add("in-preset");
            const badge = document.createElement("span");
            badge.className = "skill-scope-badge on";
            badge.textContent = presetActive === "manual" ? "manuel" : presetActive;
            head.appendChild(badge);
        }
        // En mode Manuel, l'interrupteur coche/décoche le skill pour ce mode ; sinon il active/désactive le skill globalement.
        if (presetActive === "manual" && !skill.disabled) {
            head.appendChild(skillManualToggle(skill, item));
        } else {
            const toggle = skillToggle(skill, item);
            // Preset actif (Auto ou nommé) : les interrupteurs bleus sont verrouillés et gris ; seul le mode Manuel permet de les gérer un par un.
            if (presetActive) {
                const input = toggle.querySelector("input");
                input.disabled = true;
                if (!skillInPresetScope(skill)) input.checked = false;
                toggle.classList.add("locked");
                toggle.title = "Un preset est actif : choisis Manuel pour gérer les skills un par un";
            }
            head.appendChild(toggle);
        }
        list.appendChild(item);
    }
}

async function refreshSkills() {
    const list = $("skills-list");
    try {
        const [data, presets] = await Promise.all([api.skillsList(), api.skillsPresets()]);
        skillsCache = data;
        skillsPresetState = presets || { active: null, presets: {} };
        fillSkillsPresetSelect();
        renderSkillsList();
    } catch (error) {
        extMessage(list, `Skills : ${error.message}`);
    }
}

$("skills-filter").oninput = () => renderSkillsList();
$("skills-preset").onchange = async () => {
    try {
        await api.skillsPresetActivate($("skills-preset").value || null);
        await refreshSkills();
    } catch (error) {
        skillsStatus(`Preset : ${error.message}`);
    }
};
$("btn-skill-preset-ai").onclick = async () => {
    const button = $("btn-skill-preset-ai");
    button.disabled = true;
    skillsStatus("L'IA analyse les skills installés…");
    try {
        const result = await api.skillsPresetSuggest();
        await refreshSkills();
        skillsStatus(`Presets créés ou mis à jour par l'IA : ${(result.suggested || []).join(", ")}. Choisis-en un dans la liste.`);
    } catch (error) {
        skillsStatus(`IA : ${error.message}`);
    } finally {
        button.disabled = false;
    }
};
$("btn-skill-preset-save").onclick = async () => {
    // Enregistrer n'est proposé qu'en mode Manuel : le preset reprend les skills activés avec l'interrupteur bleu.
    if (skillsPresetState.active !== "manual") {
        skillsStatus("Choisis le mode Manuel pour composer un preset avec les interrupteurs bleus.");
        return;
    }
    const manual = new Set((skillsPresetState.manual || []).map((n) => String(n).toLowerCase()));
    const names = skillsCache.skills.filter((s) => !s.disabled && manual.has(s.name.toLowerCase())).map((s) => s.name);
    if (!names.length) {
        skillsStatus("Active au moins un skill avec l'interrupteur bleu avant d'enregistrer.");
        return;
    }
    const name = await inputDialog("Nom du preset (ex. code, web)", "code");
    if (!name) return;
    try {
        await api.skillsPresetSave(name, names);
        await api.skillsPresetActivate(name);
        await refreshSkills();
    } catch (error) {
        skillsStatus(`Enregistrement : ${error.message}`);
    }
};
$("btn-skill-preset-delete").onclick = async () => {
    const name = $("skills-preset").value;
    if (!name || name === "auto") {
        skillsStatus("Choisis d'abord un preset enregistré à supprimer.");
        return;
    }
    const confirm = await inputDialog(`Supprimer le preset « ${name} » ? Tape oui pour confirmer`, "");
    if (String(confirm || "").trim().toLowerCase() !== "oui") return;
    try {
        await api.skillsPresetDelete(name);
        await refreshSkills();
    } catch (error) {
        skillsStatus(`Suppression : ${error.message}`);
    }
};

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

