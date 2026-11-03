// Vues du panneau « Nouvel onglet » (Modifications, Terminal, Fichiers, Navigateur) affichées dans le panneau de droite
// du chat plein écran, sans quitter ce mode.
// Terminal, Modifications et navigateur local réutilisent les nœuds existants : ils sont déplacés dans le panneau
// puis remis à leur place (voir browserHomeReturnAll). Fichiers est un explorateur dédié.
const browserHomeViewTitles = { home: "Nouvel onglet", changes: "Modifications", terminal: "Terminal", files: "Fichiers", browser: "Navigateur", editor: "Éditeur" };
const browserHomeViews = {};
const browserHomeBorrowed = new Map();
const browserHomeFilesState = { expanded: new Set(), collapsedMods: new Set(), filter: "", modifiedOnly: false };
let browserHomeCurrent = "home";
let browserHomeSaved = null;
let browserHomeRenderToken = 0;

Object.assign(browserHomeIcons, {
    trash: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
    stop: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="1"/></svg>',
});

const browserHomeView = document.createElement("section");
browserHomeView.className = "browser-home-view";
browserHomeView.hidden = true;
const browserHomeViewTitle = centerNode("h2", "browser-home-view-title", "");
const browserHomeViewActions = document.createElement("div");
browserHomeViewActions.className = "browser-home-view-actions";
const browserHomeViewHeader = document.createElement("div");
browserHomeViewHeader.className = "browser-home-view-header";
browserHomeViewHeader.append(
    browserHomeButton("back", "Retour", () => {
        if (browserHomeCurrent === "motion" && isMotionOpen()) closeMotionDesign();
        else if ($("app").classList.contains("browser-home-page")) browserHomeClosePage();
        else browserHomeShow("home");
    }),
    browserHomeViewTitle,
    browserHomeViewActions,
);
const browserHomeViewBody = document.createElement("div");
browserHomeViewBody.className = "browser-home-view-body";
browserHomeView.append(browserHomeViewHeader, browserHomeViewBody);
browserHome.append(browserHomeView);

/** Déplace un nœud existant dans le panneau en mémorisant sa place d'origine. */
function browserHomeBorrow(node, host) {
    if (!node) return;
    if (!browserHomeBorrowed.has(node)) browserHomeBorrowed.set(node, { parent: node.parentNode, next: node.nextSibling });
    host.append(node);
}

function browserHomeRememberPanel() {
    if (!browserHomeSaved) browserHomeSaved = { panel: ui.panel, noPanel: $("app").classList.contains("no-panel") };
}

/** Remet les nœuds empruntés (terminal, modifications, navigateur local) à leur place d'origine. */
function browserHomeReturnAll(hideBrowser) {
    if (hideBrowser && browserHomeBorrowed.has(localBrowserPanel)) hideLocalBrowser();
    for (const [node, pos] of browserHomeBorrowed) {
        const next = pos.next && pos.next.parentNode === pos.parent ? pos.next : null;
        pos.parent.insertBefore(node, next);
    }
    browserHomeBorrowed.clear();
    if (browserHomeSaved) {
        const saved = browserHomeSaved;
        browserHomeSaved = null;
        selectPanel(saved.panel);
        $("app").classList.toggle("no-panel", saved.noPanel);
    }
    syncLocalBrowserBounds();
}

let browserHomePagePrevious = null;
function browserHomeClosePage() {
    if (!$('app').classList.contains("browser-home-page")) return;
    const previous = browserHomePagePrevious;
    browserHomePagePrevious = null;
    $('app').classList.remove("browser-home-page");
    browserHomeShow(previous?.view || "home");
    setBrowserHomeOpen(Boolean(previous?.open));
}

function browserHomeShow(name, options = {}) {
    if (options.page === undefined && $('app').classList.contains("browser-home-page") && name === browserHomeCurrent) options.page = true;
    if (options.page && !$('app').classList.contains("browser-home-page")) {
        browserHomePagePrevious = { view: browserHomeCurrent, open: $('app').classList.contains("browser-home-open") };
    }
    browserHomeReturnAll(true);
    if (!browserHomeViews[name]) name = "home";
    browserHomeCurrent = name;
    $('app').classList.toggle("browser-home-page", Boolean(options.page));
    browserHomeRenderToken++;
    const home = name === "home";
    browserHomeBody.hidden = !home;
    browserHomeView.hidden = home;
    $("app").classList.toggle("browser-home-wide", !home);
    if (browserHomeActiveTab && !options.page) {
        browserHomeActiveTab.view = name;
        browserHomeActiveTab.select.textContent = browserHomeViewTitles[name];
    }
    if (home) return;
    browserHomeViewTitle.textContent = browserHomeViewTitles[name];
    browserHomeViewActions.replaceChildren();
    browserHomeViewBody.replaceChildren();
    browserHomeViewBody.className = `browser-home-view-body browser-home-view-${name}`;
    browserHomeViews[name]();
}

