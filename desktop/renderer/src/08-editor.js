/* ---------- Éditeur ---------- */

function currentTab() {
    return ui.tabs.find((t) => t.path === ui.active) || null;
}

/* La numérotation des lignes est désormais gérée par CodeMirror (basicSetup). */
function updateGutter() {}

function normalize(content) {
    return content.split("\r\n").join("\n");
}

async function openFile(rel) {
    let tab = ui.tabs.find((t) => t.path === rel);
    if (!tab) {
        try {
            const file = await api.readFile(rel);
            const text = normalize(file.content);
            tab = { path: rel, content: text, saved: text, eol: file.content.includes("\r\n") ? "\r\n" : "\n", dirty: false, scroll: 0 };
            ui.tabs.push(tab);
        } catch (err) {
            renderEntry({ type: "error", text: `${rel} : ${err.message}` });
            return;
        }
    }
    activate(rel);
}

function activate(rel) {
    const previous = currentTab();
    if (previous) {
        previous.scroll = code.scrollTop;
        previous.cmState = code.getState();
    }

    ui.active = rel;
    const tab = currentTab();
    $("editor").classList.toggle("hidden", !tab);
    $("editor-welcome").classList.toggle("hidden", Boolean(tab));
    const welcomeSub = $("welcome-sub");
    if (welcomeSub) {
        welcomeSub.textContent = ui.workspace
            ? "Projet ouvert : choisis un fichier dans l'explorateur ou demande à l'agent dans le panneau de droite."
            : "Ouvre un dossier, puis discute avec l'agent dans le panneau de droite.";
    }
    code.load(tab ? tab.content : "", tab ? extKind(tab.path) : "default", tab && tab.cmState);
    const scroll = tab ? tab.scroll : 0;
    code.scrollTop = scroll;
    /* CodeMirror mesure la mise en page de façon asynchrone : on réapplique le défilement à l'image suivante. */
    requestAnimationFrame(() => {
        if (currentTab() === tab) code.scrollTop = scroll;
    });
    $("st-file").textContent = tab ? tab.path : "";
    updateEditorActions();
    updateBreadcrumbs(tab);
    updateGutter();
    syncHighlight();
    renderTabs();
    document.querySelectorAll(".node").forEach((n) => n.classList.toggle("selected", n.dataset.path === rel));
    if (tab) code.focus();
    syncEditorContext();
    lspOnActivate();
}

/* Indique au processus principal quels fichiers sont ouverts (contexte de l'agent). */
let lastEditorContext = null;

/* Taille (caractères) des fichiers du contexte, pour l'estimation de tokens (≈ caractères / 4). */
const contextSizes = new Map();

function contextTokenEstimate(files) {
    let chars = 0;
    let known = 0;
    for (const f of files) {
        if (!contextSizes.has(f)) continue;
        chars += contextSizes.get(f);
        known++;
    }
    return { tokens: Math.ceil(chars / 4), known };
}

function formatTokens(n) {
    return n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n);
}

function measureContextFiles(files) {
    const missing = files.filter((f) => !contextSizes.has(f));
    if (!missing.length) return;
    for (const f of missing) contextSizes.set(f, 0); // évite les lectures en double
    Promise.all(missing.map(async (f) => {
        try {
            const res = await api.readFile(f);
            const text = typeof res === "string" ? res : (res && (res.content ?? res.text ?? res.data)) || "";
            contextSizes.set(f, String(text).length);
        } catch {
            contextSizes.set(f, 0);
        }
    })).then(() => {
        lastEditorContext = null;
        syncEditorContext();
    });
}

function renderEditorContext(files, active) {
    const el = $("st-context");
    if (!el) return;
    el.classList.toggle("hidden", !files.length);
    if (!files.length) {
        el.textContent = "";
        el.title = "Contexte envoyé à l'agent";
        return;
    }
    const pinned = ui.pinnedFiles || [];
    const name = active ? active.split("/").pop() : pinned.length ? pinned[0].split("/").pop() : "aucun";
    const { tokens, known } = contextTokenEstimate(files);
    const estimate = known && tokens ? ` · ~${formatTokens(tokens)} tokens` : "";
    el.textContent = `Contexte : ${name}${files.length > 1 ? ` +${files.length - 1}` : ""}${estimate}`;
    el.title = [
        "Contexte envoyé à l'agent",
        `Fichier actif : ${active || "aucun"}`,
        pinned.length ? `Fichiers épinglés (@) :\n${pinned.map((f) => `• ${f}`).join("\n")}` : "",
        `Fichiers ouverts :\n${ui.tabs.map((t) => `• ${t.path}`).join("\n") || "• aucun"}`,
        known ? `Estimation : ~${tokens} tokens (caractères / 4)` : ""
    ].filter(Boolean).join("\n");
}

