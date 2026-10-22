"use strict";

/* Interface façon VS Code : explorateur, éditeur à onglets, sortie des commandes, panneau Agent. */

const api = window.frst;
const $ = (id) => document.getElementById(id);

const SLASH_COMMANDS = [
    ["/help", "Aide"], ["/project", "Choisir un projet"], ["/unproject", "Quitter le projet"],
    ["/pwd", "Projet sélectionné"], ["/tree", "Lister un dossier (2 niveaux)"], ["/read", "Lire un fichier"],
    ["/extensions", "Extensions"],
    ["/plan", "Plan en lecture seule"], ["/analyze", "Analyser le projet (lecture seule)"], ["/undo", "Annuler la dernière modification"],
    ["/changes", "Modifications annulables"], ["/memory", "Notes du projet"],
    ["/remember", "Ajouter une note"], ["/forget", "Supprimer une note"],
    ["/permissions", "Règles des commandes"], ["/jobs", "Commandes en arrière-plan"],
    ["/mcp", "Serveurs MCP"], ["/skills", "Skills (SKILL.md)"], ["/auto", "Auto-approbation on|off|always|never"], ["/mode", "auto|agent|chat"],
    ["/new", "Nouvelle conversation"], ["/chat-id", "Chat ID / reprendre"], ["/history", "Conversations"],
    ["/messages", "Messages de la session"], ["/export", "Exporter la conversation en Markdown"], ["/usage", "Consommation"], ["/model", "Changer d'agent"],
    ["/web", "Recherche web on|off"], ["/eco", "Mode Éco on|off (contexte réduit, 4 tours)"], ["/index", "Régénérer RESUME.md"], ["/init", "Créer FRSTCLI.md"],
    ["/resume", "Résumé du projet"], ["/fr-project", "Projet FranceStudent"], ["/auth", "État de la connexion"],
    ["/login", "Se connecter"], ["/logout", "Se déconnecter"], ["/github", "Compte GitHub : login, remote, push, pull"],
    ["/review-pr", "Revue d'une pull request GitHub (n|owner/repo#n|URL) [--post]"],
    ["/worktree", "Agents parallèles en worktrees : list|new|run|show|diff|stop|remove"],
    ["/compact", "Résumer la conversation (contexte léger)"], ["/checkpoints", "Points de reprise de la session"],
    ["/rewind", "Revenir avant une demande"],
    ["/preprompt", "Pré-prompt"], ["/profil", "Profil"], ["/clear", "Effacer"]
];

const ui = {
    status: {},
    prompts: [],
    live: null,
    liveText: "",
    spinnerId: null,
    tabs: [],
    active: null,
    workspace: null,
    history: [],
    historyIndex: 0,
    slashIndex: 0,
    changes: new Map(),      // chemin -> { added, removed }
    changesOrder: [],
    models: null,            // { agents, source, error, current }
    currentModelId: null,
    highlightTimer: null,
    quota: null,             // { percent, bucket, resetAt, powerUp, limits }
    sessionRequests: ""
};

const transcript = $("transcript");
const input = $("input");
/* Complétion IA en ligne : Alt+\\ (ou Ctrl+Alt+Espace) demande une suggestion, Tab l'accepte, Échap l'ignore. */
function inlineCompletionExtension(kind) {
    const CM = window.CM;
    if (!CM.StateField || !CM.StateEffect || !CM.Decoration || !CM.WidgetType || !CM.Prec) return [];
    const setGhost = CM.StateEffect.define();
    class GhostWidget extends CM.WidgetType {
        constructor(text) {
            super();
            this.text = text;
        }
        eq(other) { return other.text === this.text; }
        toDOM() {
            const span = document.createElement("span");
            span.className = "cm-ghost-text";
            span.textContent = this.text;
            return span;
        }
        ignoreEvent() { return true; }
    }
    const ghostField = CM.StateField.define({
        create: () => null,
        update(value, tr) {
            for (const effect of tr.effects) if (effect.is(setGhost)) return effect.value;
            if (value && (tr.docChanged || tr.selection)) return null;
            return value;
        },
        provide: (field) => CM.EditorView.decorations.from(field, (ghost) => ghost
            ? CM.Decoration.set([CM.Decoration.widget({ widget: new GhostWidget(ghost.text), side: 1 }).range(ghost.pos)])
            : CM.Decoration.none)
    });
    let seq = 0;
    const activePath = () => {
        const active = typeof ui !== "undefined" ? ui.active : null;
        if (typeof active === "string") return active;
        return (active && (active.path || active.rel)) || "";
    };
    const request = (view) => {
        if (!api || !api.inlineComplete) return false;
        const pos = view.state.selection.main.head;
        const doc = view.state.doc;
        const id = ++seq;
        api.inlineComplete({
            path: activePath(),
            language: kind || "",
            prefix: doc.sliceString(Math.max(0, pos - 4000), pos),
            suffix: doc.sliceString(pos, Math.min(doc.length, pos + 1500))
        }).then((text) => {
            if (id !== seq || !text || view.state.doc !== doc || view.state.selection.main.head !== pos) return;
            view.dispatch({ effects: setGhost.of({ pos, text }) });
        }).catch(() => {});
        return true;
    };
    const accept = (view) => {
        const ghost = view.state.field(ghostField, false);
        if (!ghost) return false;
        view.dispatch({
            changes: { from: ghost.pos, insert: ghost.text },
            selection: { anchor: ghost.pos + ghost.text.length }
        });
        return true;
    };
    const dismiss = (view) => {
        if (!view.state.field(ghostField, false)) return false;
        view.dispatch({ effects: setGhost.of(null) });
        return true;
    };
    return [
        ghostField,
        CM.Prec.highest(CM.keymap.of([
            { key: "Tab", run: accept },
            { key: "Escape", run: dismiss },
            { key: "Alt-\\", run: request },
            { key: "Ctrl-Alt-Space", run: request }
        ]))
    ];
}

/* Couche de compatibilité : API proche de l'ancien <textarea> au-dessus de CodeMirror 6. */
function createCodeEditor(host) {
    const CM = window.CM;
    if (!CM || !host) {
        throw new Error("CodeMirror introuvable : vérifie que vendor/codemirror.js est chargé (npm run vendor:renderer).");
    }
    const events = new EventTarget();
    const language = new CM.Compartment();
    let silent = false;
    const emit = (name) => events.dispatchEvent(new Event(name));
    const extensions = (kind) => [
        CM.basicSetup,
        CM.keymap.of([CM.indentWithTab]),
        CM.indentUnit.of("    "),
        CM.EditorState.tabSize.of(4),
        CM.oneDark,
        language.of(CM.languageFor(kind || "default")),
        inlineCompletionExtension(kind),
        lspExtension(kind),
        inlineEditExtension(kind),
        CM.EditorView.updateListener.of((update) => {
            if (update.docChanged && !silent) emit("input");
            if (update.selectionSet) emit("select");
        })
    ];
    const view = new CM.EditorView({
        state: CM.EditorState.create({ doc: "", extensions: extensions("default") }),
        parent: host
    });
    for (const name of ["keyup", "click", "focus"]) view.contentDOM.addEventListener(name, () => emit(name));
    view.scrollDOM.addEventListener("scroll", () => emit("scroll"));
    const clamp = (n) => Math.max(0, Math.min(view.state.doc.length, Number(n) || 0));

    return {
        view,
        get value() { return view.state.doc.toString(); },
        set value(text) {
            silent = true;
            try {
                view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: String(text ?? "") } });
            } finally {
                silent = false;
            }
        },
        get selectionStart() { return view.state.selection.main.from; },
        get selectionEnd() { return view.state.selection.main.to; },
        setSelectionRange(a, b) {
            const anchor = clamp(a);
            const head = clamp(b ?? a);
            view.dispatch({ selection: { anchor, head }, effects: CM.EditorView.scrollIntoView(anchor, { y: "center" }) });
        },
        focus() { view.focus(); },
        hasFocus() { return view.hasFocus; },
        get scrollTop() { return view.scrollDOM.scrollTop; },
        set scrollTop(v) { view.scrollDOM.scrollTop = v; },
        get scrollLeft() { return view.scrollDOM.scrollLeft; },
        set scrollLeft(v) { view.scrollDOM.scrollLeft = v; },
        get clientHeight() { return view.scrollDOM.clientHeight; },
        addEventListener: (name, fn, opts) => events.addEventListener(name, fn, opts),
        removeEventListener: (name, fn, opts) => events.removeEventListener(name, fn, opts),
        dispatchEvent: (ev) => events.dispatchEvent(ev),
        getState() { return view.state; },
        /* Charge un texte ; réutilise l'état sauvegardé (historique, sélection) s'il correspond encore. */
        load(text, kind, saved) {
            const doc = String(text ?? "");
            const state = saved && saved.doc.toString() === doc
                ? saved
                : CM.EditorState.create({ doc, extensions: extensions(kind) });
            view.setState(state);
        }
    };
}

const code = createCodeEditor($("cm-host"));
const highlightEl = $("highlight");
const modelMenuEl = $("model-menu");
const output = $("output");
const expanded = new Set();

/* ---------- Rendu du texte ---------- */

const TOOL_LABELS = {
    list_directory: "Lister", read_file: "Lire", search_files: "Chercher",
    create_directory: "Créer le dossier", write_file: "Écrire", edit_file: "Éditer",
    move_path: "Déplacer", copy_path: "Copier", delete_path: "Supprimer",
    remember: "Mémoriser", run_command: "Commande"
};

function toolLabel(name) {
    return TOOL_LABELS[name] || String(name ?? "");
}

function escapeHtml(text) {
    return String(text ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function inline(text) {
    return escapeHtml(text)
        .replace(/`([^`]+)`/g, "<code>$1</code>")
        .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>");
}

function renderMarkdown(src) {
    const lines = String(src ?? "").split("\n");
    let html = "";
    let block = null;
    let list = null;
    const closeList = () => {
        if (list) {
            html += `</${list}>`;
            list = null;
        }
    };

    for (const line of lines) {
        if (/^\s*(```|~~~)/.test(line)) {
            if (block === null) {
                closeList();
                block = [];
            } else {
                html += `<pre><code>${escapeHtml(block.join("\n"))}</code></pre>`;
                block = null;
            }
            continue;
        }
        if (block !== null) {
            block.push(line);
            continue;
        }
        const heading = /^(#{1,6})\s+(.*)$/.exec(line);
        const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
        const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
        if (heading) {
            closeList();
            html += `<h4>${inline(heading[2])}</h4>`;
        } else if (bullet || numbered) {
            const kind = bullet ? "ul" : "ol";
            if (list !== kind) {
                closeList();
                html += `<${kind}>`;
                list = kind;
            }
            html += `<li>${inline((bullet || numbered)[1])}</li>`;
        } else if (!line.trim()) {
            closeList();
            html += "<br>";
        } else {
            closeList();
            html += `<div>${inline(line)}</div>`;
        }
    }

    if (block !== null) html += `<pre><code>${escapeHtml(block.join("\n"))}</code></pre>`;
    closeList();
    return html;
}

function diffLine(line) {
    if (typeof line === "string") {
        const first = line[0];
        const cls = first === "+" ? "add" : first === "-" ? "del" : first === "@" ? "hunk" : "";
        return { text: line, cls };
    }
    const kind = String(line?.type ?? line?.kind ?? line?.op ?? "");
    const text = String(line?.text ?? line?.line ?? line?.value ?? "");
    const cls = /add|ins|\+/.test(kind) ? "add" : /del|rem|-/.test(kind) ? "del" : /hunk|sep|@/.test(kind) ? "hunk" : "";
    const sign = cls === "add" ? "+ " : cls === "del" ? "- " : "  ";
    return { text: cls === "hunk" ? text : sign + text, cls };
}

function buildDiffCard(entry) {
    const card = document.createElement("div");
    card.className = "diff-card";

    if (entry.path) {
        const head = document.createElement("div");
        head.className = "diff-head";
        head.appendChild(fileIcon(entry.path, "file"));
        const p = document.createElement("span");
        p.className = "diff-path";
        p.textContent = entry.path;
        p.title = `${entry.path} — cliquez pour ouvrir`;
        p.onclick = () => openFile(entry.path);
        head.appendChild(p);
        const stats = document.createElement("span");
        stats.className = "diff-stats";
        const add = document.createElement("b");
        add.className = "add";
        add.textContent = `+${entry.added ?? 0}`;
        const del = document.createElement("b");
        del.className = "del";
        del.textContent = `-${entry.removed ?? 0}`;
        stats.append(add, del);
        head.appendChild(stats);
        card.appendChild(head);
    } else {
        const summary = document.createElement("div");
        summary.className = "diff-summary";
        summary.textContent = `+${entry.added ?? 0} / -${entry.removed ?? 0}`;
        card.appendChild(summary);
    }

    const body = document.createElement("div");
    body.className = "diff";
    body.innerHTML = (entry.lines || [])
        .map((line) => {
            const d = diffLine(line);
            return `<div class="${d.cls}">${escapeHtml(d.text) || " "}</div>`;
        })
        .join("");
    card.appendChild(body);
    return card;
}

/* ---------- Coloration syntaxique de l'éditeur ---------- */

const JS_KEYWORDS = ("await async break case catch class const continue debugger default delete do else enum export extends " +
    "false finally for from function get if implements import in instanceof interface let new null of return set static " +
    "super switch this throw true try typeof undefined var void while with yield").split(" ");
const TS_EXTRA = ("type namespace declare public private protected readonly abstract keyof infer never unknown any satisfies " +
    "as is asserts").split(" ");
const HL_KEYWORDS = {
    js: new Set(JS_KEYWORDS),
    ts: new Set([...JS_KEYWORDS, ...TS_EXTRA]),
    json: new Set(["true", "false", "null"]),
    py: new Set(("and as assert async await break class continue def del elif else except False finally for from global if " +
        "import in is lambda None nonlocal not or pass raise return True try while with yield self").split(" "))
};

function hlSpan(cls, text) {
    return `<span class="tok-${cls}">${escapeHtml(text)}</span>`;
}

function hlClike(text, kw) {
    const re = /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|(`(?:[^`\\]|\\.)*`|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(\b\d[\w.]*\b|\b0[xX][0-9a-fA-F]+\b)|([A-Za-z_$][\w$]*)|([{}()[\];,.:=+\-*/%<>!&|?~^]+)/g;
    let out = "";
    let last = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
        if (m.index > last) out += escapeHtml(text.slice(last, m.index));
        if (m[1] != null) out += hlSpan("comment", m[1]);
        else if (m[2] != null) out += hlSpan("string", m[2]);
        else if (m[3] != null) out += hlSpan("number", m[3]);
        else if (m[4] != null) {
            const word = m[4];
            const prev = text[m.index - 1];
            const rest = text.slice(re.lastIndex);
            if (kw.has(word)) out += hlSpan("keyword", word);
            else if (/^\s*\(/.test(rest)) out += hlSpan("func", word);
            else if (prev === ".") out += hlSpan("prop", word);
            else if (/^[A-Z]/.test(word)) out += hlSpan("type", word);
            else out += escapeHtml(word);
        } else {
            out += hlSpan("punct", m[5]);
        }
        last = re.lastIndex;
    }
    return out + escapeHtml(text.slice(last));
}

function hlPython(text) {
    const kw = HL_KEYWORDS.py;
    const re = /(#[^\n]*)|("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(\b\d[\w.]*\b)|([A-Za-z_]\w*)|([{}()[\];,.:=+\-*/%<>!&|?~^@]+)/g;
    let out = "";
    let last = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
        if (m.index > last) out += escapeHtml(text.slice(last, m.index));
        if (m[1] != null) out += hlSpan("comment", m[1]);
        else if (m[2] != null) out += hlSpan("string", m[2]);
        else if (m[3] != null) out += hlSpan("number", m[3]);
        else if (m[4] != null) {
            const word = m[4];
            const rest = text.slice(re.lastIndex);
            if (kw.has(word)) out += hlSpan("keyword", word);
            else if (/^\s*\(/.test(rest)) out += hlSpan("func", word);
            else if (/^[A-Z]/.test(word)) out += hlSpan("type", word);
            else out += escapeHtml(word);
        } else {
            out += hlSpan("punct", m[5]);
        }
        last = re.lastIndex;
    }
    return out + escapeHtml(text.slice(last));
}

function hlCss(text) {
    const re = /(\/\*[\s\S]*?\*\/)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(#[0-9a-fA-F]{3,8}\b)|(@[a-zA-Z-]+)|([.#:%][A-Za-z_][\w-]*|::?[a-zA-Z-]+)|([a-zA-Z-]+)(?=\s*:)|(-?\d*\.?\d+(?:[a-z%]{1,4})?)|([{}();:,>~+])/g;
    let out = "";
    let last = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
        if (m.index > last) out += escapeHtml(text.slice(last, m.index));
        if (m[1] != null) out += hlSpan("comment", m[1]);
        else if (m[2] != null) out += hlSpan("string", m[2]);
        else if (m[3] != null) out += hlSpan("color", m[3]);
        else if (m[4] != null) out += hlSpan("atrule", m[4]);
        else if (m[5] != null) out += hlSpan("selector", m[5]);
        else if (m[6] != null) out += hlSpan("prop", m[6]);
        else if (m[7] != null) out += hlSpan("number", m[7]);
        else out += hlSpan("punct", m[8]);
        last = re.lastIndex;
    }
    return out + escapeHtml(text.slice(last));
}

function hlHtml(text) {
    const re = /(<!--[\s\S]*?-->)|(<\/?[a-zA-Z][\w:-]*)|([a-zA-Z_:][\w:.-]*)(?==)|("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(&[a-zA-Z#0-9]+;)|(\/?>)/g;
    let out = "";
    let last = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
        if (m.index > last) out += escapeHtml(text.slice(last, m.index));
        if (m[1] != null) out += hlSpan("comment", m[1]);
        else if (m[2] != null) out += hlSpan("tag", m[2]);
        else if (m[3] != null) out += hlSpan("attr", m[3]);
        else if (m[4] != null) out += hlSpan("string", m[4]);
        else if (m[5] != null) out += hlSpan("entity", m[5]);
        else out += hlSpan("tag", m[6]);
        last = re.lastIndex;
    }
    return out + escapeHtml(text.slice(last));
}

function hlMarkdown(text) {
    const re = /(^#{1,6} .*$)|(```[\s\S]*?```|`[^`\n]+`)|(\*\*[^*\n]+\*\*)|(!?\[[^\]\n]*\]\([^)\n]*\))|(^\s*(?:[-*+]|\d+[.)]) )/gm;
    let out = "";
    let last = 0;
    let m;
    while ((m = re.exec(text)) !== null) {
        if (m.index > last) out += escapeHtml(text.slice(last, m.index));
        if (m[1] != null) out += hlSpan("heading", m[1]);
        else if (m[2] != null) out += hlSpan("code", m[2]);
        else if (m[3] != null) out += hlSpan("bold", m[3]);
        else if (m[4] != null) out += hlSpan("link", m[4]);
        else out += hlSpan("list", m[5]);
        last = re.lastIndex;
    }
    return out + escapeHtml(text.slice(last));
}

function extKind(path) {
    if (!path) return "default";
    const base = String(path).split("/").pop();
    const ext = base.includes(".") ? base.split(".").pop().toLowerCase() : "";
    return FILE_KINDS[ext] || "default";
}

function highlightCode(text, kind) {
    if (text.length > 400000) return escapeHtml(text);
    try {
        if (kind === "js") return hlClike(text, HL_KEYWORDS.js);
        if (kind === "ts") return hlClike(text, HL_KEYWORDS.ts);
        if (kind === "json") return hlClike(text, HL_KEYWORDS.json);
        if (kind === "py") return hlPython(text);
        if (kind === "css") return hlCss(text);
        if (kind === "html") return hlHtml(text);
        if (kind === "md") return hlMarkdown(text);
    } catch {
        // en cas d'erreur de coloration, on retombe sur le texte brut
    }
    return escapeHtml(text);
}

function syncHighlightScroll() {
    if (!highlightEl) return;
    highlightEl.scrollTop = code.scrollTop;
    highlightEl.scrollLeft = code.scrollLeft;
}

function syncHighlight() {
    if (!highlightEl) return;
    const tab = currentTab();
    if (!tab) {
        highlightEl.textContent = "";
        return;
    }
    const kind = extKind(tab.path);
    if (kind === "default" || kind === "img") {
        highlightEl.textContent = code.value;
    } else {
        highlightEl.innerHTML = `${highlightCode(code.value, kind)}\n`;
    }
    syncHighlightScroll();
}

let highlightFrame = null;

function scheduleHighlight() {
    if (highlightFrame) return;
    highlightFrame = requestAnimationFrame(() => {
        highlightFrame = null;
        syncHighlight();
    });
}

/* ---------- Transcript ---------- */

function scrollDown() {
    transcript.scrollTop = transcript.scrollHeight;
}

const QUIET_TOOLS = new Set(["read_file", "search_files", "list_directory"]);
let toolGroup = null;

function toolRowHtml(e) {
    return `<span class="tdot"></span><span class="name">${escapeHtml(toolLabel(e.name))}</span><span class="arg" title="${escapeHtml(e.arg || "")}">${escapeHtml(e.arg || "")}</span>`;
}

function plural(n, word) {
    return `${n} ${word}${n > 1 ? "s" : ""}`;
}

/** Lectures, recherches et listes successives : une seule ligne repliable. */
function addQuietTool(e) {
    if (!toolGroup) {
        const el = addEntry("tool-group", "<details><summary></summary><div class=\"tool-group-body\"></div></details>");
        toolGroup = { el, summary: el.querySelector("summary"), body: el.querySelector(".tool-group-body"), reads: 0, searches: 0, lists: 0, awaitingResult: false };
    }
    const g = toolGroup;
    if (e.name === "read_file") g.reads++;
    else if (e.name === "search_files") g.searches++;
    else g.lists++;
    const parts = [];
    if (g.reads) parts.push(plural(g.reads, "lecture"));
    if (g.searches) parts.push(plural(g.searches, "recherche"));
    if (g.lists) parts.push(`${plural(g.lists, "dossier")} listé${g.lists > 1 ? "s" : ""}`);
    g.summary.textContent = parts.join(" · ");
    const row = document.createElement("div");
    row.className = "entry tool";
    row.innerHTML = toolRowHtml(e);
    g.body.appendChild(row);
    g.awaitingResult = true;
    scrollDown();
    return row;
}