const browserHomeSideViews = {
    search: ["search-view", "Recherche dans le projet"],
    git: ["git-view", "Contrôle de version"],
    worktrees: ["wt-view", "Tâches parallèles"],
    extensions: ["ext-view", "Personnaliser"],
    settings: ["settings-view", "Paramètres"],
    project: ["project-studio", "Cockpit du projet"],
};
for (const [name, [id, title]] of Object.entries(browserHomeSideViews)) {
    browserHomeViewTitles[name] = title;
    browserHomeViews[name] = () => browserHomeBorrow($(id), browserHomeViewBody);
}
function browserHomeShowSideView(view) {
    if (view === "explorer") view = "files";
    if (!browserHomeViews[view]) return;
    ui.sideView = view;
    browserHomeShow(view, { page: true });
    setBrowserHomeOpen(true);
    if (view === "git") refreshGit();
    if (view === "worktrees") refreshWorktrees();
    if (view === "extensions") refreshExtensions();
    if (view === "settings") { refreshSettings(); loadPreferences(); }
    if (view === "project") refreshProjectStudio();
    if (view === "search") setTimeout(() => { $("search-input").focus(); $("search-input").select(); }, 0);
}

browserHomeViewTitles.motion = "Motion design";
browserHomeViews.motion = () => browserHomeBorrow(motionView, browserHomeViewBody);

browserHomeViews.editor = () => {
    browserHomeBorrow($("tabs"), browserHomeViewBody);
    browserHomeBorrow($("breadcrumbs"), browserHomeViewBody);
    browserHomeBorrow($("editor-area"), browserHomeViewBody);
};

function browserHomeOpenFile(path) {
    setBrowserHomeOpen(true);
    browserHomeShow("editor", { page: $("app").classList.contains("browser-home-page") });
    openFile(path);
}

function browserHomeCleanPath(path) {
    return String(path || "").replace(/\\/g, "/").replace(/\/+$/, "");
}

async function browserHomeGitState() {
    try {
        const status = await api.gitStatus();
        if (status && status.repo) return { repo: true, branch: status.branch || "", files: Array.isArray(status.files) ? status.files : [] };
    } catch {
        // pas de dépôt Git ou Git indisponible : on affiche simplement une liste vide
    }
    return { repo: false, branch: "", files: [] };
}

function browserHomeSection(title) {
    const section = document.createElement("section");
    section.className = "browser-home-section";
    section.append(centerNode("h2", "browser-home-heading", title));
    return section;
}

/* ---------- Terminal ---------- */

browserHomeViews.terminal = () => {
    browserHomeRememberPanel();
    const host = document.createElement("div");
    host.className = "browser-home-term-host";
    browserHomeViewBody.append(host);
    browserHomeBorrow($("terminal"), host);
    for (const [icon, label, id] of [
        ["plus", "Nouveau terminal", "btn-new-terminal"],
        ["stop", "Arrêter la commande", "btn-kill-terminal"],
        ["trash", "Effacer le terminal", "btn-clear-output"],
        ["close", "Fermer le terminal actif", "btn-close-terminal"],
    ]) browserHomeViewActions.append(browserHomeButton(icon, label, () => $(id).click()));
    selectPanel("terminal", true);
};

/* ---------- Modifications ---------- */

async function browserHomeFillGit(info, list, log, token) {
    info.textContent = "Chargement…";
    const state = await browserHomeGitState();
    if (token !== browserHomeRenderToken) return;
    list.replaceChildren();
    log.replaceChildren();
    if (!ui.workspace) { info.textContent = "Aucun projet ouvert."; return; }
    if (!state.repo) { info.textContent = "Pas de dépôt Git dans ce dossier."; return; }
    info.textContent = `Branche ${state.branch || "(détachée)"} · ${state.files.length} fichier(s) modifié(s)`;
    if (!state.files.length) list.append(centerNode("div", "browser-home-note", "Aucune modification : l'arbre de travail est propre."));
    for (const file of state.files) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "browser-home-row";
        row.title = `${file.path}\nClic : diff · Double-clic : ouvrir`;
        const code = centerNode("span", "browser-home-row-code", gitCode(file));
        code.dataset.code = gitCode(file).charAt(0);
        row.append(fileIcon(file.path, "file"), centerNode("span", "browser-home-row-label", file.path), code);
        row.onclick = () => toggleGitDiff(file, row);
        row.ondblclick = () => { if (file.worktree !== "D" && file.index !== "D") browserHomeOpenFile(file.path); };
        list.append(row);
    }
    try {
        const commits = await api.gitLog(10);
        if (token !== browserHomeRenderToken) return;
        if (!commits.length) log.append(centerNode("div", "browser-home-note", "Aucun commit pour l'instant."));
        for (const commit of commits) {
            const row = document.createElement("div");
            row.className = "browser-home-row";
            row.title = `${commit.hash}\n${commit.author} — ${commit.date}`;
            row.append(centerNode("span", "browser-home-hash", commit.short), centerNode("span", "browser-home-row-label", commit.subject));
            log.append(row);
        }
    } catch (error) {
        log.append(centerNode("div", "browser-home-note", `Historique indisponible : ${gitErrorText(error)}`));
    }
}