function syncEditorContext() {
    const pinned = ui.pinnedFiles || [];
    const files = [...new Set([...pinned, ...ui.tabs.map((t) => t.path)])];
    const active = ui.active || null;
    const { tokens } = contextTokenEstimate(files);
    const key = `${active}|${files.join(",")}|${tokens}`;
    if (key === lastEditorContext) return;
    lastEditorContext = key;
    renderEditorContext(files, active);
    api.setEditorContext(files, active).catch(() => {});
    measureContextFiles(files);
}

function updateBreadcrumbs(tab) {
    const bc = $("breadcrumbs");
    const name = tab ? tab.path.split("/").pop() : "";
    document.title = tab ? `${name} — FranceStudent Code` : "FranceStudent Code";
    const tbTitle = $("tb-title");
    if (tbTitle) tbTitle.textContent = document.title;
    if (!bc) return;
    bc.innerHTML = "";
    bc.classList.toggle("hidden", !tab);
    if (!tab) return;
    const parts = tab.path.split("/").filter((p) => p && p !== ".");
    parts.forEach((part, i) => {
        if (i > 0) {
            const sep = document.createElement("span");
            sep.className = "sep";
            sep.textContent = "›";
            bc.appendChild(sep);
        }
        const crumb = document.createElement("span");
        crumb.className = "crumb";
        if (i === parts.length - 1) crumb.appendChild(fileIcon(part, "file"));
        crumb.appendChild(document.createTextNode(part));
        bc.appendChild(crumb);
    });
}

function renderTabs() {
    const bar = $("tabs");
    bar.innerHTML = "";
    for (const t of ui.tabs) {
        const el = document.createElement("div");
        el.className = "tab" + (t.path === ui.active ? " active" : "") + (t.dirty ? " dirty" : "");
        el.title = t.path;
        const label = document.createElement("span");
        label.textContent = t.path.split("/").pop();
        const close = document.createElement("span");
        close.className = t.dirty ? "close dirty" : "close";
        close.textContent = t.dirty ? "●" : "×";
        close.onclick = (ev) => {
            ev.stopPropagation();
            closeTab(t.path);
        };
        el.onclick = () => activate(t.path);
        el.append(fileIcon(t.path, "file"), label, close);
        bar.appendChild(el);
    }
}

function closeTab(rel) {
    const tab = ui.tabs.find((t) => t.path === rel);
    if (!tab) return;
    if (tab.dirty && !window.confirm(`${rel} n'est pas enregistré. Fermer quand même ?`)) return;
    const index = ui.tabs.indexOf(tab);
    ui.tabs.splice(index, 1);
    lspOnClose(rel);
    if (ui.active === rel) {
        const next = ui.tabs[index] || ui.tabs[index - 1];
        ui.active = null;
        activate(next ? next.path : null);
    } else {
        renderTabs();
    }
}

async function saveCurrent() {
    const tab = currentTab();
    if (!tab) return;
    const content = tab.eol === "\r\n" ? tab.content.split("\n").join("\r\n") : tab.content;
    try {
        await api.writeFile(tab.path, content);
        tab.saved = tab.content;
        tab.dirty = false;
        renderTabs();
        $("st-file").textContent = `${tab.path} (enregistré)`;
        scheduleGitRefresh();
    } catch (err) {
        renderEntry({ type: "error", text: `Enregistrement impossible : ${err.message}` });
    }
}

let refreshTimer = null;

/** Après une modification par l'agent : arbre et onglets non modifiés rechargés. */
function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async () => {
        if (!ui.workspace) return;
        await renderTree();
        for (const tab of ui.tabs) {
            if (tab.dirty) continue;
            try {
                const file = await api.readFile(tab.path);
                const text = normalize(file.content);
                if (text === tab.saved) continue;
                tab.content = text;
                tab.saved = text;
                if (tab.path === ui.active) {
                    const scroll = code.scrollTop;
                    code.value = text;
                    lspScheduleSync();
                    code.scrollTop = scroll;
                    updateGutter();
                    syncHighlight();
                }
            } catch {
                // fichier supprimé ou illisible : onglet laissé tel quel
            }
        }
    }, 400);
}

code.addEventListener("scroll", () => {
    syncHighlightScroll();
});

code.addEventListener("input", () => {
    const tab = currentTab();
    if (tab) {
        tab.content = code.value;
        const dirty = tab.content !== tab.saved;
        if (dirty !== tab.dirty) {
            tab.dirty = dirty;
            renderTabs();
        }
    }
    updateGutter();
    scheduleHighlight();
});

/* ---------- Préférences de l'éditeur : enregistrement auto, formatage, aperçu Markdown, thème ---------- */