function addEntry(cls, html) {
    toolGroup = null;
    const div = document.createElement("div");
    div.className = `entry ${cls}`;
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

/** Libellé court du type d'une pièce jointe : extension en majuscules (PDF, TXT, JS…) ou catégorie MIME. */
function attachmentTypeLabel(item) {
    const match = /\.([a-z0-9]{1,6})$/i.exec(String((item && item.name) || ""));
    if (match) return match[1].toUpperCase();
    const mime = String((item && item.mime) || "").toLowerCase();
    if ((item && item.kind === "image") || mime.startsWith("image/")) return "IMAGE";
    if ((item && item.kind === "text") || mime.startsWith("text/")) return "TEXTE";
    if (mime.startsWith("audio/")) return "AUDIO";
    if (mime.startsWith("video/")) return "VIDÉO";
    return "FICHIER";
}

/** Aperçu des pièces jointes d'un message envoyé : miniature pour les images, badge de type sinon. */
function buildUserAttachments(files) {
    const box = document.createElement("div");
    box.className = "user-attachments";
    files.forEach((item) => {
        const isImage = item.kind === "image" && typeof item.preview === "string" && /^data:image\//i.test(item.preview);
        const card = document.createElement("div");
        card.className = `user-attachment ${isImage ? "is-image" : "is-file"}`;
        const size = Number.isFinite(item.size) && typeof formatBytes === "function" ? formatBytes(item.size) : "";
        card.title = [item.name, item.mime, size].filter(Boolean).join(" · ");
        if (isImage) {
            const img = document.createElement("img");
            img.src = item.preview;
            img.alt = item.name;
            img.loading = "lazy";
            img.title = "Cliquer pour agrandir ou réduire";
            img.onclick = () => card.classList.toggle("expanded");
            card.appendChild(img);
        } else {
            const badge = document.createElement("span");
            badge.className = `user-attachment-type kind-${item.kind === "text" ? "text" : "file"}`;
            badge.textContent = attachmentTypeLabel(item);
            card.appendChild(badge);
        }
        const info = document.createElement("span");
        info.className = "user-attachment-info";
        const name = document.createElement("span");
        name.className = "user-attachment-name";
        name.textContent = item.name;
        info.appendChild(name);
        const meta = document.createElement("span");
        meta.className = "user-attachment-meta";
        meta.textContent = [isImage ? "Image" : item.kind === "text" ? "Texte" : "Fichier", size].filter(Boolean).join(" · ");
        info.appendChild(meta);
        card.appendChild(info);
        box.appendChild(card);
    });
    return box;
}

function renderEntry(e) {
    switch (e.type) {
        case "welcome":
            return null;
        case "user": {
            const files = Array.isArray(e.attachments) ? e.attachments.filter((a) => a && a.name) : [];
            // Les pièces jointes sont affichées en aperçu : on retire la ligne « Pièces jointes : … » du texte.
            const text = files.length ? String(e.text || "").replace(/(^|\n)Pièces jointes : [^\n]*$/, "") : e.text;
            const el = addEntry("user", escapeHtml(text));
            if (files.length) {
                el.appendChild(buildUserAttachments(files));
                scrollDown();
            }
            return el;
        }
        case "assistant":
            return addEntry("assistant", renderMarkdown(e.text));
        case "reason": {
            const el = addEntry("reason collapsed", `<span class="reason-mark">✻</span><span class="reason-text">${inline(e.text)}</span>`);
            el.title = "Cliquer pour déplier ou replier la réflexion";
            el.onclick = () => {
                if (!String(window.getSelection())) el.classList.toggle("collapsed");
            };
            return el;
        }
        case "info":
        case "warn":
        case "error":
            return addEntry(e.type, escapeHtml(e.text));
        case "print":
            return addEntry("print", `<pre>${escapeHtml((e.lines || []).join("\n"))}</pre>`);
        case "plan":
            return addEntry("plan", `<b>Plan</b><ol>${(e.items || []).map((i) => `<li>${inline(i)}</li>`).join("")}</ol>`);
        case "tool":
            if (e.name === "run_command") appendOutput(`$ ${e.arg}`);
            if (QUIET_TOOLS.has(e.name)) return addQuietTool(e);
            return addEntry("tool", toolRowHtml(e));
        case "result": {
            if (toolGroup && toolGroup.awaitingResult) {
                const row = document.createElement("div");
                row.className = `entry result ${e.tone || ""}`;
                row.textContent = `└ ${e.text}`;
                toolGroup.body.appendChild(row);
                toolGroup.awaitingResult = false;
                if (e.tone === "error" || e.tone === "err") toolGroup.el.classList.add("has-error");
                scrollDown();
                return row;
            }
            return addEntry(`result ${e.tone || ""}`, `└ ${escapeHtml(e.text)}`);
        }
        case "diff": {
            const el = addEntry("diff-entry", "");
            el.appendChild(buildDiffCard(e));
            if (e.path) recordChange(e.path, e.added, e.removed);
            return el;
        }
        default:
            return addEntry("info", escapeHtml(JSON.stringify(e)));
    }
}

function liveStart() {
    ui.liveText = "";
    ui.live = addEntry("assistant", "");
}

function liveAppend(text) {
    if (!ui.live) liveStart();
    ui.liveText += text;
    ui.live.innerHTML = renderMarkdown(ui.liveText);
    scrollDown();
}

function liveEnd() {
    ui.live = null;
    ui.liveText = "";
}

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
    if (ui.spinnerId !== data.id || !ui.spinnerStart) ui.spinnerStart = Date.now();
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

/* ---------- Confirmations et questions ---------- */

function showPrompt() {
    const zone = $("prompt-zone");
    const p = ui.prompts[0];
    zone.innerHTML = "";

    if (!p) {
        zone.classList.add("hidden");
        input.focus();
        return;
    }

    zone.classList.remove("hidden");
    const question = document.createElement("div");
    question.className = "question";
    question.textContent = p.question;
    zone.appendChild(question);

    const buttons = document.createElement("div");
    buttons.className = "buttons";
    const answer = (value) => api.resolvePrompt(p.id, value).catch((err) => renderEntry({ type: "error", text: err.message }));
    const addButton = (label, onClick, primary = false) => {
        const b = document.createElement("button");
        b.type = "button";
        b.textContent = label;
        if (primary) b.className = "primary";
        b.onclick = onClick;
        buttons.appendChild(b);
        return b;
    };

    if (p.kind === "confirm") {
        const yes = addButton("Oui", () => answer("o"), true);
        addButton("Non", () => answer("n"));
        if (!p.force) addButton("Tout autoriser (session)", () => answer("t"));
        if (!p.force) addButton("Toujours autoriser", () => answer("tt"));
        zone.appendChild(buttons);
        setTimeout(() => yes.focus(), 0);
        scrollDown();
        return;
    }

    if (p.kind === "command" && p.prefix) {
        const prefix = document.createElement("div");
        prefix.className = "question";
        prefix.textContent = `Préfixe : ${p.prefix}`;
        zone.appendChild(prefix);
    }

    const field = document.createElement("input");
    field.type = p.kind === "secret" ? "password" : "text";
    field.addEventListener("keydown", (ev) => {
        if (ev.key === "Enter") {
            ev.preventDefault();
            answer(field.value);
        }
    });
    zone.appendChild(field);

    addButton("Valider", () => answer(field.value), true);
    if (p.kind === "command") {
        addButton("Oui (o)", () => answer("o"));
        addButton("Non (n)", () => answer("n"));
    }
    zone.appendChild(buttons);
    setTimeout(() => field.focus(), 0);
}

/* ---------- Barre d'état ---------- */

function applyStatus(s) {
    if (!s || typeof s !== "object") return;
    const wasBusy = Boolean(ui.status.busy);
    ui.status = s;
    const busy = Boolean(s.busy);

    $("statusbar").classList.toggle("busy", busy);
    $("btn-stop").classList.toggle("hidden", !busy);
    // File de prompts : le bouton reste actif pendant une demande (le message est mis en file).
    $("btn-send").disabled = false;
    $("st-busy").textContent = busy ? "⟳ en cours" : "";
    if (typeof updatePromptQueueBadge === "function") updatePromptQueueBadge();
    $("st-jobs").textContent = s.jobs ? `jobs : ${s.jobs}` : "";
    $("st-auto").textContent = s.autoApprove ? "auto-approbation" : "";
    $("st-mode").textContent = s.mode ? `mode : ${s.mode}` : "";
    $("st-model").textContent = s.model || "";
    $("model-label").textContent = s.model || "modèle";
    if (s.modelId != null) ui.currentModelId = s.modelId;
    const u = s.usage;
    let tokensText = "";
    if (u && u.reported > 0) {
        tokensText = ` · ${formatTokens(u.inputTokens || 0)} ↑ ${formatTokens(u.outputTokens || 0)} ↓ tokens`;
    } else if (u && u.chars > 0) {
        tokensText = ` · ~${formatTokens(Math.round(u.chars / 3.5))} tokens`;
    }
    ui.sessionRequests = u && u.requests ? `${u.requests} requête(s)${tokensText}` : "";
    if (busy) {
        $("btn-resume").classList.add("hidden");
    } else if (wasBusy && ui.interrupted) {
        $("btn-resume").classList.remove("hidden");
        ui.interrupted = false;
        // Interruption volontaire : on n'enchaîne pas automatiquement sur la file.
        if (typeof clearPromptQueue === "function" && (ui.promptQueue || []).length) {
            renderEntry({ type: "error", text: `File de prompts vidée après interruption (${ui.promptQueue.length} message(s) non envoyé(s)).` });
            clearPromptQueue();
        }
    } else if (wasBusy && !busy) {
        // Fin normale d'une demande : on envoie le prochain message en file.
        if (typeof flushPromptQueue === "function") setTimeout(flushPromptQueue, 0);
    }
    renderQuota();
    if (s.mode) $("mode-select").value = s.mode;

    if ((s.workspace || null) !== ui.workspace) {
        ui.workspace = s.workspace || null;
        onWorkspaceChanged();
    } else if (wasBusy && !busy) {
        scheduleRefresh();
    }

    if (wasBusy && !busy) refreshQuota();
}

/* ---------- Quota du compte FranceStudent ---------- */ function quotaBar(pct) { const n = Math.max(0, Math.min(5, Math.round(pct / 20))); return "▰".repeat(n) + "▱".repeat(5 - n); } function toggleQuotaPopover() { const existing = $("quota-popover"); if (existing) { existing.remove(); return; } const pop = document.createElement("div"); pop.id = "quota-popover"; pop.className = "quota-popover"; const add = (text, cls) => { const d = document.createElement("div"); if (cls) d.className = cls; d.textContent = text; pop.appendChild(d); return d; }; const q = ui.quota; if (!q || q.percent == null) { add("Quota indisponible pour le moment.", "qp-sub"); } else { const pct = Math.max(0, Math.min(100, Number(q.percent) || 0)); add(`Quota utilisé : ${q.uncertain ? "~" : ""}${q.percent} % ${quotaBar(pct)}`, "qp-main"); if (q.resetAt) add(`Réinitialisation : ${new Date(q.resetAt).toLocaleString()}`, "qp-sub"); for (const l of q.limits || []) { const name = [l.type, l.bucket].filter(Boolean).join("/") || "limite"; const total = l.limit ? `${l.used}/${l.limit}` : `${l.used}`; add(`${name} : ${Math.round(l.usedPercent)} % (${total})`, "qp-sub"); } if (q.powerUp) add("Power-up de quota actif", "qp-sub"); } if (ui.sessionRequests) add(`Session : ${ui.sessionRequests}`, "qp-sub"); const btn = document.createElement("button"); btn.type = "button"; btn.className = "qp-more"; btn.textContent = "Détails complets (/usage)"; btn.onclick = () => { pop.remove(); if (ui.status && ui.status.busy) return; api.submit("/usage", []).catch((err) => renderEntry({ type: "error", text: err.message })); }; pop.appendChild(btn); document.body.appendChild(pop); const close = (ev) => { if (!document.body.contains(pop)) { document.removeEventListener("click", close); return; } if (ev.target.closest && ev.target.closest("#quota-popover, #st-usage")) return; pop.remove(); document.removeEventListener("click", close); }; setTimeout(() => document.addEventListener("click", close), 0); }

function renderQuota() {
    const el = $("st-usage");
    const quota = ui.quota;

    if (!quota || quota.percent == null) {
        el.textContent = ui.sessionRequests || "";
        el.title = "";
        el.classList.remove("warn", "crit", "quota-gauge", "quota-ok", "quota-mid", "quota-high", "quota-crit");
        el.style.removeProperty("--quota-pct");
        return;
    }

    const session = ui.sessionRequests ? ` · ${ui.sessionRequests}` : "";
    const approx = quota.uncertain ? "~" : "";
    el.textContent = `quota chat ${approx}${quota.percent} %${session}`;
    // Jauge : vert < 50 %, jaune < 75 %, orange < 90 %, rouge au-delà.
    const pct = Math.max(0, Math.min(100, Number(quota.percent) || 0));
    const level = pct >= 90 ? "crit" : pct >= 75 ? "high" : pct >= 50 ? "mid" : "ok";
    el.classList.remove("quota-ok", "quota-mid", "quota-high", "quota-crit");
    el.classList.add("quota-gauge", `quota-${level}`);
    el.classList.toggle("warn", level === "high");
    el.classList.toggle("crit", level === "crit");
    el.style.setProperty("--quota-pct", `${pct}%`);

    const fmtReset = (iso) => (iso ? ` — réinit. ${new Date(iso).toLocaleString()}` : "");
    const lines = [`Quota général de chat : ${approx}${quota.percent} %${fmtReset(quota.resetAt)}`];
    if (quota.uncertain) lines.push("(décompte approximatif côté serveur)");
    const isImage = (l) => /image/i.test(`${l.type || ""} ${l.bucket || ""}`);
    for (const limit of quota.limits || []) {
        const name = [limit.type, limit.bucket].filter(Boolean).join("/") || "limite";
        const total = limit.limit ? `${limit.used}/${limit.limit}` : `${limit.used}`;
        const prefix = isImage(limit) ? "Images" : "Limite";
        lines.push(`${prefix} ${name} : ${Math.round(limit.usedPercent)} % (${total})${fmtReset(limit.resetAt)}`);
    }
    if (quota.powerUp) lines.push("Power-up de quota actif");
    lines.push("Cliquer pour le détail (/usage)");
    el.title = lines.join("\n");
}

async function refreshQuota() {
    try {
        ui.quota = await api.usage();
    } catch {
        ui.quota = null;
    }
    renderQuota();
}

/* ---------- Choix du modèle (/model) ---------- */

function hideModelMenu() {
    modelMenuEl.classList.add("hidden");
    modelMenuEl.innerHTML = "";
}

function positionModelMenu(anchor) {
    const rect = anchor.getBoundingClientRect();
    const width = Math.max(300, rect.width);
    modelMenuEl.style.minWidth = `${width}px`;
    modelMenuEl.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
    modelMenuEl.style.top = `${rect.bottom + 6}px`;
    const menuRect = modelMenuEl.getBoundingClientRect();
    if (menuRect.bottom > window.innerHeight - 8) {
        modelMenuEl.style.top = `${Math.max(8, rect.top - menuRect.height - 6)}px`;
    }
}

/** Fournisseur d'un modèle d'après provider / nom / modèle : "claude", "gpt", "gemini" ou null. */
function modelVendor(agent) {
    const text = [agent && agent.provider, agent && agent.name, agent && agent.model]
        .filter(Boolean).join(" ").toLowerCase();
    if (/claude|anthropic/.test(text)) return "claude";
    if (/gemini|google/.test(text)) return "gemini";
    if (/\bgpt|openai|\bo[134]\b/.test(text)) return "gpt";
    return null;
}

function modelLogo(agent, className = "model-logo") {
    const vendor = modelVendor(agent);
    if (!vendor) return null;
    const img = document.createElement("img");
    img.className = className;
    img.src = `assets/models/${vendor}.svg`;
    img.alt = vendor;
    return img;
}

function renderModelMenu(data) {
    const agents = (data && data.agents) || [];
    modelMenuEl.innerHTML = "";

    const head = document.createElement("div");
    head.className = "model-menu-head";
    head.textContent = data && data.source === "api" ? "Modèles FranceStudent" : "Modèles (liste locale)";
    modelMenuEl.appendChild(head);

    if (!agents.length) {
        const empty = document.createElement("div");
        empty.className = "model-empty";
        empty.textContent = "Aucun modèle disponible.";
        modelMenuEl.appendChild(empty);
        return;
    }

    for (const agent of agents) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "model-item" + (agent.id === ui.currentModelId ? " active" : "");

        const logo = modelLogo(agent);
        if (logo) row.appendChild(logo);

        const main = document.createElement("span");
        main.className = "model-item-main";
        const name = document.createElement("span");
        name.className = "model-item-name";
        name.textContent = agent.name;
        main.appendChild(name);
        const details = [agent.provider, agent.model].filter(Boolean).join(" · ");
        const sub = document.createElement("span");
        sub.className = "model-item-sub";
        sub.textContent = details || (agent.id === ui.currentModelId ? "modèle actuel" : "");
        main.appendChild(sub);
        row.appendChild(main);

        if (agent.isDefault) {
            const badge = document.createElement("span");
            badge.className = "model-badge";
            badge.textContent = "défaut";
            row.appendChild(badge);
        }
        const check = document.createElement("span");
        check.className = "model-check";
        check.textContent = agent.id === ui.currentModelId ? "✓" : "";
        row.appendChild(check);

        row.onclick = () => selectModel(agent.id);
        modelMenuEl.appendChild(row);
    }

    if (data && data.error) {
        const err = document.createElement("div");
        err.className = "model-error";
        err.textContent = `API indisponible : ${data.error}`;
        modelMenuEl.appendChild(err);
    }
}

async function openModelMenu() {
    const anchor = $("btn-model");
    modelMenuEl.classList.remove("hidden");
    modelMenuEl.dataset.kind = "model";
    if (ui.models) renderModelMenu(ui.models);
    else modelMenuEl.innerHTML = '<div class="model-empty">Chargement des modèles…</div>';
    positionModelMenu(anchor);
    const stillModel = () => !modelMenuEl.classList.contains("hidden") && modelMenuEl.dataset.kind === "model";
    try {
        const data = await api.models();
        ui.models = data;
        if (data && data.current != null) ui.currentModelId = data.current;
        if (stillModel()) {
            renderModelMenu(data);
            positionModelMenu(anchor);
        }
    } catch (err) {
        if (stillModel()) {
            modelMenuEl.innerHTML = `<div class="model-error">${escapeHtml(err.message)}</div>`;
        }
    }
}

function toggleModelMenu() {
    if (!modelMenuEl.classList.contains("hidden") && modelMenuEl.dataset.kind === "model") hideModelMenu();
    else openModelMenu();
}

async function selectModel(id) {
    hideModelMenu();
    if (id === ui.currentModelId) return;
    try {
        const res = await api.setModel(id);
        ui.currentModelId = res.id;
        $("model-label").textContent = res.name;
        $("st-model").textContent = res.name;
        if (ui.models) renderModelMenu(ui.models);
    } catch (err) {
        renderEntry({ type: "error", text: err.message });
    }
}

/* ---------- Historique des conversations (/history, reprise par /chat-id) ---------- */

function historyCurrentWorkspace() {
    return ui.workspace || (ui.status && ui.status.workspace) || null;
}

function historyMatches(item) {
    if (ui.historyOnlyProject && (item.workspace || null) !== historyCurrentWorkspace()) return false;
    const query = String(ui.historyQuery || "").trim().toLowerCase();
    if (!query) return true;
    return [item.title, item.model, item.mode, item.workspace, item.id]
        .filter(Boolean)
        .join(" ")
        .toLowerCase()
        .includes(query);
}

function renderHistoryMenu(items) {
    ui.historyItems = Array.isArray(items) ? items : [];
    modelMenuEl.innerHTML = "";
    modelMenuEl.dataset.kind = "history";
    const head = document.createElement("div");
    head.className = "model-menu-head";
    head.textContent = "Conversations récentes";
    modelMenuEl.appendChild(head);

    const tools = document.createElement("div");
    tools.className = "history-tools";
    const search = document.createElement("input");
    search.type = "search";
    search.className = "history-search";
    search.placeholder = "Rechercher (titre, modèle, dossier)…";
    search.value = ui.historyQuery || "";
    search.oninput = () => {
        ui.historyQuery = search.value;
        renderHistoryList();
    };
    search.onkeydown = (e) => {
        if (e.key !== "Escape") return;
        e.stopPropagation();
        e.preventDefault();
        if (search.value) {
            // Premier Escape : vide la recherche ; second Escape : ferme le menu.
            search.value = "";
            ui.historyQuery = "";
            renderHistoryList();
        } else {
            hideModelMenu();
        }
    };
    search.onclick = (e) => e.stopPropagation();

    const label = document.createElement("label");
    label.className = "history-filter";
    const check = document.createElement("input");
    check.type = "checkbox";
    check.disabled = !historyCurrentWorkspace();
    check.checked = !check.disabled && !!ui.historyOnlyProject;
    check.onchange = () => {
        ui.historyOnlyProject = check.checked;
        renderHistoryList();
    };
    label.title = check.disabled ? "Aucun projet ouvert." : historyCurrentWorkspace();
    label.onclick = (e) => e.stopPropagation();
    label.append(check, document.createTextNode(" Ce projet"));

    tools.append(search, label);
    modelMenuEl.appendChild(tools);

    const list = document.createElement("div");
    list.className = "history-list";
    modelMenuEl.appendChild(list);
    renderHistoryList();
    setTimeout(() => {
        if (search.isConnected) search.focus();
    }, 0);
}

function renderHistoryList() {
    const list = modelMenuEl.querySelector(".history-list");
    if (!list) return;
    list.innerHTML = "";
    const all = ui.historyItems || [];
    const shown = all.filter(historyMatches);
    if (!shown.length) {
        const empty = document.createElement("div");
        empty.className = "model-empty";
        empty.textContent = all.length ? "Aucune conversation ne correspond." : "Aucune conversation enregistrée.";
        list.appendChild(empty);
        return;
    }
    for (const item of shown) list.appendChild(renderHistoryRow(item));
}

function renderHistoryRow(item) {
    const row = document.createElement("div");
    row.className = "model-item history-item";
    row.title = [item.title, item.workspace, item.id].filter(Boolean).join("\n");

    const open = document.createElement("button");
    open.type = "button";
    open.className = "history-open";
    const main = document.createElement("span");
    main.className = "model-item-main";
    const name = document.createElement("span");
    name.className = "model-item-name";
    name.textContent = `${item.number}. ${item.title}`;
    main.appendChild(name);
    const sub = document.createElement("span");
    sub.className = "model-item-sub";
    const when = item.updatedAt ? new Date(item.updatedAt).toLocaleString() : "";
    sub.textContent = [when, item.mode, item.model, `${item.messages} message(s)`].filter(Boolean).join(" · ");
    main.appendChild(sub);
    open.appendChild(main);
    open.onclick = () => {
        hideModelMenu();
        if (ui.status && ui.status.busy) {
            renderEntry({ type: "error", text: "Une demande est en cours : attends sa fin avant de changer de conversation." });
            return;
        }
        send(`/chat-id ${item.id}`);
    };

    const actions = document.createElement("span");
    actions.className = "history-actions";

    const renameBtn = document.createElement("button");
    renameBtn.type = "button";
    renameBtn.className = "history-action";
    renameBtn.textContent = "✎";
    renameBtn.title = "Renommer";
    renameBtn.setAttribute("aria-label", "Renommer la conversation");
    renameBtn.onclick = (e) => {
        e.stopPropagation();
        startHistoryRename(row, item);
    };

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "history-action";
    removeBtn.textContent = "✕";
    removeBtn.title = "Supprimer de l'historique";
    removeBtn.setAttribute("aria-label", "Supprimer la conversation de l'historique");
    removeBtn.onclick = async (e) => {
        e.stopPropagation();
        if (removeBtn.dataset.confirm !== "1") {
            // Deux clics pour supprimer : évite les suppressions accidentelles.
            removeBtn.dataset.confirm = "1";
            removeBtn.textContent = "Supprimer ?";
            removeBtn.classList.add("danger");
            setTimeout(() => {
                if (removeBtn.isConnected && removeBtn.dataset.confirm === "1") {
                    removeBtn.dataset.confirm = "";
                    removeBtn.textContent = "✕";
                    removeBtn.classList.remove("danger");
                }
            }, 3000);
            return;
        }
        removeBtn.disabled = true;
        try {
            await api.conversationsRemove(item.id);
            ui.historyItems = (ui.historyItems || []).filter((x) => x.id !== item.id);
            ui.historyItems.forEach((x, i) => {
                x.number = i + 1; // même numérotation que /history
            });
            renderHistoryList();
        } catch (err) {
            removeBtn.disabled = false;
            renderEntry({ type: "error", text: err.message });
        }
    };

    actions.append(renameBtn, removeBtn);
    row.append(open, actions);
    return row;
}

function startHistoryRename(row, item) {
    const open = row.querySelector(".history-open");
    const actions = row.querySelector(".history-actions");
    if (!open || row.querySelector(".history-rename")) return;

    const input = document.createElement("input");
    input.type = "text";
    input.className = "history-rename";
    input.value = item.title;
    input.maxLength = 200;
    open.style.display = "none";
    if (actions) actions.style.display = "none";
    row.insertBefore(input, open);
    input.focus();
    input.select();

    let done = false;
    const finish = async (save) => {
        if (done) return;
        done = true;
        const value = input.value.trim();
        if (save && value && value !== item.title) {
            try {
                const res = await api.conversationsRename(item.id, value);
                item.title = res.title;
            } catch (err) {
                renderEntry({ type: "error", text: err.message });
            }
        }
        renderHistoryList();
    };
    input.onkeydown = (e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
            e.preventDefault();
            finish(true);
        } else if (e.key === "Escape") {
            e.preventDefault();
            finish(false);
        }
    };
    input.onclick = (e) => e.stopPropagation();
    input.onblur = () => finish(true);
}

async function openHistoryMenu() {
    const anchor = $("btn-history");
    modelMenuEl.classList.remove("hidden");
    modelMenuEl.dataset.kind = "history";
    modelMenuEl.innerHTML = '<div class="model-empty">Chargement de l\'historique…</div>';
    positionModelMenu(anchor);
    try {
        const items = await api.conversationsRecent(30);
        if (!modelMenuEl.classList.contains("hidden") && modelMenuEl.dataset.kind === "history") {
            renderHistoryMenu(items);
            positionModelMenu(anchor);
        }
    } catch (err) {
        if (!modelMenuEl.classList.contains("hidden") && modelMenuEl.dataset.kind === "history") {
            modelMenuEl.innerHTML = `<div class="model-error">${escapeHtml(err.message)}</div>`;
        }
    }
}

function toggleHistoryMenu() {
    if (!modelMenuEl.classList.contains("hidden") && modelMenuEl.dataset.kind === "history") hideModelMenu();
    else openHistoryMenu();
}

/* ---------- Modifications de l'agent ---------- */

function recordChange(path, added, removed) {
    if (!path) return;
    const previous = ui.changes.get(path) || { added: 0, removed: 0 };
    if (!ui.changes.has(path)) ui.changesOrder.push(path);
    ui.changes.set(path, {
        added: previous.added + (added || 0),
        removed: previous.removed + (removed || 0)
    });
    updateChangesBadge();
    if (ui.panel === "changes") renderChangesList();
    markTreeNode(path);
    scheduleGitRefresh();
}

function markTreeNode(path) {
    let node = null;
    document.querySelectorAll("#tree .node").forEach((n) => { if (n.dataset.path === path) node = n; });
    if (!node || node.classList.contains("agent-modified")) return;
    node.classList.add("agent-modified");
    const mark = document.createElement("span");
    mark.className = "mod-mark";
    mark.textContent = "M";
    mark.title = "Modifié par l'agent";
    node.appendChild(mark);
}

function updateChangesBadge() {
    const badge = $("changes-count");
    if (!badge) return;
    badge.textContent = ui.changes.size ? String(ui.changes.size) : "";
    badge.classList.toggle("hidden", !ui.changes.size);
}

function clearChanges() {
    ui.changes.clear();
    ui.changesOrder = [];
    updateChangesBadge();
    renderChangesList();
}

/* ---------- Annulation par modification (pile du journal, via IPC) ---------- */

let undoRefreshSeq = 0;

async function renderUndoList(note) {
    const section = $("undo-section");
    const list = $("undo-list");
    if (!section || !list || !api.undoList) return;
    const seq = ++undoRefreshSeq;
    let entries;
    try {
        entries = await api.undoList();
    } catch {
        entries = [];
    }
    if (seq !== undoRefreshSeq) return;
    list.innerHTML = "";
    if (note) {
        const msg = document.createElement("div");
        msg.className = "undo-note";
        msg.textContent = note;
        list.appendChild(msg);
    }
    if (!ui.acceptedUndo) ui.acceptedUndo = new Set();
    entries = entries.filter((entry) => !ui.acceptedUndo.has(undoKey(entry)));
    section.classList.toggle("hidden", !entries.length && !note);
    for (const entry of entries) {
        renderUndoRow(list, entry);
    }
}

/** Clé stable d'une entrée de la pile (l'index change quand on en annule une). */
function undoKey(entry) {
    return `${entry.at || ""}|${entry.kind}|${(entry.paths || []).join("|")}`;
}

/** Diff ligne à ligne simple (LCS) avec 3 lignes de contexte autour du bloc modifié. */
function undoLineDiff(before, after, context = 3) {
    const a = String(before).split("\n");
    const b = String(after).split("\n");
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start]) start++;
    let endA = a.length;
    let endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
        endA--;
        endB--;
    }
    const midA = a.slice(start, endA);
    const midB = b.slice(start, endB);
    const ops = [];
    for (let i = Math.max(0, start - context); i < start; i++) ops.push({ t: " ", s: a[i] });
    const n = midA.length;
    const m = midB.length;
    if (n && m && (n + 1) * (m + 1) <= 2000000) {
        const w = m + 1;
        const dp = new Uint32Array((n + 1) * w);
        for (let i = n - 1; i >= 0; i--) {
            for (let j = m - 1; j >= 0; j--) {
                dp[i * w + j] = midA[i] === midB[j] ? dp[(i + 1) * w + j + 1] + 1 : Math.max(dp[(i + 1) * w + j], dp[i * w + j + 1]);
            }
        }
        let i = 0;
        let j = 0;
        while (i < n && j < m) {
            if (midA[i] === midB[j]) {
                ops.push({ t: " ", s: midA[i] });
                i++;
                j++;
            } else if (dp[(i + 1) * w + j] >= dp[i * w + j + 1]) {
                ops.push({ t: "-", s: midA[i++] });
            } else {
                ops.push({ t: "+", s: midB[j++] });
            }
        }
        while (i < n) ops.push({ t: "-", s: midA[i++] });
        while (j < m) ops.push({ t: "+", s: midB[j++] });
    } else {
        for (const s of midA) ops.push({ t: "-", s });
        for (const s of midB) ops.push({ t: "+", s });
    }
    for (let i = endA; i < Math.min(a.length, endA + context); i++) ops.push({ t: " ", s: a[i] });
    return ops;
}

/** Blocs (hunks) : suites consécutives de lignes ajoutées/supprimées, {start, end} (end exclu) dans ops. */
function undoHunks(ops) {
    const hunks = [];
    let current = null;
    ops.forEach((op, i) => {
        if (op.t === " ") {
            current = null;
            return;
        }
        if (!current) {
            current = { start: i, end: i + 1 };
            hunks.push(current);
        } else {
            current.end = i + 1;
        }
    });
    return hunks;
}

/**
 * Recompose le fichier à partir d'un diff complet (contexte infini) : les blocs dont
 * l'index est dans `rejected` reprennent leurs lignes d'origine, les autres gardent les nouvelles.
 */
function composeHunks(ops, rejected) {
    const hunks = undoHunks(ops);
    const owner = new Array(ops.length).fill(-1);
    hunks.forEach((hunk, h) => {
        for (let i = hunk.start; i < hunk.end; i++) owner[i] = h;
    });
    const lines = [];
    ops.forEach((op, i) => {
        if (op.t === " ") lines.push(op.s);
        else if (rejected.has(owner[i]) ? op.t === "-" : op.t === "+") lines.push(op.s);
    });
    return lines.join("\n");
}

async function toggleUndoDiff(row, entry, btn) {
    const existing = row.nextElementSibling;
    if (existing && existing.classList.contains("undo-diff")) {
        existing.remove();
        btn.classList.remove("active");
        return;
    }
    const box = document.createElement("pre");
    box.className = "undo-diff";
    box.textContent = "Chargement du diff…";
    row.after(box);
    btn.classList.add("active");
    try {
        const diff = await api.undoDiff(entry.index, entry.at);
        box.textContent = "";
        if (diff.kind === "move") {
            box.textContent = `Déplacement ${diff.rel} : contenu inchangé.`;
            return;
        }
        if (diff.before === null || diff.after === null) {
            box.textContent = diff.before === null
                ? "Contenu d'origine indisponible (sauvegarde absente ou fichier binaire)."
                : "Le fichier n'existe plus sur le disque.";
            return;
        }
        if (diff.before === diff.after) {
            box.textContent = "Aucune différence avec l'état actuel du fichier.";
            return;
        }
        const ops = undoLineDiff(diff.before, diff.after, Infinity);
        const hunks = undoHunks(ops);
        let added = 0;
        let removed = 0;
        for (const op of ops) {
            if (op.t === "+") added++;
            if (op.t === "-") removed++;
        }
        const head = document.createElement("span");
        head.className = "diff-line head";
        head.textContent = `${diff.rel} · +${added} -${removed} · ${hunks.length} bloc(s)\n`;
        box.appendChild(head);
        const tooBig = (s) => String(s).startsWith("(fichier trop volumineux");
        const canSplit = Boolean(api.undoApplyContent) && hunks.length > 1 &&
            ["create", "copy", "write", "edit"].includes(entry.kind) && !tooBig(diff.before) && !tooBig(diff.after);
        let shown = 0;
        hunks.forEach((hunk, h) => {
            const bar = document.createElement("span");
            bar.className = "diff-line hunk-head";
            bar.textContent = `@@ bloc ${h + 1}/${hunks.length} `;
            if (canSplit) {
                const btn = document.createElement("button");
                btn.type = "button";
                btn.className = "undo-btn reject hunk-reject";
                btn.textContent = "Rejeter ce bloc";
                btn.title = "Remettre ce bloc à l'état d'origine et garder les autres";
                btn.onclick = async () => {
                    box.querySelectorAll(".hunk-reject").forEach((b) => { b.disabled = true; });
                    let message;
                    try {
                        message = await api.undoApplyContent(entry.index, entry.at, composeHunks(ops, new Set([h])), diff.after);
                    } catch (error) {
                        message = error && error.message ? error.message : String(error);
                    }
                    scheduleGitRefresh();
                    renderUndoList(message);
                };
                bar.appendChild(btn);
            }
            bar.appendChild(document.createTextNode("\n"));
            box.appendChild(bar);
            const from = Math.max(shown, hunk.start - 3);
            const to = Math.min(ops.length, hunk.end + 3);
            for (let i = from; i < to; i++) {
                const op = ops[i];
                const line = document.createElement("span");
                line.className = op.t === "+" ? "diff-line add" : op.t === "-" ? "diff-line del" : "diff-line";
                line.textContent = `${op.t} ${op.s}\n`;
                box.appendChild(line);
            }
            shown = Math.max(shown, to);
        });
    } catch (error) {
        box.textContent = error && error.message ? error.message : String(error);
    }
}

