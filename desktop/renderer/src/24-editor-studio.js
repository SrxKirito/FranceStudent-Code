// 24-editor-studio.js — formatage Prettier, comparaison de fichiers, enregistrement global.
// Portage adapté de extraopaa/francestudents-ide : pas de MergeView (absent du bundle
// CodeMirror local) ; la comparaison est un diff ligne à ligne calculé dans le renderer.

let studioFormatting = false;

function editorStudioStatus(text) {
    if (typeof lspStatus === "function") lspStatus(text);
    else if ($("st-file")) $("st-file").textContent = text;
}

async function formatEditorDocument() {
    const tab = currentTab();
    if (!tab || studioFormatting || !code.view) return false;
    const before = code.value;
    studioFormatting = true;
    try {
        const result = await api.formatDocument({ file: tab.path, text: before, tabSize: 4 });
        if (currentTab() !== tab || code.value !== before) {
            editorStudioStatus("Formatage annulé : le document a changé pendant la requête.");
            return false;
        }
        if (!result.changed) {
            editorStudioStatus("Document déjà formaté.");
            return true;
        }
        const selected = code.selectionStart;
        code.view.dispatch({
            changes: { from: 0, to: code.view.state.doc.length, insert: result.text },
            selection: { anchor: Math.min(selected, result.text.length) },
            userEvent: "input.format"
        });
        if (typeof lspSyncTabFromEditor === "function") {
            lspSyncTabFromEditor(tab);
        } else {
            tab.content = code.value;
            tab.dirty = tab.content !== tab.saved;
        }
        renderTabs();
        if (typeof lspScheduleSync === "function") lspScheduleSync();
        editorStudioStatus("Document formaté avec Prettier · Ctrl+Z pour annuler.");
        return true;
    } catch (error) {
        editorStudioStatus(`Formatage : ${error.message || error}`);
        return false;
    } finally {
        studioFormatting = false;
    }
}

async function saveAllStudioFiles() {
    let count = 0;
    for (const tab of ui.tabs.filter((t) => t.dirty)) {
        const snapshot = tab.content;
        const content = tab.eol === "\r\n" ? snapshot.split("\n").join("\r\n") : snapshot;
        try {
            await api.writeFile(tab.path, content);
            tab.saved = snapshot;
            tab.dirty = tab.content !== snapshot;
            count += 1;
        } catch (error) {
            editorStudioStatus(`Enregistrement de ${tab.path} : ${error.message || error}`);
        }
    }
    renderTabs();
    if (typeof scheduleGitRefresh === "function") scheduleGitRefresh();
    editorStudioStatus(`${count} fichier(s) enregistré(s).`);
}

/* ---------- Comparaison ---------- */

function studioLineDiff(beforeText, afterText) {
    const a = beforeText.split("\n");
    const b = afterText.split("\n");
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
    let endA = a.length;
    let endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
        endA -= 1;
        endB -= 1;
    }
    const midA = a.slice(start, endA);
    const midB = b.slice(start, endB);
    const ops = [];
    for (let i = 0; i < start; i += 1) ops.push({ kind: "same", text: a[i], left: i + 1, right: i + 1 });
    if (midA.length * midB.length > 4000000) {
        // Trop gros pour une LCS : bloc supprimé puis bloc ajouté.
        midA.forEach((text, i) => ops.push({ kind: "del", text, left: start + i + 1 }));
        midB.forEach((text, i) => ops.push({ kind: "add", text, right: start + i + 1 }));
    } else {
        const n = midA.length;
        const m = midB.length;
        const lcs = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
        for (let i = n - 1; i >= 0; i -= 1) {
            for (let j = m - 1; j >= 0; j -= 1) {
                lcs[i][j] = midA[i] === midB[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
            }
        }
        let i = 0;
        let j = 0;
        while (i < n || j < m) {
            if (i < n && j < m && midA[i] === midB[j]) {
                ops.push({ kind: "same", text: midA[i], left: start + i + 1, right: start + j + 1 });
                i += 1;
                j += 1;
            } else if (j < m && (i >= n || lcs[i][j + 1] >= lcs[i + 1][j])) {
                ops.push({ kind: "add", text: midB[j], right: start + j + 1 });
                j += 1;
            } else {
                ops.push({ kind: "del", text: midA[i], left: start + i + 1 });
                i += 1;
            }
        }
    }
    for (let k = 0; k < a.length - endA; k += 1) {
        ops.push({ kind: "same", text: a[endA + k], left: endA + k + 1, right: endB + k + 1 });
    }
    return ops;
}