browserHomeViews.changes = () => {
    browserHomeRememberPanel();
    const token = browserHomeRenderToken;
    browserHomeViewActions.append(browserHomeButton("reload", "Actualiser", () => browserHomeShow("changes")));
    const gitSection = browserHomeSection("Modifications du dépôt");
    const info = centerNode("div", "browser-home-note", "");
    const list = document.createElement("div");
    const logSection = browserHomeSection("Historique");
    const log = document.createElement("div");
    logSection.append(log);
    gitSection.append(info, list);
    const agentSection = browserHomeSection("Modifications de l'agent");
    browserHomeViewBody.append(agentSection, gitSection, logSection);
    browserHomeBorrow($("changes"), agentSection);
    selectPanel("changes");
    browserHomeFillGit(info, list, log, token);
};

/* ---------- Fichiers ---------- */

function browserHomeFileRow({ name, path, depth, dir, open, modified, onClick }) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = `browser-home-file${modified ? " modified" : ""}`;
    row.style.paddingLeft = `${8 + depth * 14}px`;
    row.dataset.path = path;
    row.title = path;
    row.append(
        centerNode("span", "browser-home-twisty", dir ? (open ? "▾" : "▸") : ""),
        fileIcon(name, dir ? "directory" : "file", open),
        centerNode("span", "browser-home-file-name", name),
    );
    if (modified && !dir) row.append(centerNode("span", "browser-home-dot", ""));
    row.onclick = onClick;
    return row;
}