function renderUndoRow(list, entry) {
    const row = document.createElement("div");
    row.className = "undo-row";
    const label = document.createElement("span");
    label.className = "change-path";
    label.textContent = entry.label;
    label.title = entry.at ? `${entry.label} · ${new Date(entry.at).toLocaleString()}` : entry.label;
    const target = entry.paths && entry.paths.length ? entry.paths[entry.paths.length - 1] : null;
    if (target && entry.kind !== "delete" && entry.kind !== "mkdir") {
        label.classList.add("clickable");
        label.onclick = () => openFile(target);
    }
    row.appendChild(label);
    const when = document.createElement("span");
    when.className = "undo-when";
    when.textContent = entry.at ? new Date(entry.at).toLocaleTimeString() : "";
    row.appendChild(when);

    const makeBtn = (text, title, cls) => {
        const b = document.createElement("button");
        b.type = "button";
        b.className = cls;
        b.textContent = text;
        b.title = title;
        return b;
    };

    const diffBtn = makeBtn("Diff", "Afficher les différences avant / après", "undo-btn");
    if (entry.kind === "mkdir") diffBtn.disabled = true;
    diffBtn.onclick = () => toggleUndoDiff(row, entry, diffBtn);

    const acceptBtn = makeBtn("Accepter", "Garder cette modification et la retirer de la liste", "undo-btn accept");
    acceptBtn.onclick = () => {
        // Masque seulement la ligne : l'entrée reste dans le journal (/undo reste possible).
        ui.acceptedUndo.add(undoKey(entry));
        const next = row.nextElementSibling;
        if (next && next.classList.contains("undo-diff")) next.remove();
        row.remove();
        if (!list.querySelector(".undo-row")) renderUndoList();
    };

    const rejectBtn = makeBtn("Rejeter", "Annuler cette modification (restaure l'état précédent)", "undo-btn reject");
    rejectBtn.onclick = async () => {
        rejectBtn.disabled = true;
        acceptBtn.disabled = true;
        let message;
        try {
            message = await api.undoEntry(entry.index, entry.at);
        } catch (error) {
            message = error && error.message ? error.message : String(error);
        }
        scheduleGitRefresh();
        renderUndoList(message);
    };

    const actions = document.createElement("span");
    actions.className = "undo-actions";
    actions.append(diffBtn, acceptBtn, rejectBtn);
    row.appendChild(actions);
    list.appendChild(row);
}

function renderChangesList() {
    const list = $("changes-list");
    const summary = $("changes-summary");
    if (!list) return;
    renderUndoList();
    list.innerHTML = "";

    if (!ui.changes.size) {
        summary.textContent = "Aucune modification par l'agent pour l'instant.";
        const empty = document.createElement("div");
        empty.className = "changes-empty";
        empty.textContent = "Les fichiers écrits ou édités par l'agent apparaîtront ici. Cliquez sur un fichier pour l'ouvrir.";
        list.appendChild(empty);
        return;
    }

    let totalAdd = 0;
    let totalDel = 0;
    for (const value of ui.changes.values()) {
        totalAdd += value.added;
        totalDel += value.removed;
    }
    summary.textContent = `${ui.changes.size} fichier(s) modifié(s) · +${totalAdd} -${totalDel}`;

    for (const path of ui.changesOrder) {
        if (!ui.changes.has(path)) continue;
        const value = ui.changes.get(path);
        const row = document.createElement("button");
        row.type = "button";
        row.className = "change-row";
        row.title = path;
        row.appendChild(fileIcon(path, "file"));
        const p = document.createElement("span");
        p.className = "change-path";
        p.textContent = path;
        row.appendChild(p);
        const stats = document.createElement("span");
        stats.className = "diff-stats";
        stats.innerHTML = `<b class="add">+${value.added}</b><b class="del">-${value.removed}</b>`;
        row.appendChild(stats);
        row.onclick = () => openFile(path);
        list.appendChild(row);
    }
}

/* ---------- Explorateur ---------- */

function projectLabel() {
    return ui.workspace ? ui.workspace.split(/[\\/]/).pop() : "Aucun projet";
}

async function renderTree() {
    const tree = $("tree");
    $("project-name").textContent = projectLabel();
    $("st-project").textContent = ui.workspace ? `📁 ${projectLabel()}` : "Aucun projet";

    if (!ui.workspace) {
        tree.innerHTML = '<div class="empty"><p>Aucun dossier ouvert.</p><button class="primary" data-open>Ouvrir un dossier</button></div>';
        tree.querySelector("[data-open]").onclick = openProject;
        return;
    }

    const root = document.createElement("div");
    await renderDir(root, ".", 0);
    tree.innerHTML = "";
    tree.appendChild(root);
}

const FILE_KINDS = {
    js: "js", mjs: "js", cjs: "js", jsx: "js", ts: "ts", tsx: "ts", json: "json", md: "md",
    css: "css", scss: "css", html: "html", htm: "html", py: "py",
    png: "img", jpg: "img", jpeg: "img", gif: "img", svg: "img", ico: "img", webp: "img"
};
const FILE_TAGS = { js: "JS", ts: "TS", json: "{}", md: "M↓", css: "#", html: "<>", py: "PY", img: "▣", default: "•" };
const FOLDER_SVG = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';
const FOLDER_OPEN_SVG = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v1H7.5a2 2 0 0 0-1.9 1.4L3 19z"/><path d="M7.2 12h14.3l-2.6 6.6a2 2 0 0 1-1.9 1.4H4z"/></svg>';

function fileIcon(name, type, open = false) {
    const span = document.createElement("span");
    span.className = "ficon";
    if (type === "directory") {
        span.dataset.kind = "folder";
        span.innerHTML = open ? FOLDER_OPEN_SVG : FOLDER_SVG;
        return span;
    }
    const base = String(name || "").split("/").pop();
    const ext = base.includes(".") ? base.split(".").pop().toLowerCase() : "";
    const kind = FILE_KINDS[ext] || "default";
    span.dataset.kind = kind;
    span.textContent = FILE_TAGS[kind];
    return span;
}

async function renderDir(container, rel, depth) {
    let entries;
    try {
        entries = await api.listDir(rel);
    } catch (err) {
        const div = document.createElement("div");
        div.className = "empty";
        div.textContent = err.message;
        container.appendChild(div);
        return;
    }

    for (const e of entries) {
        if (e.type !== "directory" && /\.tmp$/i.test(e.name)) continue;
        const node = document.createElement("div");
        const open = expanded.has(e.path);
        const modified = e.type !== "directory" && ui.changes.has(e.path);
        node.className = "node" + (e.path === ui.active ? " selected" : "") + (modified ? " agent-modified" : "");
        node.style.paddingLeft = `${6 + depth * 12}px`;
        node.dataset.path = e.path;
        node.title = e.path;

        const twisty = document.createElement("span");
        twisty.className = "twisty";
        twisty.textContent = e.type === "directory" ? (open ? "▾" : "▸") : "";
        const label = document.createElement("span");
        label.className = "label";
        label.textContent = e.name;
        node.append(twisty, fileIcon(e.name, e.type, open), label);
        if (modified) {
            const mark = document.createElement("span");
            mark.className = "mod-mark";
            mark.textContent = "M";
            mark.title = "Modifié par l'agent";
            node.appendChild(mark);
        }
        container.appendChild(node);

        node.oncontextmenu = (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            showContextMenu(ev, e);
        };

        if (e.type === "directory") {
            node.onclick = () => {
                if (open) expanded.delete(e.path);
                else expanded.add(e.path);
                renderTree();
            };
            if (open) await renderDir(container, e.path, depth + 1);
        } else {
            node.onclick = () => openFile(e.path);
        }
    }
}

async function openProject(dir) {
    if (ui.tabs.some((t) => t.dirty) && !window.confirm("Des fichiers ne sont pas enregistrés. Changer de projet quand même ?")) return;
    try {
        const ws = await api.openProject(typeof dir === "string" && dir ? dir : null);
        if (ws && ws !== ui.workspace) {
            ui.workspace = ws;
            onWorkspaceChanged();
        }
    } catch (err) {
        renderEntry({ type: "error", text: err.message });
    }
}

function onWorkspaceChanged() {
    expanded.clear();
    ui.tabs = [];
    ui.active = null;
    activate(null);
    clearChanges();
    renderTree();
    renderRecentProjects();
}

function recentProjectDate(iso) {
    const time = Date.parse(iso || "");
    if (!time) return "";
    return new Date(time).toLocaleString("fr-FR", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" });
}

async function renderRecentProjects() {
    const box = $("welcome-recent");
    const list = $("welcome-recent-list");
    if (!box || !list || typeof api.recentProjects !== "function") return;
    let items = [];
    try {
        items = await api.recentProjects(8);
    } catch {
        items = [];
    }
    const current = String(ui.workspace || "").toLowerCase();
    items = (Array.isArray(items) ? items : []).filter((p) => String(p.path).toLowerCase() !== current);
    list.textContent = "";
    for (const p of items) {
        const li = document.createElement("li");
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "welcome-recent-item";
        btn.title = p.path;
        const name = document.createElement("b");
        name.textContent = p.name || p.path;
        const where = document.createElement("small");
        where.textContent = p.path;
        const when = document.createElement("span");
        when.className = "welcome-recent-date";
        when.textContent = recentProjectDate(p.lastOpenedAt);
        btn.append(name, where, when);
        btn.onclick = () => openProject(p.path);
        li.append(btn);
        list.append(li);
    }
    box.classList.toggle("hidden", items.length === 0);
}

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

/* ---------- Saisie de l'agent ---------- */

/* ---------- Pièces jointes (fichiers / images) ---------- */

const MAX_ATTACHMENTS = 10;
// Au-delà de ce nombre de pièces jointes, une confirmation (quota) est demandée avant l'envoi.
const ATTACHMENT_QUOTA_WARN = 5;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_TEXT_BYTES = 1024 * 1024;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
let pendingAttachments = [];

/* Extensions binaires connues -> type MIME (utilisé si le navigateur n'en fournit pas). */
const BINARY_TYPES = {
    pdf: "application/pdf",
    doc: "application/msword",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    dot: "application/msword",
    dotx: "application/vnd.openxmlformats-officedocument.wordprocessingml.template",
    xls: "application/vnd.ms-excel",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    xlsm: "application/vnd.ms-excel.sheet.macroEnabled.12",
    ppt: "application/vnd.ms-powerpoint",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    odt: "application/vnd.oasis.opendocument.text",
    ods: "application/vnd.oasis.opendocument.spreadsheet",
    odp: "application/vnd.oasis.opendocument.presentation",
    rtf: "application/rtf",
    epub: "application/epub+zip",
    pages: "application/vnd.apple.pages",
    numbers: "application/vnd.apple.numbers",
    key: "application/vnd.apple.keynote",
    zip: "application/zip",
    gz: "application/gzip",
    tgz: "application/gzip",
    tar: "application/x-tar",
    "7z": "application/x-7z-compressed",
    rar: "application/vnd.rar",
    mp3: "audio/mpeg",
    wav: "audio/wav",
    m4a: "audio/mp4",
    mp4: "video/mp4",
    mov: "video/quicktime",
    heic: "image/heic",
    psd: "image/vnd.adobe.photoshop"
};

function fileExtension(name) {
    const match = /\.([a-z0-9]+)$/i.exec(String(name || ""));
    return match ? match[1].toLowerCase() : "";
}

/** true pour les PDF, documents Office, archives, médias… (à ne pas lire comme du texte). */
function isBinaryFile(file, name) {
    if (Object.prototype.hasOwnProperty.call(BINARY_TYPES, fileExtension(name))) return true;
    const type = String(file.type || "").toLowerCase();
    if (!type || type.startsWith("text/")) return false;
    if (/(json|xml|javascript|ecmascript|x-sh|x-python|yaml|toml|sql|csv)/.test(type)) return false;
    return /^(application|audio|video|font|image)\//.test(type);
}

/** Fichier quelconque -> pièce jointe { kind: "file" } en data URL base64 avec un type MIME. */
async function prepareFile(file, name) {
    if (file.size > MAX_FILE_BYTES) {
        throw new Error(`fichier trop lourd (${formatBytes(file.size)}, max ${formatBytes(MAX_FILE_BYTES)})`);
    }
    const mime = file.type || BINARY_TYPES[fileExtension(name)] || "application/octet-stream";
    const raw = await readAsDataUrl(file);
    const base64 = raw.slice(raw.indexOf(",") + 1);
    return { name, kind: "file", size: file.size, mime, data: `data:${mime};base64,${base64}` };
}

/** Icône de puce selon le type de fichier. */
function attachmentIcon(item) {
    const ext = fileExtension(item.name);
    if (ext === "pdf") return "📕";
    if (["doc", "docx", "dot", "dotx", "odt", "rtf", "pages"].includes(ext)) return "📘";
    if (["xls", "xlsx", "xlsm", "ods", "csv", "numbers"].includes(ext)) return "📗";
    if (["ppt", "pptx", "odp", "key"].includes(ext)) return "📙";
    if (["zip", "gz", "tgz", "tar", "7z", "rar"].includes(ext)) return "🗜️";
    if (/^audio\//.test(item.mime || "")) return "🎵";
    if (/^video\//.test(item.mime || "")) return "🎬";
    return item.kind === "file" ? "📎" : "📄";
}

function readAsDataUrl(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result));
        reader.onerror = () => reject(reader.error || new Error("Lecture impossible."));
        reader.readAsDataURL(file);
    });
}

function renderAttachments() {
    const box = $("attachments");
    box.replaceChildren();
    box.classList.toggle("hidden", pendingAttachments.length === 0);
    pendingAttachments.forEach((item, index) => {
        const chip = document.createElement("span");
        chip.className = "attachment-chip";
        const kindLabel = item.kind === "image" ? "image" : item.kind === "file" ? (item.mime || "fichier") : "texte";
        chip.title = item.size != null ? `${item.name} (${kindLabel}, ${formatBytes(item.size)})` : item.name;
        if (item.kind === "image") {
            chip.classList.add("is-image");
            const img = document.createElement("img");
            img.src = item.data;
            img.alt = item.name;
            chip.appendChild(img);
        } else {
            const icon = document.createElement("span");
            icon.className = "attachment-icon";
            icon.textContent = attachmentIcon(item);
            chip.appendChild(icon);
        }
        const label = document.createElement("span");
        label.className = "attachment-name";
        label.textContent = item.name;
        chip.appendChild(label);
        // Type du fichier (PNG, PDF, TXT…) affiché en badge à côté du nom.
        const typeBadge = document.createElement("span");
        typeBadge.className = `attachment-type kind-${item.kind === "image" ? "image" : item.kind === "text" ? "text" : "file"}`;
        typeBadge.textContent = attachmentTypeLabel(item);
        chip.appendChild(typeBadge);
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "attachment-remove";
        remove.textContent = "×";
        remove.title = "Retirer";
        remove.onclick = () => {
            pendingAttachments.splice(index, 1);
            renderAttachments();
        };
        chip.appendChild(remove);
        box.appendChild(chip);
    });
}

/* Formats envoyés tels quels ; les autres (bmp, svg, tiff…) sont convertis via un canvas. */
const DIRECT_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const MAX_IMAGE_SIDE = 2048;

function formatBytes(n) {
    if (n < 1024) return `${n} o`;
    if (n < 1024 * 1024) return `${Math.round(n / 1024)} Ko`;
    return `${(n / 1024 / 1024).toFixed(1)} Mo`;
}

/**
 * Image -> data URL prête à l'envoi. Les images trop lourdes, trop grandes ou dans un
 * format peu pris en charge sont décodées, redimensionnées (2048 px max) puis
 * réencodées (PNG si possible, sinon JPEG) au lieu d'être refusées.
 */
async function prepareImage(file) {
    const direct = DIRECT_IMAGE_TYPES.has(file.type);
    if (direct && file.size <= MAX_IMAGE_BYTES) return readAsDataUrl(file);

    let bitmap;
    try {
        bitmap = await createImageBitmap(file);
    } catch {
        throw new Error(`format d'image illisible (${file.type || "inconnu"}) : utiliser PNG, JPEG, WebP ou GIF`);
    }
    const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    const ctx = canvas.getContext("2d");
    const draw = (background) => {
        ctx.clearRect(0, 0, canvas.width, canvas.height);
        if (background) {
            ctx.fillStyle = background;
            ctx.fillRect(0, 0, canvas.width, canvas.height);
        }
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    };
    try {
        if (file.type !== "image/jpeg") {
            draw(null);
            const png = canvas.toDataURL("image/png");
            if (png.length * 0.75 <= MAX_IMAGE_BYTES) return png;
        }
        draw("#ffffff"); // JPEG sans transparence : fond blanc plutôt que noir
        for (const quality of [0.88, 0.75, 0.6]) {
            const jpeg = canvas.toDataURL("image/jpeg", quality);
            if (jpeg.length * 0.75 <= MAX_IMAGE_BYTES) return jpeg;
        }
    } finally {
        if (bitmap.close) bitmap.close();
    }
    throw new Error(`image trop lourde même après compression (max ${formatBytes(MAX_IMAGE_BYTES)})`);
}

async function addAttachments(fileList) {
    for (const file of Array.from(fileList || [])) {
        if (pendingAttachments.length >= MAX_ATTACHMENTS) {
            renderEntry({ type: "error", text: `Maximum ${MAX_ATTACHMENTS} pièces jointes par message.` });
            break;
        }
        const name = file.name || (file.type.startsWith("image/") ? "image-collée.png" : "fichier");
        // Même fichier ajouté deux fois (double glisser-déposer, re-sélection) : ignoré.
        if (pendingAttachments.some((a) => a.name === name && a.size === file.size)) continue;
        try {
            if (file.size === 0) throw new Error("fichier vide");
            if (file.type.startsWith("image/")) {
                try {
                    pendingAttachments.push({ name, kind: "image", size: file.size, data: await prepareImage(file) });
                    continue;
                } catch (err) {
                    // Image non décodable (HEIC, PSD…) : envoyée telle quelle comme fichier.
                    if (file.size > MAX_FILE_BYTES) throw err;
                }
                pendingAttachments.push(await prepareFile(file, name));
                continue;
            }
            if (!isBinaryFile(file, name) && file.size <= MAX_TEXT_BYTES) {
                const data = await file.text();
                if (!data.includes("\u0000")) {
                    pendingAttachments.push({ name, kind: "text", size: file.size, data });
                    continue;
                }
            }
            // PDF, Office, archives, autres binaires : envoyés tels quels (Files v2).
            pendingAttachments.push(await prepareFile(file, name));
        } catch (err) {
            renderEntry({ type: "error", text: `${name} : ${err.message || err}` });
        }
    }
    renderAttachments();
}

async function send(text) {
    const value = text ?? input.value;
    const withFiles = text === undefined && pendingAttachments.length > 0;
    if (!value.trim() && !withFiles) return;
    // Quota : beaucoup de pièces jointes consomment vite le quota du compte FranceStudent.
    if (withFiles && pendingAttachments.length >= ATTACHMENT_QUOTA_WARN && !window.confirm(
        `${pendingAttachments.length} pièces jointes : cet envoi peut consommer une part importante de ton quota. Envoyer quand même ?`
    )) return;
    const attachments = withFiles ? pendingAttachments : [];
    if (text === undefined) {
        if (value.trim()) {
            ui.history.push(value);
            ui.historyIndex = ui.history.length;
        }
        input.value = "";
        if (withFiles) {
            pendingAttachments = [];
            renderAttachments();
        }
    }
    hideSlash();
    // File de prompts : pendant qu'une demande tourne, on met en attente au lieu d'envoyer.
    if (ui.status && ui.status.busy) {
        ui.promptQueue = ui.promptQueue || [];
        ui.promptQueue.push({ value, attachments });
        updatePromptQueueBadge();
        return;
    }
    try {
        await api.submit(value, attachments);
    } catch (err) {
        renderEntry({ type: "error", text: err.message });
    }
}

function updatePromptQueueBadge() {
    const n = (ui.promptQueue || []).length;
    const busy = Boolean(ui.status && ui.status.busy);
    $("st-busy").textContent = (busy ? "⟳ en cours" : "") + (n ? ` · ${n} en file` : "");
    $("btn-send").title = n ? `${n} message(s) en file d'attente` : "";
    if (typeof renderPendingPrompts === "function") renderPendingPrompts();
}

/** Envoie le prochain message en file (appelée quand la demande en cours se termine). */
function flushPromptQueue() {
    const queue = ui.promptQueue || [];
    if (!queue.length || (ui.status && ui.status.busy)) return;
    const next = queue.shift();
    updatePromptQueueBadge();
    api.submit(next.value, next.attachments).catch((err) => renderEntry({ type: "error", text: err.message }));
}

/** Vide la file (après une interruption, par exemple). */
function clearPromptQueue() {
    ui.promptQueue = [];
    updatePromptQueueBadge();
}

function slashMatches() {
    const value = input.value;
    if (!value.startsWith("/") || /\s/.test(value)) return [];
    return SLASH_COMMANDS.filter(([cmd]) => cmd.startsWith(value.toLowerCase()));
}

function hideSlash() {
    $("slash-menu").classList.add("hidden");
    ui.slashIndex = 0;
}

function updateSlash() {
    const matches = slashMatches();
    const menu = $("slash-menu");
    if (!matches.length) {
        hideSlash();
        return;
    }
    ui.slashIndex = Math.min(ui.slashIndex, matches.length - 1);
    menu.innerHTML = "";
    matches.forEach(([cmd, desc], i) => {
        const el = document.createElement("div");
        el.textContent = `${cmd}  —  ${desc}`;
        if (i === ui.slashIndex) el.className = "active";
        el.onmousedown = (ev) => {
            ev.preventDefault();
            ui.slashIndex = i;
            pickSlash();
        };
        menu.appendChild(el);
    });
    menu.classList.remove("hidden");
}

function moveSlash(delta) {
    const count = slashMatches().length;
    if (!count) return;
    ui.slashIndex = (ui.slashIndex + delta + count) % count;
    updateSlash();
}

function pickSlash() {
    const match = slashMatches()[ui.slashIndex];
    if (match) input.value = `${match[0]} `;
    hideSlash();
    input.focus();
}

input.addEventListener("input", updateSlash);

input.addEventListener("keydown", (ev) => {
    const menuOpen = !$("slash-menu").classList.contains("hidden");

    if (menuOpen && (ev.key === "ArrowDown" || ev.key === "ArrowUp")) {
        ev.preventDefault();
        moveSlash(ev.key === "ArrowDown" ? 1 : -1);
        return;
    }
    if (menuOpen && (ev.key === "Tab" || (ev.key === "Enter" && !ev.shiftKey))) {
        const match = slashMatches()[ui.slashIndex];
        if (ev.key === "Tab" || (match && match[0] !== input.value.trim())) {
            ev.preventDefault();
            pickSlash();
            return;
        }
    }
    if (ev.key === "Enter" && !ev.shiftKey) {
        ev.preventDefault();
        send();
        return;
    }
    if (ev.key === "Escape") {
        ev.preventDefault();
        if (menuOpen) hideSlash();
        else if (ui.status.busy) api.interrupt().catch(() => {});
        else input.value = "";
        return;
    }
    if ((ev.key === "ArrowUp" || ev.key === "ArrowDown") && !input.value.includes("\n") && ui.history.length) {
        ev.preventDefault();
        const delta = ev.key === "ArrowUp" ? -1 : 1;
        ui.historyIndex = Math.max(0, Math.min(ui.history.length, ui.historyIndex + delta));
        input.value = ui.history[ui.historyIndex] ?? "";
    }
});

$("composer").addEventListener("submit", (ev) => {
    ev.preventDefault();
    send();
});

$("btn-attach").onclick = () => $("attach-input").click();
$("attach-input").addEventListener("change", async (ev) => {
    await addAttachments(ev.target.files);
    ev.target.value = "";
    input.focus();
});
input.addEventListener("paste", (ev) => {
    const files = Array.from(ev.clipboardData?.files || []);
    if (!files.length) return;
    ev.preventDefault();
    addAttachments(files);
});
$("composer").addEventListener("dragover", (ev) => {
    if (!ev.dataTransfer || !Array.from(ev.dataTransfer.types || []).includes("Files")) return;
    ev.preventDefault();
    $("composer").classList.add("drag-over");
});
$("composer").addEventListener("dragleave", (ev) => {
    // Ignorer les passages d'un enfant à l'autre du composer (sinon la surbrillance clignote).
    if (ev.relatedTarget && $("composer").contains(ev.relatedTarget)) return;
    $("composer").classList.remove("drag-over");
});
$("composer").addEventListener("drop", (ev) => {
    $("composer").classList.remove("drag-over");
    const files = ev.dataTransfer?.files;
    if (!files || !files.length) return;
    ev.preventDefault();
    addAttachments(files);
});

/* ---------- Contexte choisi par l'utilisateur : @fichier épinglé ---------- */

const AT_MAX_RESULTS = 12;
const MAX_PINNED = 20;
let atFilesCache = null;
let atFilesAt = 0;
let atFilesWorkspace = null;
let atIndex = 0;
let atItems = [];
let atSeq = 0;
if (!ui.pinnedFiles) ui.pinnedFiles = [];

function atMenuEl() {
    let menu = $("at-menu");
    if (!menu) {
        menu = document.createElement("div");
        menu.id = "at-menu";
        menu.className = "at-menu hidden";
        menu.setAttribute("role", "listbox");
        const slash = $("slash-menu");
        slash.parentNode.insertBefore(menu, slash.nextSibling);
    }
    return menu;
}

/** Jeton « @requête » juste avant le curseur, ou null. */
function atToken() {
    const caret = input.selectionStart ?? input.value.length;
    const m = /(^|\s)@([^\s@]*)$/.exec(input.value.slice(0, caret));
    return m ? { query: m[2], start: caret - m[2].length - 1, end: caret } : null;
}

async function atFiles() {
    const ws = ui.workspace || null;
    if (ws !== atFilesWorkspace) {
        // Autre projet : les fichiers épinglés de l'ancien n'ont plus de sens.
        atFilesWorkspace = ws;
        atFilesCache = null;
        if (ui.pinnedFiles.length) {
            ui.pinnedFiles = [];
            renderPinned();
            lastEditorContext = null;
            syncEditorContext();
        }
    }
    if (!ws) return [];
    if (!atFilesCache || Date.now() - atFilesAt > 30000) {
        try {
            const res = await api.listAllFiles();
            atFilesCache = Array.isArray(res) ? res : [];
        } catch {
            atFilesCache = [];
        }
        atFilesAt = Date.now();
    }
    return atFilesCache;
}

function atScore(path, q) {
    if (!q) return 3;
    const p = path.toLowerCase();
    const name = p.split("/").pop();
    if (name.startsWith(q)) return 0;
    if (name.includes(q)) return 1;
    if (p.includes(q)) return 2;
    let i = 0;
    for (const c of p) if (c === q[i]) i++;
    return i === q.length ? 4 : -1;
}

function hideAt() {
    const menu = $("at-menu");
    if (menu) menu.classList.add("hidden");
    atItems = [];
    atIndex = 0;
}

function renderAtMenu() {
    const menu = atMenuEl();
    menu.innerHTML = "";
    if (!atItems.length) {
        const empty = document.createElement("div");
        empty.className = "at-empty";
        empty.textContent = ui.workspace ? "Aucun fichier ne correspond." : "Aucun projet ouvert.";
        menu.appendChild(empty);
    }
    atItems.forEach((path, i) => {
        const el = document.createElement("div");
        el.className = i === atIndex ? "at-item active" : "at-item";
        el.setAttribute("role", "option");
        if (ui.pinnedFiles.includes(path)) el.classList.add("pinned");
        const name = document.createElement("span");
        name.className = "at-name";
        name.textContent = path.split("/").pop();
        const dir = document.createElement("span");
        dir.className = "at-dir";
        dir.textContent = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
        el.append(name, dir);
        el.onmousedown = (ev) => {
            ev.preventDefault();
            atIndex = i;
            pickAt();
        };
        menu.appendChild(el);
    });
    menu.classList.remove("hidden");
    const active = menu.querySelector(".at-item.active");
    if (active) active.scrollIntoView({ block: "nearest" });
}