function buildStudioCompareDialog() {
    const existing = $("studio-compare-dialog");
    if (existing) return existing;
    const dialog = document.createElement("dialog");
    dialog.id = "studio-compare-dialog";
    dialog.className = "studio-compare-dialog";
    dialog.innerHTML = `
        <div class="studio-compare-head">
            <div>
                <h2>Comparer le document</h2>
                <p id="studio-compare-file" class="studio-muted"></p>
            </div>
            <div class="studio-actions">
                <select id="studio-compare-base" aria-label="Version de référence">
                    <option value="saved">Version enregistrée</option>
                    <option value="git">Dernier commit Git (HEAD)</option>
                </select>
                <label class="studio-compare-context"><input type="checkbox" id="studio-compare-only" checked> Changements seuls</label>
                <button type="button" id="studio-compare-close">Fermer</button>
            </div>
        </div>
        <p id="studio-compare-summary" class="studio-muted" role="status"></p>
        <div id="studio-compare-body" class="studio-compare-body"></div>`;
    document.body.append(dialog);
    $("studio-compare-close").addEventListener("click", () => dialog.close());
    $("studio-compare-base").addEventListener("change", () => { renderStudioCompare(); });
    $("studio-compare-only").addEventListener("change", () => { renderStudioCompare(); });
    return dialog;
}

async function renderStudioCompare() {
    const tab = currentTab();
    const body = $("studio-compare-body");
    const summary = $("studio-compare-summary");
    if (!tab || !body) return;
    $("studio-compare-file").textContent = tab.path;
    body.replaceChildren();
    let before;
    try {
        before = $("studio-compare-base").value === "git" ? await api.gitShowHead(tab.path) : tab.saved;
    } catch (error) {
        summary.textContent = `Référence indisponible : ${error.message || error}`;
        return;
    }
    before = String(before ?? "").split("\r\n").join("\n");
    const ops = studioLineDiff(before, tab.content);
    const added = ops.filter((op) => op.kind === "add").length;
    const removed = ops.filter((op) => op.kind === "del").length;
    summary.textContent = added || removed ? `+${added} ligne(s) · −${removed} ligne(s)` : "Aucune différence.";
    const onlyChanges = $("studio-compare-only").checked;
    const keep = new Set();
    ops.forEach((op, index) => {
        if (op.kind === "same") return;
        for (let k = Math.max(0, index - 3); k <= Math.min(ops.length - 1, index + 3); k += 1) keep.add(k);
    });
    const fragment = document.createDocumentFragment();
    let skipped = false;
    ops.forEach((op, index) => {
        if (onlyChanges && !keep.has(index)) {
            if (!skipped) {
                const gap = document.createElement("div");
                gap.className = "studio-diff-gap";
                gap.textContent = "⋯";
                fragment.append(gap);
            }
            skipped = true;
            return;
        }
        skipped = false;
        const row = document.createElement("div");
        row.className = `studio-diff-line studio-diff-${op.kind}`;
        const left = document.createElement("span");
        left.className = "studio-diff-num";
        left.textContent = op.left ?? "";
        const right = document.createElement("span");
        right.className = "studio-diff-num";
        right.textContent = op.right ?? "";
        const text = document.createElement("span");
        text.className = "studio-diff-text";
        text.textContent = `${op.kind === "add" ? "+" : op.kind === "del" ? "−" : " "} ${op.text}`;
        row.append(left, right, text);
        fragment.append(row);
    });
    body.append(fragment);
}