const EDITOR_PREFS_KEY = "fs-editor-prefs";
const AUTOSAVE_DELAY_MS = 1000;
const editorPrefs = { autosave: false, theme: "dark" };
try {
    const stored = JSON.parse(localStorage.getItem(EDITOR_PREFS_KEY) || "{}");
    if (typeof stored.autosave === "boolean") editorPrefs.autosave = stored.autosave;
    if (stored.theme === "light" || stored.theme === "dark") editorPrefs.theme = stored.theme;
} catch {
    // préférences par défaut
}

function saveEditorPrefs() {
    try {
        localStorage.setItem(EDITOR_PREFS_KEY, JSON.stringify(editorPrefs));
    } catch {
        // stockage local indisponible
    }
}

let autosaveTimer = null;

/** Enregistre l'onglet actif une seconde après la dernière frappe (si l'auto-save est activé). */
function scheduleAutosave() {
    clearTimeout(autosaveTimer);
    if (!editorPrefs.autosave) return;
    const tab = currentTab();
    if (!tab || !tab.dirty) return;
    const path = tab.path;
    autosaveTimer = setTimeout(() => {
        const current = currentTab();
        if (current && current.path === path && current.dirty) saveCurrent();
    }, AUTOSAVE_DELAY_MS);
}

function setAutosave(on) {
    editorPrefs.autosave = Boolean(on);
    saveEditorPrefs();
    updateEditorActions();
    if (editorPrefs.autosave) scheduleAutosave();
    else clearTimeout(autosaveTimer);
}

/** Formatage léger intégré (Prettier n'est pas une dépendance du projet) :
    JSON réindenté sur 2 espaces ; ailleurs, espaces de fin de ligne retirés et un seul saut de ligne final. */
function formatText(text, path) {
    const src = String(text ?? "");
    if (/\.json$/i.test(path || "")) {
        try {
            return `${JSON.stringify(JSON.parse(src), null, 2)}\n`;
        } catch {
            // JSON invalide : formatage générique
        }
    }
    // En Markdown, deux espaces en fin de ligne forcent un retour à la ligne : on les garde.
    const keepTrailing = isMarkdownPath(path);
    let out = keepTrailing ? src : src.split("\n").map((line) => line.replace(/[ \t]+$/, "")).join("\n");
    out = out.replace(/\n*$/, "\n");
    return out === "\n" && !src ? "" : out;
}

function formatCurrent() {
    const tab = currentTab();
    if (!tab) return;
    const next = formatText(tab.content, tab.path);
    if (next === tab.content) {
        $("st-file").textContent = `${tab.path} (déjà formaté)`;
        return;
    }
    const scroll = code.scrollTop;
    code.value = next;
    tab.content = next;
    tab.dirty = tab.content !== tab.saved;
    code.scrollTop = scroll;
    renderTabs();
    lspScheduleSync();
    updateGutter();
    syncHighlight();
    updateMdPreview();
    scheduleAutosave();
    $("st-file").textContent = `${tab.path} (formaté)`;
}

let mdPreviewOn = false;
let mdPreviewTimer = null;

function isMarkdownPath(path) {
    return /\.(md|markdown|mdx)$/i.test(path || "");
}

/** Affiche (ou masque) le rendu Markdown à droite de l'éditeur. */
function updateMdPreview() {
    const el = $("md-preview");
    if (!el) return;
    const tab = currentTab();
    const show = Boolean(mdPreviewOn && tab && isMarkdownPath(tab.path));
    el.classList.toggle("hidden", !show);
    $("editor").classList.toggle("with-preview", show);
    if (show) el.innerHTML = renderMarkdown(tab.content);
    else el.replaceChildren();
}

function toggleMdPreview() {
    const tab = currentTab();
    if (!tab || !isMarkdownPath(tab.path)) return;
    mdPreviewOn = !mdPreviewOn;
    updateMdPreview();
    updateEditorActions();
}

/** Libellés et visibilité des contrôles de la barre d'état liés à l'éditeur. */
function updateEditorActions() {
    const tab = currentTab();
    const md = Boolean(tab && isMarkdownPath(tab.path));
    const fmt = $("st-format");
    if (fmt) fmt.classList.toggle("hidden", !tab);
    const preview = $("st-preview");
    if (preview) {
        preview.classList.toggle("hidden", !md);
        preview.textContent = mdPreviewOn ? "Aperçu : on" : "Aperçu";
    }
    const auto = $("st-autosave");
    if (auto) auto.textContent = `Auto-save : ${editorPrefs.autosave ? "on" : "off"}`;
    const theme = $("st-theme");
    if (theme) theme.textContent = editorPrefs.theme === "light" ? "◐ Clair" : "◐ Sombre";
    updateMdPreview();
}