async function updateAt() {
    const tok = atToken();
    if (!tok) {
        hideAt();
        return;
    }
    hideSlash();
    const seq = ++atSeq;
    const files = await atFiles();
    if (seq !== atSeq || !atToken()) return;
    const q = tok.query.toLowerCase();
    atItems = files
        .map((path) => ({ path, score: atScore(path, q) }))
        .filter((x) => x.score >= 0)
        .sort((a, b) => a.score - b.score || a.path.length - b.path.length)
        .slice(0, AT_MAX_RESULTS)
        .map((x) => x.path);
    atIndex = Math.min(atIndex, Math.max(0, atItems.length - 1));
    renderAtMenu();
}

function pickAt() {
    const path = atItems[atIndex];
    const tok = atToken();
    if (path && tok) {
        // Le jeton @… est retiré du message : le fichier passe en contexte épinglé.
        input.value = input.value.slice(0, tok.start) + input.value.slice(tok.end);
        input.setSelectionRange(tok.start, tok.start);
        pinFile(path);
    }
    hideAt();
    input.focus();
}

function pinFile(path) {
    if (ui.pinnedFiles.includes(path)) return;
    if (ui.pinnedFiles.length >= MAX_PINNED) {
        renderEntry({ type: "error", text: `Maximum ${MAX_PINNED} fichiers épinglés.` });
        return;
    }
    ui.pinnedFiles.push(path);
    renderPinned();
    lastEditorContext = null;
    syncEditorContext();
}

function unpinFile(path) {
    ui.pinnedFiles = ui.pinnedFiles.filter((p) => p !== path);
    renderPinned();
    lastEditorContext = null;
    syncEditorContext();
}

function renderPinned() {
    let box = $("pinned-files");
    if (!box) {
        box = document.createElement("div");
        box.id = "pinned-files";
        box.className = "pinned-files";
        const attachments = $("attachments");
        attachments.parentNode.insertBefore(box, attachments);
    }
    box.replaceChildren();
    box.classList.toggle("hidden", ui.pinnedFiles.length === 0);
    for (const path of ui.pinnedFiles) {
        const chip = document.createElement("span");
        chip.className = "attachment-chip pinned-chip";
        chip.title = `${path}\n(épinglé dans le contexte de l'agent)`;
        const icon = document.createElement("span");
        icon.className = "attachment-icon";
        icon.textContent = "@";
        const label = document.createElement("span");
        label.className = "attachment-name";
        label.textContent = path.split("/").pop();
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "attachment-remove";
        remove.textContent = "×";
        remove.title = "Retirer du contexte";
        remove.onclick = () => unpinFile(path);
        chip.append(icon, label, remove);
        box.appendChild(chip);
    }
}

input.addEventListener("input", updateAt);
input.addEventListener("blur", () => setTimeout(() => {
    if (document.activeElement !== input) hideAt();
}, 150));

// Phase de capture : passe avant le gestionnaire du menu « / » et de l'envoi.
input.addEventListener("keydown", (ev) => {
    const menu = $("at-menu");
    if (!menu || menu.classList.contains("hidden")) return;
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        if (!atItems.length) return;
        atIndex = (atIndex + (ev.key === "ArrowDown" ? 1 : -1) + atItems.length) % atItems.length;
        renderAtMenu();
    } else if (ev.key === "Tab" || (ev.key === "Enter" && !ev.shiftKey)) {
        if (!atItems.length) return;
        ev.preventDefault();
        ev.stopImmediatePropagation();
        pickAt();
    } else if (ev.key === "Escape") {
        ev.preventDefault();
        ev.stopImmediatePropagation();
        hideAt();
    }
}, true);

/* ---------- Boutons et raccourcis ---------- */

$("btn-stop").onclick = () => {
    ui.interrupted = true;
    api.interrupt().catch(() => {});
};
$("btn-resume").onclick = () => {
    ui.interrupted = false;
    $("btn-resume").classList.add("hidden");
    send("Reprends la tâche précédente là où tu t'es arrêté (elle a été interrompue).");
};
$("btn-analyze").onclick = () => send("/analyze");
$("btn-new").onclick = () => send("/new");
$("btn-clear").onclick = () => send("/clear");
$("btn-help").onclick = () => send("/help");
$("mode-select").onchange = (ev) => send(`/mode ${ev.target.value}`);
$("btn-model").onclick = (ev) => {
    ev.stopPropagation();
    toggleModelMenu();
};
$("st-model").onclick = () => toggleModelMenu();
$("btn-history").onclick = (ev) => {
    ev.stopPropagation();
    toggleHistoryMenu();
};
$("st-usage").onclick = () => {
    if (ui.status && ui.status.busy) return;
    toggleQuotaPopover();
};
if (!$("st-usage").title) $("st-usage").title = "Cliquer pour afficher la consommation (/usage)";
$("btn-open-project").onclick = openProject;
$("btn-open-project-2").onclick = openProject;
$("btn-refresh-tree").onclick = () => renderTree();
$("btn-clear-output").onclick = () => {
    output.textContent = "";
};

function toggleSidebar() {
    const app = $("app");
    app.classList.toggle("no-sidebar");
    document.querySelector('[data-view="explorer"]').classList.toggle("active", !app.classList.contains("no-sidebar"));
}

document.querySelector('[data-view="explorer"]').onclick = toggleSidebar;
document.querySelector('[data-view="agent"]').onclick = () => input.focus();

const IS_MAC = /Mac/i.test(navigator.platform || navigator.userAgent || "");
if (IS_MAC) document.documentElement.classList.add("mac");

document.addEventListener("keydown", (ev) => {
    if (!(ev.ctrlKey || (IS_MAC && ev.metaKey))) {
        if (ev.key === "Escape" && ui.status.busy && document.activeElement !== input) {
            api.interrupt().catch(() => {});
        }
        return;
    }
    const key = ev.key.toLowerCase();
    if (ev.shiftKey && key === "e") {
        ev.preventDefault();
        toggleSidebar();
    } else if (ev.shiftKey && key === "a") {
        ev.preventDefault();
        input.focus();
    } else if (key === "s") {
        ev.preventDefault();
        saveCurrent();
    } else if (key === "o") {
        ev.preventDefault();
        openProject();
    } else if (key === "w") {
        ev.preventDefault();
        if (ui.active) closeTab(ui.active);
    } else if (key === "l") {
        ev.preventDefault();
        input.focus();
    }
});

window.addEventListener("beforeunload", (ev) => {
    if (ui.tabs.some((t) => t.dirty)) {
        ev.preventDefault();
        ev.returnValue = "";
    }
});

const LAYOUT_LIMITS = {
    "--left": { min: 240, max: 600 },
    "--right": { min: 360, max: 900 },
    "--bottom": { min: 60, max: 600 },
};
const CENTER_MIN_WIDTH = 320;
const EDITOR_MIN_HEIGHT = 160;

function layoutPx(cssVar) {
    const value = parseInt(getComputedStyle(document.documentElement).getPropertyValue(cssVar), 10);
    return Number.isFinite(value) ? value : LAYOUT_LIMITS[cssVar].min;
}

function layoutHidden(cssVar) {
    const app = $("app");
    if (cssVar === "--left") return app.classList.contains("no-sidebar");
    if (cssVar === "--right") return app.classList.contains("no-agent");
    return app.classList.contains("no-panel");
}

function layoutMax(cssVar) {
    const limits = LAYOUT_LIMITS[cssVar];
    let room;
    if (cssVar === "--bottom") {
        const center = $("center");
        const height = center && center.clientHeight ? center.clientHeight : window.innerHeight;
        room = height - EDITOR_MIN_HEIGHT;
    } else {
        const other = cssVar === "--left" ? "--right" : "--left";
        const otherWidth = layoutHidden(other) ? 0 : layoutPx(other) + 4;
        room = window.innerWidth - 48 - 4 - otherWidth - CENTER_MIN_WIDTH;
    }
    return Math.max(limits.min, Math.min(limits.max, room));
}

function clampLayout() {
    for (const v of ["--right", "--left", "--bottom"]) {
        if (layoutHidden(v)) continue;
        const current = layoutPx(v);
        const next = Math.max(LAYOUT_LIMITS[v].min, Math.min(layoutMax(v), current));
        if (next !== current) document.documentElement.style.setProperty(v, `${next}px`);
    }
}

let layoutFrame = 0;

function scheduleClampLayout() {
    if (layoutFrame) return;
    layoutFrame = requestAnimationFrame(() => {
        layoutFrame = 0;
        clampLayout();
    });
}

function dragResizer(id, cssVar, axis, invert) {
    const handle = $(id);
    if (!handle) return;
    handle.addEventListener("pointerdown", (ev) => {
        if (ev.button !== 0) return;
        ev.preventDefault();
        try {
            handle.setPointerCapture(ev.pointerId);
        } catch {
            // capture indisponible
        }
        const start = axis === "x" ? ev.clientX : ev.clientY;
        const initial = layoutPx(cssVar);
        const min = LAYOUT_LIMITS[cssVar].min;
        const max = layoutMax(cssVar);
        let last = start;
        let frame = 0;
        document.body.classList.add(axis === "x" ? "resizing-x" : "resizing-y");
        const apply = () => {
            frame = 0;
            const delta = last - start;
            const value = Math.max(min, Math.min(max, initial + (invert ? -delta : delta)));
            document.documentElement.style.setProperty(cssVar, `${value}px`);
        };
        const move = (e) => {
            last = axis === "x" ? e.clientX : e.clientY;
            if (!frame) frame = requestAnimationFrame(apply);
        };
        const up = () => {
            if (frame) {
                cancelAnimationFrame(frame);
                apply();
            }
            handle.removeEventListener("pointermove", move);
            handle.removeEventListener("pointerup", up);
            handle.removeEventListener("pointercancel", up);
            document.body.classList.remove("resizing-x", "resizing-y");
            if (typeof saveLayout === "function") saveLayout();
        };
        handle.addEventListener("pointermove", move);
        handle.addEventListener("pointerup", up);
        handle.addEventListener("pointercancel", up);
    });
}

dragResizer("resizer-left", "--left", "x", false);
dragResizer("resizer-right", "--right", "x", true);
dragResizer("resizer-bottom", "--bottom", "y", true);

window.addEventListener("resize", scheduleClampLayout);
new MutationObserver(scheduleClampLayout).observe($("app"), { attributes: true, attributeFilter: ["class"] });
scheduleClampLayout();

/* ---------- Boîte de saisie ---------- */

function inputDialog(title, value = "") {
    return new Promise((resolve) => {
        const overlay = document.createElement("div");
        overlay.className = "modal-overlay";
        const box = document.createElement("div");
        box.className = "modal";
        const heading = document.createElement("div");
        heading.className = "modal-title";
        heading.textContent = title;
        const field = document.createElement("input");
        field.type = "text";
        field.value = value;
        const buttons = document.createElement("div");
        buttons.className = "buttons";
        const ok = document.createElement("button");
        ok.type = "button";
        ok.className = "primary";
        ok.textContent = "OK";
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.textContent = "Annuler";
        buttons.append(ok, cancel);
        box.append(heading, field, buttons);
        overlay.appendChild(box);
        document.body.appendChild(overlay);

        const close = (result) => {
            overlay.remove();
            resolve(result);
        };
        ok.onclick = () => close(field.value.trim() || null);
        cancel.onclick = () => close(null);
        overlay.addEventListener("mousedown", (ev) => {
            if (ev.target === overlay) close(null);
        });
        field.addEventListener("keydown", (ev) => {
            if (ev.key === "Enter") {
                ev.preventDefault();
                close(field.value.trim() || null);
            } else if (ev.key === "Escape") {
                ev.preventDefault();
                ev.stopPropagation();
                close(null);
            }
        });
        setTimeout(() => {
            field.focus();
            const slash = field.value.lastIndexOf("/");
            const dot = field.value.lastIndexOf(".");
            field.setSelectionRange(slash + 1, dot > slash + 1 ? dot : field.value.length);
        }, 0);
    });
}

/* ---------- Opérations sur les fichiers ---------- */

function parentOf(rel) {
    const i = rel.lastIndexOf("/");
    return i < 0 ? "." : rel.slice(0, i);
}

function cleanRel(name) {
    return name.split("\\").join("/").replace(/^\/+/, "").replace(/\/+$/, "");
}

function joinRel(dir, name) {
    const clean = cleanRel(name);
    return !dir || dir === "." ? clean : `${dir}/${clean}`;
}

async function newEntry(kind, baseDir = ".") {
    if (!ui.workspace) {
        openProject();
        return;
    }
    const name = await inputDialog(kind === "directory" ? "Nom du nouveau dossier" : "Nom du nouveau fichier", "");
    if (!name) return;
    const rel = joinRel(baseDir, name);
    try {
        await api.createEntry(rel, kind);
    } catch (err) {
        renderEntry({ type: "error", text: `Création impossible : ${err.message}` });
        return;
    }
    let dir = kind === "directory" ? rel : parentOf(rel);
    while (dir && dir !== ".") {
        expanded.add(dir);
        dir = parentOf(dir);
    }
    await renderTree();
    if (kind !== "directory") await openFile(rel);
}

async function renameNode(entry) {
    const name = await inputDialog(`Renommer ${entry.path}`, entry.path);
    if (!name) return;
    const from = entry.path;
    const to = cleanRel(name);
    if (!to || to === from) return;
    try {
        await api.renameEntry(from, to);
    } catch (err) {
        renderEntry({ type: "error", text: `Renommage impossible : ${err.message}` });
        return;
    }
    const moved = (p) => p === from || p.startsWith(`${from}/`);
    const remap = (p) => to + p.slice(from.length);
    for (const tab of ui.tabs) {
        if (moved(tab.path)) tab.path = remap(tab.path);
    }
    if (ui.active && moved(ui.active)) {
        ui.active = remap(ui.active);
        $("st-file").textContent = ui.active;
    }
    for (const p of [...expanded]) {
        if (moved(p)) {
            expanded.delete(p);
            expanded.add(remap(p));
        }
    }
    renderTabs();
    await renderTree();
}

async function deleteNode(entry) {
    if (!window.confirm(`Mettre « ${entry.path} » à la corbeille ?`)) return;
    try {
        await api.trashEntry(entry.path);
    } catch (err) {
        renderEntry({ type: "error", text: `Suppression impossible : ${err.message}` });
        return;
    }
    const gone = (p) => p === entry.path || p.startsWith(`${entry.path}/`);
    const wasActive = Boolean(ui.active && gone(ui.active));
    ui.tabs = ui.tabs.filter((t) => !gone(t.path));
    for (const p of [...expanded]) {
        if (gone(p)) expanded.delete(p);
    }
    if (wasActive) {
        ui.active = null;
        const last = ui.tabs[ui.tabs.length - 1];
        activate(last ? last.path : null);
    } else {
        renderTabs();
    }
    await renderTree();
}

function mention(rel) {
    const sep = input.value && !/\s$/.test(input.value) ? " " : "";
    input.value += `${sep}${rel} `;
    input.focus();
}

/* ---------- Menu contextuel de l'explorateur ---------- */

const contextMenu = $("context-menu");

function hideContextMenu() {
    contextMenu.classList.add("hidden");
    contextMenu.innerHTML = "";
}

function showContextMenu(ev, entry) {
    const isDir = !entry || entry.type === "directory";
    const rel = entry ? entry.path : ".";
    const dir = entry ? (isDir ? rel : parentOf(rel)) : ".";
    const items = [];
    if (entry && !isDir) items.push(["Ouvrir", () => openFile(rel)]);
    items.push(["Nouveau fichier…", () => newEntry("file", dir)]);
    items.push(["Nouveau dossier…", () => newEntry("directory", dir)]);
    if (entry) {
        items.push(null);
        items.push(["Renommer…", () => renameNode(entry)]);
        items.push(["Supprimer (corbeille)", () => deleteNode(entry)]);
    }
    items.push(null);
    items.push(["Mentionner à l'agent", () => mention(rel)]);
    items.push(["Copier le chemin relatif", () => navigator.clipboard.writeText(rel).catch(() => {})]);
    items.push(["Afficher dans l'Explorateur Windows", () => api.revealInExplorer(rel).catch(() => {})]);

    contextMenu.innerHTML = "";
    for (const item of items) {
        const el = document.createElement("div");
        if (!item) {
            el.className = "sep";
        } else {
            el.className = "item";
            el.textContent = item[0];
            el.onclick = () => {
                hideContextMenu();
                item[1]();
            };
        }
        contextMenu.appendChild(el);
    }
    contextMenu.classList.remove("hidden");
    const rect = contextMenu.getBoundingClientRect();
    contextMenu.style.left = `${Math.max(0, Math.min(ev.clientX, window.innerWidth - rect.width - 4))}px`;
    contextMenu.style.top = `${Math.max(0, Math.min(ev.clientY, window.innerHeight - rect.height - 4))}px`;
}

$("tree").addEventListener("contextmenu", (ev) => {
    ev.preventDefault();
    if (ui.workspace) showContextMenu(ev, null);
});
$("tree").addEventListener("scroll", hideContextMenu);

$("btn-new-file").onclick = () => newEntry("file", ".");
$("btn-new-folder").onclick = () => newEntry("directory", ".");
$("btn-collapse-tree").onclick = () => {
    expanded.clear();
    renderTree();
};

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

/* ---------- Éditeur : curseur, aller à la ligne, indentation ---------- */

const cursorInfo = document.createElement("span");
cursorInfo.id = "st-cursor";
$("st-busy").parentNode.insertBefore(cursorInfo, $("st-busy"));

function updateCursor() {
    const tab = currentTab();
    if (!tab) {
        cursorInfo.textContent = "";
        return;
    }
    const before = code.value.slice(0, code.selectionStart);
    const line = before.split("\n").length;
    const col = code.selectionStart - before.lastIndexOf("\n");
    const selected = Math.abs(code.selectionEnd - code.selectionStart);
    const eol = tab.eol === "\r\n" ? "CRLF" : "LF";
    cursorInfo.textContent = `Ln ${line}, Col ${col}${selected ? ` (${selected} sél.)` : ""} · ${eol}`;
}

for (const name of ["keyup", "click", "input", "focus", "select"]) code.addEventListener(name, updateCursor);

function goToLine(n) {
    if (!currentTab()) return;
    const lines = code.value.split("\n");
    const target = Math.max(1, Math.min(lines.length, Number(n) || 1));
    let pos = 0;
    for (let i = 0; i < target - 1; i++) pos += lines[i].length + 1;
    code.focus();
    /* setSelectionRange fait défiler CodeMirror pour centrer la ligne visée. */
    code.setSelectionRange(pos, pos + lines[target - 1].length);
    updateCursor();
}

/* L'auto-indentation à la touche Entrée est assurée par CodeMirror (basicSetup). */

/* ---------- Palette (Ctrl+P / Ctrl+Maj+P) ---------- */

const palette = { items: [], index: 0, files: null };

function closePalette() {
    $("palette").classList.add("hidden");
}

async function openPalette(mode) {
    hideContextMenu();
    const field = $("palette-input");
    $("palette").classList.remove("hidden");
    field.value = mode === "commands" ? ">" : mode === "line" ? ":" : "";
    field.placeholder = "Fichier par nom · > commandes · : numéro de ligne";
    field.focus();
    palette.files = null;
    updatePalette();
    if (!ui.workspace) return;
    try {
        const res = await api.listAllFiles();
        const list = Array.isArray(res) ? res : (res && res.files) || [];
        palette.files = list.map((f) => (typeof f === "string" ? f : f.path)).filter(Boolean);
    } catch {
        palette.files = [];
    }
    if (!$("palette").classList.contains("hidden")) updatePalette();
}

function fuzzyScore(text, query) {
    if (!query) return 1;
    const t = text.toLowerCase();
    const q = query.toLowerCase();
    const idx = t.indexOf(q);
    if (idx >= 0) {
        const base = t.lastIndexOf("/") + 1;
        return 1000 + (idx >= base ? 500 : 0) - idx - t.length / 100;
    }
    let score = 0;
    let pos = 0;
    let last = -2;
    for (const ch of q) {
        const found = t.indexOf(ch, pos);
        if (found < 0) return 0;
        score += found === last + 1 ? 5 : 1;
        last = found;
        pos = found + 1;
    }
    return Math.max(0.01, score - t.length / 100);
}

function paletteCommands() {
    const cmds = [
        ["Ouvrir un dossier…", "Ctrl+O", openProject],
        ["Enregistrer le fichier", "Ctrl+S", saveCurrent],
        ["Fermer l'onglet", "Ctrl+W", () => ui.active && closeTab(ui.active)],
        ["Nouveau fichier…", "Ctrl+N", () => newEntry("file", ".")],
        ["Nouveau dossier…", "", () => newEntry("directory", ".")],
        ["Aller au fichier…", "Ctrl+P", () => openPalette("files")],
        ["Aller à la ligne…", "Ctrl+G", askGoToLine],
        ["Aller au symbole…", "Ctrl+Maj+O", () => openSymbolNav()],
        ["Rechercher dans le projet", "Ctrl+Maj+F", focusSearch],
        ["Afficher l'explorateur", "Ctrl+Maj+E", () => showSideView("explorer")],
        ["Afficher/masquer le panneau du bas", "Ctrl+J", () => togglePanel()],
        ["Ouvrir le terminal", "Ctrl+²", () => selectPanel("terminal", true)],
        ["Afficher la sortie de l'agent", "", () => selectPanel("output")],
        ["Replier l'arborescence", "", () => { expanded.clear(); renderTree(); }],
        ["Actualiser l'arborescence", "", () => renderTree()],
        ["Changer de modèle…", "/model", () => openModelMenu()],
        ["Afficher les modifications", "", () => selectPanel("changes")],
        ["Interrompre l'agent", "Échap", () => api.interrupt().catch(() => {})],
        ["Aller à la saisie de l'agent", "Ctrl+L", () => input.focus()],
        ["Aller à la définition", "F12", () => lspGoToDefinition()],
        ["Rechercher les références", "Maj+F12", () => lspFindReferences()],
        ["Renommer le symbole", "F2", () => lspRenameSymbol()],
        ["Afficher l'aide à la signature", "Ctrl+Maj+Espace", () => lspShowSignature(code.view, true)],
        ["Actions de code / corrections rapides", "Ctrl+.", () => lspShowCodeActions()],
        ["Formater le document", "Maj+Alt+F", () => lspFormatDocument()],
        ["Modifier la sélection avec l'IA…", "Ctrl+K", () => inlineEditStart()]
    ].map(([label, detail, run]) => ({ label, detail, run }));
    for (const [cmd, desc] of SLASH_COMMANDS) {
        cmds.push({
            label: `Agent : ${desc}`,
            detail: cmd,
            run: () => {
                input.value = `${cmd} `;
                input.focus();
            }
        });
    }
    return cmds;
}

function askGoToLine() {
    if (!currentTab()) return;
    openPalette("line");
}

function updatePalette() {
    const raw = $("palette-input").value;
    let items = [];
    if (raw.startsWith(">")) {
        const q = raw.slice(1).trim();
        items = paletteCommands()
            .map((c) => ({ ...c, score: fuzzyScore(`${c.label} ${c.detail}`, q) }))
            .filter((c) => c.score > 0);
        if (q) items.sort((a, b) => b.score - a.score);
    } else if (raw.startsWith(":")) {
        const tab = currentTab();
        const n = parseInt(raw.slice(1), 10);
        if (tab) {
            const total = code.value.split("\n").length;
            items = [{
                label: Number.isFinite(n) ? `Aller à la ligne ${n}` : `Saisir un numéro de ligne (1 à ${total})`,
                detail: tab.path,
                run: Number.isFinite(n) ? () => goToLine(n) : null
            }];
        }
    } else if (ui.workspace) {
        const q = raw.trim();
        if (palette.files === null) {
            items = [{ label: "Chargement des fichiers…", detail: "", run: null }];
        } else {
            items = palette.files
                .map((p) => ({ p, score: fuzzyScore(p, q) }))
                .filter((x) => x.score > 0)
                .sort((a, b) => b.score - a.score)
                .slice(0, 200)
                .map(({ p }) => ({ label: p.split("/").pop(), detail: p, run: () => openFile(p) }));
        }
    }
    palette.items = items;
    palette.index = 0;
    renderPaletteList();
}

function renderPaletteList() {
    const list = $("palette-list");
    list.innerHTML = "";
    if (!palette.items.length) {
        const empty = document.createElement("div");
        empty.className = "palette-empty";
        empty.textContent = ui.workspace || $("palette-input").value.startsWith(">") ? "Aucun résultat." : "Aucun projet ouvert (tapez > pour les commandes).";
        list.appendChild(empty);
        return;
    }
    palette.items.forEach((item, i) => {
        const el = document.createElement("div");
        el.className = "palette-item" + (i === palette.index ? " active" : "");
        const label = document.createElement("span");
        label.textContent = item.label;
        const detail = document.createElement("span");
        detail.className = "detail";
        detail.textContent = item.detail || "";
        el.append(label, detail);
        el.onmousedown = (ev) => {
            ev.preventDefault();
            palette.index = i;
            runPaletteItem();
        };
        list.appendChild(el);
    });
    const active = list.children[palette.index];
    if (active) active.scrollIntoView({ block: "nearest" });
}

function runPaletteItem() {
    const item = palette.items[palette.index];
    if (!item || !item.run) return;
    closePalette();
    Promise.resolve()
        .then(() => item.run())
        .catch((err) => renderEntry({ type: "error", text: err.message }));
}

$("palette-input").addEventListener("input", updatePalette);
$("palette-input").addEventListener("keydown", (ev) => {
    if (ev.key === "ArrowDown" || ev.key === "ArrowUp") {
        ev.preventDefault();
        const n = palette.items.length;
        if (!n) return;
        palette.index = (palette.index + (ev.key === "ArrowDown" ? 1 : -1) + n) % n;
        renderPaletteList();
    } else if (ev.key === "Enter") {
        ev.preventDefault();
        runPaletteItem();
    } else if (ev.key === "Escape") {
        ev.preventDefault();
        ev.stopPropagation();
        closePalette();
    }
});

/* ---------- Panneau du bas : sortie de l'agent et terminal ---------- */

ui.panel = "output";

/* Terminaux multiples (comme VS Code) : chaque terminal a sa sortie colorée (ANSI),
   son dossier courant, son historique et au plus une commande en cours. */
const termInput = $("terminal-input");
const termViews = $("term-views");
const termList = $("term-list");
const terms = [];
const termByProc = new Map();
const earlyData = new Map();
const exitedProcs = new Map();
let termSeq = 0;
let activeTermKey = null;

/* ---------- Vrai terminal : xterm.js + pseudo-terminal (node-pty) ----------
   Chaque onglet lance un shell interactif (zsh/bash, PowerShell sous Windows).
   Repli automatique sur le terminal simple ci-dessous si node-pty ou xterm.js
   est indisponible. */
const termByPty = new Map();
const earlyPty = new Map();
const exitedPty = new Map();
let ptyBroken = false;
const XTERM_THEME = {
    background: "#181818",
    foreground: "#cccccc",
    cursor: "#aeafad",
    cursorAccent: "#181818",
    selectionBackground: "#264f78",
    black: "#000000", red: "#cd3131", green: "#0dbc79", yellow: "#e5e510",
    blue: "#2472c8", magenta: "#bc3fbc", cyan: "#11a8cd", white: "#e5e5e5",
    brightBlack: "#666666", brightRed: "#f14c4c", brightGreen: "#23d18b", brightYellow: "#f5f543",
    brightBlue: "#3b8eea", brightMagenta: "#d670d6", brightCyan: "#29b8db", brightWhite: "#ffffff"
};

function xtermSupported() {
    return !ptyBroken
        && typeof window.Terminal === "function"
        && Boolean(window.FitAddon && window.FitAddon.FitAddon)
        && typeof api.ptyCreate === "function";
}

/** Ajuste xterm à la taille de son conteneur et prévient le shell (SIGWINCH). */
function fitTerm(term) {
    if (!term || !term.xterm || !term.el.isConnected || term.el.classList.contains("hidden")) return;
    if (!term.el.clientWidth || !term.el.clientHeight) return;
    try {
        term.fit.fit();
    } catch {
        return;
    }
    const { cols, rows } = term.xterm;
    if (term.ptyId && (cols !== term.lastCols || rows !== term.lastRows)) {
        term.lastCols = cols;
        term.lastRows = rows;
        api.ptyResize(term.ptyId, cols, rows).catch(() => {});
    }
}

function focusTerm(term = terms.find((t) => t.key === activeTermKey)) {
    if (term && term.xterm) term.xterm.focus();
    else termInput.focus();
}