async function openStudioCompare() {
    const tab = currentTab();
    if (!tab) {
        editorStudioStatus("Ouvre un fichier pour le comparer.");
        return;
    }
    if (typeof lspSyncTabFromEditor === "function") lspSyncTabFromEditor(tab);
    const dialog = buildStudioCompareDialog();
    if (!dialog.open) dialog.showModal();
    await renderStudioCompare();
}

/* ---------- Barre d'outils et raccourcis ---------- */

function buildEditorStudioToolbar() {
    const host = $("cm-host");
    if (!host || $("studio-editor-toolbar")) return;
    const bar = document.createElement("div");
    bar.id = "studio-editor-toolbar";
    bar.className = "studio-editor-toolbar";
    const actions = [
        ["Formater", "Formater avec Prettier (Maj+Alt+F)", formatEditorDocument],
        ["Comparer", "Comparer avec la version enregistrée ou HEAD (Ctrl+Alt+D)", openStudioCompare],
        ["Tout enregistrer", "Enregistrer tous les fichiers modifiés (Ctrl+Maj+S)", saveAllStudioFiles]
    ];
    for (const [label, title, run] of actions) {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = label;
        button.title = title;
        button.addEventListener("click", () => { run(); });
        bar.append(button);
    }
    host.before(bar);
}

window.addEventListener("keydown", (event) => {
    if (document.querySelector("dialog[open]")) return;
    const key = event.key.toLowerCase();
    const mod = event.ctrlKey || event.metaKey;
    let action = null;
    if (event.shiftKey && event.altKey && !mod && key === "f") action = formatEditorDocument;
    else if (mod && event.shiftKey && !event.altKey && key === "s") action = saveAllStudioFiles;
    else if (mod && event.altKey && !event.shiftKey && key === "d") action = openStudioCompare;
    if (!action) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    Promise.resolve(action()).catch((error) => editorStudioStatus(error.message || String(error)));
}, true);

/* ---------- Préférences de l'éditeur, aperçu HTML, marque-pages ---------- */
// Le thème, l'enregistrement automatique et l'aperçu Markdown existent déjà dans 08-editor.js
// (editorPrefs, setAutosave, applyTheme, toggleMdPreview) : on les réutilise au lieu de les dupliquer.

const STUDIO_EDITOR_PREFS_KEY = "frst.editor-prefs";
const STUDIO_BOOKMARKS_KEY = "frst.bookmarks";
const studioEditorPrefs = { fontSize: 14, wrap: false, formatOnSave: false };
let studioBookmarks = {};
let studioHtmlPreviewOn = false;
let studioHtmlTimer = null;
let studioLastPath = null;

(() => {
    try {
        const stored = JSON.parse(localStorage.getItem(STUDIO_EDITOR_PREFS_KEY) || "{}");
        const size = Number(stored.fontSize);
        if (size >= 10 && size <= 24) studioEditorPrefs.fontSize = Math.round(size);
        if (typeof stored.wrap === "boolean") studioEditorPrefs.wrap = stored.wrap;
        if (typeof stored.formatOnSave === "boolean") studioEditorPrefs.formatOnSave = stored.formatOnSave;
    } catch {
        // préférences par défaut
    }
    try {
        const marks = JSON.parse(localStorage.getItem(STUDIO_BOOKMARKS_KEY) || "{}");
        if (marks && typeof marks === "object" && !Array.isArray(marks)) studioBookmarks = marks;
    } catch {
        studioBookmarks = {};
    }
})();

function saveStudioEditorPrefs() {
    try {
        localStorage.setItem(STUDIO_EDITOR_PREFS_KEY, JSON.stringify(studioEditorPrefs));
    } catch {
        editorStudioStatus("Préférences non enregistrées : stockage local indisponible.");
    }
}

function applyStudioEditorPrefs() {
    document.documentElement.style.setProperty("--editor-font-size", `${studioEditorPrefs.fontSize}px`);
    const editor = $("editor");
    if (editor) editor.classList.toggle("studio-wrap", studioEditorPrefs.wrap);
    if (code.view && typeof code.view.requestMeasure === "function") code.view.requestMeasure();
}