/** Thème clair/sombre : variables CSS via :root[data-theme], et événement pour les terminaux xterm. */
function applyTheme(theme) {
    editorPrefs.theme = theme === "light" ? "light" : "dark";
    document.documentElement.dataset.theme = editorPrefs.theme;
    window.dispatchEvent(new CustomEvent("fs-theme-change", { detail: { theme: editorPrefs.theme } }));
    updateEditorActions();
}

function toggleTheme() {
    applyTheme(editorPrefs.theme === "light" ? "dark" : "light");
    saveEditorPrefs();
}

code.addEventListener("input", () => {
    scheduleAutosave();
    if (!mdPreviewOn) return;
    clearTimeout(mdPreviewTimer);
    mdPreviewTimer = setTimeout(updateMdPreview, 150);
});

$("st-format").addEventListener("click", () => formatCurrent());
$("st-preview").addEventListener("click", () => toggleMdPreview());
$("st-autosave").addEventListener("click", () => setAutosave(!editorPrefs.autosave));
$("st-theme").addEventListener("click", () => toggleTheme());

/* ---------- Navigateur intégré (<webview>, durci côté main.js) ---------- */

function normalizeBrowserUrl(raw) {
    const v = String(raw || "").trim();
    if (!v) return "";
    if (/^https?:\/\//i.test(v)) return v;
    if (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(v)) return `http://${v}`;
    return `https://${v}`;
}

function browserNavigate(raw) {
    const url = normalizeBrowserUrl(raw);
    if (!url) return;
    $("browser-url").value = url;
    const view = $("browser-view");
    try {
        view.loadURL(url);
    } catch {
        view.setAttribute("src", url);
    }
}

function toggleBrowser(force) {
    const el = $("browser");
    const show = force === undefined ? el.classList.contains("hidden") : Boolean(force);
    el.classList.toggle("hidden", !show);
    $("st-browser").textContent = show ? "🌐 Navigateur : on" : "🌐 Navigateur";
    if (show) {
        const urlInput = $("browser-url");
        if (!urlInput.value) urlInput.value = "http://localhost:3000";
        urlInput.focus();
        urlInput.select();
    }
}

(function wireBrowser() {
    const view = $("browser-view");
    const urlInput = $("browser-url");
    // Les méthodes de la webview lèvent une erreur tant qu'elle n'est pas attachée.
    const safe = (fn) => () => {
        try {
            fn();
        } catch {
            /* webview pas encore prête */
        }
    };
    $("st-browser").addEventListener("click", () => toggleBrowser());
    $("browser-close").addEventListener("click", () => toggleBrowser(false));
    $("browser-back").addEventListener("click", safe(() => view.canGoBack() && view.goBack()));
    $("browser-forward").addEventListener("click", safe(() => view.canGoForward() && view.goForward()));
    $("browser-reload").addEventListener("click", safe(() => view.reload()));
    $("browser-external").addEventListener("click", () => {
        const url = normalizeBrowserUrl(urlInput.value);
        if (url) api.openExternal(url).catch(() => {});
    });
    urlInput.addEventListener("keydown", (ev) => {
        if (ev.key !== "Enter") return;
        ev.preventDefault();
        browserNavigate(urlInput.value);
    });
    const syncUrl = (ev) => {
        if (ev && ev.url && ev.url !== "about:blank") {
            urlInput.value = ev.url;
            urlInput.title = "";
        }
    };
    view.addEventListener("did-navigate", syncUrl);
    view.addEventListener("did-navigate-in-page", syncUrl);
    view.addEventListener("did-fail-load", (ev) => {
        if (ev.isMainFrame && ev.errorCode !== -3) urlInput.title = `Échec du chargement : ${ev.errorDescription || ev.errorCode}`;
    });
    // Ctrl+Maj+B : afficher/masquer le navigateur intégré.
    document.addEventListener("keydown", (ev) => {
        if (ev.ctrlKey && ev.shiftKey && !ev.altKey && (ev.key === "B" || ev.key === "b")) {
            ev.preventDefault();
            toggleBrowser();
        }
    });
})();

// Raccourcis : Maj+Alt+F formate, Ctrl+Maj+V ouvre l'aperçu (fichiers Markdown).
document.addEventListener("keydown", (ev) => {
    const key = String(ev.key || "").toLowerCase();
    if (ev.shiftKey && ev.altKey && !ev.ctrlKey && (key === "f" || ev.code === "KeyF") && currentTab()) {
        ev.preventDefault();
        formatCurrent();
    } else if ((ev.ctrlKey || ev.metaKey) && ev.shiftKey && key === "v" && currentTab() && isMarkdownPath(currentTab().path)) {
        ev.preventDefault();
        toggleMdPreview();
    }
}, true);

// Les préférences sont appliquées au chargement ; l'écouteur xterm (14-panel.js) relit data-theme à la création.
document.documentElement.dataset.theme = editorPrefs.theme;
updateEditorActions();