function clearTerm(term) {
    if (!term) return;
    if (term.xterm) term.xterm.clear();
    else term.el.replaceChildren();
}

function disposeXterm(term) {
    if (!term || !term.xterm) return;
    if (term.ptyId) {
        termByPty.delete(term.ptyId);
        api.ptyKill(term.ptyId).catch(() => {});
        term.ptyId = null;
    }
    if (term.resizeObs) term.resizeObs.disconnect();
    try {
        term.xterm.dispose();
    } catch {
        // déjà libéré
    }
    term.xterm = null;
}

function startPty(term) {
    const xterm = term.xterm;
    if (!ui.workspace) {
        xterm.writeln("\x1b[33mAucun projet ouvert : ouvrez un dossier puis un nouveau terminal (+).\x1b[0m");
        return;
    }
    api.ptyCreate(".", xterm.cols, xterm.rows).then((res) => {
        if (!terms.includes(term) || !term.xterm) {
            api.ptyKill(res.id).catch(() => {});
            return;
        }
        term.ptyId = res.id;
        term.lastCols = xterm.cols;
        term.lastRows = xterm.rows;
        term.name = `${res.shell || "Terminal"} ${term.key}`;
        termByPty.set(res.id, term);
        if (earlyPty.has(res.id)) {
            xterm.write(earlyPty.get(res.id));
            earlyPty.delete(res.id);
        }
        if (exitedPty.has(res.id)) {
            const data = exitedPty.get(res.id);
            exitedPty.delete(res.id);
            ptyExit(data);
        }
        renderTermList();
        fitTerm(term);
    }).catch((err) => {
        const message = err && err.message ? err.message : String(err);
        xterm.writeln(`\x1b[31mTerminal indisponible : ${message}\x1b[0m`);
        if (/node-pty/i.test(message)) {
            ptyBroken = true;
            xterm.writeln("\x1b[90mLes prochains terminaux (+) utiliseront le mode simple.\x1b[0m");
        }
    });
}

function createXtermTerminal(focus) {
    const el = document.createElement("div");
    el.className = "term-view xterm-host";
    termViews.appendChild(el);
    const term = {
        key: termSeq,
        name: `Terminal ${termSeq}`,
        cwd: ".",
        root: ui.workspace || null,
        el,
        procId: null,
        ptyId: null,
        history: [],
        historyIndex: 0,
        style: {},
        pending: "",
        draft: ""
    };
    const xterm = new window.Terminal({
        cursorBlink: true,
        fontFamily: "Menlo, Monaco, 'SF Mono', Consolas, 'Courier New', monospace",
        fontSize: 13,
        lineHeight: 1.15,
        scrollback: 5000,
        macOptionIsMeta: true,
        theme: currentXtermTheme()
    });
    const fit = new window.FitAddon.FitAddon();
    xterm.loadAddon(fit);
    term.xterm = xterm;
    term.fit = fit;
    terms.push(term);
    selectTerminal(term.key, false);
    xterm.open(el);
    // Laisse passer les raccourcis globaux de l'application (Ctrl+², Ctrl+J, Ctrl+P…).
    xterm.attachCustomKeyEventHandler((ev) => {
        if (ev.type !== "keydown" || !(ev.ctrlKey || ev.metaKey)) return true;
        const k = String(ev.key || "").toLowerCase();
        if (ev.code === "Backquote" || k === "`" || k === "²") return false;
        if (k === "j" || k === "p") return false;
        if (ev.metaKey && (k === "c" || k === "v")) return false;
        return true;
    });
    xterm.onData((data) => {
        if (term.ptyId) api.ptyWrite(term.ptyId, data).catch(() => {});
    });
    term.resizeObs = new ResizeObserver(() => fitTerm(term));
    term.resizeObs.observe(el);
    fitTerm(term);
    startPty(term);
    if (focus) setTimeout(() => focusTerm(term), 0);
    return term;
}

/** Sortie d'un pseudo-terminal (événement ptyData). */
function ptyData(data) {
    if (!data || data.id === undefined || data.id === null || typeof data.data !== "string") return;
    const term = termByPty.get(data.id);
    if (term && term.xterm) {
        term.xterm.write(data.data);
        return;
    }
    earlyPty.set(data.id, (earlyPty.get(data.id) || "") + data.data);
    while (earlyPty.size > 50) earlyPty.delete(earlyPty.keys().next().value);
}

function ptyExit(data) {
    if (!data || data.id === undefined || data.id === null) return;
    const term = termByPty.get(data.id);
    if (!term) {
        exitedPty.set(data.id, data);
        while (exitedPty.size > 50) exitedPty.delete(exitedPty.keys().next().value);
        return;
    }
    termByPty.delete(data.id);
    term.ptyId = null;
    if (term.xterm) {
        const how = data.signal ? `signal ${data.signal}` : `code ${data.code}`;
        term.xterm.writeln(`\r\n\x1b[90m[shell terminé, ${how}] · + pour ouvrir un nouveau terminal\x1b[0m`);
    }
    renderTermList();
}

const ANSI_COLORS = ["#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5"];
const ANSI_BRIGHT = ["#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#ffffff"];

function ansi256(n) {
    if (n < 8) return ANSI_COLORS[n];
    if (n < 16) return ANSI_BRIGHT[n - 8];
    if (n < 232) {
        const v = n - 16;
        const c = (x) => (x ? 55 + x * 40 : 0);
        return `rgb(${c(Math.floor(v / 36))},${c(Math.floor(v / 6) % 6)},${c(v % 6)})`;
    }
    const g = 8 + (n - 232) * 10;
    return `rgb(${g},${g},${g})`;
}

function applySgr(style, params) {
    const p = params.length ? params : [0];
    for (let i = 0; i < p.length; i++) {
        const n = p[i];
        if (n === 0) Object.assign(style, { fg: null, bg: null, bold: false, dim: false, italic: false, underline: false, inverse: false });
        else if (n === 1) style.bold = true;
        else if (n === 2) style.dim = true;
        else if (n === 3) style.italic = true;
        else if (n === 4) style.underline = true;
        else if (n === 7) style.inverse = true;
        else if (n === 22) { style.bold = false; style.dim = false; }
        else if (n === 23) style.italic = false;
        else if (n === 24) style.underline = false;
        else if (n === 27) style.inverse = false;
        else if (n >= 30 && n <= 37) style.fg = ANSI_COLORS[n - 30];
        else if (n === 39) style.fg = null;
        else if (n >= 40 && n <= 47) style.bg = ANSI_COLORS[n - 40];
        else if (n === 49) style.bg = null;
        else if (n >= 90 && n <= 97) style.fg = ANSI_BRIGHT[n - 90];
        else if (n >= 100 && n <= 107) style.bg = ANSI_BRIGHT[n - 100];
        else if (n === 38 || n === 48) {
            let color = null;
            if (p[i + 1] === 5) { color = ansi256(p[i + 2] || 0); i += 2; }
            else if (p[i + 1] === 2) { color = `rgb(${p[i + 2] || 0},${p[i + 3] || 0},${p[i + 4] || 0})`; i += 4; }
            if (n === 38) style.fg = color;
            else style.bg = color;
        }
    }
}

/** Ajoute du texte (avec séquences ANSI) à la sortie d'un terminal. */
function termAppend(term, text) {
    if (!term || !text) return;
    let data = term.pending + String(text);
    term.pending = "";
    const cut = /\x1b(\[[0-9;?]*)?$/.exec(data);
    if (cut) {
        term.pending = cut[0];
        data = data.slice(0, cut.index);
    }
    data = data.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "").split("\r\n").join("\n");
    const el = term.el;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    const frag = document.createDocumentFragment();
    const flush = (chunk) => {
        const part = chunk.replace(/[^\n\r]*\r/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "");
        if (!part) return;
        const s = term.style;
        if (!s.fg && !s.bg && !s.bold && !s.dim && !s.italic && !s.underline && !s.inverse) {
            frag.appendChild(document.createTextNode(part));
            return;
        }
        const span = document.createElement("span");
        span.textContent = part;
        let fg = s.fg;
        let bg = s.bg;
        if (s.inverse) {
            fg = s.bg || "#181818";
            bg = s.fg || "#cccccc";
        }
        if (fg) span.style.color = fg;
        if (bg) span.style.backgroundColor = bg;
        if (s.bold) span.style.fontWeight = "bold";
        if (s.dim) span.style.opacity = "0.7";
        if (s.italic) span.style.fontStyle = "italic";
        if (s.underline) span.style.textDecoration = "underline";
        frag.appendChild(span);
    };
    const re = /\x1b\[([0-9;?]*)([ -/]*)([@-~])/g;
    let last = 0;
    let m;
    while ((m = re.exec(data))) {
        flush(data.slice(last, m.index));
        last = re.lastIndex;
        if (m[3] === "m" && !m[1].includes("?")) {
            applySgr(term.style, m[1].split(";").filter((x) => x !== "").map(Number));
        }
    }
    flush(data.slice(last));
    el.appendChild(frag);
    while (el.childNodes.length > 4000) el.removeChild(el.firstChild);
    if (atBottom) el.scrollTop = el.scrollHeight;
}

function termPrompt(term) {
    const root = String(ui.workspace || "").split(/[\\/]/).filter(Boolean).pop() || "projet";
    return `PS ${term.cwd === "." ? root : `${root}/${term.cwd}`}>`;
}

function createTerminal(focus = true) {
    termSeq++;
    if (xtermSupported()) {
        try {
            return createXtermTerminal(focus);
        } catch (err) {
            console.warn("[terminal] xterm.js indisponible, repli sur le terminal simple :", err);
            ptyBroken = true;
            const broken = terms.find((t) => t.key === termSeq);
            if (broken) {
                disposeXterm(broken);
                broken.el.remove();
                terms.splice(terms.indexOf(broken), 1);
            }
        }
    }
    const el = document.createElement("pre");
    el.className = "output term-view";
    termViews.appendChild(el);
    const term = {
        key: termSeq,
        name: `PowerShell ${termSeq}`,
        cwd: ".",
        root: ui.workspace || null,
        el,
        procId: null,
        history: [],
        historyIndex: 0,
        style: {},
        pending: "",
        draft: ""
    };
    applySgr(term.style, [0]);
    terms.push(term);
    selectTerminal(term.key, focus);
    termAppend(term, "\x1b[90mPowerShell dans le dossier du projet · « cd » change de dossier · « cls » ou Ctrl+L efface · Ctrl+C arrête.\x1b[0m\n");
    return term;
}

function activeTerm() {
    return terms.find((t) => t.key === activeTermKey) || terms[0] || createTerminal(false);
}

function selectTerminal(key, focus = false) {
    const prev = terms.find((t) => t.key === activeTermKey);
    if (prev && prev.key !== key) prev.draft = termInput.value;
    activeTermKey = key;
    const term = terms.find((t) => t.key === key);
    for (const t of terms) t.el.classList.toggle("hidden", t !== term);
    if (term && prev !== term) termInput.value = term.draft || "";
    // La ligne de saisie simple ne sert qu'au terminal de repli : xterm gère sa propre saisie.
    const line = document.querySelector("#terminal .terminal-line");
    if (line) line.classList.toggle("hidden", Boolean(term && term.xterm));
    renderTermList();
    updateKillButton();
    if (term && term.xterm) requestAnimationFrame(() => fitTerm(term));
    if (focus) setTimeout(() => focusTerm(term), 0);
}

function renderTermList() {
    termList.replaceChildren();
    termList.classList.toggle("hidden", terms.length < 2);
    for (const t of terms) {
        const row = document.createElement("div");
        row.className = `term-item${t.key === activeTermKey ? " active" : ""}${t.procId ? " running" : ""}`;
        row.title = t.cwd === "." ? t.name : `${t.name} — ${t.cwd}`;
        const dot = document.createElement("span");
        dot.className = "term-dot";
        const label = document.createElement("span");
        label.className = "term-name";
        label.textContent = t.name;
        const close = document.createElement("button");
        close.type = "button";
        close.className = "term-close";
        close.textContent = "×";
        close.title = "Fermer ce terminal";
        close.onclick = (ev) => {
            ev.stopPropagation();
            closeTerminal(t.key);
        };
        row.append(dot, label, close);
        row.onclick = () => selectTerminal(t.key, true);
        termList.appendChild(row);
    }
    const term = terms.find((t) => t.key === activeTermKey);
    $("terminal-ps").textContent = term ? termPrompt(term) : "PS>";
}

function closeTerminal(key) {
    const index = terms.findIndex((t) => t.key === key);
    if (index < 0) return;
    const term = terms[index];
    if (term.procId && term.procId !== "pending") {
        termByProc.delete(term.procId);
        api.killTerminal(term.procId).catch(() => {});
    }
    disposeXterm(term);
    term.el.remove();
    terms.splice(index, 1);
    if (!terms.length) {
        activeTermKey = null;
        createTerminal(ui.panel === "terminal");
        return;
    }
    if (activeTermKey === key) selectTerminal(terms[Math.min(index, terms.length - 1)].key, true);
    else renderTermList();
}

function selectPanel(name, focus = false) {
    ui.panel = name;
    $("app").classList.remove("no-panel");
    $("tab-output").classList.toggle("active", name === "output");
    $("tab-terminal").classList.toggle("active", name === "terminal");
    $("tab-changes").classList.toggle("active", name === "changes");
    output.classList.toggle("hidden", name !== "output");
    $("terminal").classList.toggle("hidden", name !== "terminal");
    $("changes").classList.toggle("hidden", name !== "changes");
    if (name === "changes") renderChangesList();
    if (name === "terminal" && !terms.length) createTerminal(focus);
    updateKillButton();
    if (name === "terminal") {
        const current = terms.find((t) => t.key === activeTermKey);
        if (current && current.xterm) requestAnimationFrame(() => fitTerm(current));
    }
    if (focus && name === "terminal") setTimeout(() => focusTerm(), 0);
    saveLayout();
}

function togglePanel(name) {
    const app = $("app");
    if (!app.classList.contains("no-panel") && (!name || name === ui.panel)) {
        app.classList.add("no-panel");
        saveLayout();
        return;
    }
    selectPanel(name || ui.panel, true);
}

function updateKillButton() {
    const term = terms.find((t) => t.key === activeTermKey);
    const running = Boolean(term && term.procId && term.procId !== "pending");
    const onTerminal = ui.panel === "terminal";
    $("btn-kill-terminal").classList.toggle("hidden", !running || !onTerminal);
    $("btn-new-terminal").classList.toggle("hidden", !onTerminal);
    $("btn-close-terminal").classList.toggle("hidden", !onTerminal);
    $("terminal").classList.toggle("running", running);
}

$("tab-output").onclick = () => selectPanel("output");
$("tab-terminal").onclick = () => selectPanel("terminal", true);
$("tab-changes").onclick = () => selectPanel("changes");
$("btn-undo").onclick = () => send("/undo");
$("btn-clear-output").onclick = () => {
    if (ui.panel === "terminal") clearTerm(activeTerm());
    else if (ui.panel === "changes") clearChanges();
    else output.textContent = "";
};

function capMap(map, max = 50) {
    while (map.size > max) map.delete(map.keys().next().value);
}

/** Sortie d'un processus : envoyée au terminal qui l'a lancé (mise de côté si son id n'est pas encore connu). */
function termData(data) {
    if (!data || data.id === undefined || data.id === null || !data.text) return;
    const term = termByProc.get(data.id);
    if (term) {
        termAppend(term, data.text);
        return;
    }
    earlyData.set(data.id, (earlyData.get(data.id) || "") + String(data.text));
    capMap(earlyData);
}

function termExit(data) {
    if (!data || data.id === undefined || data.id === null) return;
    const term = termByProc.get(data.id);
    if (!term) {
        exitedProcs.set(data.id, data);
        capMap(exitedProcs);
        return;
    }
    termByProc.delete(data.id);
    term.procId = null;
    const ok = !data.signal && Number(data.code) === 0;
    const how = data.signal ? `signal ${data.signal}` : `code ${data.code}`;
    termAppend(term, `\x1b[${ok ? "90" : "31"}m[processus terminé, ${how}]\x1b[0m\n`);
    renderTermList();
    updateKillButton();
}

async function runTerminalLine(line, term = activeTerm()) {
    const trimmed = String(line || "").trim();
    if (!trimmed) {
        termAppend(term, `\x1b[1;32m${termPrompt(term)}\x1b[0m\n`);
        return;
    }
    if (term.history[term.history.length - 1] !== trimmed) term.history.push(trimmed);
    if (term.history.length > 200) term.history.shift();
    term.historyIndex = term.history.length;
    if (/^(cls|clear|clear-host)$/i.test(trimmed)) {
        term.el.replaceChildren();
        return;
    }
    if (term.procId) {
        termAppend(term, "\x1b[33mUne commande est déjà en cours (Ctrl+C ou ■ pour l'arrêter, + pour ouvrir un autre terminal).\x1b[0m\n");
        return;
    }
    if (!ui.workspace) {
        termAppend(term, "\x1b[31mOuvrez d'abord un projet.\x1b[0m\n");
        return;
    }
    termAppend(term, `\x1b[1;32m${termPrompt(term)}\x1b[0m ${trimmed}\n`);

    const cd = /^(cd|chdir|set-location|sl)(?:\s+(.*))?$/i.exec(trimmed);
    if (cd && !/[;&|]/.test(trimmed)) {
        const target = String(cd[2] || "").trim().replace(/^["']|["']$/g, "") || ".";
        try {
            term.cwd = (await api.terminalCd(term.cwd, target)) || ".";
        } catch (err) {
            termAppend(term, `\x1b[31m${err.message}\x1b[0m\n`);
        }
        renderTermList();
        return;
    }

    term.procId = "pending";
    renderTermList();
    updateKillButton();
    try {
        const res = await api.runTerminal(trimmed, term.cwd);
        const id = res && typeof res === "object" ? res.id : res;
        if (!terms.includes(term)) {
            api.killTerminal(id).catch(() => {});
            return;
        }
        term.procId = id;
        termByProc.set(id, term);
        if (earlyData.has(id)) {
            const text = earlyData.get(id);
            earlyData.delete(id);
            termAppend(term, text);
        }
        if (exitedProcs.has(id)) {
            const data = exitedProcs.get(id);
            exitedProcs.delete(id);
            termExit(data);
            return;
        }
    } catch (err) {
        term.procId = null;
        termAppend(term, `\x1b[31mErreur : ${err.message}\x1b[0m\n`);
    }
    renderTermList();
    updateKillButton();
}

async function killTerm(term = activeTerm()) {
    const id = term.procId;
    if (!id || id === "pending") return;
    try {
        await api.killTerminal(id);
    } catch (err) {
        termAppend(term, `\x1b[31mArrêt impossible : ${err.message}\x1b[0m\n`);
    }
}

$("btn-kill-terminal").onclick = () => killTerm();
$("btn-new-terminal").onclick = () => createTerminal(true);
$("btn-close-terminal").onclick = () => {
    if (activeTermKey !== null) closeTerminal(activeTermKey);
};

/* ---------- Serveur de dev : démarrer / arrêter dans un terminal dédié ---------- */

let serverTerm = null;

function serverRunning() {
    return Boolean(serverTerm && terms.includes(serverTerm));
}

function updateServerButtons() {
    const running = serverRunning();
    if (!running) serverTerm = null;
    $("btn-server-start").classList.toggle("hidden", running);
    $("btn-server-stop").classList.toggle("hidden", !running);
}

/** Choisit le script npm : dev, sinon start, sinon serve (lecture de package.json). */
async function detectDevScript() {
    try {
        const file = await api.readFile("package.json");
        const scripts = (JSON.parse(file.content) || {}).scripts || {};
        for (const name of ["dev", "start", "serve"]) {
            if (scripts[name]) return name === "start" ? "npm start" : `npm run ${name}`;
        }
        return null;
    } catch {
        return null;
    }
}

function waitForPty(term, timeoutMs = 8000) {
    return new Promise((resolve) => {
        const started = Date.now();
        const tick = () => {
            if (!terms.includes(term) || !term.xterm) return resolve(false);
            if (term.ptyId) return resolve(true);
            if (Date.now() - started > timeoutMs) return resolve(false);
            setTimeout(tick, 100);
        };
        tick();
    });
}

async function startDevServer() {
    if (!ui.workspace) {
        renderEntry({ type: "error", text: "Ouvrez d'abord un projet pour démarrer un serveur." });
        return;
    }
    if (serverRunning()) {
        selectPanel("terminal", true);
        selectTerminal(serverTerm.key, true);
        return;
    }
    const command = await detectDevScript();
    if (!command) {
        renderEntry({ type: "error", text: "Aucun script « dev », « start » ou « serve » dans package.json." });
        return;
    }
    selectPanel("terminal", false);
    const term = createTerminal(true);
    term.name = `Serveur ${term.key}`;
    serverTerm = term;
    updateServerButtons();
    renderTermList();
    if (term.xterm) {
        if (await waitForPty(term)) {
            // startPty renomme le terminal d'après le shell : on remet le libellé « Serveur ».
            term.name = `Serveur ${term.key}`;
            renderTermList();
            api.ptyWrite(term.ptyId, `${command}\r`).catch(() => {});
        } else term.xterm.writeln("\x1b[31mImpossible de lancer le serveur : terminal non prêt.\x1b[0m");
    } else {
        runTerminalLine(command, term);
    }
}

async function stopDevServer() {
    if (!serverRunning()) {
        updateServerButtons();
        return;
    }
    const term = serverTerm;
    if (term.xterm && term.ptyId) {
        // Ctrl+C deux fois : npm demande parfois une confirmation sous Windows (« Terminer le programme de commandes ? »).
        api.ptyWrite(term.ptyId, "\x03").catch(() => {});
        setTimeout(() => {
            if (term.ptyId) api.ptyWrite(term.ptyId, "\x03").catch(() => {});
        }, 300);
    } else {
        await killTerm(term);
    }
    serverTerm = null;
    updateServerButtons();
}

$("btn-server-start").onclick = () => startDevServer();
$("btn-server-stop").onclick = () => stopDevServer();
// Si le terminal du serveur est fermé, les boutons se remettent à jour.
new MutationObserver(() => updateServerButtons()).observe(termViews, { childList: true });

/* ---------- Thème des terminaux xterm (suit le thème clair/sombre) ---------- */

const XTERM_THEME_LIGHT = {
    ...XTERM_THEME,
    background: "#ffffff",
    foreground: "#333333",
    cursor: "#333333",
    cursorAccent: "#ffffff",
    selectionBackground: "#add6ff",
    white: "#555555",
    brightWhite: "#333333",
    yellow: "#949800",
    brightYellow: "#b5ba00"
};

function currentXtermTheme() {
    return document.documentElement.dataset.theme === "light" ? XTERM_THEME_LIGHT : XTERM_THEME;
}

window.addEventListener("fs-theme-change", () => {
    const theme = currentXtermTheme();
    for (const t of terms) {
        if (!t.xterm) continue;
        try {
            t.xterm.options.theme = theme;
        } catch {
            // ancienne API xterm : thème appliqué aux prochains terminaux
        }
    }
});

termInput.addEventListener("keydown", (ev) => {
    const term = activeTerm();
    const key = String(ev.key || "").toLowerCase();
    if (ev.key === "Enter") {
        ev.preventDefault();
        const value = termInput.value;
        termInput.value = "";
        term.draft = "";
        runTerminalLine(value, term);
    } else if (ev.ctrlKey && !ev.shiftKey && key === "c" && termInput.selectionStart === termInput.selectionEnd) {
        ev.preventDefault();
        if (term.procId && term.procId !== "pending") {
            killTerm(term);
        } else {
            termAppend(term, `\x1b[1;32m${termPrompt(term)}\x1b[0m ${termInput.value}\x1b[90m^C\x1b[0m\n`);
            termInput.value = "";
            term.historyIndex = term.history.length;
        }
    } else if (ev.ctrlKey && !ev.shiftKey && key === "l") {
        ev.preventDefault();
        term.el.replaceChildren();
    } else if ((ev.key === "ArrowUp" || ev.key === "ArrowDown") && term.history.length) {
        ev.preventDefault();
        const delta = ev.key === "ArrowUp" ? -1 : 1;
        term.historyIndex = Math.max(0, Math.min(term.history.length, term.historyIndex + delta));
        termInput.value = term.history[term.historyIndex] ?? "";
    }
});

$("terminal").addEventListener("mouseup", (ev) => {
    // Clic dans la liste des onglets : selectTerminal gère déjà le focus.
    if (ev.target && ev.target.closest && ev.target.closest("#term-list")) return;
    const current = terms.find((t) => t.key === activeTermKey);
    if (current && current.xterm) {
        if (!current.xterm.hasSelection()) current.xterm.focus();
        return;
    }
    if (!String(window.getSelection())) termInput.focus();
});

/* ---------- File de prompts visible (au-dessus de la saisie) ---------- */
/* Portage simplifié du module 14-task-queue du dépôt extraopaa : uniquement côté renderer,
   sur la file locale ui.promptQueue (09-composer.js), sans IPC taskQueue. */

(() => {
    const anchor = $("attachments");
    if (!anchor || $("pending-prompts")) return;
    const host = document.createElement("div");
    host.id = "pending-prompts";
    host.className = "pending-prompts hidden";
    host.setAttribute("aria-label", "Prompts en attente");
    anchor.parentNode.insertBefore(host, anchor);
})();

function pendingAttachmentName(a) {
    if (!a) return "";
    if (typeof a === "string") return a.split(/[\\/]/).pop();
    return a.name || (a.path ? String(a.path).split(/[\\/]/).pop() : "") || "fichier";
}

function pendingPromptAction(label, title, run) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "pending-btn";
    btn.textContent = label;
    btn.title = title;
    btn.setAttribute("aria-label", title);
    btn.onclick = (ev) => {
        ev.preventDefault();
        run();
    };
    return btn;
}

function movePendingPrompt(index, delta) {
    const queue = ui.promptQueue || [];
    const target = index + delta;
    if (target < 0 || target >= queue.length) return;
    [queue[index], queue[target]] = [queue[target], queue[index]];
    updatePromptQueueBadge();
}

function removePendingPrompt(index) {
    const queue = ui.promptQueue || [];
    if (index < 0 || index >= queue.length) return;
    queue.splice(index, 1);
    updatePromptQueueBadge();
}

function editPendingPrompt(index) {
    const queue = ui.promptQueue || [];
    const item = queue[index];
    if (!item) return;
    if (input.value.trim() && !confirm("Remplacer le texte en cours de saisie par ce prompt en attente ?")) return;
    queue.splice(index, 1);
    input.value = item.value || "";
    if (Array.isArray(item.attachments) && item.attachments.length) {
        pendingAttachments = [...pendingAttachments, ...item.attachments];
        renderAttachments();
    }
    updatePromptQueueBadge();
    if (typeof autosizeInput === "function") autosizeInput();
    input.focus();
}

function renderPendingPrompts() {
    const host = $("pending-prompts");
    if (!host) return;
    const queue = ui.promptQueue || [];
    host.replaceChildren();
    host.classList.toggle("hidden", !queue.length);
    if (!queue.length) return;
    const head = document.createElement("div");
    head.className = "pending-head";
    const title = document.createElement("span");
    title.textContent = `${queue.length} demande(s) en attente · envoi automatique à la fin de la tâche en cours`;
    head.append(title, pendingPromptAction("Tout effacer", "Vider la file d'attente", () => {
        if (confirm(`Supprimer les ${queue.length} demande(s) en attente ?`)) clearPromptQueue();
    }));
    host.appendChild(head);
    queue.forEach((item, i) => {
        const row = document.createElement("div");
        row.className = "pending-prompt";
        const icon = document.createElement("span");
        icon.className = "pending-icon";
        icon.textContent = "↳";
        const text = document.createElement("span");
        text.className = "pending-text";
        text.textContent = item.value || "(sans texte)";
        text.title = item.value || "";
        if (Array.isArray(item.attachments) && item.attachments.length) {
            const files = document.createElement("small");
            files.className = "pending-attachments";
            files.textContent = "📎 " + item.attachments.map(pendingAttachmentName).join(", ");
            files.title = files.textContent;
            text.appendChild(files);
        }
        const up = pendingPromptAction("↑", "Monter", () => movePendingPrompt(i, -1));
        up.disabled = i === 0;
        const down = pendingPromptAction("↓", "Descendre", () => movePendingPrompt(i, 1));
        down.disabled = i === queue.length - 1;
        row.append(
            icon,
            text,
            pendingPromptAction("Modifier", "Remettre ce prompt dans la saisie pour le modifier", () => editPendingPrompt(i)),
            up,
            down,
            pendingPromptAction("✕", "Supprimer ce prompt en attente", () => removePendingPrompt(i))
        );
        host.appendChild(row);
    });
}
/* ---------- Raccourcis globaux ---------- */

function isEditable(el) {
    return Boolean(el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable));
}

window.addEventListener("keydown", (ev) => {
    if (!ev.ctrlKey && !ev.altKey && !ev.metaKey) {
        if (ev.key === "Escape" && !contextMenu.classList.contains("hidden")) {
            ev.stopPropagation();
            hideContextMenu();
            return;
        }
        if (ev.key === "Escape" && !modelMenuEl.classList.contains("hidden")) {
            const active = document.activeElement;
            // La recherche et le renommage de l'historique gèrent Escape eux-mêmes.
            if (active && modelMenuEl.contains(active) && active.matches(".history-search, .history-rename")) return;
            ev.stopPropagation();
            hideModelMenu();
            return;
        }
        const p = ui.prompts[0];
        const free = !isEditable(document.activeElement) && !document.querySelector(".modal-overlay") && $("palette").classList.contains("hidden");
        if (p && p.kind === "confirm" && free) {
            const k = ev.key.toLowerCase();
            const value = k === "o" || k === "y" ? "o" : k === "n" ? "n" : k === "t" && !p.force ? "t" : null;
            if (value) {
                ev.preventDefault();
                ev.stopPropagation();
                api.resolvePrompt(p.id, value).catch((err) => renderEntry({ type: "error", text: err.message }));
            }
        }
        return;
    }
    const key = ev.key.toLowerCase();
    let action = null;
    if ((ev.code === "Backquote" || key === "`" || key === "²") && ev.shiftKey) action = () => {
        selectPanel("terminal", false);
        createTerminal(true);
    };
    else if (ev.code === "Backquote" || key === "`" || key === "²") action = () => togglePanel("terminal");
    else if (key === "p" && ev.shiftKey) action = () => openPalette("commands");
    else if (key === "p") action = () => openPalette("files");
    else if (key === "f" && ev.shiftKey) action = focusSearch;
    else if (key === "e" && ev.shiftKey) action = () => toggleSideView("explorer");
    else if (key === "j" && !ev.shiftKey) action = () => togglePanel();
    else if (key === "g" && ev.shiftKey) action = () => toggleSideView("git");
    else if (key === "g" && !ev.shiftKey) action = askGoToLine;
    else if (key === "n" && !ev.shiftKey) action = () => newEntry("file", ".");
    else if (key === "b" && !ev.shiftKey) action = () => toggleSideView(ui.sideView || "explorer");
    if (!action) return;
    ev.preventDefault();
    ev.stopPropagation();
    action();
}, true);

document.addEventListener("mousedown", (ev) => {
    if (!contextMenu.classList.contains("hidden") && !contextMenu.contains(ev.target)) hideContextMenu();
    if (!modelMenuEl.classList.contains("hidden") &&
        !modelMenuEl.contains(ev.target) &&
        !ev.target.closest("#btn-model") &&
        !ev.target.closest("#btn-history") &&
        !ev.target.closest("#st-model")) {
        hideModelMenu();
    }
    const pal = $("palette");
    if (!pal.classList.contains("hidden") && !pal.contains(ev.target)) closePalette();
});
window.addEventListener("blur", hideContextMenu);

/* ---------- Copie des blocs de code ---------- */

transcript.addEventListener("dblclick", (ev) => {
    const pre = ev.target.closest("pre");
    if (!pre) return;
    navigator.clipboard.writeText(pre.textContent).then(() => {
        pre.classList.add("copied");
        setTimeout(() => pre.classList.remove("copied"), 900);
    }).catch(() => {});
});

/* ---------- Disposition mémorisée ---------- */

const LAYOUT_KEY = "frst.desktop.layout";
const LAYOUT_VARS = ["--left", "--right", "--bottom"];

function saveLayout() {
    try {
        const data = { noPanel: $("app").classList.contains("no-panel"), chatMax: $("app").classList.contains("chat-max") };
        for (const v of LAYOUT_VARS) {
            const value = document.documentElement.style.getPropertyValue(v).trim();
            if (value) data[v] = value;
        }
        localStorage.setItem(LAYOUT_KEY, JSON.stringify(data));
    } catch {
        // stockage local indisponible
    }
}

try {
    const saved = JSON.parse(localStorage.getItem(LAYOUT_KEY) || "{}");
    for (const v of LAYOUT_VARS) {
        if (/^[0-9]+px$/.test(saved[v] || "")) document.documentElement.style.setProperty(v, saved[v]);
    }
    if (saved.noPanel || saved.noPanel === undefined) $("app").classList.add("no-panel");
    if (saved.chatMax) $("app").classList.add("chat-max");
} catch {
    // disposition par défaut
}

/* ---------- Barre de titre, accueil et zone de saisie ---------- */

function bindClick(id, fn) {
    const el = $(id);
    if (el) el.addEventListener("click", fn);
}

function toggleAgent() {
    const app = $("app");
    app.classList.toggle("no-agent");
    if (!app.classList.contains("no-agent")) input.focus();
}

function syncTitlebar() {
    const app = $("app");
    const set = (id, on) => {
        const el = $(id);
        if (el) el.classList.toggle("active", on);
    };
    set("tb-toggle-sidebar", !app.classList.contains("no-sidebar"));
    set("tb-toggle-panel", !app.classList.contains("no-panel"));
    set("tb-toggle-agent", !app.classList.contains("no-agent")); set("tb-chat-max", app.classList.contains("chat-max")); const maxBtn = $("tb-chat-max"); if (maxBtn) maxBtn.setAttribute("aria-pressed", String(app.classList.contains("chat-max")));
}

bindClick("tb-palette", () => openPalette("files"));
bindClick("tb-toggle-sidebar", () => toggleSideView(ui.sideView || "explorer"));
bindClick("tb-toggle-panel", () => togglePanel());
bindClick("tb-toggle-agent", () => { $("app").classList.remove("chat-max"); toggleAgent(); saveLayout(); }); function toggleChatMax() { const app = $("app"); const on = !app.classList.contains("chat-max"); app.classList.toggle("chat-max", on); if (on) app.classList.remove("no-agent"); const btn = $("tb-chat-max"); if (btn) { btn.setAttribute("aria-pressed", String(on)); btn.title = on ? "Réduire le chat (Ctrl+Maj+M)" : "Agrandir le chat (Ctrl+Maj+M)"; } saveLayout(); input.focus(); } bindClick("tb-chat-max", toggleChatMax); document.addEventListener("keydown", (ev) => { if (ev.ctrlKey && ev.shiftKey && !ev.altKey && (ev.key === "M" || ev.key === "m")) { ev.preventDefault(); toggleChatMax(); } });
bindClick("wa-open", () => openProject());
bindClick("wa-goto", () => openPalette("files"));
bindClick("wa-palette", () => openPalette("commands"));
bindClick("wa-terminal", () => togglePanel("terminal"));

new MutationObserver(syncTitlebar).observe($("app"), { attributes: true, attributeFilter: ["class"] });
syncTitlebar();

function autosizeInput() {
    input.style.height = "auto";
    input.style.height = `${Math.min(input.scrollHeight, 240)}px`;
}

input.addEventListener("input", autosizeInput);
input.addEventListener("keyup", autosizeInput);
$("composer").addEventListener("submit", () => setTimeout(autosizeInput, 0));

window.addEventListener("mouseup", () => setTimeout(saveLayout, 0));
window.addEventListener("beforeunload", saveLayout);

/* ---------- Événements du processus principal ---------- */

api.onEvent((channel, data) => {
    switch (channel) {
        case "entry":
            renderEntry(data);
            if (data.type === "result" || data.type === "diff") scheduleRefresh();
            break;
        case "liveStart":
            liveStart();
            break;
        case "liveAppend":
            liveAppend(data);
            break;
        case "liveEnd":
            liveEnd();
            break;
        case "spinner":
            setSpinner(data);
            break;
        case "prompt":
            ui.prompts.push(data);
            if (ui.prompts.length === 1) showPrompt();
            break;
        case "promptResolved": {
            const wasFirst = ui.prompts[0] && ui.prompts[0].id === data.id;
            ui.prompts = ui.prompts.filter((p) => p.id !== data.id);
            if (wasFirst) showPrompt();
            break;
        }
        case "commandLine":
            appendOutput(data);
            break;
        case "clear":
            transcript.innerHTML = "";
            toolGroup = null;
            liveEnd();
            clearChanges();
            break;
        case "terminalData":
            termData(data);
            break;
        case "terminalExit":
            termExit(data || {});
            break;
        case "ptyData":
            ptyData(data);
            break;
        case "ptyExit":
            ptyExit(data || {});
            break;
        case "status":
            applyStatus(data);
            break;
        default:
            break;
    }
});

/* ---------- Vue Git : état du dépôt, diff inline et journal ---------- */

ui.git = { open: null, timer: null, busy: false };

function gitCode(file) {
    const code = `${file.index || " "}${file.worktree || " "}`.trim();
    return code || "M";
}

function gitDiffLines(result) {
    const text = typeof result === "string" ? result : String(result?.diff ?? result?.text ?? "");
    return text
        .split(/\r?\n/)
        .filter((line) => line && !/^(diff --git|index |--- |\+\+\+ |new file mode|deleted file mode|similarity index|rename from|rename to)/.test(line));
}

function gitCountChanges(lines) {
    let added = 0;
    let removed = 0;
    for (const line of lines) {
        if (line[0] === "+") added++;
        else if (line[0] === "-") removed++;
    }
    return { added, removed };
}

function updateGitBadge(count) {
    const badge = $("git-count");
    if (!badge) return;
    badge.textContent = count ? String(count) : "";
    badge.classList.toggle("hidden", !count);
}

function gitMessage(container, text) {
    container.innerHTML = "";
    const empty = document.createElement("div");
    empty.className = "ext-empty";
    empty.textContent = text;
    container.appendChild(empty);
}

async function toggleGitDiff(file, row) {
    const next = row.nextElementSibling;
    if (next && next.classList.contains("git-diff")) {
        next.remove();
        ui.git.open = null;
        return;
    }
    document.querySelectorAll("#git-files .git-diff").forEach((el) => el.remove());
    ui.git.open = file.path;
    const holder = document.createElement("div");
    holder.className = "git-diff";
    holder.textContent = "Chargement du diff…";
    row.after(holder);
    try {
        let lines;
        if (file.worktree === "?") {
            // Fichier non suivi : tout son contenu est un ajout.
            const content = await api.readFile(file.path);
            const text = typeof content === "string" ? content : String(content?.content ?? "");
            lines = text.split(/\r?\n/).map((l) => `+${l}`);
        } else {
            lines = gitDiffLines(await api.gitDiff(file.path, Boolean(file.staged)));
        }
        holder.innerHTML = "";
        if (!lines.length) {
            holder.textContent = "Aucune différence textuelle (fichier binaire ou changement de mode).";
            return;
        }
        holder.appendChild(buildDiffCard({ path: file.path, lines, ...gitCountChanges(lines) }));
    } catch (error) {
        holder.textContent = `Diff impossible : ${error.message}`;
    }
}

function renderGitFiles(files) {
    const list = $("git-files");
    list.innerHTML = "";
    if (!files.length) {
        gitMessage(list, "Aucune modification : l'arbre de travail est propre.");
        return;
    }
    for (const file of files) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "git-row";
        row.title = `${file.path}${file.from ? ` (depuis ${file.from})` : ""} — ${file.label || ""}\nClic : diff · Double-clic : ouvrir`;
        row.appendChild(fileIcon(file.path, "file"));
        const p = document.createElement("span");
        p.className = "git-path";
        p.textContent = file.path;
        row.appendChild(p);
        const c = document.createElement("span");
        c.className = "git-code";
        c.textContent = gitCode(file) + (file.staged ? " ·indexé" : "");
        row.appendChild(c);
        row.onclick = () => toggleGitDiff(file, row);
        row.ondblclick = () => { if (file.worktree !== "D" && file.index !== "D") openFile(file.path); };
        list.appendChild(row);
        if (ui.git.open === file.path) toggleGitDiff(file, row);
    }
}