function syncEditorPrefsCard() {
    const theme = $("set-editor-theme");
    if (!theme) return;
    if (typeof editorPrefs === "object") {
        if (document.activeElement !== theme && theme.value !== editorPrefs.theme) theme.value = editorPrefs.theme;
        const auto = $("set-editor-autosave");
        if (auto.checked !== Boolean(editorPrefs.autosave)) auto.checked = Boolean(editorPrefs.autosave);
    }
    const size = $("set-editor-font-size");
    if (document.activeElement !== size && Number(size.value) !== studioEditorPrefs.fontSize) size.value = String(studioEditorPrefs.fontSize);
    $("set-editor-wrap").checked = studioEditorPrefs.wrap;
    $("set-editor-format-on-save").checked = studioEditorPrefs.formatOnSave;
}

function buildEditorPrefsCard() {
    const anchor = $("settings-message");
    if (!anchor || $("studio-editor-prefs")) return;
    const card = document.createElement("div");
    card.id = "studio-editor-prefs";
    card.className = "ext-section";
    card.innerHTML = `
        <div class="ext-section-head"><span>Éditeur</span></div>
        <label class="settings-row settings-number">Thème <select id="set-editor-theme" class="settings-select"><option value="dark">Sombre</option><option value="light">Clair</option></select></label>
        <label class="settings-row settings-number">Taille du texte (px) <input type="number" id="set-editor-font-size" min="10" max="24" step="1"></label>
        <label class="settings-row"><input type="checkbox" id="set-editor-wrap"> Retour à la ligne automatique</label>
        <label class="settings-row"><input type="checkbox" id="set-editor-autosave"> Enregistrement automatique (1 s après la dernière frappe)</label>
        <label class="settings-row"><input type="checkbox" id="set-editor-format-on-save"> Formater avec Prettier à l'enregistrement (Ctrl+S)</label>
        <div class="settings-note">Préférences propres à cette machine. L'enregistrement automatique ne déclenche pas le formatage.</div>`;
    anchor.before(card);
    $("set-editor-theme").addEventListener("change", (event) => {
        if (typeof applyTheme === "function") {
            applyTheme(event.target.value);
            if (typeof saveEditorPrefs === "function") saveEditorPrefs();
        }
    });
    $("set-editor-font-size").addEventListener("change", (event) => {
        const size = Math.round(Number(event.target.value));
        studioEditorPrefs.fontSize = Number.isFinite(size) ? Math.min(24, Math.max(10, size)) : 14;
        event.target.value = String(studioEditorPrefs.fontSize);
        saveStudioEditorPrefs();
        applyStudioEditorPrefs();
    });
    $("set-editor-wrap").addEventListener("change", (event) => {
        studioEditorPrefs.wrap = event.target.checked;
        saveStudioEditorPrefs();
        applyStudioEditorPrefs();
    });
    $("set-editor-autosave").addEventListener("change", (event) => {
        if (typeof setAutosave === "function") setAutosave(event.target.checked);
    });
    $("set-editor-format-on-save").addEventListener("change", (event) => {
        studioEditorPrefs.formatOnSave = event.target.checked;
        saveStudioEditorPrefs();
    });
    syncEditorPrefsCard();
}

async function saveWithStudioFormat() {
    const tab = currentTab();
    if (!tab) return;
    if (studioEditorPrefs.formatOnSave) await formatEditorDocument();
    if (currentTab() === tab) await saveCurrent();
}

/* Aperçu HTML : iframe sandbox sans scripts, alimentée par srcdoc (aucun serveur). */

function isStudioHtmlPath(path) {
    return /\.html?$/i.test(path || "");
}