browserHomeViews.files = () => {
    const token = browserHomeRenderToken;
    const state = browserHomeFilesState;
    let modified = new Set();

    browserHomeViewActions.append(
        browserHomeButton("globe", "Ouvrir le navigateur intégré", () => browserHomeShow("browser")),
        browserHomeButton("reload", "Actualiser les fichiers", () => browserHomeShow("files")),
    );

    const head = document.createElement("div");
    head.className = "browser-home-files-head";
    const folder = fileIcon(projectLabel(), "directory", true);
    head.append(folder, centerNode("span", "browser-home-file-name", projectLabel()));

    const filter = document.createElement("input");
    filter.type = "search";
    filter.className = "browser-home-filter";
    filter.placeholder = "Filtrer les fichiers…";
    filter.setAttribute("aria-label", "Filtrer les fichiers");
    filter.spellcheck = false;
    filter.value = state.filter;

    const chip = document.createElement("button");
    chip.type = "button";
    chip.className = "browser-home-chip";
    chip.setAttribute("aria-pressed", String(state.modifiedOnly));
    const chipCount = centerNode("span", "browser-home-chip-count", "0");
    chip.append(centerNode("span", "browser-home-chip-label", "Toutes les modifications"), chipCount);

    const modsSection = browserHomeSection("Fichiers modifiés");
    modsSection.classList.add("browser-home-files-section");
    const modsList = document.createElement("div");
    modsSection.append(modsList);
    const allSection = browserHomeSection("Tous les fichiers");
    allSection.classList.add("browser-home-files-section");
    allSection.hidden = state.modifiedOnly;
    const allList = document.createElement("div");
    allSection.append(allList);
    browserHomeViewBody.append(head, filter, chip, modsSection, allSection);

    function applyFilter() {
        const query = state.filter.trim().toLowerCase();
        for (const list of [modsList, allList]) {
            const rows = [...list.querySelectorAll(".browser-home-file")];
            if (!query) { for (const row of rows) row.hidden = false; continue; }
            const hits = rows.map((row) => row.dataset.path).filter((path) => path.toLowerCase().includes(query));
            for (const row of rows) {
                const path = row.dataset.path;
                row.hidden = !(hits.includes(path) || hits.some((hit) => hit.startsWith(`${path}/`)));
            }
        }
    }

    function renderModified() {
        modsList.replaceChildren();
        chipCount.textContent = String(modified.size);
        if (!modified.size) { modsList.append(centerNode("div", "browser-home-note", "Aucun fichier modifié.")); return; }
        const root = { dirs: new Map(), files: [] };
        for (const path of [...modified].sort()) {
            const parts = path.split("/");
            let node = root;
            for (const part of parts.slice(0, -1)) {
                if (!node.dirs.has(part)) node.dirs.set(part, { dirs: new Map(), files: [] });
                node = node.dirs.get(part);
            }
            node.files.push({ name: parts[parts.length - 1], path });
        }
        const walk = (node, base, depth) => {
            for (const [name, child] of [...node.dirs].sort((a, b) => a[0].localeCompare(b[0]))) {
                const dirPath = base ? `${base}/${name}` : name;
                const open = !state.collapsedMods.has(dirPath);
                modsList.append(browserHomeFileRow({
                    name, path: dirPath, depth, dir: true, open,
                    onClick: () => {
                        if (open) state.collapsedMods.add(dirPath); else state.collapsedMods.delete(dirPath);
                        renderModified();
                        applyFilter();
                    },
                }));
                if (open) walk(child, dirPath, depth + 1);
            }
            for (const file of node.files) {
                modsList.append(browserHomeFileRow({ name: file.name, path: file.path, depth, modified: true, onClick: () => browserHomeOpenFile(file.path) }));
            }
        };
        walk(root, "", 0);
    }

    async function renderAll() {
        if (!ui.workspace) {
            allList.replaceChildren(centerNode("div", "browser-home-note", "Aucun dossier ouvert."));
            return;
        }
        const rows = document.createDocumentFragment();
        const walk = async (rel, depth) => {
            let entries;
            try {
                entries = await api.listDir(rel);
            } catch (error) {
                rows.append(centerNode("div", "browser-home-note", error?.message || String(error)));
                return;
            }
            entries = entries
                .filter((entry) => entry.type === "directory" || !/\.tmp$/i.test(entry.name))
                .sort((a, b) => (a.type === "directory" ? 0 : 1) - (b.type === "directory" ? 0 : 1) || a.name.localeCompare(b.name));
            for (const entry of entries) {
                const dir = entry.type === "directory";
                const open = dir && state.expanded.has(entry.path);
                rows.append(browserHomeFileRow({
                    name: entry.name, path: entry.path, depth, dir, open,
                    modified: !dir && modified.has(browserHomeCleanPath(entry.path)),
                    onClick: dir
                        ? () => {
                            if (open) state.expanded.delete(entry.path); else state.expanded.add(entry.path);
                            renderAll().then(applyFilter);
                        }
                        : () => browserHomeOpenFile(entry.path),
                }));
                if (open) await walk(entry.path, depth + 1);
            }
        };
        await walk(".", 0);
        if (token !== browserHomeRenderToken) return;
        allList.replaceChildren(rows);
    }

    filter.oninput = () => { state.filter = filter.value; applyFilter(); };
    chip.onclick = () => {
        state.modifiedOnly = !state.modifiedOnly;
        chip.setAttribute("aria-pressed", String(state.modifiedOnly));
        allSection.hidden = state.modifiedOnly;
    };

    (async () => {
        const git = await browserHomeGitState();
        if (token !== browserHomeRenderToken) return;
        modified = new Set([...git.files.map((file) => browserHomeCleanPath(file.path)), ...[...ui.changes.keys()].map(browserHomeCleanPath)]);
        renderModified();
        await renderAll();
        if (token === browserHomeRenderToken) applyFilter();
    })();
};

/* ---------- Navigateur intégré (navigateur local de l'application) ---------- */

browserHomeViews.browser = () => {
    // showLocalBrowser() quitterait le plein écran depuis ces vues latérales : on les remplace d'abord par l'explorateur.
    browserHomeBorrow(localBrowserPanel, browserHomeViewBody);
    showLocalBrowser();
};

// Quand on quitte le plein écran, le terminal, les modifications et le navigateur reprennent leur place habituelle.
new MutationObserver(() => {
    if (!browserHomeBorrowed.size || $("app").classList.contains("focus-agent")) return;
    browserHomeReturnAll(false);
    browserHomeShow("home");
}).observe($("app"), { attributes: true, attributeFilter: ["class"] });

new ResizeObserver(() => {
    if (browserHomeCurrent === "terminal") {
        const term = terms.find((t) => t.key === activeTermKey);
        if (term) fitTerm(term);
    } else if (browserHomeCurrent === "browser") syncLocalBrowserBounds();
}).observe(browserHomeViewBody);

browserHomeAddTab();