function renderGitLog(commits) {
    const list = $("git-log");
    list.innerHTML = "";
    if (!commits.length) {
        gitMessage(list, "Aucun commit pour l'instant.");
        return;
    }
    for (const commit of commits) {
        const row = document.createElement("div");
        row.className = "git-commit";
        row.title = `${commit.hash}\n${commit.author} — ${commit.date}`;
        const h = document.createElement("span");
        h.className = "git-hash";
        h.textContent = commit.short;
        row.appendChild(h);
        const s = document.createElement("span");
        s.textContent = ` ${commit.subject}`;
        row.appendChild(s);
        list.appendChild(row);
    }
}

async function refreshGit() {
    if (ui.git.busy) return;
    ui.git.busy = true;
    const branch = $("git-branch");
    try {
        const st = await api.gitStatus();
        if (!st || !st.repo) {
            branch.textContent = "Pas de dépôt Git dans ce dossier.";
            gitMessage($("git-files"), "Initialisez un dépôt avec « git init » dans le terminal.");
            $("git-log").innerHTML = "";
            updateGitBadge(0);
            return;
        }
        const sync = [st.ahead ? `↑${st.ahead}` : "", st.behind ? `↓${st.behind}` : ""].filter(Boolean).join(" ");
        branch.textContent = `Branche ${st.branch || "(détachée)"}${sync ? ` · ${sync}` : ""} · ${st.files.length} fichier(s) modifié(s)`;
        updateGitBadge(st.files.length);
        renderGitFiles(st.files);
        renderGitLog(await api.gitLog(20));
    } catch (error) {
        branch.textContent = `Git : ${gitErrorText(error)}`;
    } finally {
        ui.git.busy = false;
        refreshGitHub();
    }
}

/** Message d'erreur IPC sans le préfixe ajouté par Electron. */
function gitErrorText(error) {
    return String((error && error.message) || error || "").replace(/^Error invoking remote method '[^']*': (?:Error: )?/, "");
}

function gitActionMessage(text, kind) {
    const box = $("git-action-msg");
    box.textContent = text || "";
    box.className = `git-action-msg${kind ? ` ${kind}` : ""}`;
}

/** État du compte GitHub et du remote origin (seule la version masquée du token arrive ici). */
async function refreshGitHub() {
    if (!api.githubStatus) return;
    const account = $("gh-account");
    try {
        const st = await api.githubStatus();
        if (st.connected) {
            account.textContent = `Connecté : ${st.login || "?"}${st.name ? ` (${st.name})` : ""} · token ${st.masked || ""}${st.source ? ` (${st.source})` : ""}`;
        } else if (st.error) {
            account.textContent = `Token refusé ou réseau indisponible : ${st.error}`;
        } else {
            account.textContent = "Non connecté à GitHub.";
        }
        $("gh-login-row").classList.toggle("hidden", Boolean(st.connected));
        $("gh-logout-row").classList.toggle("hidden", !(st.connected || st.masked));
        $("gh-remote").textContent = st.remote ? `Remote origin : ${st.remote}` : "Aucun remote « origin ».";
    } catch (error) {
        account.textContent = `GitHub : ${gitErrorText(error)}`;
    }
}

/** Lance une action Git/GitHub : boutons désactivés pendant l'action, message, puis actualisation. */
async function runGitAction(label, fn) {
    if (ui.git.action) return;
    ui.git.action = true;
    const buttons = Array.from(document.querySelectorAll("#git-view button"));
    buttons.forEach((b) => { b.disabled = true; });
    gitActionMessage(`${label}…`, "");
    try {
        const text = await fn();
        gitActionMessage(text || `${label} : terminé.`, "ok");
    } catch (error) {
        gitActionMessage(`${label} : ${gitErrorText(error)}`, "error");
    } finally {
        buttons.forEach((b) => { b.disabled = false; });
        ui.git.action = false;
        refreshGit();
    }
}

function gitCommitNow() {
    const input = $("git-commit-msg");
    const message = input.value.trim();
    if (!message) {
        gitActionMessage("Écrivez un message de commit.", "error");
        input.focus();
        return;
    }
    runGitAction("Commit", async () => {
        const r = await api.gitCommit(message);
        input.value = "";
        return `Commit créé (${r.files} fichier(s)).`;
    });
}

/** Rafraîchissement différé (écritures de l'agent, sauvegardes). */
function scheduleGitRefresh() {
    clearTimeout(ui.git.timer);
    ui.git.timer = setTimeout(() => {
        if (ui.workspace) refreshGit();
    }, 400);
}

$("btn-git-refresh").onclick = () => refreshGit();
$("btn-git-commit").onclick = () => gitCommitNow();
$("git-commit-msg").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
        event.preventDefault();
        gitCommitNow();
    }
});
$("btn-git-push").onclick = () => runGitAction("Push", async () => {
    const r = await api.githubPush();
    return `Push terminé : ${r.branch} → ${r.remote}.`;
});
$("btn-git-pull").onclick = () => runGitAction("Pull", async () => {
    const r = await api.githubPull();
    return `Pull terminé (${r.remote}/${r.branch})${r.output ? ` : ${r.output.split("\n").pop()}` : "."}`;
});
$("btn-git-fetch").onclick = () => runGitAction("Fetch", async () => {
    const r = await api.githubFetch();
    return `Fetch terminé (${r.remote}).`;
});
$("btn-gh-login").onclick = () => {
    const input = $("gh-token");
    const token = input.value.trim();
    if (!token) {
        gitActionMessage("Collez un token GitHub.", "error");
        input.focus();
        return;
    }
    runGitAction("Connexion GitHub", async () => {
        try {
            const u = await api.githubLoginToken(token);
            return `Connecté en tant que ${u.login || "?"}.`;
        } finally {
            input.value = "";
        }
    });
};
$("gh-token").addEventListener("keydown", (event) => {
    if (event.key === "Enter") $("btn-gh-login").click();
});
$("btn-gh-logout").onclick = () => runGitAction("Déconnexion GitHub", async () => {
    await api.githubLogout();
    return "Token GitHub supprimé de cet ordinateur.";
});
$("btn-gh-remote").onclick = () => {
    const input = $("gh-remote-input");
    const spec = input.value.trim();
    if (!spec) {
        gitActionMessage("Indiquez owner/repo ou une URL GitHub.", "error");
        input.focus();
        return;
    }
    runGitAction("Remote", async () => {
        const r = await api.githubSetRemote(spec);
        input.value = "";
        return `Remote ${r.remote} ${r.updated ? "mis à jour" : "ajouté"} : ${r.url}`;
    });
};
$("btn-gh-create").onclick = () => {
    const input = $("gh-repo-name");
    const name = input.value.trim();
    if (!name) {
        gitActionMessage("Indiquez le nom du dépôt à créer.", "error");
        input.focus();
        return;
    }
    const isPublic = $("gh-repo-public").checked;
    runGitAction("Création du dépôt", async () => {
        const repo = await api.githubCreateRepo(name, isPublic);
        input.value = "";
        let extra = "";
        const st = await api.githubStatus().catch(() => null);
        if (st && !st.remote && ui.workspace) {
            await api.githubSetRemote(repo.full_name);
            extra = " Remote origin défini.";
        }
        return `Dépôt ${repo.private ? "privé" : "public"} créé : ${repo.html_url}.${extra}`;
    });
};
/* ---------- Vue Worktrees : agents parallèles dans des worktrees Git ---------- */

ui.worktrees = { busy: false, agents: new Map(), cards: new Map() };

const WT_STATUS = { running: "en cours", done: "terminé", failed: "échec", stopped: "arrêté" };

function wtMessage(text, kind) {
    const box = $("wt-msg");
    if (!box) return;
    box.textContent = text || "";
    box.className = `git-action-msg${kind ? ` ${kind}` : ""}`;
}

function updateWorktreeBadge() {
    const badge = $("wt-count");
    if (!badge) return;
    let running = 0;
    for (const agent of ui.worktrees.agents.values()) if (agent.status === "running") running++;
    badge.textContent = running ? String(running) : "";
    badge.classList.toggle("hidden", !running);
}

function wtStatusText(agent) {
    if (!agent) return "Aucun agent lancé.";
    const label = WT_STATUS[agent.status] || agent.status;
    const ended = agent.status !== "running" && agent.exitCode !== null && agent.exitCode !== undefined;
    const mode = agent.readOnly ? "lecture seule" : agent.yes ? "écritures auto" : "sans écriture";
    return `Agent : ${label}${ended ? ` (code ${agent.exitCode})` : ""} · ${mode}`;
}

function wtAgentText(agent) {
    if (!agent) return "";
    const answer = String(agent.answer || "").trim();
    const text = answer || String(agent.log || "").trim();
    return text.length > 6000 ? `…${text.slice(-6000)}` : text;
}

function wtApplyCard(name) {
    const card = ui.worktrees.cards.get(name);
    if (!card) return;
    const agent = ui.worktrees.agents.get(name) || null;
    const running = Boolean(agent && agent.status === "running");
    card.status.textContent = wtStatusText(agent);
    card.status.className = `wt-status wt-${agent ? agent.status : "idle"}`;
    card.status.title = agent && agent.prompt ? `Demande : ${agent.prompt}` : "";
    card.output.textContent = wtAgentText(agent);
    card.output.classList.toggle("hidden", !card.output.textContent);
    card.start.disabled = running;
    card.stop.disabled = !running;
    card.remove.disabled = running;
}

/** Mise à jour envoyée par le processus principal (événement worktreeAgent). */
function wtUpdateAgent(agent) {
    if (!agent || !agent.name) return;
    const previous = ui.worktrees.agents.get(agent.name);
    ui.worktrees.agents.set(agent.name, agent);
    if (ui.worktrees.cards.has(agent.name)) wtApplyCard(agent.name);
    else if (ui.sideView === "worktrees") refreshWorktrees();
    if (previous && previous.status === "running" && agent.status !== "running") {
        const label = WT_STATUS[agent.status] || agent.status;
        wtMessage(`Agent ${agent.name} : ${label}. Ouvre « Diff » pour relire sa branche ${agent.branch}.`, agent.status === "done" ? "ok" : "error");
    }
    updateWorktreeBadge();
}

function wtButton(label, title, onClick, primary) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `git-btn${primary ? " git-btn-primary" : ""}`;
    button.textContent = label;
    button.title = title;
    button.onclick = onClick;
    return button;
}

function wtCheck(label, title, parent) {
    const wrap = document.createElement("label");
    wrap.className = "git-check";
    wrap.title = title;
    const box = document.createElement("input");
    box.type = "checkbox";
    wrap.append(box, ` ${label}`);
    parent.appendChild(wrap);
    return box;
}

function renderWorktrees(items) {
    const list = $("wt-list");
    const drafts = new Map();
    for (const [name, card] of ui.worktrees.cards) {
        drafts.set(name, { prompt: card.prompt.value, yes: card.yes.checked, plan: card.plan.checked });
    }
    list.innerHTML = "";
    ui.worktrees.cards.clear();
    if (!items.length) {
        gitMessage(list, "Aucun worktree. Crée-en un ci-dessus, puis donne une demande à son agent.");
        return;
    }
    for (const item of items) {
        const name = item.name;
        if (item.agent) ui.worktrees.agents.set(name, item.agent);

        const el = document.createElement("div");
        el.className = "wt-card";

        const head = document.createElement("div");
        head.className = "wt-head";
        const title = document.createElement("span");
        title.className = "wt-name";
        title.textContent = name;
        title.title = item.path;
        const branch = document.createElement("span");
        branch.className = "wt-branch";
        branch.textContent = item.branch || (item.detached ? "(détachée)" : "");
        head.append(title, branch);

        const status = document.createElement("div");
        const prompt = document.createElement("textarea");
        prompt.className = "git-input";
        prompt.rows = 2;
        prompt.placeholder = "Demande pour l'agent de ce worktree (Ctrl/Cmd+Entrée pour lancer)";
        prompt.addEventListener("keydown", (ev) => {
            if (ev.key === "Enter" && (ev.ctrlKey || ev.metaKey)) {
                ev.preventDefault();
                wtStart(name);
            }
        });

        const options = document.createElement("div");
        options.className = "wt-options";
        const yes = wtCheck("écritures auto", "Autorise l'agent à écrire et à lancer des commandes sans confirmation (--yes). Sans cette option, il ne peut rien modifier.", options);
        const plan = wtCheck("lecture seule", "Mode plan : l'agent analyse sans rien modifier.", options);

        const output = document.createElement("pre");
        output.className = "wt-output hidden";
        const diff = document.createElement("div");
        diff.className = "wt-diff hidden";

        const card = { el, status, prompt, yes, plan, output, diff };
        card.start = wtButton("Lancer", "Lancer l'agent dans ce worktree", () => wtStart(name), true);
        card.stop = wtButton("Arrêter", "Arrêter l'agent en cours", () => wtStop(name));
        card.diffBtn = wtButton("Diff", "Afficher les modifications du worktree", () => wtToggleDiff(name));
        card.remove = wtButton("Supprimer", "Supprimer le worktree (la branche est conservée)", () => wtRemove(name));
        const actions = document.createElement("div");
        actions.className = "wt-actions";
        actions.append(card.start, card.stop, card.diffBtn, card.remove);

        const draft = drafts.get(name);
        if (draft) {
            prompt.value = draft.prompt;
            yes.checked = draft.yes;
            plan.checked = draft.plan;
        }

        el.append(head, status, prompt, options, actions, output, diff);
        list.appendChild(el);
        ui.worktrees.cards.set(name, card);
        wtApplyCard(name);
    }
}

async function refreshWorktrees() {
    if (ui.worktrees.busy) return;
    ui.worktrees.busy = true;
    try {
        const data = await api.worktreeList();
        $("wt-root").textContent = data.root ? `Dossier : ${data.root}` : "Ouvre un projet Git pour utiliser les worktrees.";
        for (const agent of data.agents || []) ui.worktrees.agents.set(agent.name, agent);
        renderWorktrees((data.worktrees || []).filter((w) => w.managed && w.name));
    } catch (error) {
        gitMessage($("wt-list"), `Worktrees indisponibles : ${gitErrorText(error)}`);
    } finally {
        ui.worktrees.busy = false;
        updateWorktreeBadge();
    }
}

async function wtCreate() {
    const nameInput = $("wt-name");
    const name = nameInput.value.trim();
    const base = $("wt-base").value.trim() || "HEAD";
    if (!name) {
        wtMessage("Donne un nom au worktree (lettres, chiffres, . _ -).", "error");
        nameInput.focus();
        return;
    }
    $("btn-wt-create").disabled = true;
    try {
        const made = await api.worktreeCreate(name, base);
        nameInput.value = "";
        wtMessage(`Worktree ${made.name} créé sur la branche ${made.branch} (depuis ${made.base}).`, "ok");
        await refreshWorktrees();
        const card = ui.worktrees.cards.get(made.name);
        if (card) card.prompt.focus();
    } catch (error) {
        wtMessage(gitErrorText(error), "error");
    } finally {
        $("btn-wt-create").disabled = false;
    }
}

async function wtStart(name) {
    const card = ui.worktrees.cards.get(name);
    if (!card) return;
    const prompt = card.prompt.value.trim();
    if (!prompt) {
        wtMessage("Écris d'abord une demande pour l'agent.", "error");
        card.prompt.focus();
        return;
    }
    try {
        const agent = await api.worktreeStart(name, prompt, { yes: card.yes.checked, readOnly: card.plan.checked });
        card.prompt.value = "";
        wtUpdateAgent(agent);
        wtMessage(`Agent lancé dans ${name} (branche ${agent.branch}).`, "ok");
    } catch (error) {
        wtMessage(gitErrorText(error), "error");
    }
}

async function wtStop(name) {
    try {
        wtUpdateAgent(await api.worktreeStop(name));
        wtMessage(`Agent ${name} arrêté.`, "ok");
    } catch (error) {
        wtMessage(gitErrorText(error), "error");
    }
}

async function wtToggleDiff(name) {
    const card = ui.worktrees.cards.get(name);
    if (!card) return;
    if (!card.diff.classList.contains("hidden")) {
        card.diff.classList.add("hidden");
        card.diff.innerHTML = "";
        return;
    }
    card.diff.classList.remove("hidden");
    card.diff.textContent = "Chargement du diff…";
    try {
        const changes = await api.worktreeChanges(name);
        card.diff.innerHTML = "";
        const status = String(changes.status || "").trim();
        const summary = document.createElement("pre");
        summary.className = "wt-output";
        summary.textContent = status || "Aucune modification non validée dans ce worktree.";
        card.diff.appendChild(summary);
        const lines = gitDiffLines(changes.diff);
        if (lines.length) {
            card.diff.appendChild(buildDiffCard({ path: `${name} (${changes.branch})`, lines, ...gitCountChanges(lines) }));
        }
    } catch (error) {
        card.diff.textContent = `Diff impossible : ${gitErrorText(error)}`;
    }
}