function updateStudioHtmlPreview() {
    const editor = $("editor");
    if (!editor) return;
    const tab = currentTab();
    const show = Boolean(studioHtmlPreviewOn && tab && isStudioHtmlPath(tab.path));
    let frame = $("studio-html-preview");
    if (show && !frame) {
        frame = document.createElement("iframe");
        frame.id = "studio-html-preview";
        frame.className = "studio-html-preview";
        frame.setAttribute("sandbox", "");
        frame.title = "Aperçu HTML";
        editor.append(frame);
    }
    editor.classList.toggle("studio-html-on", show);
    if (!frame) return;
    frame.classList.toggle("hidden", !show);
    if (show) {
        if (frame.getAttribute("srcdoc") !== tab.content) frame.setAttribute("srcdoc", tab.content);
    } else if (frame.hasAttribute("srcdoc")) {
        frame.removeAttribute("srcdoc");
    }
    const button = $("studio-preview-toggle");
    if (button) button.setAttribute("aria-pressed", String(show || Boolean($("editor").classList.contains("with-preview"))));
}

function toggleStudioPreview() {
    const tab = currentTab();
    if (!tab) {
        editorStudioStatus("Ouvre un fichier Markdown ou HTML pour l'aperçu.");
        return;
    }
    if (typeof isMarkdownPath === "function" && isMarkdownPath(tab.path) && typeof toggleMdPreview === "function") {
        toggleMdPreview();
    } else if (isStudioHtmlPath(tab.path)) {
        studioHtmlPreviewOn = !studioHtmlPreviewOn;
        updateStudioHtmlPreview();
        editorStudioStatus(studioHtmlPreviewOn ? "Aperçu HTML (scripts désactivés, ressources relatives non chargées)." : "Aperçu HTML fermé.");
    } else {
        editorStudioStatus("Aperçu disponible pour les fichiers Markdown et HTML.");
    }
    updateStudioHtmlPreview();
}

/* Marque-pages : numéros de ligne mémorisés par projet et par fichier. */

function studioBookmarkKey(tab) {
    return `${(ui && ui.workspace) || ""}::${tab.path}`;
}

function studioTabBookmarks(tab) {
    const list = tab ? studioBookmarks[studioBookmarkKey(tab)] : null;
    return Array.isArray(list) ? list.filter((n) => Number.isInteger(n) && n > 0) : [];
}

function storeStudioBookmarks(tab, list) {
    const key = studioBookmarkKey(tab);
    if (list.length) studioBookmarks[key] = [...new Set(list)].sort((a, b) => a - b);
    else delete studioBookmarks[key];
    try {
        localStorage.setItem(STUDIO_BOOKMARKS_KEY, JSON.stringify(studioBookmarks));
    } catch {
        editorStudioStatus("Marque-pages non enregistrés : stockage local indisponible.");
    }
}

function studioCurrentLine() {
    const state = code.view.state;
    return state.doc.lineAt(state.selection.main.head).number;
}

function gotoStudioLine(number) {
    if (!code.view) return;
    const doc = code.view.state.doc;
    const line = doc.line(Math.min(Math.max(1, number), doc.lines));
    code.view.dispatch({ selection: { anchor: line.from }, scrollIntoView: true });
    code.view.focus();
}

function toggleStudioBookmark() {
    const tab = currentTab();
    if (!tab || !code.view) {
        editorStudioStatus("Ouvre un fichier pour poser un marque-page.");
        return;
    }
    const line = studioCurrentLine();
    const list = studioTabBookmarks(tab);
    const exists = list.includes(line);
    storeStudioBookmarks(tab, exists ? list.filter((n) => n !== line) : [...list, line]);
    renderStudioBookmarks();
    editorStudioStatus(exists ? `Marque-page retiré (ligne ${line}).` : `Marque-page posé (ligne ${line}).`);
}

function nextStudioBookmark(backward) {
    const tab = currentTab();
    if (!tab || !code.view) return;
    const doc = code.view.state.doc;
    const list = studioTabBookmarks(tab).filter((n) => n <= doc.lines);
    if (!list.length) {
        editorStudioStatus("Aucun marque-page dans ce fichier (Ctrl+Alt+K pour en poser un).");
        return;
    }
    const current = studioCurrentLine();
    const target = backward
        ? ([...list].reverse().find((n) => n < current) ?? list[list.length - 1])
        : (list.find((n) => n > current) ?? list[0]);
    gotoStudioLine(target);
    editorStudioStatus(`Marque-page : ligne ${target}.`);
}

function renderStudioBookmarks() {
    const select = $("studio-bookmarks");
    if (!select) return;
    const tab = currentTab();
    const list = studioTabBookmarks(tab);
    select.replaceChildren();
    const head = document.createElement("option");
    head.value = "";
    head.textContent = `Marque-pages (${list.length})`;
    select.append(head);
    const doc = tab && code.view ? code.view.state.doc : null;
    for (const number of list) {
        const option = document.createElement("option");
        option.value = String(number);
        const text = doc && number <= doc.lines ? doc.line(number).text.trim().slice(0, 50) : "(au-delà de la fin)";
        option.textContent = `L${number} · ${text}`;
        select.append(option);
    }
    select.disabled = !tab;
}

function extendEditorStudioToolbar() {
    const bar = $("studio-editor-toolbar");
    if (!bar || $("studio-preview-toggle")) return;
    const add = (id, label, title, run) => {
        const button = document.createElement("button");
        button.type = "button";
        button.id = id;
        button.textContent = label;
        button.title = title;
        button.addEventListener("click", () => { run(); });
        bar.append(button);
        return button;
    };
    add("studio-preview-toggle", "Aperçu", "Aperçu Markdown ou HTML (Ctrl+Maj+V)", toggleStudioPreview);
    add("studio-bookmark-toggle", "Marque-page", "Poser ou retirer un marque-page sur la ligne (Ctrl+Alt+K)", toggleStudioBookmark);
    add("studio-bookmark-next", "Suivant", "Marque-page suivant (Ctrl+Alt+J) · précédent : Ctrl+Alt+Maj+J", () => nextStudioBookmark(false));
    const select = document.createElement("select");
    select.id = "studio-bookmarks";
    select.setAttribute("aria-label", "Aller à un marque-page");
    select.addEventListener("mousedown", renderStudioBookmarks);
    select.addEventListener("change", () => {
        const number = Number(select.value);
        select.value = "";
        if (number) gotoStudioLine(number);
    });
    bar.append(select);
}

window.addEventListener("keydown", (event) => {
    if (document.querySelector("dialog[open]")) return;
    const key = event.key.toLowerCase();
    const mod = event.ctrlKey || event.metaKey;
    const inField = Boolean(event.target && event.target.closest && event.target.closest("input, textarea, select"));
    let action = null;
    if (mod && !event.shiftKey && !event.altKey && key === "s" && studioEditorPrefs.formatOnSave && currentTab()) action = saveWithStudioFormat;
    else if (mod && event.shiftKey && !event.altKey && key === "v" && !inField && currentTab()) action = toggleStudioPreview;
    else if (mod && event.altKey && !event.shiftKey && key === "k" && !inField && currentTab()) action = toggleStudioBookmark;
    else if (mod && event.altKey && key === "j" && !inField && currentTab()) action = () => nextStudioBookmark(event.shiftKey);
    if (!action) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    Promise.resolve(action()).catch((error) => editorStudioStatus(error.message || String(error)));
}, true);

code.addEventListener("input", () => {
    if (!studioHtmlPreviewOn) return;
    clearTimeout(studioHtmlTimer);
    studioHtmlTimer = setTimeout(updateStudioHtmlPreview, 300);
});

setInterval(() => {
    const tab = currentTab();
    const path = tab ? tab.path : null;
    if (path !== studioLastPath) {
        studioLastPath = path;
        updateStudioHtmlPreview();
        renderStudioBookmarks();
    }
    syncEditorPrefsCard();
}, 400);

buildEditorStudioToolbar();
extendEditorStudioToolbar();
buildEditorPrefsCard();
applyStudioEditorPrefs();
renderStudioBookmarks();