async function wtRemove(name) {
    if (!window.confirm(`Supprimer le worktree ${name} ?\nLa branche frst/${name} est conservée.`)) return;
    try {
        await api.worktreeRemove(name, false);
    } catch (error) {
        const reason = gitErrorText(error);
        if (!window.confirm(`Suppression refusée : ${reason}\n\nForcer la suppression ? Les modifications non validées du worktree seront perdues.`)) {
            wtMessage(reason, "error");
            return;
        }
        try {
            await api.worktreeRemove(name, true);
        } catch (forced) {
            wtMessage(gitErrorText(forced), "error");
            return;
        }
    }
    ui.worktrees.agents.delete(name);
    wtMessage(`Worktree ${name} supprimé (branche frst/${name} conservée).`, "ok");
    refreshWorktrees();
}

$("btn-wt-create").onclick = wtCreate;
$("btn-wt-refresh").onclick = refreshWorktrees;
$("wt-name").addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
        ev.preventDefault();
        wtCreate();
    }
});

api.onEvent((channel, data) => {
    if (channel === "worktreeAgent") wtUpdateAgent(data);
});
"use strict";

/* LSP (typescript-language-server) : complétion, survol et diagnostics pour les fichiers JS/TS de l'éditeur. */

const LSP_FILE_RE = /\.(?:[cm]?[jt]s|[jt]sx)$/i;
const lspDiagnosticsByPath = new Map();
let lspSyncTimer = null;
let lspWarned = false;

function lspEnabledFor(rel) {
    return Boolean(rel) && LSP_FILE_RE.test(String(rel)) && Boolean(api && api.lspSync);
}

function lspActivePath() {
    const tab = currentTab();
    return tab ? (tab.path || tab.rel || "") : "";
}

function lspWarn(err) {
    if (lspWarned) return;
    lspWarned = true;
    const detail = err && err.message ? err.message : String(err || "erreur inconnue");
    renderEntry({ type: "warn", text: `LSP indisponible : ${detail}` });
}

function lspCompletionOptions(result) {
    const items = Array.isArray(result) ? result : (result && Array.isArray(result.items) ? result.items : []);
    return items.slice(0, 300).map((item) => ({
        label: item.label,
        type: item.type || undefined,
        detail: item.detail || undefined,
        info: item.documentation || undefined,
        boost: 0,
        apply: item.insertText && item.insertText !== item.label ? item.insertText : undefined
    }));
}

function lspHoverString(result) {
    if (!result) return "";
    const raw = typeof result === "string" ? result : String(result.text || result.contents || "");
    /* Le serveur renvoie du Markdown : on retire les lignes de clôture ``` pour un affichage texte brut. */
    return raw.replace(/^```[\w-]*$\n?/gm, "");
}

function lspExtension(kind) {
    if (kind !== "js" && kind !== "ts") return [];
    const CM = window.CM;
    if (!CM || !CM.hoverTooltip || !CM.lintGutter || !CM.EditorState) return [];
    const source = async (context) => {
        const rel = lspActivePath();
        if (!lspEnabledFor(rel) || !api.lspCompletion) return null;
        const word = context.matchBefore(/[\w$]*/);
        const before = context.state.sliceDoc(Math.max(0, context.pos - 1), context.pos);
        if (!context.explicit && (!word || word.from === word.to) && before !== ".") return null;
        const line = context.state.doc.lineAt(context.pos);
        let result;
        try {
            result = await api.lspCompletion(rel, context.state.doc.toString(), line.number - 1, context.pos - line.from);
        } catch (err) {
            lspWarn(err);
            return null;
        }
        if (context.aborted) return null;
        const options = lspCompletionOptions(result);
        if (!options.length) return null;
        return { from: word ? word.from : context.pos, options, validFor: /^[\w$]*$/ };
    };
    const hover = CM.hoverTooltip(async (view, pos) => {
        const rel = lspActivePath();
        if (!lspEnabledFor(rel) || !api.lspHover) return null;
        const line = view.state.doc.lineAt(pos);
        const result = await api.lspHover(rel, view.state.doc.toString(), line.number - 1, pos - line.from).catch(() => null);
        const text = lspHoverString(result).trim();
        if (!text) return null;
        return {
            pos,
            above: true,
            create() {
                const dom = document.createElement("div");
                dom.className = "cm-lsp-hover";
                dom.style.whiteSpace = "pre-wrap";
                dom.style.maxWidth = "560px";
                dom.style.padding = "4px 8px";
                dom.style.fontFamily = "var(--mono, monospace)";
                dom.textContent = text;
                return { dom };
            }
        };
    });
    return [
        CM.EditorState.languageData.of(() => [{ autocomplete: source }]),
        hover,
        CM.lintGutter(),
        lspEditingExtension()
    ];
}

function lspApplyDiagnostics(diagnostics) {
    const CM = window.CM;
    if (!CM || !CM.setDiagnostics || !code.view) return;
    const view = code.view;
    const doc = view.state.doc;
    const toPos = (p) => {
        const lineNo = Math.max(1, Math.min(doc.lines, (Number(p && p.line) || 0) + 1));
        const line = doc.line(lineNo);
        return Math.min(line.to, line.from + Math.max(0, Number(p && p.character) || 0));
    };
    const list = (Array.isArray(diagnostics) ? diagnostics : []).map((d) => {
        const from = toPos(d.from);
        const to = Math.max(from, toPos(d.to || d.from));
        const severity = d.severity === "error" || d.severity === "warning" ? d.severity : "info";
        const origin = [d.source, d.code].filter((x) => x !== undefined && x !== null && x !== "").join(" ");
        return { from, to, severity, message: String(d.message || ""), source: origin || undefined };
    });
    try {
        view.dispatch(CM.setDiagnostics(view.state, list));
    } catch (err) {
        lspWarn(err);
    }
}

function lspSyncActive() {
    const tab = currentTab();
    const rel = lspActivePath();
    if (!tab || !lspEnabledFor(rel)) return;
    const text = typeof tab.content === "string" ? tab.content : code.value;
    Promise.resolve(api.lspSync(rel, text)).catch(lspWarn);
}

function lspScheduleSync() {
    if (!lspEnabledFor(lspActivePath())) return;
    clearTimeout(lspSyncTimer);
    lspSyncTimer = setTimeout(lspSyncActive, 400);
}

function lspOnActivate() {
    const rel = lspActivePath();
    if (!lspEnabledFor(rel)) return;
    lspSyncActive();
    lspApplyDiagnostics(lspDiagnosticsByPath.get(rel) || []);
}

function lspOnClose(rel) {
    if (!rel) return;
    lspDiagnosticsByPath.delete(rel);
    if (lspEnabledFor(rel) && api.lspClose) Promise.resolve(api.lspClose(rel)).catch(() => {});
}

/* ---------- Navigation, renommage, signature, actions de code, formatage ---------- */

function lspOffset(doc, p) {
    const lineNo = Math.max(1, Math.min(doc.lines, (Number(p && p.line) || 0) + 1));
    const line = doc.line(lineNo);
    return Math.min(line.to, line.from + Math.max(0, Number(p && p.character) || 0));
}

function lspCursor() {
    const rel = lspActivePath();
    if (!lspEnabledFor(rel) || !code.view) return null;
    const view = code.view;
    const pos = view.state.selection.main.head;
    const line = view.state.doc.lineAt(pos);
    return { rel, view, pos, text: view.state.doc.toString(), line: line.number - 1, character: pos - line.from };
}

function lspNotice(text) {
    renderEntry({ type: "warn", text });
}

function lspStatus(text) {
    const el = $("st-file");
    if (el) el.textContent = text;
}

function lspSyncTabFromEditor(tab) {
    if (!tab) return;
    tab.content = code.value;
    tab.dirty = tab.content !== tab.saved;
}

function lspLocationLabel(loc) {
    const label = `${loc.rel}:${loc.line + 1}:${loc.character + 1}`;
    const tab = ui.tabs.find((t) => t.path === loc.rel);
    const lineText = tab && typeof tab.content === "string" ? tab.content.split("\n")[loc.line] : "";
    return { label, detail: lineText ? lineText.trim().slice(0, 120) : "" };
}

/** Liste de choix modale ; renvoie l'index choisi ou null. */
function lspPick(title, items) {
    return new Promise((resolve) => {
        const overlay = document.createElement("div");
        overlay.className = "modal-overlay";
        const box = document.createElement("div");
        box.className = "modal";
        const heading = document.createElement("div");
        heading.className = "modal-title";
        heading.textContent = title;
        const list = document.createElement("div");
        list.style.maxHeight = "50vh";
        list.style.overflowY = "auto";
        list.style.display = "flex";
        list.style.flexDirection = "column";
        list.style.gap = "2px";
        const close = (result) => {
            overlay.remove();
            resolve(result);
        };
        items.forEach((item, i) => {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.style.textAlign = "left";
            btn.style.whiteSpace = "pre";
            btn.style.overflow = "hidden";
            btn.style.textOverflow = "ellipsis";
            btn.textContent = item.detail ? `${item.label}   ${item.detail}` : item.label;
            btn.title = btn.textContent;
            btn.onclick = () => close(i);
            list.appendChild(btn);
        });
        const buttons = document.createElement("div");
        buttons.className = "buttons";
        const cancel = document.createElement("button");
        cancel.type = "button";
        cancel.textContent = "Annuler";
        cancel.onclick = () => close(null);
        buttons.appendChild(cancel);
        box.append(heading, list, buttons);
        overlay.appendChild(box);
        document.body.appendChild(overlay);
        overlay.addEventListener("mousedown", (ev) => {
            if (ev.target === overlay) close(null);
        });
        overlay.addEventListener("keydown", (ev) => {
            const choices = [...list.querySelectorAll("button")];
            const index = choices.indexOf(document.activeElement);
            if (ev.key === "Escape") {
                ev.preventDefault();
                ev.stopPropagation();
                close(null);
            } else if (ev.key === "ArrowDown" && choices.length) {
                ev.preventDefault();
                choices[Math.min(choices.length - 1, index + 1)].focus();
            } else if (ev.key === "ArrowUp" && choices.length) {
                ev.preventDefault();
                choices[Math.max(0, index - 1)].focus();
            }
        });
        setTimeout(() => {
            const first = list.querySelector("button") || cancel;
            first.focus();
        }, 0);
    });
}

async function lspReveal(loc) {
    if (!loc || !loc.rel) return;
    if (lspActivePath() !== loc.rel) await openFile(loc.rel);
    if (lspActivePath() !== loc.rel || !code.view) return;
    /* activate() rétablit le défilement à l'image suivante : on place la sélection après. */
    await new Promise((resolve) => requestAnimationFrame(resolve));
    const view = code.view;
    const doc = view.state.doc;
    const anchor = lspOffset(doc, { line: loc.line, character: loc.character });
    const head = Math.max(anchor, lspOffset(doc, { line: loc.endLine, character: loc.endCharacter }));
    view.dispatch({ selection: { anchor, head }, scrollIntoView: true });
    code.focus();
}

async function lspGoToDefinition() {
    const at = lspCursor();
    if (!at) {
        lspNotice("Aller à la définition : disponible pour les fichiers JS/TS.");
        return;
    }
    let locations;
    try {
        locations = await api.lspDefinition(at.rel, at.text, at.line, at.character);
    } catch (err) {
        lspNotice(`Définition introuvable : ${err.message}`);
        return;
    }
    if (!Array.isArray(locations) || !locations.length) {
        lspStatus("Aucune définition trouvée dans le projet.");
        return;
    }
    if (locations.length === 1) {
        await lspReveal(locations[0]);
        return;
    }
    const index = await lspPick("Définitions", locations.map(lspLocationLabel));
    if (index !== null) await lspReveal(locations[index]);
}

async function lspFindReferences() {
    const at = lspCursor();
    if (!at) {
        lspNotice("Références : disponible pour les fichiers JS/TS.");
        return;
    }
    let refs;
    try {
        refs = await api.lspReferences(at.rel, at.text, at.line, at.character);
    } catch (err) {
        lspNotice(`Références introuvables : ${err.message}`);
        return;
    }
    if (!Array.isArray(refs) || !refs.length) {
        lspStatus("Aucune référence trouvée.");
        return;
    }
    const index = await lspPick(`${refs.length} référence(s)`, refs.map(lspLocationLabel));
    if (index !== null) await lspReveal(refs[index]);
}

/** Applique des TextEdit LSP à un texte (normalisé en \n). */
function lspApplyEditsToText(text, edits) {
    const source = String(text ?? "");
    const starts = [0];
    for (let i = 0; i < source.length; i++) if (source[i] === "\n") starts.push(i + 1);
    const offset = (p) => {
        const line = Math.max(0, Number(p && p.line) || 0);
        if (line >= starts.length) return source.length;
        const end = line + 1 < starts.length ? starts[line + 1] - 1 : source.length;
        return Math.min(starts[line] + Math.max(0, Number(p && p.character) || 0), end);
    };
    const sorted = edits
        .map((e, index) => ({ from: offset(e.range.start), to: offset(e.range.end), insert: String(e.newText ?? ""), index }))
        .sort((a, b) => b.from - a.from || b.index - a.index);
    let out = source;
    for (const e of sorted) out = out.slice(0, e.from) + e.insert + out.slice(Math.max(e.from, e.to));
    return out;
}

/**
 * Applique une modification multi-fichiers : onglet actif via CodeMirror (annulable),
 * autres onglets ouverts en mémoire (à enregistrer), fichiers fermés directement sur disque.
 */
async function lspApplyWorkspaceEdit(edit, expected) {
    const files = edit && Array.isArray(edit.files) ? edit.files : [];
    const failures = [];
    let changed = 0;
    for (const file of files) {
        const edits = (file.edits || []).filter((e) => e && e.range);
        if (!edits.length) continue;
        const tab = ui.tabs.find((t) => t.path === file.rel);
        try {
            if (tab && tab.path === ui.active && code.view) {
                const view = code.view;
                if (expected && file.rel === expected.rel && view.state.doc.toString() !== expected.text) {
                    throw new Error("le fichier a changé pendant la requête");
                }
                const doc = view.state.doc;
                const changes = edits
                    .map((e) => {
                        const from = lspOffset(doc, e.range.start);
                        return { from, to: Math.max(from, lspOffset(doc, e.range.end)), insert: String(e.newText ?? "") };
                    })
                    .sort((a, b) => a.from - b.from);
                view.dispatch({ changes, userEvent: "input.lsp" });
                lspSyncTabFromEditor(tab);
            } else if (tab) {
                tab.content = lspApplyEditsToText(tab.content, edits);
                tab.dirty = tab.content !== tab.saved;
                tab.cmState = null;
            } else {
                const data = await api.readFile(file.rel);
                const eol = data.content.includes("\r\n") ? "\r\n" : "\n";
                const next = lspApplyEditsToText(normalize(data.content), edits);
                await api.writeFile(file.rel, eol === "\r\n" ? next.split("\n").join("\r\n") : next);
            }
            changed++;
        } catch (err) {
            failures.push(`${file.rel} : ${err.message}`);
        }
    }
    renderTabs();
    lspScheduleSync();
    if (changed) scheduleGitRefresh();
    return { changed, failures };
}

function lspReportEdit(label, edit, result) {
    const skipped = edit && edit.skipped ? ` (${edit.skipped} modification(s) hors projet ignorée(s))` : "";
    if (result.failures.length) {
        lspNotice(`${label} : ${result.changed} fichier(s) modifié(s), échecs :\n${result.failures.join("\n")}${skipped}`);
    } else {
        lspStatus(`${label} : ${result.changed} fichier(s) modifié(s)${skipped}`);
    }
}

async function lspRenameSymbol() {
    const at = lspCursor();
    if (!at) {
        lspNotice("Renommer : disponible pour les fichiers JS/TS.");
        return;
    }
    const word = at.view.state.wordAt(at.pos);
    const current = word ? at.view.state.sliceDoc(word.from, word.to) : "";
    const name = await inputDialog("Renommer le symbole", current);
    if (!name || name === current) return;
    let edit;
    try {
        edit = await api.lspRename(at.rel, at.text, at.line, at.character, name);
    } catch (err) {
        lspNotice(`Renommage impossible : ${err.message}`);
        return;
    }
    if (!edit || !Array.isArray(edit.files) || !edit.files.length) {
        lspNotice("Renommage impossible : ce symbole ne peut pas être renommé ici.");
        return;
    }
    lspReportEdit(`Renommé en ${name}`, edit, await lspApplyWorkspaceEdit(edit, { rel: at.rel, text: at.text }));
}

async function lspShowCodeActions() {
    const at = lspCursor();
    if (!at) {
        lspNotice("Actions de code : disponibles pour les fichiers JS/TS.");
        return;
    }
    const sel = at.view.state.selection.main;
    const doc = at.view.state.doc;
    const a = doc.lineAt(sel.from);
    const b = doc.lineAt(sel.to);
    let actions;
    try {
        actions = await api.lspCodeActions(at.rel, at.text, {
            fromLine: a.number - 1,
            fromChar: sel.from - a.from,
            toLine: b.number - 1,
            toChar: sel.to - b.from
        });
    } catch (err) {
        lspNotice(`Actions de code indisponibles : ${err.message}`);
        return;
    }
    if (!Array.isArray(actions) || !actions.length) {
        lspStatus("Aucune action de code disponible ici.");
        return;
    }
    actions = [...actions].sort((x, y) => Number(Boolean(y.preferred)) - Number(Boolean(x.preferred)));
    const index = await lspPick("Actions de code", actions.map((x) => ({ label: (x.preferred ? "★ " : "") + x.title, detail: x.kind })));
    if (index === null) return;
    const chosen = actions[index];
    lspReportEdit(chosen.title, chosen.edit, await lspApplyWorkspaceEdit(chosen.edit, { rel: at.rel, text: at.text }));
}

async function lspFormatDocument() {
    const at = lspCursor();
    if (!at) {
        lspNotice("Formatage : disponible pour les fichiers JS/TS.");
        return;
    }
    const CM = window.CM;
    const unit = CM && CM.indentUnit ? at.view.state.facet(CM.indentUnit) : "    ";
    const tabSize = unit === "\t" ? 4 : unit.length || 4;
    let result;
    try {
        result = await api.lspFormat(at.rel, at.text, tabSize);
    } catch (err) {
        lspNotice(`Formatage impossible : ${err.message}`);
        return;
    }
    if (!result || !result.changed || result.text === at.text) {
        lspStatus(`${at.rel} : déjà formaté`);
        return;
    }
    const view = code.view;
    if (lspActivePath() !== at.rel || !view || view.state.doc.toString() !== at.text) {
        lspNotice("Formatage annulé : le fichier a changé pendant la requête.");
        return;
    }
    const before = at.text;
    const after = String(result.text);
    let start = 0;
    while (start < before.length && start < after.length && before[start] === after[start]) start++;
    let endA = before.length;
    let endB = after.length;
    while (endA > start && endB > start && before[endA - 1] === after[endB - 1]) {
        endA--;
        endB--;
    }
    view.dispatch({ changes: { from: start, to: endA, insert: after.slice(start, endB) }, userEvent: "input.format" });
    lspSyncTabFromEditor(currentTab());
    renderTabs();
    lspScheduleSync();
}

/* Aide à la signature : champ d'état + infobulle (créés à la demande, window.CM étant chargé avant). */
function lspSignatureState() {
    if (lspSignatureState.cache) return lspSignatureState.cache;
    const CM = window.CM;
    if (!CM || !CM.StateField || !CM.StateEffect || !CM.showTooltip) return null;
    const set = CM.StateEffect.define();
    const field = CM.StateField.define({
        create: () => null,
        update(value, tr) {
            for (const e of tr.effects) if (e.is(set)) return e.value;
            if (!value) return value;
            let next = value;
            if (tr.docChanged) next = { ...value, pos: tr.changes.mapPos(value.pos) };
            if (tr.selection) {
                const doc = tr.state.doc;
                const head = tr.state.selection.main.head;
                if (doc.lineAt(head).number !== doc.lineAt(Math.min(next.pos, doc.length)).number) return null;
            }
            return next;
        },
        provide: (f) => CM.showTooltip.from(f)
    });
    lspSignatureState.cache = { set, field };
    return lspSignatureState.cache;
}

function lspSignatureTooltip(pos, sig) {
    return {
        pos,
        above: true,
        create() {
            const dom = document.createElement("div");
            dom.className = "cm-lsp-signature";
            dom.style.maxWidth = "560px";
            dom.style.padding = "4px 8px";
            dom.style.fontFamily = "var(--mono, monospace)";
            dom.style.whiteSpace = "pre-wrap";
            const head = document.createElement("div");
            const param = sig.parameters && sig.parameters[sig.activeParameter];
            if (param && param.to > param.from) {
                const strong = document.createElement("b");
                strong.textContent = sig.label.slice(param.from, param.to);
                strong.style.textDecoration = "underline";
                head.append(sig.label.slice(0, param.from), strong, sig.label.slice(param.to));
            } else {
                head.textContent = sig.label;
            }
            if (sig.count > 1) head.append(`  (${sig.index + 1}/${sig.count})`);
            dom.appendChild(head);
            if (sig.documentation) {
                const doc = document.createElement("div");
                doc.style.opacity = "0.8";
                doc.style.marginTop = "4px";
                doc.textContent = sig.documentation;
                dom.appendChild(doc);
            }
            return { dom };
        }
    };
}

function lspCloseSignature(view) {
    const parts = lspSignatureState();
    if (!parts || !view || !view.state.field(parts.field, false)) return false;
    view.dispatch({ effects: parts.set.of(null) });
    return true;
}

async function lspShowSignature(view = code.view, explicit = true) {
    const parts = lspSignatureState();
    const rel = lspActivePath();
    if (!parts || !view || !lspEnabledFor(rel) || !api.lspSignatureHelp) return;
    const pos = view.state.selection.main.head;
    const line = view.state.doc.lineAt(pos);
    const text = view.state.doc.toString();
    let sig = null;
    try {
        sig = await api.lspSignatureHelp(rel, text, line.number - 1, pos - line.from);
    } catch (err) {
        if (explicit) lspNotice(`Aide à la signature indisponible : ${err.message}`);
    }
    if (lspActivePath() !== rel || view.state.doc.toString() !== text) return;
    if (!sig) {
        lspCloseSignature(view);
        if (explicit) lspStatus("Aucune signature à afficher ici.");
        return;
    }
    view.dispatch({ effects: parts.set.of(lspSignatureTooltip(pos, sig)) });
}

/** Raccourcis LSP (fichiers JS/TS) et déclenchement automatique de l'aide à la signature. */
function lspEditingExtension() {
    const CM = window.CM;
    if (!CM || !CM.keymap || !CM.Prec || !CM.EditorView) return [];
    const parts = lspSignatureState();
    const run = (fn) => () => {
        Promise.resolve()
            .then(fn)
            .catch((err) => lspNotice(`LSP : ${err && err.message ? err.message : err}`));
        return true;
    };
    const keys = CM.Prec.high(CM.keymap.of([
        { key: "F12", run: run(lspGoToDefinition) },
        { key: "Shift-F12", run: run(lspFindReferences) },
        { key: "F2", run: run(lspRenameSymbol) },
        { key: "Ctrl-Shift-Space", run: run(() => lspShowSignature(code.view, true)) },
        { key: "Mod-.", run: run(lspShowCodeActions) },
        { key: "Shift-Alt-f", run: run(lspFormatDocument) },
        { key: "Escape", run: (view) => lspCloseSignature(view) }
    ]));
    const trigger = CM.EditorView.updateListener.of((update) => {
        if (!update.docChanged || !parts) return;
        const head = update.state.selection.main.head;
        const before = update.state.sliceDoc(Math.max(0, head - 1), head);
        const open = Boolean(update.state.field(parts.field, false));
        clearTimeout(lspShowSignature.timer);
        if (before === ")" && open) {
            lspShowSignature.timer = setTimeout(() => lspCloseSignature(update.view), 0);
        } else if (before === "(" || before === "," || open) {
            lspShowSignature.timer = setTimeout(() => lspShowSignature(update.view, false), 150);
        }
    });
    return parts ? [keys, parts.field, trigger] : [keys];
}

code.addEventListener("input", lspScheduleSync);

api.onEvent((channel, data) => {
    if (channel !== "lspDiagnostics" || !data || !data.path) return;
    const diagnostics = Array.isArray(data.diagnostics) ? data.diagnostics : [];
    lspDiagnosticsByPath.set(data.path, diagnostics);
    if (data.path === lspActivePath()) lspApplyDiagnostics(diagnostics);
});
"use strict";

/*
 * Modification IA de la sélection (style Cmd+K) : Ctrl/Cmd+K ouvre une consigne, l'IA réécrit la
 * sélection (ou la ligne courante si rien n'est sélectionné), puis un diff permet d'accepter ou de rejeter.
 * inlineEditExtension est appelée par createCodeEditor (00-base) avant l'exécution de ce module :
 * elle ne doit donc utiliser aucune constante de haut niveau de ce fichier.
 */

function inlineEditExtension() {
    const CM = window.CM;
    if (!CM || !CM.keymap || !CM.Prec) return [];
    return CM.Prec.highest(CM.keymap.of([
        {
            key: "Mod-k",
            run: () => {
                inlineEditStart().catch((err) => renderEntry({ type: "error", text: `Modification IA : ${err.message}` }));
                return true;
            }
        }
    ]));
}

function inlineEditRange(view) {
    const sel = view.state.selection.main;
    if (!sel.empty) return { from: sel.from, to: sel.to };
    const line = view.state.doc.lineAt(sel.head);
    return { from: line.from, to: line.to };
}

/** Modale de diff : renvoie true (accepter) ou false (rejeter). */
function inlineEditReview(title, before, after) {
    return new Promise((resolve) => {
        const overlay = document.createElement("div");
        overlay.className = "modal-overlay";
        const box = document.createElement("div");
        box.className = "modal";
        box.style.width = "900px";
        box.style.maxWidth = "90vw";
        const heading = document.createElement("div");
        heading.className = "modal-title";
        heading.textContent = title;
        const diff = document.createElement("div");
        diff.className = "inline-edit-diff";
        diff.style.maxHeight = "60vh";
        diff.style.overflow = "auto";
        diff.style.fontFamily = "var(--mono, monospace)";
        diff.style.fontSize = "12px";
        diff.style.whiteSpace = "pre";
        for (const op of undoLineDiff(before, after, 1000000)) {
            const row = document.createElement("div");
            row.className = "diff-line" + (op.t === "+" ? " add" : op.t === "-" ? " del" : "");
            if (op.t === "+") row.style.background = "rgba(46, 160, 67, 0.25)";
            if (op.t === "-") row.style.background = "rgba(248, 81, 73, 0.25)";
            row.textContent = `${op.t} ${op.s}`;
            diff.appendChild(row);
        }
        const buttons = document.createElement("div");
        buttons.className = "buttons";
        const accept = document.createElement("button");
        accept.type = "button";
        accept.className = "primary undo-btn accept";
        accept.textContent = "Accepter";
        const reject = document.createElement("button");
        reject.type = "button";
        reject.className = "undo-btn reject";
        reject.textContent = "Rejeter";
        buttons.append(accept, reject);
        box.append(heading, diff, buttons);
        overlay.appendChild(box);
        document.body.appendChild(overlay);
        const close = (result) => {
            overlay.remove();
            resolve(result);
        };
        accept.onclick = () => close(true);
        reject.onclick = () => close(false);
        overlay.addEventListener("mousedown", (ev) => {
            if (ev.target === overlay) close(false);
        });
        overlay.addEventListener("keydown", (ev) => {
            if (ev.key === "Escape") {
                ev.preventDefault();
                ev.stopPropagation();
                close(false);
            } else if (ev.key === "Enter" && (ev.metaKey || ev.ctrlKey)) {
                ev.preventDefault();
                close(true);
            }
        });
        setTimeout(() => accept.focus(), 0);
    });
}

async function inlineEditStart() {
    const tab = currentTab();
    const view = code.view;
    if (!tab || !view) {
        renderEntry({ type: "warn", text: "Modification IA : ouvre d'abord un fichier." });
        return;
    }
    if (!api.inlineEdit) {
        renderEntry({ type: "warn", text: "Modification IA indisponible dans cette version." });
        return;
    }
    const { from, to } = inlineEditRange(view);
    const doc = view.state.doc;
    const selection = doc.sliceString(from, to);
    const instruction = await inputDialog(
        selection.trim() ? "Modifier la sélection avec l'IA : consigne" : "Générer du code ici avec l'IA : consigne"
    );
    if (!instruction) return;
    const rel = tab.path;
    $("st-file").textContent = `${rel} — modification IA en cours…`;
    let result;
    try {
        result = await api.inlineEdit({
            path: rel,
            language: extKind(rel),
            instruction,
            selection,
            prefix: doc.sliceString(Math.max(0, from - 3000), from),
            suffix: doc.sliceString(to, Math.min(doc.length, to + 1500))
        });
    } catch (err) {
        $("st-file").textContent = rel;
        renderEntry({ type: "error", text: `Modification IA : ${err.message}` });
        return;
    }
    $("st-file").textContent = rel;
    const replacement = String(result ?? "");
    if (replacement === selection) {
        renderEntry({ type: "warn", text: "Modification IA : aucune modification proposée." });
        return;
    }
    const accepted = await inlineEditReview(`Modification IA — ${rel}`, selection, replacement);
    if (!accepted) return;
    if (currentTab() !== tab || code.view !== view || view.state.doc.sliceString(from, to) !== selection) {
        renderEntry({ type: "warn", text: "Modification IA annulée : le fichier a changé entre-temps." });
        return;
    }
    view.dispatch({
        changes: { from, to, insert: replacement },
        selection: { anchor: from, head: from + replacement.length },
        userEvent: "input.ai"
    });
    code.focus();
}
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
/* ---------- Connexion guidée et guide de démarrage (porté de 21-onboarding) ----------
 * Les identifiants sont saisis dans une fenêtre dédiée, jamais dans le chat.
 * main.js réutilise loginWithPassword : seul le cookie de session est enregistré.
 */
const GUIDE_ORIGIN = "https://ia.francestudent.org";
const GUIDE_SEEN_KEY = "frst.guide-seen";
const guideState = { step: 1, busy: false, returnFocus: null };

function buildConnectionGuide() {
    if ($("connection-guide")) return;
    const wrap = document.createElement("div");
    wrap.id = "connection-guide";
    wrap.className = "guide-overlay hidden";
    wrap.setAttribute("role", "dialog");
    wrap.setAttribute("aria-modal", "true");
    wrap.setAttribute("aria-labelledby", "guide-title");
    wrap.innerHTML = `
<div class="guide-card">
  <button type="button" id="guide-close" class="guide-close" aria-label="Fermer le guide">✕</button>
  <ol class="guide-steps">
    <li data-guide-step="1">Connexion</li>
    <li data-guide-step="2">Projet</li>
    <li data-guide-step="3">Première demande</li>
  </ol>
  <h2 id="guide-title"></h2>
  <p id="guide-description" class="guide-description"></p>
  <section data-guide-page="1">
    <form id="guide-login-form" autocomplete="on">
      <label class="guide-field">Adresse e-mail
        <input type="email" id="guide-email" required autocomplete="username" spellcheck="false">
      </label>
      <label class="guide-field">Mot de passe
        <span class="guide-password-row">
          <input type="password" id="guide-password" required autocomplete="current-password">
          <button type="button" id="guide-show-password" aria-pressed="false" aria-label="Afficher le mot de passe">Afficher</button>
        </span>
      </label>
      <div class="guide-actions">
        <button type="submit" id="guide-login-submit" class="guide-primary">Se connecter</button>
        <button type="button" id="guide-open-site">Ouvrir le site FranceStudent</button>
      </div>
      <p class="guide-note">Ton mot de passe n'est jamais enregistré : seul le cookie de session est conservé sur cet ordinateur.</p>
    </form>
    <div id="guide-already-connected" class="hidden">
      <p>Tu es déjà connecté à FranceStudent.</p>
      <div class="guide-actions">
        <button type="button" id="guide-to-project" class="guide-primary">Continuer</button>
        <button type="button" id="guide-open-account">Gérer mon compte</button>
      </div>
    </div>
  </section>
  <section data-guide-page="2" class="hidden">
    <p id="guide-project-name"></p>
    <div class="guide-actions">
      <button type="button" id="guide-pick-project" class="guide-primary">Ouvrir un dossier</button>
      <button type="button" id="guide-project-next">Continuer</button>
      <button type="button" id="guide-skip-project">Plus tard</button>
    </div>
  </section>
  <section data-guide-page="3" class="hidden">
    <ul class="guide-tips">
      <li>Écris ta demande en français dans la zone du bas ; tape / pour voir les commandes.</li>
      <li>Les modifications de fichiers te sont présentées avant d'être appliquées.</li>
      <li>Tu peux envoyer d'autres messages pendant que l'agent travaille : ils sont mis en file.</li>
    </ul>
    <div class="guide-actions">
      <button type="button" id="guide-first-prompt" class="guide-primary">Préparer une première demande</button>
      <button type="button" id="guide-show-help">Voir l'aide (/help)</button>
      <button type="button" id="guide-finish">Terminer</button>
    </div>
  </section>
  <p id="guide-message" class="guide-message" role="status" aria-live="polite"></p>
</div>`;
    document.body.appendChild(wrap);
}

function buildGuideSettingsButtons() {
    const anchor = $("settings-message");
    if (!anchor || $("settings-guide")) return;
    const row = document.createElement("div");
    row.className = "ext-section guide-settings";
    row.innerHTML = `<div class="ext-section-head"><span>Compte FranceStudent</span></div>
<div class="guide-actions">
  <button type="button" id="settings-guide">Connexion et guide</button>
  <button type="button" id="settings-logout">Se déconnecter</button>
</div>`;
    anchor.parentNode.insertBefore(row, anchor);
}

function guideBooted() {
    return Boolean(ui.status && ui.status.booted);
}

function guideMessage(text, isError = false) {
    $("guide-message").textContent = text;
    $("guide-message").classList.toggle("is-error", Boolean(isError));
}

function openConnectionGuide(step) {
    guideState.returnFocus = document.activeElement;
    $("connection-guide").classList.remove("hidden");
    setGuideStep(step || (guideBooted() ? (ui.workspace ? 3 : 2) : 1));
    try { localStorage.setItem(GUIDE_SEEN_KEY, "1"); } catch { /* stockage indisponible */ }
    setTimeout(() => {
        if (guideState.step === 1 && !guideBooted()) { $("guide-email").focus(); return; }
        const first = $("connection-guide").querySelector("section:not(.hidden) button:not(:disabled), section:not(.hidden) input:not(:disabled)");
        if (first) first.focus();
    }, 0);
}

function closeConnectionGuide() {
    if (guideState.busy) return;
    $("guide-password").value = "";
    $("connection-guide").classList.add("hidden");
    if (guideState.returnFocus && guideState.returnFocus.isConnected) guideState.returnFocus.focus();
    else input.focus();
}

function setGuideStep(step) {
    guideState.step = [1, 2, 3].includes(step) ? step : 1;
    for (const page of document.querySelectorAll("[data-guide-page]")) {
        page.classList.toggle("hidden", Number(page.dataset.guidePage) !== guideState.step);
    }
    for (const marker of document.querySelectorAll("[data-guide-step]")) {
        const n = Number(marker.dataset.guideStep);
        marker.classList.toggle("current", n === guideState.step);
        marker.classList.toggle("done", n < guideState.step);
        if (n === guideState.step) marker.setAttribute("aria-current", "step");
        else marker.removeAttribute("aria-current");
    }
    $("guide-title").textContent = ["", "Bienvenue. On commence ?", "Ouvre le bon dossier", "Ta première demande"][guideState.step];
    $("guide-description").textContent = [
        "",
        "Connecte-toi avec les mêmes identifiants que sur le site FranceStudent.",
        "Pas besoin de configuration technique : choisis simplement le dossier de ton projet.",
        "L'agent comprend tes demandes en français. Tu peux préciser ou corriger ce que tu veux au fil du travail."
    ][guideState.step];
    $("guide-login-form").classList.toggle("hidden", guideBooted());
    $("guide-already-connected").classList.toggle("hidden", !guideBooted());
    $("guide-project-name").textContent = ui.workspace
        ? `Dossier choisi : ${ui.workspace.replace(/[\\/]+$/, "").split(/[\\/]/).pop()}`
        : "Tu pourras aussi ouvrir un dossier plus tard depuis l'explorateur.";
    $("guide-project-next").disabled = !ui.workspace;
    guideMessage("");
}

function guideError(error) {
    const message = String((error && error.message) || error || "Connexion impossible.");
    const special = /captcha|double authentification|two.factor|2fa|cloudflare/i.test(message);
    guideMessage(special
        ? "Ton compte demande une vérification supplémentaire que cette connexion ne prend pas encore en charge. Ouvre le site FranceStudent pour vérifier ton accès."
        : /password|mot de passe|identifiant|invalid|incorrect|401|403/i.test(message)
            ? "Connexion refusée. Vérifie l'adresse e-mail et le mot de passe de ton compte FranceStudent."
            : `La connexion n'a pas abouti (${message}). Vérifie tes identifiants et ta connexion Internet, puis réessaie.`, true);
}

function setGuideControlsDisabled(disabled) {
    for (const control of $("connection-guide").querySelectorAll("input, button")) control.disabled = disabled;
}

buildConnectionGuide();
buildGuideSettingsButtons();

$("guide-login-form").onsubmit = async (event) => {
    event.preventDefault();
    if (guideState.busy || !$("guide-login-form").reportValidity()) return;
    guideState.busy = true;
    guideMessage("Connexion à FranceStudent…");
    $("guide-login-submit").textContent = "Connexion…";
    $("guide-login-form").setAttribute("aria-busy", "true");
    setGuideControlsDisabled(true);
    try {
        const result = await api.loginAccount({ email: $("guide-email").value.trim(), password: $("guide-password").value });
        if (!result || !result.ok) throw new Error((result && result.reason) || "Connexion impossible.");
        applyStatus(await api.status());
        if (typeof refreshQuota === "function") refreshQuota();
        setGuideStep(2);
        guideMessage("Connecté. Ton mot de passe n'a pas été enregistré.");
    } catch (error) {
        guideError(error);
    } finally {
        $("guide-password").value = "";
        guideState.busy = false;
        setGuideControlsDisabled(false);
        $("guide-project-next").disabled = !ui.workspace;
        $("guide-login-submit").textContent = "Se connecter";
        $("guide-login-form").removeAttribute("aria-busy");
    }
};

$("guide-close").onclick = closeConnectionGuide;
$("guide-finish").onclick = closeConnectionGuide;
$("guide-to-project").onclick = () => setGuideStep(2);
$("guide-skip-project").onclick = () => setGuideStep(3);
$("guide-project-next").onclick = () => setGuideStep(3);
$("guide-open-site").onclick = () => api.openExternal(GUIDE_ORIGIN).catch(guideError);
$("guide-open-account").onclick = () => api.openExternal(GUIDE_ORIGIN).catch(guideError);
$("guide-show-help").onclick = () => {
    closeConnectionGuide();
    send("/help");
};
$("guide-show-password").onclick = () => {
    const reveal = $("guide-password").type === "password";
    $("guide-password").type = reveal ? "text" : "password";
    $("guide-show-password").textContent = reveal ? "Masquer" : "Afficher";
    $("guide-show-password").setAttribute("aria-pressed", String(reveal));
    $("guide-show-password").setAttribute("aria-label", reveal ? "Masquer le mot de passe" : "Afficher le mot de passe");
};
$("guide-pick-project").onclick = async () => {
    try {
        await api.openProject();
        applyStatus(await api.status());
        setGuideStep(2);
    } catch (error) {
        guideMessage(error.message, true);
    }
};
$("guide-first-prompt").onclick = () => {
    closeConnectionGuide();
    if (typeof setAgentTab === "function") setAgentTab("conversation");
    input.value = ui.workspace
        ? "Explore ce projet et explique-moi comment le lancer et le vérifier."
        : "Explique-moi comment tu peux m'aider et comment démarrer mon premier projet.";
    if (typeof saveStudioDraft === "function") saveStudioDraft();
    autosizeInput();
    input.focus();
};

$("settings-guide").onclick = () => openConnectionGuide();
$("settings-logout").onclick = async () => {
    $("settings-logout").disabled = true;
    $("settings-message").textContent = "Déconnexion…";
    try {
        await api.logoutAccount();
        $("settings-message").textContent = "Déconnecté : session locale effacée.";
    } catch (error) {
        $("settings-message").textContent = `Déconnexion non terminée : ${error.message}`;
        try { applyStatus(await api.status()); } catch { /* statut indisponible */ }
    } finally {
        $("settings-logout").disabled = false;
    }
};

// Le bouton d'aide ouvre le guide ; /help reste accessible depuis le guide et par la commande.
$("btn-help").onclick = () => openConnectionGuide();
$("btn-help").title = "Connexion et guide de démarrage";

api.onEvent(async (channel) => {
    if (channel !== "signedOut") return;
    try { applyStatus(await api.status()); } catch { /* statut indisponible */ }
    ui.quota = null;
    renderQuota();
    $("guide-email").value = "";
    $("guide-password").value = "";
    $("guide-password").type = "password";
    $("guide-show-password").textContent = "Afficher";
    $("guide-show-password").setAttribute("aria-pressed", "false");
    $("guide-show-password").setAttribute("aria-label", "Afficher le mot de passe");
    if (typeof showSideView === "function") showSideView("explorer");
    openConnectionGuide(1);
    guideMessage("Tu es déconnecté de cet ordinateur. Tu peux te reconnecter ou utiliser un autre compte.");
});

$("connection-guide").addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); closeConnectionGuide(); return; }
    if (event.key !== "Tab") return;
    const controls = [...$("connection-guide").querySelectorAll("button:not(:disabled), input:not(:disabled)")]
        .filter((element) => element.offsetParent !== null);
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); if (last) last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); if (first) first.focus(); }
});

/** Appelé par 99-boot après le bootstrap : guide ouvert si aucune session, ou au premier lancement. */
function maybeOpenConnectionGuide() {
    let seen = false;
    try { seen = localStorage.getItem(GUIDE_SEEN_KEY) === "1"; } catch { /* stockage indisponible */ }
    if (!guideBooted() || !seen) openConnectionGuide();
}
// 22-extension-center.js — centre d'extensions : édition, import et suppression de skills,
// activation et retrait des serveurs MCP.
// Portage adapté de extraopaa/francestudents-ide : la vue Extensions locale (12-sidebar.js)
// est conservée ; ce module l'enrichit au lieu de la remplacer. API : api.extensionAction.

function centerNode(tag, className = "", text = "") {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
}

function centerButton(label, handler, primary = false) {
    const button = centerNode("button", primary ? "primary" : "", label);
    button.type = "button";
    button.onclick = async (event) => {
        event.stopPropagation();
        button.disabled = true;
        try {
            await handler(event);
        } catch (error) {
            if (typeof lspStatus === "function") lspStatus(error.message || String(error));
        } finally {
            button.disabled = false;
        }
    };
    return button;
}

/* ---------- Boîte d'édition / import d'un skill ---------- */

document.body.insertAdjacentHTML("beforeend", `<dialog id="skill-editor" class="center-dialog" aria-labelledby="skill-editor-title"><form id="skill-editor-form"><div class="center-dialog-head"><h2 id="skill-editor-title">Skill</h2><button type="button" id="skill-editor-close" aria-label="Fermer">×</button></div><div class="center-filters"><input id="skill-editor-name" maxlength="64" placeholder="nom-du-skill" spellcheck="false" aria-label="Nom du skill"><select id="skill-editor-scope" aria-label="Portée"><option value="utilisateur">Utilisateur</option><option value="projet">Projet</option></select></div><label class="center-code-label">SKILL.md<textarea id="skill-editor-content" rows="18" spellcheck="false" maxlength="200000"></textarea></label><p id="skill-editor-message" class="studio-message" role="status"></p><div class="center-dialog-actions"><button type="button" id="skill-editor-cancel">Annuler</button><button type="submit" id="skill-editor-save" class="primary">Enregistrer</button></div></form></dialog>`);

let skillEditorMode = null;

function skillTemplate(name) {
    return `---\nname: ${name || "mon-skill"}\ndescription: Quand utiliser ce skill.\n---\n\n# ${name || "Mon skill"}\n\nInstructions pour l'agent.\n`;
}

async function openSkillEditor(mode, name = "") {
    skillEditorMode = { mode, name };
    $("skill-editor-message").textContent = "";
    $("skill-editor-name").disabled = mode === "edit";
    $("skill-editor-scope").disabled = mode === "edit";
    $("skill-editor-title").textContent = mode === "edit" ? `Modifier le skill ${name}` : "Importer un skill";
    if (mode === "edit") {
        const data = await api.extensionAction("read", { name });
        $("skill-editor-name").value = data.name;
        $("skill-editor-scope").value = data.scope;
        $("skill-editor-content").value = data.content;
    } else {
        $("skill-editor-name").value = "";
        $("skill-editor-scope").value = "utilisateur";
        $("skill-editor-content").value = skillTemplate("");
    }
    $("skill-editor").showModal();
    (mode === "edit" ? $("skill-editor-content") : $("skill-editor-name")).focus();
}

$("skill-editor-close").onclick = () => $("skill-editor").close();
$("skill-editor-cancel").onclick = () => $("skill-editor").close();
$("skill-editor-form").onsubmit = async (event) => {
    event.preventDefault();
    const state = skillEditorMode;
    if (!state) return;
    const content = $("skill-editor-content").value;
    $("skill-editor-save").disabled = true;
    try {
        if (state.mode === "edit") {
            await api.extensionAction("save", { name: state.name, content });
        } else {
            const name = $("skill-editor-name").value.trim();
            if (!name) throw new Error("Donne un nom au skill.");
            await api.extensionAction("import", { name, content, scope: $("skill-editor-scope").value });
        }
        $("skill-editor").close();
        await refreshSkills();
    } catch (error) {
        $("skill-editor-message").textContent = error.message;
    } finally {
        $("skill-editor-save").disabled = false;
    }
};

/* ---------- Actions ajoutées aux listes de la vue Extensions ---------- */

function centerItemActions(item, buttons) {
    if (item.dataset.centerDecorated) return;
    item.dataset.centerDecorated = "1";
    const bar = centerNode("div", "center-item-actions");
    bar.append(...buttons);
    item.appendChild(bar);
}

function decorateSkills() {
    for (const item of $("skills-list").querySelectorAll(".ext-item")) {
        const name = item.querySelector(".ext-item-name")?.textContent;
        if (!name) continue;
        centerItemActions(item, [
            centerButton("Modifier", () => openSkillEditor("edit", name)),
            centerButton("Supprimer", async () => {
                if (!window.confirm(`Supprimer définitivement le skill « ${name} » et son dossier ?`)) return;
                await api.extensionAction("remove", { name });
                await refreshSkills();
            })
        ]);
    }
}

function decorateMcp() {
    for (const item of $("mcp-list").querySelectorAll(".ext-item")) {
        const name = item.querySelector(".ext-item-name")?.textContent;
        if (!name) continue;
        const disabled = item.querySelector(".ext-tag")?.textContent === "disabled";
        const mcpAction = async (action, payload) => {
            await api.extensionAction(action, payload);
            await refreshMcp();
        };
        centerItemActions(item, [
            centerButton(disabled ? "Activer" : "Désactiver", () => mcpAction("mcp-toggle", { name, disabled: !disabled })),
            centerButton("Retirer", async () => {
                if (!window.confirm(`Retirer le serveur MCP « ${name} » de mcp.json ?`)) return;
                await mcpAction("mcp-remove", { name });
            })
        ]);
    }
}

new MutationObserver(decorateSkills).observe($("skills-list"), { childList: true });
new MutationObserver(decorateMcp).observe($("mcp-list"), { childList: true });

const skillImportButton = centerNode("button", "", "Importer");
skillImportButton.type = "button";
skillImportButton.id = "btn-skill-import";
skillImportButton.title = "Créer un skill à partir d'un contenu SKILL.md";
skillImportButton.onclick = () => openSkillEditor("import").catch((error) => lspStatus(error.message));
$("btn-skill-dir")?.parentElement?.prepend(skillImportButton);
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
/* ---------- Navigation par symboles (Ctrl+Maj+O) ---------- */
/* Portage autonome du module 25-symbols du dépôt extraopaa : extraction locale par expressions régulières,
   sans IPC documentSymbols. Réutilise lspPick, lspStatus (18-lsp.js) et goToLine (13-editor-tools.js). */

const SYMBOL_NAV_LANGS = [
    {
        test: /\.(md|markdown)$/i,
        fences: true,
        rules: [{ re: /^(#{1,6})\s+(.+?)\s*#*\s*$/, kind: "titre", depth: (m) => m[1].length - 1, name: (m) => m[2] }]
    },
    {
        test: /\.(?:[cm]?[jt]s|[jt]sx)$/i,
        rules: [
            { re: /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([\w$]+)/, kind: "fonction" },
            { re: /^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([\w$]+)/, kind: "classe" },
            { re: /^\s*(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*=>|[\w$]+\s*=>)/, kind: "fonction" },
            { re: /^\s*(?:export\s+)?(?:interface|type|enum)\s+([\w$]+)/, kind: "type" },
            { re: /^\s+(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?([\w$]+)\s*\([^)]*\)\s*\{\s*$/, kind: "méthode", depth: () => 1, skip: /^(if|for|while|switch|catch|function|return|else)$/ }
        ]
    },
    {
        test: /\.py$/i,
        rules: [
            { re: /^(\s*)(?:async\s+)?def\s+(\w+)/, kind: "fonction", depth: (m) => Math.floor(m[1].length / 4), name: (m) => m[2] },
            { re: /^(\s*)class\s+(\w+)/, kind: "classe", depth: (m) => Math.floor(m[1].length / 4), name: (m) => m[2] }
        ]
    },
    {
        test: /\.(css|scss|less)$/i,
        rules: [
            { re: /^\s*(@(?:media|supports|keyframes|layer)[^{]*)\{/, kind: "règle @" },
            { re: /^([^\s{}@\/][^{}]*?)\s*\{\s*$/, kind: "sélecteur" }
        ]
    },
    {
        test: /\.html?$/i,
        rules: [
            { re: /<(h[1-6])[^>]*>([^<]+)/i, kind: "titre", depth: (m) => Number(m[1][1]) - 1, name: (m) => m[2] },
            { re: /\bid="([^"]+)"/, kind: "id", depth: () => 1 }
        ]
    }
];

function symbolNavExtract(path, text) {
    const lang = SYMBOL_NAV_LANGS.find((l) => l.test.test(path));
    if (!lang) return null;
    const items = [];
    let inFence = false;
    String(text).split("\n").forEach((line, index) => {
        if (lang.fences && /^\s*(```|~~~)/.test(line)) {
            inFence = !inFence;
            return;
        }
        if (inFence) return;
        for (const rule of lang.rules) {
            const m = rule.re.exec(line);
            if (!m) continue;
            const name = String(rule.name ? rule.name(m) : m[1]).trim();
            if (!name || (rule.skip && rule.skip.test(name))) continue;
            items.push({ name, kind: rule.kind, line: index + 1, depth: rule.depth ? rule.depth(m) : 0 });
            break;
        }
    });
    return items.slice(0, 800);
}

async function openSymbolNav() {
    const tab = currentTab();
    if (!tab) {
        lspStatus("Ouvre un document pour afficher ses symboles.");
        return;
    }
    const path = tab.path || tab.rel || "";
    const items = symbolNavExtract(path, code.value);
    if (items === null) {
        lspStatus("Symboles disponibles pour JS/TS, Markdown, Python, CSS et HTML.");
        return;
    }
    if (!items.length) {
        lspStatus("Aucun symbole repéré dans ce document.");
        return;
    }
    const index = await lspPick(
        `Symboles · ${path} (${items.length})`,
        items.map((it) => ({ label: `${"  ".repeat(Math.max(0, Math.min(6, it.depth)))}${it.name}`, detail: `${it.kind} · L${it.line}` }))
    );
    if (index !== null && currentTab() === tab) goToLine(items[index].line);
}

window.addEventListener("keydown", (ev) => {
    if (!(ev.ctrlKey || ev.metaKey) || !ev.shiftKey || ev.altKey || String(ev.key).toLowerCase() !== "o") return;
    if (document.querySelector(".modal-overlay") || !$("palette").classList.contains("hidden")) return;
    ev.preventDefault();
    ev.stopImmediatePropagation();
    openSymbolNav();
}, true);
// 26-research-assets-updates.js — recherche Internet en arrière-plan dans le cockpit du projet.
// Portage adapté de extraopaa/francestudents-ide. API : api.webResearch (list, start, cancel).
// Les mises à jour sont déjà gérées par la section « Import et mises à jour » des paramètres
// (12-sidebar.js, api.checkUpdates) : pas de carte en double. L'aperçu des fichiers binaires,
// la capture de page et la mise à jour automatique ne sont pas portés (API absentes en local).

const researchState = { jobs: [], timer: null };

(() => {
    const tabs = document.querySelector("#project-studio .studio-tabs");
    const body = document.querySelector("#project-studio .studio-body");
    if (!tabs || !body) return;
    const tab = centerNode("button", "", "Internet");
    tab.type = "button";
    tab.dataset.studioTab = "research";
    tabs.append(tab);
    pstudioBindTab(tab);
    body.insertAdjacentHTML("beforeend", `<div class="studio-tab-page hidden" data-studio-page="research"><section class="studio-card"><h3>Recherche Internet</h3><form id="studio-research-form" class="center-filters"><input id="studio-research-query" maxlength="1000" placeholder="Que cherchez-vous ?" aria-label="Recherche" spellcheck="false"><button type="submit" class="primary">Rechercher</button></form><p class="studio-muted">Les recherches tournent en arrière-plan (DuckDuckGo) : vous pouvez continuer à travailler.</p></section><div id="studio-research-jobs"></div></div>`);
    tab.addEventListener("click", () => researchRefresh());
})();

function researchStatus(status) {
    return { running: "En cours", done: "Terminée", failed: "Échec", stopped: "Arrêtée" }[status] || status;
}

function researchRender() {
    const box = $("studio-research-jobs");
    if (!box) return;
    box.replaceChildren();
    if (!researchState.jobs.length) {
        box.append(centerNode("p", "studio-muted", "Aucune recherche pour l'instant."));
        return;
    }
    for (const job of researchState.jobs.slice().reverse()) {
        const card = centerNode("article", "studio-card studio-research-job");
        card.dataset.status = job.status;
        const head = centerNode("div", "studio-card-head");
        head.append(centerNode("strong", "", job.query), centerNode("span", job.status === "failed" ? "studio-pill error" : "studio-pill", researchStatus(job.status)));
        if (job.status === "running") head.append(centerButton("Arrêter", () => researchCancel(job.id)));
        card.append(head);
        if (job.error) card.append(centerNode("p", "studio-muted", job.error));
        const result = job.result || {};
        if (result.message) card.append(centerNode("p", "studio-muted", result.message));
        for (const item of result.results || []) {
            const row = centerNode("div", "studio-research-result");
            const link = centerNode("a", "", item.title || item.url);
            link.href = item.url;
            link.title = item.url;
            link.onclick = (event) => {
                event.preventDefault();
                api.openExternal(item.url).catch((error) => pstudioError(error));
            };
            row.append(link, centerNode("span", "studio-muted", item.url));
            if (item.snippet) row.append(centerNode("p", "", item.snippet));
            card.append(row);
        }
        box.append(card);
    }
}

async function researchRefresh() {
    try {
        researchState.jobs = await api.webResearch("list");
        researchRender();
    } catch (error) {
        pstudioError(error);
    }
}

async function researchCancel(id) {
    try {
        researchState.jobs = await api.webResearch("cancel", { id });
        researchRender();
    } catch (error) {
        pstudioError(error);
    }
}

if ($("studio-research-form")) {
    $("studio-research-form").onsubmit = async (event) => {
        event.preventDefault();
        const query = $("studio-research-query").value.trim();
        if (!query) return;
        try {
            await api.webResearch("start", { query });
            $("studio-research-query").value = "";
            pstudioMessage(`Recherche lancée : ${query}`);
            await researchRefresh();
        } catch (error) {
            pstudioError(error);
        }
    };
}

if (api && typeof api.onEvent === "function") {
    api.onEvent((channel) => {
        if (channel !== "webResearch") return;
        clearTimeout(researchState.timer);
        researchState.timer = setTimeout(researchRefresh, 200);
    });
}
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
/* ---------- Démarrage ---------- */

(async () => {
    try {
        applyStatus(await api.status());
    } catch {
        // statut indisponible au démarrage
    }
    renderTree();
    input.focus();
    try {
        await api.bootstrap();
    } catch (err) {
        renderEntry({ type: "error", text: err.message });
    }
    renderRecentProjects();
    try {
        applyStatus(await api.status());
    } catch {
        // statut indisponible
    }
    if (typeof maybeOpenConnectionGuide === "function") maybeOpenConnectionGuide();
    refreshQuota();
    setInterval(refreshQuota, 120000);
})();
