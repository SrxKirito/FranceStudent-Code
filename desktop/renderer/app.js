"use strict";

/* Interface façon VS Code : explorateur, éditeur à onglets, sortie des commandes, panneau Agent. */

const api = window.frst;
const $ = (id) => document.getElementById(id);

const SLASH_COMMANDS = [
    ["/help", "Aide"], ["/project", "Choisir un projet"], ["/unproject", "Quitter le projet"],
    ["/pwd", "Projet sélectionné"], ["/tree", "Lister un dossier (2 niveaux)"], ["/read", "Lire un fichier"],
    ["/extensions", "Extensions"],
    ["/plan", "Plan en lecture seule"], ["/undo", "Annuler la dernière modification"],
    ["/changes", "Modifications annulables"], ["/memory", "Notes du projet"],
    ["/remember", "Ajouter une note"], ["/forget", "Supprimer une note"],
    ["/permissions", "Règles des commandes"], ["/jobs", "Commandes en arrière-plan"],
    ["/mcp", "Serveurs MCP"], ["/skills", "Skills (SKILL.md)"], ["/auto", "Auto-approbation on|off|always|never"], ["/mode", "auto|agent|chat"],
    ["/new", "Nouvelle conversation"], ["/chat-id", "Chat ID / reprendre"], ["/history", "Conversations"],
    ["/messages", "Messages de la session"], ["/usage", "Consommation"], ["/model", "Changer d'agent"],
    ["/web", "Recherche web on|off"], ["/index", "Régénérer RESUME.md"], ["/init", "Créer FRSTCLI.md"],
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
    quotaRequestCheckpoint: null,
    quotaRefreshPending: false,
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
    const options = new CM.Compartment();
    let preferences = {fontSize:13,tabSize:4,wordWrap:false};
    const optionExtensions = () => [
        CM.indentUnit.of(" ".repeat(preferences.tabSize)), CM.EditorState.tabSize.of(preferences.tabSize),
        CM.EditorView.theme({"&":{fontSize:`${preferences.fontSize}px`},".cm-scroller":{fontFamily:"var(--mono)"}}),
        ...(preferences.wordWrap ? [CM.EditorView.lineWrapping] : [])
    ];
    let silent = false;
    const emit = (name) => events.dispatchEvent(new Event(name));
    const extensions = (kind) => [
        CM.basicSetup,
        CM.keymap.of([CM.indentWithTab]),
        options.of(optionExtensions()),
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
        configure(value) { preferences={...preferences,...value}; view.dispatch({effects:options.reconfigure(optionExtensions())}); },
        /* Charge un texte ; réutilise l'état sauvegardé (historique, sélection) s'il correspond encore. */
        load(text, kind, saved) {
            const doc = String(text ?? "");
            const state = saved && saved.doc.toString() === doc
                ? saved
                : CM.EditorState.create({ doc, extensions: extensions(kind) });
            view.setState(state);
            view.dispatch({effects:options.reconfigure(optionExtensions())});
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
    ask_user: "Question de l’agent",
    effectcraft: "EffectCraft",
    list_directory: "Lister", read_file: "Lire", search_files: "Chercher",web_search_result:"Résultat web",view_image:"Examiner l’image",
    create_directory: "Créer le dossier", write_file: "Écrire", edit_file: "Éditer",
    move_path: "Déplacer", copy_path: "Copier", delete_path: "Supprimer",
    remember: "Mémoriser", run_command: "Commande", web_search: "Rechercher sur le web", web_fetch: "Lire une source", update_plan: "Actualiser le plan", semantic_search: "Explorer le code", diagnostics: "Diagnostics", browse: "Vérifier la page", job_output: "Lire la commande", job_stop: "Arrêter la commande"
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
    return String(text ?? "").split(/(`[^`]+`|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\)|\*\*[^*]+\*\*|https?:\/\/[^\s<>]+)/g).map(part => {
        if (part.startsWith("`") && part.endsWith("`")) return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
        if (part.startsWith("**") && part.endsWith("**")) return `<b>${escapeHtml(part.slice(2, -2))}</b>`;
        const match = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(part);
        const url = match ? match[2] : /^https?:\/\//.test(part) ? part : null;
        if (url) return `<a href="${escapeHtml(url)}" data-web-url="${escapeHtml(url)}">${escapeHtml(match ? match[1] : url)}</a>`;
        return escapeHtml(part);
    }).join("");
}

/* Remplace un bloc « # nom.ext + contenu » d’une réponse de l’agent par une puce cliquable, sice fichier a été modifié pendant la tâche. */
function agentFileChip(source) {
    if (ui.status.mode === "chat" || !ui.changes || !ui.changes.size || typeof fileIcon !== "function") return null;
    const first = String(source || "").replace(/\r/g, "").split("\n")[0].trim();
    const named = /^(?:#|\/\/|--|%)\s*([\w@.\-\/\\]+\.\w{1,8})\s*$/.exec(first) || /^(?:<!--|\/\*)\s*([\w@.\-\/\\]+\.\w{1,8})\s*(?:-->|\*\/)$/.exec(first);
    if (!named) return null;
    const wanted = named[1].replace(/\\/g, "/").replace(/^\.\//, "");
    const path = [...ui.changes.keys()].find(key => key === wanted || key.endsWith("/" + wanted));
    if (!path) return null;
    const chip = document.createElement("button");
    chip.type = "button"; chip.className = "agent-file-chip"; chip.dataset.openPath = path;
    chip.title = `Ouvrir ${path} dans l’éditeur`; chip.setAttribute("aria-label", `Ouvrir ${path} dans l’éditeur`);
    const name = path.split("/").pop(), label = document.createElement("span");
    label.textContent = name; chip.append(fileIcon(name, "file"), label);
    return chip;
}

function renderMarkdown(src) {
    if(typeof window!=="undefined"&&window.StudioVendor) {
        // Protéger les formules avant Markdown, qui interprète notamment les barres inverses.
        const formulas = [];
        let markerPrefix = "FRSTMATH"; while (String(src ?? "").includes(markerPrefix)) markerPrefix += "X";
        const mathPattern = /```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]+`|\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([^\n]+?)\\\)|(^|[^\\$])\$([^\s$](?:[^$\n]*?[^\s$\\])?)\$(?![\w$])/g;
        const markedSource = String(src ?? "").replace(mathPattern, (match, block, brackets, parens, prefix, inlineMath) => {
            if (match.startsWith("`") || match.startsWith("~~~") || !window.katex) return match;
            const tex = block || brackets || parens || inlineMath;
            if (!tex?.trim()) return match;
            const marker = `${markerPrefix}${formulas.length}END`;
            try { formulas.push(window.katex.renderToString(tex.trim(), { displayMode: Boolean(block || brackets), throwOnError: false, trust: false, maxExpand: 100, maxSize: 20 })); }
            catch { formulas.push(escapeHtml(match.slice((prefix || "").length))); }
            return (prefix || "") + marker;
        });
        const template=document.createElement("template");template.innerHTML=window.StudioVendor.markdown(markedSource);
        for(const anchor of template.content.querySelectorAll("a")) {
            const href=anchor.getAttribute("href")||"";
            if(/^https?:\/\//i.test(href))anchor.dataset.webUrl=href;
            else anchor.removeAttribute("href");
        }
        for (const code of template.content.querySelectorAll("pre code")) {
            const language = [...code.classList].find(name => name.startsWith("language-"))?.slice(9).toLowerCase() || "";
            if (ui.status.mode === "chat") {
                const source = code.textContent || "", requested = [...transcript.querySelectorAll(".entry.user .message-content")].at(-1)?.textContent || "";
                let isDocument = language === "pdf" || /^(?:#|\/\/|%|--)\s*[\w-]+\.pdf\s*$/i.test(source.split("\n")[0].trim()) && /\bpdf\b/i.test(requested);
                if (["pptx", "powerpoint"].includes(language)) { try { parsePowerPoint(source); isDocument=true; } catch { /* bloc incomplet ou non valide */ } }
                const complete = [...String(src || "").matchAll(/```[^\n`]*\n([\s\S]*?)```/g)].some(match => match[1].replace(/\r/g, "").trimEnd() === source.replace(/\r/g, "").trimEnd());
                if (isDocument && complete) {
                    const placeholder=document.createElement("div"); placeholder.className="classic-generating-file"; placeholder.textContent="Préparation du fichier…"; code.parentElement.replaceWith(placeholder); continue;
                }
            }
            { const chip = agentFileChip(code.textContent); if (chip) { code.parentElement.replaceWith(chip); continue; } }
            if (["quiz", "cards"].includes(language) && typeof renderStudyBlock === "function") { const markup = renderStudyBlock(code.textContent, language, false); if (markup) { const holder = document.createElement("div"); holder.innerHTML = markup; code.parentElement.replaceWith(...holder.childNodes); continue; } }
            const kind = ({ javascript: "js", typescript: "ts", python: "py", markdown: "md", xml: "html" })[language] || language;
            code.innerHTML = highlightCode(code.textContent, kind);
        }
        if (formulas.length) template.innerHTML = template.innerHTML.replace(new RegExp(`${markerPrefix}(\\d+)END`, "g"), (marker, index) => formulas[Number(index)] ?? marker);
        return template.innerHTML;
    }
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
    if (p.kind === "question") {
        renderAgentQuestion(p, zone);
        scrollDown();
        return;
    }
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
    const wasBooted = Boolean(ui.status.booted);
    ui.status = s;
    if (wasBooted && !s.booted && typeof clearAccountSettings === "function") clearAccountSettings();
    if (!wasBooted && s.booted && typeof loadMobileSettingsSection === "function" && document.querySelector("#browser-home .browser-home-view-settings #settings-view")) loadMobileSettingsSection();
    if (typeof updateComposerContext === "function") updateComposerContext(s);
    if (typeof updateChatAccess === "function") updateChatAccess(s);
    if (typeof updateChatReasoning === "function") updateChatReasoning(s);
    if (typeof updateChatToolSelection === "function") updateChatToolSelection(s);
    if (typeof updateWslProject === "function") updateWslProject(s);
    const ecoButton = $("eco-mode-toggle");
    if (ecoButton) {
        ecoButton.disabled = Boolean(s.busy);
        ecoButton.setAttribute("aria-pressed", String(Boolean(s.ecoMode)));
        ecoButton.querySelector(".eco-mode-label").textContent = s.ecoMode ? "Éco activé" : "Mode Éco";
        ecoButton.title = s.ecoMode ? "Désactiver le mode Éco" : "Réduire la consommation avec des capacités limitées";
    }
    const busy = Boolean(s.busy);
    $("settings-logout").disabled = !s.booted || busy;
    $("settings-account-status").textContent = !s.booted ? "Non connecté." : busy ? "Connecté · arrête la tâche avant de te déconnecter." : "Connecté à FranceStudent.";
    updateStudioStatus(s);

    $("statusbar").classList.toggle("busy", busy);
    $("btn-stop").classList.toggle("hidden", !busy);
    $("btn-send").disabled = false;
    $("btn-send").textContent = busy ? "Ajouter" : "Envoyer";
    $("btn-send").title = busy ? "Ajouter ce prompt à la file (Entrée)" : "Envoyer (Entrée)";
    input.placeholder = busy ? "Ajouter une demande à la suite…" : "Demande à l’agent… (/ pour les commandes)";
    document.querySelector(".composer-hint").textContent = busy ? "Entrée : ajouter à la suite" : "Entrée : envoyer · Maj+Entrée : ligne";
    $("mode-select").disabled = busy;
    renderInlinePending(queueSnapshot);
    $("st-busy").textContent = busy ? "⟳ en cours" : "";
    $("st-jobs").textContent = s.jobs ? `jobs : ${s.jobs}` : "";
    $("st-auto").textContent = s.fullAccess ? "Full accès" : s.autoApprove ? "auto-approbation" : "";
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
    }
    renderQuota();
    refreshQuotaAtRequestCheckpoint(s.usage?.requests);
    if (s.mode) $("mode-select").value = s.mode;
    if (typeof updateChatModeMenu === "function") updateChatModeMenu(s);

    if ((s.workspace || null) !== ui.workspace) {
        ui.workspace = s.workspace || null;
        onWorkspaceChanged();
        refreshTaskQueue();
    } else if (wasBusy && !busy) {
        scheduleRefresh();
        if (typeof renderCodexRail === "function") renderCodexRail();
    }

    if (wasBusy && !busy) refreshQuota();
}

function refreshQuotaAtRequestCheckpoint(requests) {
    const count = Number(requests);
    if (!Number.isFinite(count) || count < 0) return;
    const checkpoint = Math.floor(count / 5) * 5;
    if (ui.quotaRequestCheckpoint == null) {
        // Le chargement initial récupère déjà le quota ; commencer le suivi
        // depuis le compteur courant évite un second rafraîchissement au démarrage.
        ui.quotaRequestCheckpoint = checkpoint;
        return;
    }
    if (checkpoint <= ui.quotaRequestCheckpoint) return;
    ui.quotaRequestCheckpoint = checkpoint;
    void refreshQuota();
}

/* ---------- Quota du compte FranceStudent ---------- */

function renderQuota() {
    renderUsageMeter();
    if(typeof renderComposerQuota === "function")renderComposerQuota();
    renderUsageDashboard();
    if(typeof updateQuotaRecoveryCards==="function")updateQuotaRecoveryCards();
}

async function refreshQuota() {
    if (ui.quotaLoading) { ui.quotaRefreshPending = true; return; }
    if (!ui.status.booted) { ui.quota = null; renderQuota(); return; }
    ui.quotaLoading = true;
    ui.quotaError = "";
    renderQuota();
    try {
        const quota = await api.usage();
        applyStatus(await api.status());
        ui.quota = ui.status.booted ? quota : null;
        ui.quotaUpdatedAt = new Date().toISOString();
    } catch {
        ui.quota = null;
        ui.quotaError = "Le quota est momentanément indisponible. Réessaie dans quelques instants.";
    }
    ui.quotaLoading = false;
    renderQuota();
    if (ui.quotaRefreshPending) {
        ui.quotaRefreshPending = false;
        setTimeout(() => { void refreshQuota(); }, 0);
    }
    return ui.quota;
}

/* ---------- Choix du modèle (/model) ---------- */

let historyMenuAnchor = null;
function hideModelMenu() {
    modelMenuEl.classList.add("hidden");
    modelMenuEl.innerHTML = "";
    historyMenuAnchor = null;
}

function positionModelMenu(anchor) {
    const rect = anchor.getBoundingClientRect();
    const width = Math.min(modelMenuEl.dataset.kind === "history" ? 520 : Math.max(300, rect.width), window.innerWidth - 16);
    modelMenuEl.style.minWidth = "0";
    modelMenuEl.style.width = `${width}px`;
    const below=Math.max(0,window.innerHeight-rect.bottom-14),above=Math.max(0,rect.top-14);
    const placeBelow=below>=above;
    modelMenuEl.style.maxHeight = `${Math.max(0,placeBelow?below:above)}px`;
    modelMenuEl.style.left = `${Math.max(8, Math.min(rect.left, window.innerWidth - width - 8))}px`;
    modelMenuEl.style.top = `${rect.bottom + 6}px`;
    const menuRect = modelMenuEl.getBoundingClientRect();
    if (!placeBelow)modelMenuEl.style.top = `${Math.max(8,rect.top-menuRect.height-6)}px`;
}

window.addEventListener("resize", () => {
    if (!modelMenuEl.classList.contains("hidden")) positionModelMenu(modelMenuEl.dataset.kind === "history" ? (historyMenuAnchor || $("btn-history")) : $("btn-model"));
});

const HISTORY_DELETE_CONFIRM_KEY = "frst.history.confirm-delete";
function historyDeletionConfirmationEnabled() {
    try { return localStorage.getItem(HISTORY_DELETE_CONFIRM_KEY) !== "off"; } catch { return true; }
}

function confirmHistoryDeletion(item) {
    if (!historyDeletionConfirmationEnabled()) return Promise.resolve(true);
    return new Promise(resolve => {
        const dialog = document.createElement("dialog");
        dialog.id = "history-delete-dialog";
        dialog.className = "history-delete-dialog";
        dialog.innerHTML = '<h2>Supprimer cette conversation ?</h2><p class="history-delete-title"></p><p>Elle sera retirée de l’historique local. Les fichiers du projet sont conservés.</p><label><input type="checkbox"> Ne plus demander avant de supprimer une conversation</label><div class="studio-actions"><button type="button" data-action="cancel">Annuler</button><button type="button" data-action="delete" class="danger">Supprimer</button></div>';
        dialog.querySelector(".history-delete-title").textContent = item.title;
        let confirmed = false;
        dialog.querySelector('[data-action="cancel"]').onclick = () => dialog.close();
        dialog.querySelector('[data-action="delete"]').onclick = () => {
            confirmed = true;
            if (dialog.querySelector("input").checked) {
                try { localStorage.setItem(HISTORY_DELETE_CONFIRM_KEY, "off"); } catch { /* Confirmation remains enabled when storage is unavailable. */ }
            }
            dialog.close();
        };
        dialog.addEventListener("close", () => { dialog.remove(); hideModelMenu(); resolve(confirmed); }, { once: true });
        studioSurfaceHeader(dialog,{title:"Supprimer cette conversation ?",subtitle:"Les fichiers de ton projet sont conservés.",icon:"auth"});
        dialog.querySelector(".studio-actions").classList.add("fs-dialog-footer");
        document.body.appendChild(dialog);
        dialog.showModal();
        dialog.querySelector('[data-action="cancel"]').focus();
    });
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
    img.src = `assets/models/${vendor === "gpt" ? "chatgpt" : vendor}.png`;
    img.alt = vendor;
    return img;
}

function modelUseGroup(agent) {
    const model = String(agent.model || agent.name || "").toLowerCase().trim().replace(/\s+/g, "-");
    if (/^gpt-5\.6-luna(?:-|$)/.test(model) || /^gemini-3\.8-flash(?:-|$)/.test(model)) return "simple";
    if (/^gpt-5\.6-terra(?:-|$)/.test(model)) return "everyday";
    if (agent.isDefault) return "start";
    if (/^claude-haiku-/.test(model) || /^gpt-6-luna(?:-|$)/.test(model)) return "simple";
    if (/^claude-sonnet-/.test(model) || /^gpt-6\.1-terra(?:-|$)/.test(model)) return "everyday";
    if (/^claude-(?:opus|fable)-/.test(model) || /^gemini-(?:[\d.]+-)?pro(?:-|$)/.test(model) || /^gpt-6(?:\.1)?-sol(?:-|$)/.test(model)) return "complex";
    return "other";
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

    const intro = document.createElement("p");
    intro.className = "model-guide-intro";
    intro.textContent = agents.some(agent => agent.isDefault)
        ? "Pour commencer, essaie le modèle par défaut. Classement indicatif : chaque modèle peut servir à d’autres usages."
        : "Classement indicatif : chaque modèle peut servir à d’autres usages. Choisis librement selon tes besoins.";
    modelMenuEl.appendChild(intro);
    const groups = [
        ["start", "Pour commencer", "Le choix par défaut du service"],
        ["simple", "Demandes simples", "Questions courtes, reformulation, petites corrections"],
        ["everyday", "Au quotidien", "Rédaction, code et projets courants"],
        ["complex", "Tâches complexes", "Analyse approfondie et problèmes difficiles"],
        ["other", "Autres modèles", "Choisis librement selon tes préférences"]
    ];
    for (const [key, title, hint] of groups) {
        const items = agents.filter(agent => modelUseGroup(agent) === key);
        if (!items.length) continue;
        const group = document.createElement("section");
        group.className = "model-guide-group";
        const heading = document.createElement("h3");
        heading.className = "model-guide-heading";
        heading.textContent = title;
        const description = document.createElement("p");
        description.className = "model-guide-description";
        description.textContent = hint;
        group.append(heading, description);
        modelMenuEl.appendChild(group);
        for (const agent of items) {
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
        group.appendChild(row);
        }
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
    if(typeof isMotionOpen==="function" && isMotionOpen())return null;
    return ui.workspace || (ui.status && ui.status.workspace) || null;
}

function historyMatches(item) {
    const motion=typeof isMotionOpen==="function" && isMotionOpen();
    if(!!item.motionDesign!==motion)return false;
    if (!motion && ui.historyOnlyProject && (item.workspace || null) !== historyCurrentWorkspace()) return false;
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
    const subtitle=document.createElement("p");subtitle.className="history-intro";subtitle.textContent="Retrouve tes échanges et reprends où tu en étais.";
    modelMenuEl.appendChild(head);
    modelMenuEl.appendChild(subtitle);

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
    const confirmation = document.createElement("label");
    confirmation.className = "history-confirm-setting";
    const confirmationInput = document.createElement("input");
    confirmationInput.type = "checkbox";
    confirmationInput.checked = historyDeletionConfirmationEnabled();
    confirmationInput.onchange = () => {
        try { localStorage.setItem(HISTORY_DELETE_CONFIRM_KEY, confirmationInput.checked ? "on" : "off"); } catch { confirmationInput.checked = true; }
    };
    confirmation.append(confirmationInput, document.createTextNode(" Confirmer avant de supprimer"));
    modelMenuEl.appendChild(confirmation);

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
    let previousGroup="";
    for (const item of shown){
        const date=new Date(item.updatedAt),today=new Date();today.setHours(0,0,0,0);
        const yesterday=new Date(today);yesterday.setDate(yesterday.getDate()-1);
        const group=date>=today?"Aujourd’hui":date>=yesterday?"Hier":"Plus anciennes";
        if(group!==previousGroup){const heading=document.createElement("div");heading.className="history-group";heading.textContent=group;list.appendChild(heading);previousGroup=group;}
        list.appendChild(renderHistoryRow(item));
    }
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
    name.textContent = item.title;
    main.appendChild(name);
    const sub = document.createElement("span");
    sub.className = "model-item-sub";
    const when = item.updatedAt ? new Date(item.updatedAt).toLocaleString("fr-FR",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"}) : "";
    for(const text of [item.motionDesign?"Motion design":"Code",item.model]){if(!text)continue;const badge=document.createElement("span");badge.className="history-badge";badge.textContent=text;sub.appendChild(badge);}
    const detail=document.createElement("span");detail.className="history-detail";detail.textContent=[when,`${item.messages || 0} échange${item.messages>1?"s":""}`].filter(Boolean).join(" · ");
    sub.appendChild(detail);
    if(item.workspace && !item.motionDesign){const folder=document.createElement("span");folder.className="history-folder";folder.textContent=item.workspace.replace(/[\\/]+$/,"").split(/[\\/]/).pop();main.appendChild(folder);}
    main.appendChild(sub);
    open.appendChild(main);
    open.onclick = async () => {
        hideModelMenu();
        if (ui.status && ui.status.busy) {
            renderEntry({ type: "error", text: "Une demande est en cours : attends sa fin avant de changer de conversation." });
            return;
        }
        try{
            if(item.motionDesign && !isMotionOpen())await openMotionDesign();
            else if(!item.motionDesign && isMotionOpen())await closeMotionDesign();
            afterConversationOpened(await api.conversationsOpen(item.id, { mode: !item.motionDesign && (item.mode === "chat" || ui.status.mode === "chat") ? "chat" : "" }));
        }catch(error){renderEntry({type:"error",text:error.message});}
    };

    const actions = document.createElement("span");
    actions.className = "history-actions";

    const renameBtn = document.createElement("button");
    renameBtn.type = "button";
    renameBtn.className = "history-action";
    renameBtn.innerHTML = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="m15 5 4 4M4 20l4-1L20 7a3 3 0 0 0-4-4L4 15Z"/></svg>';
    renameBtn.title = "Renommer";
    renameBtn.setAttribute("aria-label", "Renommer la conversation");
    renameBtn.onclick = (e) => {
        e.stopPropagation();
        startHistoryRename(row, item);
    };

    const removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "history-action";
    removeBtn.innerHTML = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6m4-6v6"/></svg>';
    removeBtn.title = "Supprimer de l'historique";
    removeBtn.setAttribute("aria-label", "Supprimer la conversation de l'historique");
    removeBtn.onclick = async (e) => {
        e.stopPropagation();
        removeBtn.disabled = true;
        try {
            if (!await confirmHistoryDeletion(item)) { removeBtn.disabled = false; return; }
            await api.conversationsRemove(item.id);
            window.dispatchEvent(new Event("frst-conversations-changed"));
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
                window.dispatchEvent(new Event("frst-conversations-changed"));
            } catch (err) {
                renderEntry({ type: "error", text: err.message });
            }
        }
        renderHistoryList();
        if (row.isConnected && row.closest("#codex-rail")) {
            open.style.display = "";
            if (actions) actions.style.display = "";
            row.querySelector(".model-item-name").textContent = item.title;
            input.remove();
        }
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

async function openHistoryMenu(anchor = $("btn-history")) {
    historyMenuAnchor = anchor;
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

function toggleHistoryMenu(anchor = $("btn-history")) {
    if (!modelMenuEl.classList.contains("hidden") && modelMenuEl.dataset.kind === "history") hideModelMenu();
    else openHistoryMenu(anchor);
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
    png: "img", jpg: "img", jpeg: "img", gif: "img", svg: "img", ico: "img", webp: "img", yaml:"yaml", yml:"yaml"
};
const FILE_TAGS = { js: "JS", ts: "TS", json: "{}", md: "M↓", css: "#", html: "<>", py: "PY", img: "▣", yaml:"YML", default: "•" };
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

async function openProject() {
    if (ui.tabs.some((t) => t.dirty) && !await confirmStudioAction("Des fichiers ne sont pas enregistrés. Changer de projet quand même ?")) return;
    try {
        const ws = await api.openProject();
        if (ws && ws !== ui.workspace) {
            ui.workspace = ws;
            onWorkspaceChanged();
        }
    } catch (err) {
        renderEntry({ type: "error", text: err.message });
    }
}

function onWorkspaceChanged() {
    studioWorkspaceChanged();
    expanded.clear();
    ui.tabs = [];
    ui.active = null;
    activate(null);
    clearChanges();
    renderTree();
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
    if ($("app").classList.contains("focus-agent") && browserHomeCurrent !== "editor") {
        setBrowserHomeOpen(true);
        browserHomeShow("editor");
    }
    let tab = ui.tabs.find((t) => t.path === rel);
    if (!tab) {
        try {
            if(/\.(png|jpe?g|gif|webp|bmp|ico|mp3|wav|ogg|m4a|mp4|webm|mov|pdf|docx?|xlsx?|pptx?|zip|gz|7z|rar)$/i.test(rel)) {
                tab={path:rel,content:"",saved:"",dirty:false,kind:"asset",asset:await api.inspectFile(rel),eol:"\n",scroll:0};
            }else{
            const file = await api.readFile(rel);
            const text = normalize(file.content);
            tab = { path: rel, content: text, saved: text, encoding:file.encoding||"utf8",bom:file.bom===true,eol: file.content.includes("\r\n") ? "\r\n" : "\n", dirty: false, scroll: 0 };
            }
            ui.tabs.push(tab);
        } catch (err) {
            try {tab={path:rel,content:"",saved:"",dirty:false,kind:"asset",asset:await api.inspectFile(rel),eol:"\n",scroll:0};ui.tabs.push(tab);}
            catch {renderEntry({ type: "error", text: `${rel} : ${err.message}` });return;}
        }
    }
    if (!$ ("app").classList.contains("focus-agent") && ["project", "settings", "extensions"].includes(ui.sideView)) showSideView("explorer");
    activate(rel);
}

function activate(rel) {
    window.frstBrowserHide?.();
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
    showStudioAsset(tab);
    const scroll = tab ? tab.scroll : 0;
    code.scrollTop = scroll;
    /* CodeMirror mesure la mise en page de façon asynchrone : on réapplique le défilement à l'image suivante. */
    requestAnimationFrame(() => {
        if (currentTab() === tab) code.scrollTop = scroll;
    });
    $("st-file").textContent = tab ? tab.path : "";
    updateBreadcrumbs(tab);
    updateGutter();
    syncHighlight();
    renderTabs();
    document.querySelectorAll(".node").forEach((n) => n.classList.toggle("selected", n.dataset.path === rel));
    if (tab&&tab.kind!=="asset") code.focus();
    syncEditorContext();
    lspOnActivate();
    if(studioPreviewVisible)updateDocumentPreview();
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
    document.title = tab ? `${name} — FranceStudent IDE` : "FranceStudent IDE";
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
    window.frstBrowserTab?.();
}

async function closeTab(rel) {
    const tab = ui.tabs.find((t) => t.path === rel);
    if (!tab) return;
    if (tab.dirty && !await confirmStudioAction(`${rel} n'est pas enregistré. Fermer quand même ?`)) return;
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
    if (!tab||tab.kind==="asset") return;
    if(studioEditorPreferences.formatOnSave&&currentTab()===tab)await formatEditorDocument();
    const snapshot=tab.content;
    const content = tab.eol === "\r\n" ? snapshot.split("\n").join("\r\n") : snapshot;
    try {
        await api.writeFile(tab.path, content,{encoding:tab.encoding||"utf8",bom:tab.bom===true});
        tab.saved = snapshot;
        tab.dirty = tab.content!==snapshot;
        renderTabs();
        $("st-file").textContent = `${tab.path} (enregistré)`;
        scheduleGitRefresh();
        if(studioPreviewVisible)updateDocumentPreview();
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
                // L’utilisateur peut avoir modifié ou fermé l’onglet pendant la lecture.
                if (tab.dirty || !ui.tabs.includes(tab)) continue;
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
    if(tab?.kind==="asset")return;
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

/* ---------- Saisie de l'agent ---------- */

/* ---------- Pièces jointes (fichiers / images) ---------- */

const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const MAX_FILE_BYTES = 25 * 1024 * 1024;
const ATTACHMENT_QUOTA_WARNING_COUNT = 5;
let pendingAttachments = [];
const attachmentQuotaWarning = document.createElement("p");
attachmentQuotaWarning.id = "attachment-quota-warning";
attachmentQuotaWarning.className = "attachment-quota-warning hidden";
attachmentQuotaWarning.setAttribute("role", "status");
attachmentQuotaWarning.setAttribute("aria-live", "polite");
$("attachments").after(attachmentQuotaWarning);

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

/** Fichier quelconque -> pièce jointe { kind: "file" } en data URL base64 avec un type MIME. */
async function prepareFile(file, name) {
    if (file.size > MAX_FILE_BYTES) {
        throw new Error(`fichier trop lourd (${formatBytes(file.size)}, max ${formatBytes(MAX_FILE_BYTES)})`);
    }
    const mime = file.type || BINARY_TYPES[fileExtension(name)] || "application/octet-stream";
    const raw = await readAsDataUrl(file);
    const base64 = raw.slice(raw.indexOf(",") + 1);
    const previewId = await rememberAttachmentPreview(file, name);
    return { name, kind: "file", size: file.size, mime, data: `data:${mime};base64,${base64}`, previewId };
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
    const fileCount=pendingAttachments.reduce((sum,item)=>sum+(item.selectedPaths?.length??1),0);
    const manyFiles = fileCount >= ATTACHMENT_QUOTA_WARNING_COUNT;
    attachmentQuotaWarning.classList.toggle("hidden", !manyFiles);
    attachmentQuotaWarning.textContent = manyFiles
        ? pendingAttachments.some(item=>item.selectedPaths)
            ? `⚠ ${fileCount} fichiers sélectionnés : leur analyse peut consommer beaucoup de quota. Le traitement local évite les envois inutiles ; les contenus effectivement lus par l’IA restent comptabilisés.`
            : `⚠ ${pendingAttachments.length} fichiers joints : leur analyse risque de consommer énormément de quota, notamment si les documents contiennent beaucoup de pages ou nécessitent plusieurs envois. Retire les fichiers inutiles avant d’envoyer.`
        : "";
    box.replaceChildren();
    box.classList.toggle("hidden", pendingAttachments.length === 0);
    pendingAttachments.forEach((item, index) => {
        const chip = document.createElement("span");
        chip.className = "attachment-chip";
        const kindLabel = item.kind === "image" ? "image" : item.kind === "file" ? (item.mime || "fichier") : "texte";
        chip.title = item.size != null ? `${item.name} (${kindLabel}, ${formatBytes(item.size)})` : item.name;
        if (item.kind === "image") {
            const img = document.createElement("img");
            img.src = item.data;
            img.alt = "";
            chip.appendChild(img);
        } else {
            const icon = document.createElement("span");
            icon.className = "attachment-icon";
            icon.textContent = attachmentIcon(item);
            chip.appendChild(icon);
        }
        const label = document.createElement("span");
        label.className = "attachment-name";
        label.textContent = item.selectedPaths?`${item.name} · ${item.selectedPaths.length} fichier(s)` : item.name;
        const contents = document.createDocumentFragment();
        while (chip.firstChild) contents.append(chip.firstChild);
        contents.append(label);
        chip.append(previewButtonFor(item, contents));
        if(item.readabilityWarning){const warning=document.createElement("span");warning.className="attachment-readability-warning";warning.textContent="⚠ Lisibilité réduite";warning.title=item.readabilityWarning;chip.append(warning);chip.title+=" · "+item.readabilityWarning;}
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
async function prepareImage(file,details={}) {
    const direct = DIRECT_IMAGE_TYPES.has(file.type);

    let bitmap;
    try {
        bitmap = await createImageBitmap(file);
    } catch {
        throw new Error(`format d'image illisible (${file.type || "inconnu"}) : utiliser PNG, JPEG, WebP ou GIF`);
    }
    const projectedScale=Math.min(1,MAX_IMAGE_SIDE/Math.max(bitmap.width,bitmap.height));
    details.originalWidth=bitmap.width;details.originalHeight=bitmap.height;
    details.sentWidth=Math.max(1,Math.round(bitmap.width*projectedScale));details.sentHeight=Math.max(1,Math.round(bitmap.height*projectedScale));
    if(projectedScale<.75||file.size>MAX_IMAGE_BYTES){details.readabilityWarning=`${bitmap.width} × ${bitmap.height} → ${details.sentWidth} × ${details.sentHeight} pixels. La réduction ou compression peut rendre les petits textes et détails difficiles à lire.`;}
    if(direct&&file.size<=MAX_IMAGE_BYTES&&bitmap.width<=MAX_IMAGE_SIDE&&bitmap.height<=MAX_IMAGE_SIDE){bitmap.close?.();return readAsDataUrl(file);}
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

let attachmentPreparationQueue=Promise.resolve();
function addAttachments(fileList){
    const files=Array.from(fileList||[]);
    const next=attachmentPreparationQueue.then(()=>prepareAttachments(files));
    attachmentPreparationQueue=next.catch(()=>{});return next;
}
async function prepareAttachments(fileList) {
    for (const file of Array.from(fileList || [])) {
        const name = file.name || (file.type.startsWith("image/") ? "image-collée.png" : "fichier");
        // Names and sizes alone do not prove identity (notably repeated screenshot names).
        const candidates=pendingAttachments.filter(a=>a.name===name&&a.size===file.size);
        try {
            if (file.size === 0) throw new Error("fichier vide");
            if(candidates.length&&file.size<=MAX_FILE_BYTES){const originalData=await readAsDataUrl(file);if(candidates.some(a=>a.data===originalData))continue;}
            if(/\.zip$/i.test(name)||["application/zip","application/x-zip-compressed"].includes(file.type)){
                const attachment=await prepareFile(file,name);
                let selection;
                try{selection=await chooseZipFiles(attachment);}
                catch{selection={...attachment,classicPreparation:true};studioFeedback(`${name} : inventaire local indisponible, lecture classique utilisée.`);}
                if(selection)pendingAttachments.push(selection);
                continue;
            }
            // Keep SVG source as well as its raster preview. Decode document
            // encodings in the backend instead of losing bytes with File.text().
            if (file.type.startsWith("image/") && !["image/svg+xml", "image/gif", "image/tiff"].includes(file.type) && !["svg", "gif", "tif", "tiff"].includes(fileExtension(name))) {
                try {
                    const details={};
                    const data=await prepareImage(file,details);
                    const previewId = await rememberAttachmentPreview(file, name);
                    pendingAttachments.push({ name, kind: "image", size: file.size, data, previewId, ...details });
                    continue;
                } catch (err) {
                    // Image non décodable (HEIC, PSD…) : envoyée telle quelle comme fichier.
                    if (file.size > MAX_FILE_BYTES) throw err;
                }
                pendingAttachments.push(await prepareFile(file, name));
                continue;
            }
            // Documents are converted locally when sending, via the same path
            // for file selection, paste, drag and drop, and queued requests.
            pendingAttachments.push(await prepareFile(file, name));
        } catch (err) {
            renderEntry({ type: "error", text: `${name} : ${err.message || err}` });
        }
    }
    renderAttachments();
}

const imageReadabilityDialog=document.createElement("dialog");
imageReadabilityDialog.id="image-readability-dialog";imageReadabilityDialog.className="center-dialog image-readability-dialog";
imageReadabilityDialog.setAttribute("aria-labelledby","image-readability-title");
imageReadabilityDialog.innerHTML=`<h2 id="image-readability-title">Cette image risque d’être difficile à lire</h2><p class="settings-help">Pour respecter les limites du modèle, les images ci-dessous seront réduites ou compressées. Les petits textes et détails peuvent devenir illisibles.</p><ul id="image-readability-list"></ul><p class="settings-help">Pour une meilleure lecture, recadre la zone utile ou envoie plusieurs captures plus courtes. L’original reste intact.</p><form method="dialog" class="center-dialog-actions"><button value="cancel" autofocus>Revenir aux images</button><button value="send" class="primary">Envoyer quand même</button></form>`;
document.body.append(imageReadabilityDialog);
let imageReadabilityPending=false;
async function confirmImageReadability(attachments){
    const risky=attachments.filter(item=>item.readabilityWarning);
    if(!risky.length)return true;
    if(imageReadabilityPending)return false;
    imageReadabilityPending=true;
    const list=$("image-readability-list");list.replaceChildren();
    for(const item of risky){const row=document.createElement("li"),name=document.createElement("b"),detail=document.createElement("small");name.textContent=item.name;detail.textContent=item.readabilityWarning;row.append(name,detail);list.append(row);}
    imageReadabilityDialog.returnValue="cancel";
    return new Promise(resolve=>{
        imageReadabilityDialog.addEventListener("close",()=>{imageReadabilityPending=false;resolve(imageReadabilityDialog.returnValue==="send");},{once:true});
        imageReadabilityDialog.showModal();
    });
}

async function send(text) {
    if (typeof cancelChatDictation === "function") cancelChatDictation();
    if(ui.replayingConversation){studioFeedback("L’historique de la conversation est encore en cours de chargement.");return;}
    if(typeof motionChatSwitch!=="undefined" && motionChatSwitch){studioFeedback("Le changement de chat est en cours.");return;}
    const value = text ?? input.value;
    const withFiles = text === undefined && pendingAttachments.length > 0;
    if (!value.trim() && !withFiles) return;
    if (!ui.status.booted && !value.trim().startsWith("/")) { openConnectionGuide(1); return; }
    if (!value.trim().startsWith("/") && ui.workspace && ui.tabs.some(tab => tab.dirty)) {
        if (!await confirmStudioAction("Certains fichiers ouverts ne sont pas enregistrés. La version automatique ne contiendra que leur état sur le disque. Envoie la demande quand même ?", { title: "Fichiers non enregistrés", confirmLabel: "Envoyer", danger: false })) return;
    }
    const attachments = withFiles ? [...pendingAttachments] : [];
    if(withFiles&&!await confirmImageReadability(attachments))return;
    if (text === undefined) {
        if (value.trim()) {
            ui.history.push(value);
            ui.historyIndex = ui.history.length;
        }
        input.value = "";
        saveStudioDraft();
        if (withFiles) {
            pendingAttachments = [];
            renderAttachments();
        }
    }
    hideSlash();
    try {
        if (inlineEditingId) {
            await api.taskQueue("edit", { id: inlineEditingId, prompt: value.trim()||"Analyse les pièces jointes.", attachments });
            inlineEditingId = null;
            studioFeedback("Prompt en attente mis à jour.");
            return;
        }
        const result = await api.submit(value, attachments, { ...(typeof chatToolOptions === "function" ? chatToolOptions() : {}), studyMode: ui.status.mode === "chat" && typeof classicStudyMode !== "undefined" ? classicStudyMode : "" });
        if (result?.error) throw Object.assign(new Error(result.error),{reported:result.errorReported===true});
        if (result?.queued) studioFeedback("Prompt ajouté à la suite.");
    } catch (err) {
        if (text === undefined && !input.value) {
            input.value = value;
            if (withFiles) { pendingAttachments = attachments; renderAttachments(); }
            saveStudioDraft(); autosizeInput();
        }
        if(!err.reported)renderEntry({ type: "error", text: err.message });
    }
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
        if (inlineEditingId) { inlineEditingId = null; input.value = ""; pendingAttachments=[];renderAttachments();saveStudioDraft(); studioFeedback("Modification annulée."); return; }
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
const attachmentDropZone = $("agent");
const attachmentDropHint = document.createElement("div");
attachmentDropHint.className = "attachment-drop-hint hidden";
attachmentDropHint.setAttribute("role", "status");
attachmentDropHint.textContent = "Déposez vos fichiers pour les joindre";
attachmentDropZone.appendChild(attachmentDropHint);

function isFileDrag(ev) {
    return Array.from(ev.dataTransfer?.types || []).includes("Files") || Boolean(ev.dataTransfer?.files?.length);
}
function showAttachmentDrop(active) {
    attachmentDropZone.classList.toggle("drag-over", active);
    $("composer").classList.toggle("drag-over", active);
    attachmentDropHint.classList.toggle("hidden", !active);
}
attachmentDropZone.addEventListener("dragenter", (ev) => {
    if (!isFileDrag(ev)) return;
    ev.preventDefault();
    showAttachmentDrop(true);
});
attachmentDropZone.addEventListener("dragover", (ev) => {
    if (!isFileDrag(ev)) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = "copy";
    showAttachmentDrop(true);
});
attachmentDropZone.addEventListener("dragleave", (ev) => {
    if (ev.relatedTarget && attachmentDropZone.contains(ev.relatedTarget)) return;
    showAttachmentDrop(false);
});
attachmentDropZone.addEventListener("drop", async (ev) => {
    showAttachmentDrop(false);
    if (!isFileDrag(ev)) return;
    ev.preventDefault();
    const files = Array.from(ev.dataTransfer.files || []);
    if (!files.length) return;
    await addAttachments(files);
    input.focus();
});
// Prevent Chromium from navigating to a file dropped outside the conversation.
document.addEventListener("dragover", (ev) => {
    if (!isFileDrag(ev)) return;
    ev.preventDefault();
    if (!attachmentDropZone.contains(ev.target)) {
        ev.dataTransfer.dropEffect = "none";
        showAttachmentDrop(false);
    }
});
document.addEventListener("drop", (ev) => {
    if (isFileDrag(ev)) ev.preventDefault();
    showAttachmentDrop(false);
});
document.addEventListener("dragleave", (ev) => {
    if (!ev.relatedTarget) showAttachmentDrop(false);
});
document.addEventListener("dragend", () => showAttachmentDrop(false));
window.addEventListener("blur", () => showAttachmentDrop(false));

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
$("btn-new").onclick = () => send("/new");
$("btn-clear").onclick = () => send("/clear");
if ($("btn-help")) $("btn-help").onclick = () => send("/help");
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
    setAgentTab("usage");
};
$("st-usage").setAttribute("role", "button");
$("st-usage").tabIndex = 0;
$("st-usage").onkeydown = event => {
    if (event.key === "Enter" || event.key === " ") { event.preventDefault(); setAgentTab("usage"); }
};
$("btn-open-project").onclick = openProject;
$("btn-open-project-2").onclick = openProject;
$("btn-refresh-tree").onclick = () => renderTree();
$("btn-clear-output").onclick = () => {
    output.textContent = "";
};

function toggleSidebar() {
    const app = $("app");
    app.classList.toggle("no-sidebar");
    document.querySelector('[data-view="explorer"]')?.classList.toggle("active", !app.classList.contains("no-sidebar"));
}

for (const b of document.querySelectorAll('[data-view="explorer"]')) b.onclick = toggleSidebar;

const IS_MAC = /Mac/i.test(navigator.platform || navigator.userAgent || "");
if (IS_MAC) document.documentElement.classList.add("mac");

document.addEventListener("keydown", (ev) => {
    if(document.querySelector("dialog[open]"))return;
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
    "--left": { min: 150, max: 600 },
    "--right": { min: 280, max: 900 },
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
    if (!await confirmStudioAction(`Mettre « ${entry.path} » à la corbeille ?`,{title:"Supprimer cet élément",confirmLabel:"Mettre à la corbeille",danger:true})) return;
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
    for (const b of document.querySelectorAll('[data-view="explorer"], [data-view="search"], [data-view="git"], [data-view="worktrees"], [data-view="extensions"], [data-view="settings"], [data-view="project"]')) {
        b.classList.toggle("active", b.dataset.view === view);
    }
}

function showSideView(view) {
    browserHomeShowSideView(view);
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

// Les boutons de vue peuvent être absents (barre d'activité supprimée) : on lie seulement ceux qui existent.
for (const view of ["explorer", "search", "git", "worktrees", "extensions", "settings"]) {
    for (const b of document.querySelectorAll(`[data-view="${view}"]`)) b.onclick = () => toggleSideView(view);
}

/* ---------- Vue Paramètres : auto-approbation des écritures et des commandes ---------- */
let settingsAccessMode = "ask";

function applySettings(s) {
    if (!s || typeof s !== "object") return;
    settingsAccessMode = s.fullAccess ? "full" : s.autoApprove && s.autoApproveCommands ? "auto" : !s.autoApprove && !s.autoApproveCommands ? "ask" : "custom";
    for (const button of document.querySelectorAll("[data-access-mode]")) {
        const selected = button.dataset.accessMode === settingsAccessMode;
        button.setAttribute("aria-checked", String(selected));
        button.classList.toggle("selected", selected);
        button.tabIndex = selected || (settingsAccessMode === "custom" && button.dataset.accessMode === "ask") ? 0 : -1;
    }
    const descriptions = {
        ask: "L’agent demande ton accord avant de modifier des fichiers ou de lancer des commandes sensibles.",
        auto: "Les modifications et les commandes autorisées s’exécutent sans demander. Les commandes bloquées restent interdites.",
        full: "Toutes les actions sont autorisées sans confirmation, y compris hors du projet. Lis l’avertissement ci-dessous.",
        custom: "Tu utilises des autorisations personnalisées. Choisis un mode ci-dessus ou ajuste les options détaillées."
    };
    $("access-mode-description").textContent = descriptions[settingsAccessMode];
    $("full-access-warning").classList.toggle("hidden", !s.fullAccess);
    $("set-remember-access").checked = s.rememberAccess !== undefined ? Boolean(s.rememberAccess) : settingsAccessMode === "full" ? Boolean(s.fullAccessAlways) : Boolean(s.always && s.commandsAlways);
    $("set-remember-access").disabled = settingsAccessMode === "custom";
    $("detailed-permissions").disabled = Boolean(s.fullAccess);
    $("set-auto-writes").checked = Boolean(s.autoApprove);
    $("set-auto-writes-always").checked = Boolean(s.always);
    $("set-auto-commands").checked = Boolean(s.autoApproveCommands);
    $("set-auto-commands-always").checked = Boolean(s.commandsAlways);
    if (s.webSearch !== undefined) $("set-web-search").checked = Boolean(s.webSearch);
    if (s.automaticWeb !== undefined) $("set-automatic-web").checked = Boolean(s.automaticWeb);
    if (s.extensionsMode !== undefined) {
        $("set-extensions-auto").checked = s.extensionsMode !== "manual";
        $("set-extensions-manual").checked = s.extensionsMode === "manual";
    }
    $("st-auto").textContent = s.fullAccess ? "Full accès" : s.autoApprove ? "auto-approbation" : "";
}

async function refreshSettings() {
    try {
        // Mode vide : main.js ne change rien et renvoie l'état actuel.
        applySettings(await api.setAutoApprove(""));
        $("settings-message").textContent = "";
    } catch (error) {
        $("settings-message").textContent = `Paramètres : ${error.message}`;
    }
}

async function changeSetting(mode) {
    try {
        applySettings(await api.setAutoApprove(mode));
        $("settings-message").textContent = "Réglage enregistré.";
    } catch (error) {
        $("settings-message").textContent = `Réglage non enregistré : ${error.message}`;
        await refreshSettings();
    }
}

for (const button of document.querySelectorAll("[data-access-mode]")) button.onclick = () => changeSetting(`access-${button.dataset.accessMode}-${$("set-remember-access").checked ? "always" : "session"}`);
for (const button of document.querySelectorAll("[data-access-mode]")) button.onkeydown = event => {
    if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const buttons = [...document.querySelectorAll("[data-access-mode]")];
    const index = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (buttons.indexOf(button) + (event.key === "ArrowLeft" ? buttons.length - 1 : 1)) % buttons.length;
    buttons[index].focus(); buttons[index].click();
};
$("set-remember-access").onchange = e => changeSetting(`access-${settingsAccessMode}-${e.target.checked ? "always" : "session"}`);

$("set-auto-writes").onchange = (e) => changeSetting(e.target.checked ? "on" : "off");
$("set-auto-writes-always").onchange = (e) => changeSetting(e.target.checked ? "always" : "never");
$("set-auto-commands").onchange = (e) => changeSetting(e.target.checked ? "commands-on" : "commands-off");
$("set-auto-commands-always").onchange = (e) => changeSetting(e.target.checked ? "commands-always" : "commands-never");
$("set-web-search").onchange = (e) => changeSetting(e.target.checked ? "web-on" : "web-off");
$("set-automatic-web").onchange = (e) => changeSetting(e.target.checked ? "auto-web-on" : "auto-web-off");
$("set-extensions-auto").onchange = (e) => { if (e.target.checked) changeSetting("extensions-auto"); };
$("set-extensions-manual").onchange = (e) => { if (e.target.checked) changeSetting("extensions-manual"); };
$("settings-close").onclick = () => showSideView("explorer");

/* ---------- Vue Extensions : serveurs MCP et skills (modules réels du CLI) ---------- */

function extItem(name, { dot = null, tag = "", sub = "", error = false, title = "" } = {}) {
    const item = document.createElement("div");
    item.className = "ext-item";
    if (title) item.title = title;
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
            list.appendChild(renderMcpCard(server, sub));
        }
    } catch (error) {
        extMessage(list, `MCP : ${error.message}`);
    }
}

async function refreshSkills() {
    return loadExtensionCenter();
}

function refreshExtensions() {
    refreshGithubPlugin();
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
    if (!await confirmStudioAction(`Remplacer « ${query} » par « ${replacement} » dans ${files.length} fichier(s) ?${limited}`)) return;

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
    if (!tab||tab.kind==="asset") {
        cursorInfo.textContent = tab?"Aperçu · lecture seule":"";
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
    cmds.push(...[
        ["Cockpit du projet","Ctrl+Maj+D",()=>showSideView("project")],
        ["Commandes et exécutions du projet","",()=>{showSideView("project");setStudioTab("tasks");}],
        ["Vérifier l’environnement","",()=>{showSideView("project");setStudioTab("quality");diagnoseStudio();}],
        ["Boîte à outils locale : JSON, Base64, SHA-256","",()=>{showSideView("project");setStudioTab("tools");}],
        ["Enregistrer tous les fichiers","Ctrl+Maj+S",saveAllStudioFiles],
        ["Aperçu Markdown ou HTML","Ctrl+Maj+V",openDocumentPreview],
        ["Comparer le document côte à côte","",openStudioCompare],
        ["Naviguer dans les symboles du document","Ctrl+Maj+O",openStudioSymbols],
        ["Marquer la ligne actuelle","Ctrl+F2",toggleStudioBookmark],
        ["Bibliothèque de skills","",()=>showSideView("extensions")],
        ["Paramètres de l’éditeur","",()=>showSideView("settings")],
        ["Raccourcis clavier","",()=>{showSideView("project");setStudioTab("shortcuts");}]
    ].map(([label,detail,run])=>({label,detail,run})));
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
        const commands=paletteCommands();
        items = q&&window.StudioVendor ? new window.StudioVendor.Fuse(commands,{keys:["label","detail"],threshold:.42,ignoreLocation:true}).search(q,{limit:100}).map(result=>result.item) : commands
            .map((c) => ({ ...c, score: fuzzyScore(`${c.label} ${c.detail}`, q) }))
            .filter((c) => c.score > 0);
        if (q&&!window.StudioVendor) items.sort((a, b) => b.score - a.score);
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
            const files=q&&window.StudioVendor ? new window.StudioVendor.Fuse(palette.files,{threshold:.4,ignoreLocation:true}).search(q,{limit:200}).map(result=>result.item):palette.files;
            const matches=q&&window.StudioVendor?files.map(p=>({p})):files
                .map((p) => ({ p, score: fuzzyScore(p, q) }))
                .filter((x) => x.score > 0)
                .sort((a, b) => b.score - a.score);
            items = matches
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
        theme: XTERM_THEME
    });
    const fit = new window.FitAddon.FitAddon();
    xterm.loadAddon(fit);
    term.xterm = xterm;
    term.fit = fit;
    terms.push(term);
    selectTerminal(term.key, false);
    xterm.open(el);
    xterm.registerLinkProvider({provideLinks(line,callback){
        const text=xterm.buffer.active.getLine(line-1)?.translateToString(true)||"";
        const links=[];
        for(const match of text.matchAll(/https?:\/\/(?:localhost|127\.0\.0\.1)(?::\d+)?(?:\/[^\s<>"']*)?/gi)){
            links.push({text:match[0],range:{start:{x:match.index+1,y:line},end:{x:match.index+match[0].length,y:line}},activate:()=>openLocalBrowser(match[0])});
        }
        callback(links);
    }});
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
    let initialOutput = (earlyPty.get(data.id) || "") + data.data;
    if (initialOutput.length > 128000) initialOutput = "\r\n[Sortie initiale abrégée pour limiter la mémoire]\r\n" + initialOutput.slice(-120000);
    earlyPty.set(data.id, initialOutput);
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
        const how = data.errorCode || (data.signal ? `signal ${data.signal}` : `code ${data.code}`);
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

/* Pending prompts live directly above the composer. */
let queueSnapshot = { tasks: [], enabled: false };
let inlineEditingId = null;
let pendingRenderSignature = null;
let draggedPendingId = null;
function clearPendingDropMarkers() {
    document.querySelectorAll(".pending-drop-before, .pending-drop-after, .pending-dragging").forEach(row => row.classList.remove("pending-drop-before", "pending-drop-after", "pending-dragging"));
}
async function editQueuedPrompt(task,attach=false){
    try{
        const result=await api.taskQueue("attachments",{id:task.id});
        inlineEditingId=task.id;input.value=task.prompt;pendingAttachments=result.attachments||[];renderAttachments();autosizeInput();saveStudioDraft();input.focus();
        studioFeedback("Modifie le prompt ou ses fichiers · Entrée pour enregistrer · Échap pour annuler");
        if(attach)$("attach-input").click();
    }catch(error){studioFeedback(error.message);}
}
function renderTaskQueue(snapshot) {
    if (!snapshot) return;
    queueSnapshot = snapshot;
    renderInlinePending(snapshot);
}
async function queueAction(action, payload = {}) {
    try {
        renderTaskQueue(await api.taskQueue(action, payload));
        return true;
    } catch (error) {
        studioFeedback(error.message);
        return false;
    }
}
function refreshTaskQueue() {
    inlineEditingId = null;
    return api.taskQueue("list").then(renderTaskQueue).catch(error => studioFeedback(error.message));
}

function renderInlinePending(snapshot) {
    const host = $("pending-prompts");
    if (!host) return;
    const waiting = (snapshot?.tasks || []).filter(task => ["pending", "steering"].includes(task.status));
    const signature = JSON.stringify([waiting, snapshot.enabled, Boolean(ui.status.canSteer)]);
    if (signature === pendingRenderSignature) return;
    pendingRenderSignature = signature;
    const openMenus = new Set([...host.querySelectorAll(".pending-menu[open]")].map(menu => menu.dataset.taskId));
    host.replaceChildren();
    host.classList.toggle("hidden", !waiting.length);
    if (waiting.length && !snapshot.enabled) {
        const paused = document.createElement("div"); paused.className = "pending-paused";
        const label = document.createElement("span"); label.textContent = `En pause · ${waiting.length} demande(s) en attente`;
        const resume = document.createElement("button"); resume.type = "button"; resume.textContent = "Reprendre"; resume.onclick = () => queueAction("start");
        paused.append(label, resume); host.appendChild(paused);
    }
    for (const task of waiting) {
        const row = document.createElement("div"); row.className = "pending-prompt";
        const icon = document.createElement("span"); icon.className = "pending-icon"; icon.textContent = "↳";
        if (task.status === "pending") {
            const handle = document.createElement("span"); handle.className = "pending-drag-handle";
            handle.textContent = "⠿"; handle.draggable = true;
            handle.title = "Glisser pour réorganiser ; utiliser le menu pour monter ou descendre au clavier";
            handle.setAttribute("aria-hidden", "true");
            handle.addEventListener("dragstart", event => {
                draggedPendingId = task.id;
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", task.id);
                row.classList.add("pending-dragging");
            });
            handle.addEventListener("dragend", () => { draggedPendingId = null; clearPendingDropMarkers(); });
            row.addEventListener("dragover", event => {
                if (!draggedPendingId || draggedPendingId === task.id) return;
                event.preventDefault(); event.dataTransfer.dropEffect = "move";
                host.querySelectorAll(".pending-drop-before, .pending-drop-after").forEach(item => item.classList.remove("pending-drop-before", "pending-drop-after"));
                const before = event.clientY < row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2;
                row.classList.add(before ? "pending-drop-before" : "pending-drop-after");
            });
            row.addEventListener("dragleave", event => {
                if (!row.contains(event.relatedTarget)) row.classList.remove("pending-drop-before", "pending-drop-after");
            });
            row.addEventListener("drop", event => {
                if (!draggedPendingId || draggedPendingId === task.id) return;
                event.preventDefault();
                const id = draggedPendingId;
                const position = event.clientY < row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2 ? "before" : "after";
                draggedPendingId = null; clearPendingDropMarkers();
                queueAction("move", { id, targetId: task.id, position });
            });
            row.appendChild(handle);
        }
        const text = document.createElement("span"); text.className = "pending-text"; text.textContent = task.prompt; text.title = task.prompt;
        if(task.attachments?.length){const files=document.createElement("small");files.className="pending-attachments";files.textContent="📎 "+task.attachments.map(file=>file.name).join(", ");files.title=files.textContent;text.append(files);}
        const steer = document.createElement("button"); steer.type = "button"; steer.className = "pending-steer"; steer.textContent = task.status === "steering" ? "Transmise…" : "Orienter";
        steer.title = "Transmettre cette consigne à l’agent en cours dès sa prochaine étape";
        steer.disabled = !ui.status.canSteer || task.status !== "pending" || task.mode === "plan";
        if(task.attachments?.length)steer.title="Transmettre cette consigne et ses fichiers à la prochaine étape de l’agent.";
        steer.onclick = () => queueAction("steer", { id: task.id });
        const remove = document.createElement("button"); remove.type = "button"; remove.className = "pending-remove"; remove.title = "Supprimer ce prompt en attente"; remove.setAttribute("aria-label", `Supprimer : ${task.prompt.slice(0, 50)}`);
        remove.innerHTML = '<svg class="i" viewBox="0 0 24 24"><path d="M4 7h16M6 7l1 13h10l1-13M9 7V4h6v3M10 10v7M14 10v7"/></svg>';
        remove.onclick = () => queueAction("remove", { id: task.id });
        const menu = document.createElement("details"); menu.className = "pending-menu";
        menu.dataset.taskId = task.id; menu.open = openMenus.has(String(task.id));
        const summary = document.createElement("summary"); summary.textContent = "⋯"; summary.setAttribute("aria-label", "Actions sur le prompt");
        const actions = document.createElement("div"); actions.className = "pending-menu-items";
        const action = (label, callback) => { const button = document.createElement("button"); button.type = "button"; button.textContent = label; button.onclick = () => { menu.open = false; callback(); }; actions.appendChild(button); };
        if (task.status === "pending") {
            action("Modifier", () => editQueuedPrompt(task));
            action("Joindre un fichier", () => editQueuedPrompt(task,true));
            action("Monter", () => queueAction("move", { id: task.id, direction: "up" }));
            action("Descendre", () => queueAction("move", { id: task.id, direction: "down" }));
        }
        menu.append(summary, actions); row.append(icon, text, steer, remove, menu); host.appendChild(row);
    }
}
/* ---------- Raccourcis globaux ---------- */

function isEditable(el) {
    return Boolean(el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "SELECT" || el.isContentEditable));
}

window.addEventListener("keydown", (ev) => {
    if (document.querySelector("dialog[open]")) return;
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
    else if (key === "w" && ev.shiftKey) action = () => toggleSideView("worktrees");
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
        !ev.target.closest("#codex-rail-brand-search") &&
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
        const data = { noPanel: $("app").classList.contains("no-panel") };
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
    if (saved.noPanel) $("app").classList.add("no-panel");
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
    set("tb-toggle-agent", !app.classList.contains("no-agent"));
}

bindClick("tb-palette", () => openPalette("files"));
bindClick("tb-toggle-sidebar", () => toggleSideView(ui.sideView || "explorer"));
bindClick("tb-toggle-panel", () => togglePanel());
bindClick("tb-toggle-agent", toggleAgent);
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
            resetToolActivity();
            renderWorkPlan([]);
            studioEntries.length = 0;
            if ($("spinner")?.parentNode === transcript) $("agent").insertBefore($("spinner"), $("prompt-zone"));
            transcript.innerHTML = "";
            resetRequestFileChanges();
            resetTranscriptFollow();
            $("agent-starter").classList.remove("hidden");
            liveEnd();
            clearChanges();
            ui.interrupted = false;
            $("btn-resume").classList.add("hidden");
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
        case "commandEnd":
            if (!ui.replayingConversation) finishToolActivity();
            break;
        case "status":
            applyStatus(data);
            break;
        case "taskQueue":
            renderTaskQueue(data);
            break;
        case "agentActivity":
            renderAgentActivity(data);
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
        $("git-setup").classList.toggle("hidden", !ui.workspace || Boolean(st && st.repo));
        $("git-identity").classList.toggle("hidden", !ui.workspace || !st || !st.repo);
        if (!st || !st.repo) {
            branch.textContent = "Pas de dépôt Git dans ce dossier.";
            gitMessage($("git-files"), "Initialisez Git pour voir les modifications de ce projet.");
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
        $("git-setup").classList.add("hidden");
        $("git-identity").classList.add("hidden");
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
$("btn-git-init").onclick = () => runGitAction("Initialisation Git", async () => {
    if (!ui.workspace) throw new Error("Ouvrez d’abord un projet.");
    const result = await api.gitInit(ui.workspace);
    return result.message;
});
$("btn-git-identity").onclick = () => runGitAction("Identité Git", async () => {
    if (!ui.workspace) throw new Error("Ouvrez d’abord un projet.");
    const result = await api.gitSetIdentity(ui.workspace, $("git-identity-name").value, $("git-identity-email").value);
    return result.message;
});
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
    if (!await confirmStudioAction(`Supprimer le worktree ${name} ?\nLa branche frst/${name} est conservée.`)) return;
    try {
        await api.worktreeRemove(name, false);
    } catch (error) {
        const reason = gitErrorText(error);
        if (!await confirmStudioAction(`Suppression refusée : ${reason}\n\nForcer la suppression ? Les modifications non validées du worktree seront perdues.`)) {
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
    if(tab?.kind==="asset")return "";
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

async function lspFormatDocument() { return formatEditorDocument(); }

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
/* ---------- Espace agent : activité, sources, favoris et brouillons ---------- */
const studioEntries = [];
let studioRun = null;
let studioWorkspace = undefined;
let studioTab = "conversation";
let studioActivitySeq = 0;
let favoritePrompts = readStudioStorage("frst.prompt-favorites", []);
if (!Array.isArray(favoritePrompts)) favoritePrompts = [];
const starterFavorites = [
    { title: "Revue des changements", prompt: "Inspecte le diff Git local et recherche les bugs et régressions. Donne les fichiers et lignes concernés, le niveau de gravité et les vérifications utiles, sans modifier le code." },
    { title: "Corriger un bug", prompt: "Reproduis le problème suivant, identifie sa cause, corrige-le puis vérifie la correction : " },
    { title: "Écrire les tests utiles", prompt: "Inspecte le code et les tests existants. Identifie les comportements importants non couverts, ajoute les tests pertinents et lance-les." },
    { title: "Améliorer les performances", prompt: "Cherche un problème de performance mesurable. Établis une mesure de référence, propose et implémente une amélioration puis compare les résultats." },
    { title: "Documenter le projet", prompt: "Vérifie les commandes et le fonctionnement réel du projet, puis mets à jour sa documentation d’installation, d’utilisation et de test." }
];

function readStudioStorage(key, fallback) {
    try { return JSON.parse(localStorage.getItem(key)) ?? fallback; } catch { return fallback; }
}
function writeStudioStorage(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch { studioFeedback("Le stockage local est indisponible."); }
}
function studioFeedback(message) { $("composer-feedback").textContent = message || ""; }
function studioDraftKey(workspace,mode=typeof motionChatMode!=="undefined"?motionChatMode:"code") {return `frst.draft:${workspace || "global"}${mode==="motion"?":motion":""}`;}
function saveStudioDraft() {
    if (studioWorkspace !== undefined) writeStudioStorage(studioDraftKey(studioWorkspace), input.value);
}
function setAgentTab(tab) {
    studioTab = ["conversation", "backups", "activity", "usage"].includes(tab) ? tab : "conversation";
    $("agent").dataset.tab = studioTab;
    for (const button of document.querySelectorAll("[data-agent-tab]")) {
        const selected = button.dataset.agentTab === studioTab;
        button.classList.toggle("selected", selected);
        button.setAttribute("aria-selected", String(selected));
        button.tabIndex = selected || button.dataset.agentTab === "conversation" ? 0 : -1;
    }
    if (studioTab === "activity" || studioTab === "backups") refreshStudioActivity();
    if (studioTab === "usage") { renderUsageDashboard(); refreshQuota(); }
}
function updateStudioStatus(status) {
    const workspace = status.workspace || null;
    updateAgentProjectLabel(workspace);
    $("agent-access").textContent = status.fullAccess ? "Full accès" : status.autoApprove && status.autoApproveCommands ? "Automatique" : "Sur approbation";
    $("agent-access").classList.toggle("full-access", Boolean(status.fullAccess));
    if (studioWorkspace !== workspace) {
        saveStudioDraft();
        studioWorkspace = workspace;
        studioActivitySeq++;
        $("activity-checkpoints").replaceChildren();
        if (studioTab === "activity" || studioTab === "backups") refreshStudioActivity();
        input.value = readStudioStorage(studioDraftKey(workspace), "");
        autosizeInput();
        if (studioRun && studioRun.workspace !== workspace) { studioRun = null; renderAgentActivity(null); }
    }
}
function updateAgentProjectLabel(workspace=ui.workspace){
    const motion=typeof isMotionOpen==="function" && isMotionOpen();
    $("agent-project-name").textContent=motion?"Projet EffectCraft":workspace?workspace.replace(/[\\/]+$/, "").split(/[\\/]/).pop():"Aucun projet";
    $("agent-project-name").title=motion?"Projet motion indépendant du dossier ouvert dans l’espace code":workspace || "Ouvre un dossier pour travailler sur un projet";
}
let franceStudentProjects=[];
// Phrase de confirmation sous les onglets (créée par 56-chat-layout.js) ; error=true la passe en rouge.
function setFranceStudentProjectState(message,error=false){const state=$("agent-fr-project-state");if(!state)return;state.textContent=message;state.classList.toggle("error",Boolean(error));}
function renderFranceStudentProjects(selected){
    const select=$("agent-fr-project");if(!select)return;
    select.replaceChildren();select.append(new Option("Aucun projet (historique général)",""));
    for(const project of franceStudentProjects){const option=new Option(project.name||"Projet sans nom",String(project.id));option.selected=String(project.id)===String(selected?.id||"");select.append(option)}
    const chatsButton=$("agent-fr-project-chats");if(chatsButton){chatsButton.disabled=!select.value;chatsButton.title=select.value?"Ouvrir une discussion de ce projet":"Choisis un projet pour voir ses discussions";}
    const current=franceStudentProjects.find(project=>String(project.id)===select.value);const name=current?.name||selected?.name||"";
    if(typeof renderComposerScope==='function')renderComposerScope();
    select.title=select.value?`Nouvelles discussions dans « ${name} »`:"Choisis le projet FranceStudent des nouvelles discussions";
    setFranceStudentProjectState(ui.status.mode === "chat"
        ? (select.value ? `Les nouvelles discussions du chat sont classées dans « ${name} ».` : "Sans projet : les discussions du chat restent dans l’historique général.")
        : "Les nouvelles discussions de l’agent sont classées dans le projet FranceStudent « Agent » ; ce sélecteur concerne le chat normal.");
}
async function refreshFranceStudentProjects(){const data=await api.frProjects("list");franceStudentProjects=Array.isArray(data.projects)?data.projects:[];renderFranceStudentProjects(data.selected);
    // Le projet mémorisé n'existe plus sur le site : on le dit au lieu de le garder en silence.
    if(data.forgotten!==undefined)setFranceStudentProjectState(`Le projet « ${data.forgotten||"mémorisé"} » n’existe plus sur FranceStudent. Sans projet : les discussions restent dans l’historique général.`,true);
    return data;}
// ↻ : recharge la liste depuis le site (et revérifie le projet mémorisé).
$("agent-fr-project-refresh")?.addEventListener("click",async event=>{
    const button=event.currentTarget;button.disabled=true;setFranceStudentProjectState("Actualisation des projets…");
    try{await refreshFranceStudentProjects();}
    catch(error){setFranceStudentProjectState(`Impossible d’actualiser les projets : ${error.message}`,true);}
    finally{button.disabled=false}
});
// Après la reprise d'une discussion : resélectionne son projet FranceStudent et signale un dossier associé introuvable.
// Le changement de dossier lui-même arrive par le statut (onWorkspaceChanged dans 05-status-model.js).
function afterConversationOpened(result){
    if(!result)return;
    if(result.frProject?.id && $("agent-fr-project")?.value!==String(result.frProject.id))renderFranceStudentProjects(result.frProject);
    if(result.folderMissing)studioFeedback(`Le dossier associé à cette discussion est introuvable : ${result.folderMissing}. La discussion est ouverte dans le dossier actuel.`);
    else if(result.workspaceChanged && result.workspace)studioFeedback(`Dossier du projet ouvert : ${result.workspace}`);
}
async function createFranceStudentProject(){
    const name=await inputDialog("Créer un projet FranceStudent","Donne un nom à ce groupe de conversations.");if(!name)return;
    const result=await api.frProjects("create",{name});franceStudentProjects=result.projects||franceStudentProjects;renderFranceStudentProjects(result.selected);studioFeedback(result.created?`Projet « ${result.selected.name} » créé. Les nouvelles discussions y seront classées.`:`Projet « ${result.selected.name} » sélectionné.`);
}
$("agent-fr-project")?.addEventListener("change",async event=>{
    const select=event.currentTarget;select.disabled=true;
    try{const result=await api.frProjects(select.value?"select":"clear",select.value?{id:select.value}:{});franceStudentProjects=result.projects||franceStudentProjects;renderFranceStudentProjects(result.selected);studioFeedback(result.selected?`Les nouvelles discussions seront classées dans « ${result.selected.name} ».`:"Les nouvelles discussions ne seront rattachées à aucun projet FranceStudent.");}
    catch(error){studioFeedback(error.message);await refreshFranceStudentProjects().catch(()=>{});}finally{select.disabled=false}
});
$("agent-fr-project-create")?.addEventListener("click",()=>createFranceStudentProject().catch(error=>studioFeedback(error.message)));
// Liste les discussions du projet FranceStudent choisi et reprend celle sélectionnée (chargement API si absente localement).
async function openFranceStudentProjectChats(forceChat=false){
    const projectId=$("agent-fr-project")?.value||"";if(!projectId){studioFeedback("Choisis d’abord un projet FranceStudent.");return;}
    const project=franceStudentProjects.find(item=>String(item.id)===projectId);
    const previous=document.activeElement,dialog=document.createElement("dialog");dialog.id="fr-project-chats-dialog";dialog.className="fs-dialog fs-project-chats-dialog";
    studioSurfaceHeader(dialog,{title:"Discussions du projet",subtitle:`Reprends une conversation de « ${project?.name||"Projet sans nom"} ».`,icon:"chat"});
    const status=centerNode("p","fs-section-description","Chargement des discussions…");status.setAttribute("role","status");
    const list=centerNode("div","fs-project-chat-list");list.setAttribute("role","list");
    const more=centerNode("button","","Charger plus");more.type="button";more.hidden=true;
    dialog.append(studioSurfaceSection("Conversations","",[status,list,more]));document.body.append(dialog);
    dialog.addEventListener("close",()=>{dialog.remove();requestAnimationFrame(()=>{if(previous?.isConnected)previous.focus();});},{once:true});
    let cursor="";
    const openChat=async id=>{
 if(ui.status && ui.status.busy){studioFeedback("Une demande est en cours : attends sa fin avant de changer de conversation.");return;}
        dialog.close();
        try{if(isMotionOpen())await closeMotionDesign();const result=await api.conversationsOpen(id,{projectId,projectName:project?.name||"",mode:forceChat || ui.status.mode === "chat" ? "chat" : ""});setAgentTab("conversation");afterConversationOpened(result);}catch(error){studioFeedback(error.message);}
    };
    const load=async()=>{
 more.disabled=true;
 try{
     const data=await api.frProjects("chats",{id:projectId,limit:30,cursorChatId:cursor});const chats=Array.isArray(data?.chats)?data.chats:[];
     for(const chat of chats){
         const id=String(chat?.id||chat?.chatId||"");if(!id)continue;
  const item=centerNode("button","fs-project-chat-item");item.type="button";item.setAttribute("role","listitem");
  const when=chat.updatedAt||chat.updated_at||chat.lastMessageAt||chat.createdAt||chat.created_at;
         const date=when&&!Number.isNaN(new Date(when).getTime())?new Date(when).toLocaleString("fr-FR",{day:"numeric",month:"short",hour:"2-digit",minute:"2-digit"}):"";
         item.append(centerNode("strong","",chat.title||chat.name||chat.chatName||"Discussion sans titre"),centerNode("span","",[date,chat.model].filter(Boolean).join(" · ")||`ID ${id}`));
         item.title=`Reprendre cette discussion (${id})`;item.onclick=()=>openChat(id);list.append(item);
     }
     const last=chats.at(-1);cursor=last?String(last.id||last.chatId||""):"";more.hidden=!data?.hasMore||!cursor;
     status.textContent=list.children.length?"":"Aucune discussion dans ce projet pour l’instant.";
        }catch(error){status.textContent=error.message;}finally{more.disabled=false;}
    };
    more.onclick=()=>load();dialog.showModal();await load();
}
$("agent-fr-project-chats")?.addEventListener("click",()=>openFranceStudentProjectChats().catch(error=>studioFeedback(error.message)));
// Au démarrage, la session peut ne pas être encore restaurée : on réessaie seul avant d'afficher une erreur,
// puis on recharge quand l'écran de chargement ou le guide de connexion disparaît.
let franceStudentProjectsLoaded=false,franceStudentProjectsRetry=null,franceStudentProjectsLoading=false;
async function loadFranceStudentProjectsAtStartup(attempt=0){
    clearTimeout(franceStudentProjectsRetry);
    if(franceStudentProjectsLoaded || franceStudentProjectsLoading)return;
    franceStudentProjectsLoading=true;
    try{await refreshFranceStudentProjects();franceStudentProjectsLoaded=true;}
    catch(error){
        if(attempt<5){setFranceStudentProjectState("Chargement des projets FranceStudent…");franceStudentProjectsRetry=setTimeout(()=>loadFranceStudentProjectsAtStartup(attempt+1),Math.min(1000*2**attempt,8000));}
        else setFranceStudentProjectState(`Impossible de charger les projets FranceStudent : ${error.message} Utilise ↻ pour réessayer.`,true);
    }finally{franceStudentProjectsLoading=false;}
}
loadFranceStudentProjectsAtStartup();
for(const [id,attribute] of [["startup-loading","hidden"],["connection-guide","class"]]){
    const node=$(id);if(!node)continue;
    new MutationObserver(()=>{const ready=$("startup-loading")?.hidden!==false && $("connection-guide")?.classList.contains("hidden")!==false;if(ready && !franceStudentProjectsLoaded)loadFranceStudentProjectsAtStartup();}).observe(node,{attributes:true,attributeFilter:[attribute]});
}
function recordStudioEntry(entry) {
    if (entry.type === "user" && /^\/new\b/.test(entry.text || "")) studioEntries.length = 0;
    if (["user", "assistant", "tool", "result", "error", "warn", "plan"].includes(entry.type)) {
        studioEntries.push({ ...entry, at: new Date().toISOString() });
        if (studioEntries.length > 3000) studioEntries.shift();
    }
}
function exportStudioMarkdown() {
    const header = `# Conversation FranceStudent ${isMotionOpen()?"Motion design":"Code"}\n\nProjet : ${isMotionOpen()?"EffectCraft":studioWorkspace || "Aucun"}\nExport : ${new Date().toISOString()}\n\n`;
    return header + studioEntries.map(entry => {
        if (entry.type === "user" || entry.type === "assistant") return `## ${entry.type === "user" ? "Vous" : "Agent"}\n\n${entry.text}\n`;
        if (entry.type === "tool") return `**${toolLabel(entry.name)}**\n\n\`\`\`text\n${entry.arg || ""}\n\`\`\`\n`;
        if (entry.type === "plan") return `### Plan\n${(entry.items || []).map(item => `- ${item}`).join("\n")}\n`;
        return `> ${String(entry.text || "").replace(/\n/g, "\n> ")}\n`;
    }).join("\n");
}
function humanDuration(start, end) {
    const seconds = Math.max(0, Math.floor(((end || Date.now()) - start) / 1000));
    return seconds < 60 ? `${seconds} s` : `${Math.floor(seconds / 60)} min ${String(seconds % 60).padStart(2, "0")} s`;
}
function emptyStudioText(parent, text) {
    const note = document.createElement("p"); note.className = "muted"; note.textContent = text; parent.appendChild(note);
}
function renderAgentActivity(run) {
    const motion=typeof isMotionOpen==="function" && isMotionOpen();
    if(run && (!!run.motionDesign!==motion || !motion && run.workspace!==ui.workspace))run=null;
    studioRun = run;
    const steps = run?.steps || [];
    if (!ui.replayingConversation) renderWorkPlan(steps, { status: run?.status || "idle" });
    const overview = $("activity-overview"); overview.replaceChildren();
    const timeline = $("activity-timeline"); timeline.replaceChildren();
    const sources = $("activity-sources"); sources.replaceChildren();
    if (!run) {
        emptyStudioText(overview, "Les actions, les commandes et les sources apparaîtront ici dès la prochaine demande.");
        return;
    }
    const status = { running: "En cours", done: "Terminée", failed: "À vérifier", interrupted: "Interrompue" }[run.status] || run.status;
    const title = document.createElement("div"); title.className = "run-title"; title.textContent = run.prompt;
    const line = document.createElement("p"); line.className = `run-status run-status-${run.status}`; line.textContent = `${status} · ${humanDuration(run.startedAt, run.endedAt)}`;
    const stats = document.createElement("div"); stats.className = "activity-stats";
    for (const [value, label] of [[run.commands, "commandes"], [run.reads, "explorations"], [run.writes, "écritures"]]) {
        const stat = document.createElement("div"); const number = document.createElement("strong"); number.textContent = value || 0;
        const name = document.createElement("small"); name.textContent = label; stat.append(number, name); stats.appendChild(stat);
    }
    overview.append(title, line, stats);
    for (const action of (run.actions || []).slice().reverse()) {
        const row = document.createElement("details"); row.className = `activity-action activity-action-${action.status}`;
        const summary = document.createElement("summary"); summary.textContent = `${action.status === "done" ? "✓" : action.status === "running" ? "◉" : "!"} ${toolLabel(action.name)} · ${humanDuration(action.startedAt, action.endedAt)}`;
        const body = document.createElement("pre"); body.textContent = [action.argument, action.result].filter(Boolean).join("\n\n");
        row.append(summary, body); timeline.appendChild(row);
    }
    if (!run.actions?.length) emptyStudioText(timeline, "L’agent prépare sa prochaine action.");
    for (const source of run.sources || []) {
        const row = document.createElement("button"); row.type = "button"; row.className = "source-card";
        const title = document.createElement("strong"); title.textContent = source.title;
        const meta = document.createElement("small");
        try { meta.textContent = `${new URL(source.url).hostname} · ${source.consulted ? "Source consultée" : "Résultat de recherche"}`; } catch { continue; }
        row.append(title, meta); row.onclick = () => api.openExternal(source.url).catch(error => studioFeedback(error.message)); sources.appendChild(row);
    }
    if (!run.sources?.length) emptyStudioText(sources, "Les liens sont distingués selon qu’ils ont été trouvés ou effectivement consultés.");
}
async function refreshStudioActivity() {
    const seq = ++studioActivitySeq;
    try {
        const motion=isMotionOpen();
        const [run, jobs, checkpoints] = await Promise.all([api.agentActivity(), motion?[]:api.backgroundJobs("list"), motion?[]:api.checkpoints("list")]);
        if (seq !== studioActivitySeq) return;
        renderAgentActivity(run);
        const jobsHost = $("activity-jobs"); jobsHost.replaceChildren();
        if (!jobs.length) emptyStudioText(jobsHost, "Aucune commande en arrière-plan.");
        for (const job of jobs) {
            const row = document.createElement("div"); row.className = "workspace-item";
            const label = document.createElement("div"); label.textContent = `${job.id} · ${job.command}`;
            const meta = document.createElement("small"); meta.textContent = `${job.status} · ${Math.floor(job.duration_ms / 1000)} s${job.exit_code !== null ? ` · code ${job.exit_code}` : ""}`;
            const output = document.createElement("button"); output.type = "button"; output.textContent = "Sortie";
            output.onclick = async () => { try { const result = await api.backgroundJobs("output", job.id); $("activity-job-output").textContent = result.output || "Aucune sortie."; $("activity-job-output").classList.remove("hidden"); } catch (error) { studioFeedback(error.message); } };
            row.append(label, meta, output);
            if (job.status === "running") {
                const stop = document.createElement("button"); stop.type = "button"; stop.textContent = "Arrêter";
                stop.onclick = () => api.backgroundJobs("stop", job.id).then(refreshStudioActivity).catch(error => studioFeedback(error.message)); row.appendChild(stop);
            }
            jobsHost.appendChild(row);
        }
        const pointsHost = $("activity-checkpoints"); pointsHost.replaceChildren();
        if (!checkpoints.length) emptyStudioText(pointsHost, motion ? "Les sauvegardes des fichiers sont disponibles dans l’espace Code." : "Les versions disponibles apparaîtront ici après une demande à l’agent.");
        for (const point of checkpoints) {
            const row = document.createElement("div"); row.className = "workspace-item";
            const label = document.createElement("div"); label.textContent = point.task || "Version sans titre";
            const time = document.createElement("small"); time.textContent = `${new Date(point.at).toLocaleString("fr-FR")} · ${point.kind === "safety" ? "Sécurité avant restauration" : "Avant la demande"}`;
            const restore = document.createElement("button"); restore.type = "button"; restore.textContent = "Voir et restaurer"; restore.disabled = Boolean(ui.status.busy);
            restore.onclick = async () => {
                if (ui.tabs.some(tab => tab.dirty)) { studioFeedback("Enregistre tous les fichiers ouverts avant de restaurer une version."); return; }
                restore.disabled = true;
                try {
                    const preview = await api.checkpoints("preview", point.id);
                    if (!preview.changes.length) { studioFeedback("Les fichiers suivis correspondent déjà à cette version."); return; }
                    if (preview.changes.length > 100) { studioFeedback("Plus de 100 fichiers diffèrent : restauration désactivée pour éviter un aperçu incomplet."); return; }
                    const details = preview.changes.map(change => `${change.action} : ${change.path}`).join("\n");
                    const excluded = preview.excludedPaths || [];
                    const excludedDetails = excluded.length ? `\n\nChemins exclus (${excluded.length}) :\n${excluded.slice(0, 20).join("\n")}${excluded.length > 20 ? `\n… et ${excluded.length - 20} autre(s).` : ""}` : "";
                    const message = `Revenir à l’état précédant « ${point.task} » ?\n\n${details}\n\nTous les changements listés depuis cette version seront annulés, y compris tes modifications manuelles et celles des demandes suivantes. Les fichiers marqués « retirer » seront supprimés. Une version de sécurité sera créée avant la restauration.${excludedDetails}\n\nLes chemins exclus et les actions externes ne sont pas restaurés.`;
                    if (!await confirmStudioAction(message, { title: "Restaurer une version", confirmLabel: "Restaurer", danger: true })) return;
                    if (ui.tabs.some(tab => tab.dirty)) throw new Error("Enregistre tous les fichiers ouverts avant de restaurer une version.");
                    const workspace = ui.workspace;
                    const result = await api.checkpoints("restore", point.id, preview.expected);
                    let dirtyRemoved = false;
                    if (ui.workspace === workspace) {
                        for (const change of preview.changes.filter(item => item.action === "retirer")) {
                            const tab = ui.tabs.find(item => item.path === change.path);
                            if (!tab) continue;
                            if (tab.dirty) { dirtyRemoved = true; continue; }
                            await closeTab(tab.path);
                        }
                    }
                    studioFeedback(`${result.restored} fichier(s) restauré(s).${dirtyRemoved ? " Un onglet modifié reste ouvert alors que son fichier a été retiré : vérifie son contenu avant de l’enregistrer." : ""}`);
                    scheduleRefresh(); refreshStudioActivity();
                } catch (error) { studioFeedback(error.message); scheduleRefresh(); refreshStudioActivity(); }
                finally { restore.disabled = Boolean(ui.status.busy); }
            };
            const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "Supprimer la version"; remove.disabled = Boolean(ui.status.busy);
            remove.onclick = async () => {
                if (!await confirmStudioAction(`Supprimer définitivement la version « ${point.task || "sans titre"} » ? Les fichiers actuels ne seront pas modifiés.`, { title: "Supprimer une version", confirmLabel: "Supprimer", danger: true })) return;
                remove.disabled = true;
                try { await api.checkpoints("remove", point.id); studioFeedback("Version supprimée."); await refreshStudioActivity(); }
                catch (error) { studioFeedback(error.message); }
                finally { remove.disabled = Boolean(ui.status.busy); }
            };
            row.append(label, time, restore, remove); pointsHost.appendChild(row);
        }
    } catch (error) { studioFeedback(error.message); }
}
function renderFavoritePrompts() {
    const list = $("favorite-list"); list.replaceChildren();
    for (const [index, favorite] of [...favoritePrompts, ...starterFavorites].entries()) {
        const row = document.createElement("div"); row.className = "favorite-row";
        const use = document.createElement("button"); use.type = "button"; use.textContent = favorite.title; use.title = favorite.prompt;
        use.onclick = () => { input.value = favorite.prompt; saveStudioDraft(); autosizeInput(); setAgentTab("conversation"); $("agent-favorites").classList.add("hidden"); input.focus(); };
        row.appendChild(use);
        if (index < favoritePrompts.length) {
            const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "×"; remove.setAttribute("aria-label", `Retirer ${favorite.title}`);
            remove.onclick = () => { favoritePrompts.splice(index, 1); writeStudioStorage("frst.prompt-favorites", favoritePrompts); renderFavoritePrompts(); }; row.appendChild(remove);
        }
        list.appendChild(row);
    }
}

for (const button of document.querySelectorAll("[data-agent-tab]")) {
    button.onclick = () => setAgentTab(button.dataset.agentTab);
    button.onkeydown = event => {
        if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
        event.preventDefault();
        const tabs = [...document.querySelectorAll("[data-agent-tab]")].filter(tab => tab.getClientRects().length);
        const next = tabs[(tabs.indexOf(button) + (event.key === "ArrowLeft" ? tabs.length - 1 : 1)) % tabs.length];
        setAgentTab(next.dataset.agentTab); next.focus();
    };
}
for (const button of document.querySelectorAll("[data-starter]")) button.onclick = () => { input.value = button.dataset.starter; autosizeInput(); saveStudioDraft(); input.focus(); };
$("agent-access").onclick = () => showSideView("settings");
function setAgentFocus(active){
    $("app").classList.toggle("focus-agent",active);
}
function renderWindowFullscreen(active){
    const button=$("agent-focus"), label=active?"Quitter le plein écran":"Plein écran";
    button.setAttribute("aria-pressed",String(active));button.setAttribute("aria-label",label);button.title=label;
    button.textContent=active?"⤡":"⤢";
}
$("agent-focus").onclick = () => {
    if (!$("app").classList.contains("focus-agent")) setAgentFocus(true);
    api.windowFullscreen("toggle").catch(error => studioFeedback(error.message));
};
api.onEvent((channel, active) => { if (channel === "windowFullscreen") renderWindowFullscreen(Boolean(active)); });
api.windowFullscreen("status").then(renderWindowFullscreen).catch(() => renderWindowFullscreen(false));
setAgentFocus(true);
$("activity-refresh").onclick = refreshStudioActivity;
// Interrupteur des sauvegardes automatiques (réglage checkpointBackupsEnabled).
// Jamais choisi (undefined) = activé, comme côté agent (!== false).
const backupsToggle = $("backups-enabled");
function renderBackupsToggle(enabled) {
    backupsToggle.checked = enabled;
    $("backups-enabled-label").textContent = enabled ? "Activées" : "Désactivées";
}
async function loadBackupsToggle() {
    try { renderBackupsToggle(await api.checkpointPreference("get") !== false); }
    catch (error) { studioFeedback(error.message); }
}
backupsToggle.onchange = async () => {
    const wanted = backupsToggle.checked;
    if (wanted && !await confirmStudioAction("Les sauvegardes automatiques consomment énormément de stockage : l’IDE copie les fichiers du projet avant chaque demande modifiable de l’agent. Sur un projet moyen ou grand, ces copies peuvent occuper plusieurs gigaoctets. Activer quand même ?", { title: "Activer les sauvegardes automatiques ?", confirmLabel: "Activer quand même" })) {
        renderBackupsToggle(false);
        return;
    }
    backupsToggle.disabled = true;
    try {
        renderBackupsToggle(await api.checkpointPreference("set", wanted));
        studioFeedback(wanted ? "Sauvegardes automatiques activées. Surveille l’espace disque." : "Sauvegardes automatiques désactivées : aucune nouvelle version ne sera créée avant les demandes.");
    } catch (error) {
        renderBackupsToggle(!wanted);
        studioFeedback(error.message);
    } finally {
        backupsToggle.disabled = false;
    }
};
loadBackupsToggle();
$("backups-refresh").onclick = () => { loadBackupsToggle(); refreshStudioActivity(); };
$("favorite-open").onclick = () => { renderFavoritePrompts(); $("agent-favorites").classList.toggle("hidden"); };
$("favorite-close").onclick = () => $("agent-favorites").classList.add("hidden");
$("draft-save-favorite").onclick = () => {
    const prompt = input.value.trim();
    if (!prompt) { studioFeedback("Écris un prompt avant de l’enregistrer."); return; }
    if (favoritePrompts.length >= 30) { studioFeedback("Tu as déjà 30 favoris. Retire un favori pour en ajouter un."); return; }
    favoritePrompts.unshift({ title: prompt.replace(/\s+/g, " ").slice(0, 55), prompt: prompt.slice(0, 30000) });
    writeStudioStorage("frst.prompt-favorites", favoritePrompts); studioFeedback("Prompt enregistré en favori.");
};
$("conversation-export").onclick = () => api.exportConversation(exportStudioMarkdown()).then(result => studioFeedback(result.canceled ? "Export annulé." : "Conversation exportée.")).catch(error => studioFeedback(error.message));
input.addEventListener("input", saveStudioDraft);
window.addEventListener("beforeunload", saveStudioDraft);
transcript.addEventListener("click", event => {
    const chip = event.target.closest("button[data-open-path]");
    if (chip) { event.preventDefault(); const target = chip.dataset.openPath || ""; if (target && !target.startsWith("../") && !/^(?:[a-z]:|\/)/i.test(target)) openFile(target); return; }
    const link = event.target.closest("a[data-web-url]");
    if (link) { event.preventDefault(); api.openExternal(link.dataset.webUrl).catch(error => studioFeedback(error.message)); }
});
setInterval(() => { if ((studioTab === "activity" || studioTab === "backups") && !document.hidden) refreshStudioActivity(); }, 3000);
setAgentTab("conversation");
/* Connexion explicite et guide accessible, sans identifiants dans le chat. */
let guideStep = 1;
let guideBusy = false;
let guideReturnFocus = null;
let connectionOrigin = "https://ia.francestudent.org";

function openConnectionGuide(step) {
    guideReturnFocus = document.activeElement;
    $("connection-guide").classList.remove("hidden");
    setGuideStep(step || (ui.status.booted ? (ui.workspace ? 3 : 2) : 1));
    setTimeout(() => {
        const first = $("connection-guide").querySelector('input:not(:disabled), button:not(:disabled)');
        if (guideStep === 1 && !ui.status.booted) $("guide-email").focus();
        else if (first) first.focus();
    }, 0);
}
function closeConnectionGuide() {
    if (guideBusy) return;
    $("guide-password").value = "";
    $("connection-guide").classList.add("hidden");
    if (guideReturnFocus?.isConnected) guideReturnFocus.focus();
    else input.focus();
}
function setGuideStep(step) {
    guideStep = [1, 2, 3].includes(step) ? step : 1;
    for (const page of document.querySelectorAll("[data-guide-page]")) page.classList.toggle("hidden", Number(page.dataset.guidePage) !== guideStep);
    for (const marker of document.querySelectorAll("[data-guide-step]")) {
        marker.classList.toggle("current", Number(marker.dataset.guideStep) === guideStep);
        if (Number(marker.dataset.guideStep) === guideStep) marker.setAttribute("aria-current", "step");
        else marker.removeAttribute("aria-current");
    }
    $("guide-title").textContent = ["", "Bienvenue. On commence ?", "Ouvre le bon dossier", "Ta première demande"][guideStep];
    $("guide-description").textContent = ["", "Connecte-toi avec les mêmes identifiants que sur le site FranceStudent.", "Pas besoin de configuration technique : choisis simplement le dossier de ton projet.", "L’agent comprend tes demandes en français. Tu peux préciser ou corriger ce que tu veux au fil du travail."][guideStep];
    $("guide-login-form").classList.toggle("hidden", Boolean(ui.status.booted));
    $("guide-already-connected").classList.toggle("hidden", !ui.status.booted);
    $("guide-project-name").textContent = ui.workspace ? `Dossier choisi : ${ui.workspace.replace(/[\\/]+$/, "").split(/[\\/]/).pop()}` : "Tu pourras aussi ouvrir un dossier plus tard avec le bouton Ouvrir un dossier.";
    $("guide-project-next").disabled = !ui.workspace;
    $("guide-message").textContent = "";
    $("guide-message").classList.remove("is-error");
}
function guideError(error) {
    const message = String(error?.message || error || "Connexion impossible.");
    const special = /captcha|double authentification|two.factor|cloudflare/i.test(message);
    $("guide-message").textContent = special
        ? "Ton compte demande une vérification supplémentaire que cette connexion ne prend pas encore en charge. Ouvre le site FranceStudent pour vérifier ton accès."
        : /password|mot de passe|identifiant|invalid|incorrect|401|403/i.test(message)
            ? "Connexion refusée. Vérifie l’adresse e-mail et le mot de passe de ton compte FranceStudent."
            : "La connexion n’a pas abouti. Vérifie tes identifiants et ta connexion Internet, puis réessaie.";
    $("guide-message").classList.add("is-error");
}

$("guide-login-form").onsubmit = async event => {
    event.preventDefault();
    if (guideBusy || !$("guide-login-form").reportValidity()) return;
    guideBusy = true;
    $("guide-message").textContent = "Connexion à FranceStudent…";
    $("guide-message").classList.remove("is-error");
    $("guide-login-submit").textContent = "Connexion…";
    $("guide-login-form").setAttribute("aria-busy", "true");
    for (const control of $("connection-guide").querySelectorAll("input, button")) control.disabled = true;
    try {
        const result = await api.loginAccount({ email: $("guide-email").value.trim(), password: $("guide-password").value });
        if (!result?.ok) throw new Error(result?.reason || "Connexion impossible.");
        applyStatus(await api.status());
        setGuideStep(2);
        if(result.credentialWarning)$("guide-message").textContent=result.credentialWarning;
    } catch (error) { guideError(error); }
    finally {
        $("guide-password").value = "";
        guideBusy = false;
        for (const control of $("connection-guide").querySelectorAll("input, button")) control.disabled = false;
        $("guide-project-next").disabled = !ui.workspace;
        $("guide-login-submit").textContent = "Se connecter";
        $("guide-login-form").removeAttribute("aria-busy");
    }
};
$("guide-close").onclick = closeConnectionGuide;
$("guide-finish").onclick = closeConnectionGuide;
$("settings-guide").onclick = () => openConnectionGuide();
$("settings-logout").onclick = async () => {
    $("settings-logout").disabled = true;
    $("settings-message").textContent = "Déconnexion…";
    try { await api.logoutAccount(); }
    catch (error) {
        $("settings-message").textContent = `Déconnexion non terminée : ${error.message}`;
        applyStatus(await api.status());
    }
};
api.onEvent(async channel => {
    if (channel !== "signedOut") return;
    applyStatus(await api.status());
    ui.quota = null;
    renderQuota();
    $("guide-email").value = "";
    $("guide-password").value = "";
    $("guide-password").type = "password";
    $("guide-show-password").textContent = "Afficher";
    $("guide-show-password").setAttribute("aria-pressed", "false");
    $("guide-show-password").setAttribute("aria-label", "Afficher le mot de passe");
    showSideView("explorer");
    openConnectionGuide(1);
    $("guide-message").textContent = "Tu es déconnecté de cet ordinateur. Tu peux te reconnecter ou utiliser un autre compte.";
});
if ($("btn-help")) {
    $("btn-help").onclick = () => openConnectionGuide();
    $("btn-help").title = "Connexion et guide de démarrage";
}
$("guide-to-project").onclick = () => setGuideStep(2);
$("guide-show-password").onclick = () => {
    const reveal = $("guide-password").type === "password";
    $("guide-password").type = reveal ? "text" : "password";
    $("guide-show-password").textContent = reveal ? "Masquer" : "Afficher";
    $("guide-show-password").setAttribute("aria-pressed", String(reveal));
    $("guide-show-password").setAttribute("aria-label", reveal ? "Masquer le mot de passe" : "Afficher le mot de passe");
};
$("guide-open-site").onclick = () => api.openExternal(connectionOrigin).catch(guideError);
$("guide-open-account").onclick = () => api.openExternal(connectionOrigin).catch(guideError);
$("guide-pick-project").onclick = async () => {
    try { await api.openProject(); applyStatus(await api.status()); setGuideStep(2); }
    catch (error) { $("guide-message").textContent = error.message; }
};
$("guide-skip-project").onclick = () => setGuideStep(3);
$("guide-project-next").onclick = () => setGuideStep(3);
$("guide-first-prompt").onclick = () => {
    closeConnectionGuide();
    setAgentTab("conversation");
    input.value = ui.workspace ? "Explore ce projet et explique-moi comment le lancer et le vérifier." : "Explique-moi comment tu peux m’aider et comment démarrer mon premier projet.";
    saveStudioDraft(); autosizeInput(); input.focus();
};
$("connection-guide").addEventListener("keydown", event => {
    if (event.key === "Escape") { event.preventDefault(); closeConnectionGuide(); return; }
    if (event.key !== "Tab") return;
    const controls = [...$("connection-guide").querySelectorAll("button:not(:disabled), input:not(:disabled), summary")].filter(element => element.offsetParent !== null);
    const first = controls[0], last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
});
/* ---------- Bibliothèque, skills installés et profils ---------- */
let centerData = null;
let skillEditorState = null;
let centerLoading = 0;
let installedVisibleCount = 60;
function centerNode(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
}
function centerButton(text, handler, primary = false) {
    const button = centerNode("button", primary ? "primary" : "", text);
    button.type = "button";
    button.onclick = async () => {
        button.disabled = true;
        try { await handler(); }
        catch (error) { $("center-message").textContent = error.message; }
        finally { button.disabled = false; }
    };
    return button;
}
function uninstallSkillButton(skill){
    const button=centerButton("Désinstaller",()=>uninstallCenterSkill(skill));
    button.classList.add("skill-uninstall");return button;
}
function setCenterTab(tab) {
    if (tab === "mcp") refreshPluginInstallations();
    const headings = { mcp: "Plugins", github: "GitHub", installed: "Skills", library: "Bibliothèque de skills", roblox: "Roblox · Blender", marketplace: "Marketplace code", motion: "Motion design" };
    const title = $("center-page-title");
    if (title) title.textContent = headings[tab] || "Personnaliser";
    for (const panel of document.querySelectorAll("[data-center-panel]")) panel.classList.toggle("hidden", panel.dataset.centerPanel !== tab);
    for (const select of document.querySelectorAll(".center-skill-section-select")) select.value = tab === "mcp" ? "installed" : tab;
    for (const button of document.querySelectorAll("[data-center-tab]")) {
        const selected = button.dataset.centerTab === (["mcp", "github"].includes(tab) ? tab : "installed");
        button.setAttribute("aria-selected", String(selected));
        button.tabIndex = selected ? 0 : -1;
    }
}
// Une seule entrée Skills ; les différentes collections se choisissent dans son contenu.
for (const panel of document.querySelectorAll('[data-center-panel]:not([data-center-panel="mcp"]):not([data-center-panel="github"])')) {
    const label = centerNode("label", "center-skill-section-label", "Afficher ");
    const select = centerNode("select", "center-skill-section-select");
    select.setAttribute("aria-label", "Choisir les skills à afficher");
    for (const [value, text] of [["installed", "Mes skills"], ["library", "Bibliothèque"], ["marketplace", "Skills de la communauté"], ["roblox", "Roblox et Blender"], ["motion", "Motion design"]]) {
        const option = centerNode("option", "", text); option.value = value; select.append(option);
    }
    select.value = panel.dataset.centerPanel;
    select.onchange = () => setCenterTab(select.value);
    label.append(select); panel.prepend(label);
}
for (const button of document.querySelectorAll("[data-center-tab]")) {
    button.onclick = () => setCenterTab(button.dataset.centerTab);
    button.onkeydown = event => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const buttons = [...document.querySelectorAll("[data-center-tab]")];
        const index = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : (buttons.indexOf(button) + (event.key === "ArrowRight" ? 1 : buttons.length - 1)) % buttons.length;
        buttons[index].click(); buttons[index].focus();
    };
}
$("ext-close").onclick = () => showSideView("explorer");
$("plugin-github-entry").querySelector(".plugin-entry-icon").append(document.querySelector('[data-center-tab="github"] svg').cloneNode(true));
$("plugin-github-entry").onclick = () => setCenterTab("github");
let pluginInstallSequence = 0;
function placeInstalledPlugin(kind, installed) {
    const entry = $(`plugin-${kind}-entry`), host = $(installed ? "plugin-installed" : "plugin-public");
    if (entry.parentElement !== host) host.insertBefore(entry, $(installed ? "plugin-installed-empty" : "plugin-public-empty"));
    const shortcut = $(`plugin-${kind}-shortcut`); if (shortcut) shortcut.hidden = !installed;
}
async function refreshPluginInstallations() {
    const sequence = ++pluginInstallSequence;
    // Lecture locale seulement : ni démarrage MCP ni appel au modèle.
    const results = await Promise.allSettled([api.githubStatus(), api.creativePlugins("status")]);
    if (sequence !== pluginInstallSequence) return;
    if (results[0].status === "fulfilled") placeInstalledPlugin("github", Boolean(results[0].value.connected));
    if (results[1].status === "fulfilled") for (const kind of ["roblox", "blender"]) placeInstalledPlugin(kind, Boolean(results[1].value[kind].installed));
    filterPlugins();
}
function filterPlugins() {
    const query = $("plugin-search").value.trim().toLocaleLowerCase("fr");
    for (const entry of document.querySelectorAll(".plugin-entry")) entry.hidden = !entry.textContent.toLocaleLowerCase("fr").includes(query);
    for (const category of ["public", "installed"]) {
        const host = $(`plugin-${category}`), any = [...host.querySelectorAll(".plugin-entry")].some(entry => !entry.hidden);
        $(`plugin-${category}-empty`).hidden = any;
        if (category === "public") $(`plugin-${category}-empty`).textContent = query ? "Aucun plugin ne correspond à ta recherche." : "Tous les plugins disponibles sont installés.";
        else $(`plugin-${category}-empty`).textContent = query ? "Aucun plugin installé ne correspond à ta recherche." : "Aucun plugin installé. Configure un plugin, puis vérifie sa connexion pour le retrouver ici.";
    }
    const cards = [...$("mcp-list").children].filter(card => !card.classList.contains("ext-empty"));
    for (const card of cards) card.hidden = !card.textContent.toLocaleLowerCase("fr").includes(query);
    $("plugin-personal-empty").hidden = !query || !cards.length || cards.some(card => !card.hidden);
}
$("plugin-search").addEventListener("input", filterPlugins);
new MutationObserver(filterPlugins).observe($("mcp-list"), {childList:true});
for (const button of document.querySelectorAll("[data-plugin-filter]")) button.onclick = () => {
    for (const category of ["public", "installed", "personal"]) $(`plugin-${category}`).hidden = button.dataset.pluginFilter !== category;
    refreshPluginInstallations();
    for (const item of document.querySelectorAll("[data-plugin-filter]")) item.setAttribute("aria-pressed", String(item === button));
};
async function refreshGithubPlugin() {
    const status = $("plugin-github-status");
    try {
        const account = await api.githubStatus();
        placeInstalledPlugin("github", Boolean(account.connected)); filterPlugins();
        status.textContent = account.connected ? `Connecté : ${account.login || "GitHub"}` : account.error ? `Connexion indisponible : ${gitErrorText(account.error)}` : "Aucun compte connecté.";
        $("plugin-github-token-option").hidden = Boolean(account.connected);
        $("plugin-github-device").hidden = Boolean(account.connected);
        $("plugin-github-open").hidden = !account.connected;
        $("plugin-github-install").hidden = !account.connected;
        $("plugin-github-disconnect").hidden = !(account.connected || account.masked);
    } catch (error) { status.textContent = `GitHub : ${gitErrorText(error)}`; }
}
let githubDeviceSequence = 0;
const githubDeviceDialog = document.createElement("dialog");
githubDeviceDialog.className = "conversation-import-dialog github-device-dialog";
githubDeviceDialog.setAttribute("aria-labelledby", "github-device-title");
githubDeviceDialog.innerHTML = '<h2 id="github-device-title">Connexion à GitHub</h2><p>Sur GitHub, saisis ce code puis autorise l’application :</p><p id="github-device-value" class="github-device-value" aria-live="polite"></p><p class="settings-help">La connexion se terminera automatiquement après ton autorisation.</p><div class="studio-actions"><button type="button" id="plugin-github-cancel">Annuler</button></div>';
document.body.appendChild(githubDeviceDialog);
githubDeviceDialog.addEventListener("cancel", event => { event.preventDefault(); $("plugin-github-cancel").click(); });
$("plugin-github-device").onclick = async () => {
    const sequence = ++githubDeviceSequence, button = $("plugin-github-device");
    button.disabled = true;
    $("plugin-github-code").textContent = "Préparation de la connexion…";
    try {
        const flow = await api.githubDeviceStart();
        if (sequence !== githubDeviceSequence) return;
        $("github-device-value").textContent = flow.code;
        githubDeviceDialog.showModal();
        await api.openExternal("https://github.com/login/device", true);
        await api.githubDeviceFinish();
        if (sequence !== githubDeviceSequence) return;
        $("plugin-github-code").textContent = "Compte connecté. Installe également l’application GitHub sur les dépôts à utiliser.";
        await refreshGithubPlugin();
    } catch (error) { if (sequence === githubDeviceSequence) $("plugin-github-code").textContent = `Connexion : ${gitErrorText(error)}`; }
    finally { if (sequence === githubDeviceSequence) { if (githubDeviceDialog.open) githubDeviceDialog.close(); button.disabled = false; } }
};
$("plugin-github-cancel").onclick = async () => {
    githubDeviceSequence++; if (githubDeviceDialog.open) githubDeviceDialog.close();
    await api.githubDeviceCancel();
    $("plugin-github-device").disabled = false;
    $("plugin-github-code").textContent = "Connexion annulée.";
};
$("plugin-github-form").onsubmit = async event => {
    event.preventDefault();
    const input = $("plugin-github-token"), button = event.currentTarget.querySelector('button[type="submit"]');
    const token = input.value.trim();
    if (!token) { input.focus(); return; }
    button.disabled = true;
    try { await api.githubLoginToken(token); await refreshGithubPlugin(); }
    catch (error) { $("plugin-github-status").textContent = `Connexion : ${gitErrorText(error)}`; }
    finally { input.value = ""; button.disabled = false; }
};
$("plugin-github-disconnect").onclick = async event => {
    const button = event.currentTarget; button.disabled = true;
    try { await api.githubLogout(); await refreshGithubPlugin(); }
    catch (error) { $("plugin-github-status").textContent = `Déconnexion : ${gitErrorText(error)}`; }
    finally { button.disabled = false; }
};
$("plugin-github-open").onclick = () => $("gh-connector-open").click();
$("plugin-github-install").onclick = () => api.openExternal("https://github.com/apps/francestudent-code", true).catch(error => { $("plugin-github-status").textContent = gitErrorText(error); });
async function loadExtensionCenter() {
    const seq = ++centerLoading;
    try {
        const data = await api.extensionAction("list");
        if (seq !== centerLoading) return;
        centerData = data;
        renderExtensionCenter();
    } catch (error) { $("center-message").textContent = `Extensions : ${error.message}`; }
}
async function changeExtension(action, payload, message = "Modification enregistrée.") {
    centerData = await api.extensionAction(action, payload);
    renderExtensionCenter();
    $("center-message").textContent = message;
}
function renderExtensionCenter() {
    if (!centerData) return;
    const active = centerData.skills.filter(skill => !skill.disabled).length;
    $("center-count").textContent = `${centerData.skills.length} installé(s) · ${active} activé(s)`;
    const selectedProfile = $("skill-profile").value;
    $("skill-profile").replaceChildren(centerNode("option", "", "Choisir un profil"));
    $("skill-profile").firstChild.value = "";
    for (const name of Object.keys(centerData.profiles).sort()) {
        const option = centerNode("option", "", name); option.value = name; $("skill-profile").appendChild(option);
    }
    $("skill-profile").value = selectedProfile;
    for (const select of [$("library-scope"), $("skill-editor-scope")]) select.querySelector('[value="projet"]').disabled = !centerData.workspace;
    renderLibrary(); renderRobloxLibrary(); renderInstalledSkills(); renderMotionMarketplace();
    for(const card of document.querySelectorAll("#marketplace-results .center-card"))if(card.marketplaceItem)renderMarketplaceSkillActions(card);
}
function renderRobloxLibrary() {
    if (!centerData) return;
    const query = $("roblox-search").value.toLocaleLowerCase("fr").trim();
    const category = $("roblox-category").value;
    const list = $("roblox-list"); list.replaceChildren();
    const items = centerData.library.filter(item => (item.application === "roblox" || item.category === "Blender") && (!category || item.category === category) && `${item.title} ${item.description} ${item.id}`.toLocaleLowerCase("fr").includes(query));
    for (const item of items) {
        const card = centerNode("article", "center-card roblox-card");
        card.append(centerNode("span", "ext-tag", item.category), centerNode("h3", "", item.title), centerNode("p", "", item.description), centerNode("p", "settings-help", "Inclus hors ligne · aucune clé supplémentaire"));
        const actions = centerNode("div", "center-card-actions");
        actions.append(centerButton("Voir les instructions", () => openSkillEditor({kind:"library", item})));
        const scope = $("library-scope").value;
        const installed = centerData.skills.find(skill => skill.key === libraryInstallKey(item, scope));
        actions.append(installed ? uninstallSkillButton(installed) : centerButton("Installer", () => changeExtension("install", {id:item.id, scope}, `${item.title} installé.`), true));
        card.append(actions); list.append(card);
    }
    if (!list.children.length) list.append(centerNode("p", "ext-empty", "Aucun skill Roblox ou Blender ne correspond à cette recherche."));
}
function renderLibrary() {
    if (!centerData) return;
    const query = $("library-search").value.toLocaleLowerCase("fr").trim();
    const category = $("library-category").value;
    const scope = $("library-scope").value;
    const list = $("library-list"); list.replaceChildren();
    for (const item of centerData.library.filter(item => (!category || category === item.category) && `${item.title} ${item.description} ${item.category} ${item.id}`.toLocaleLowerCase("fr").includes(query))) {
        const card = centerNode("article", "center-card");
        card.dataset.libraryId = item.id;
        card.append(centerNode("span", "ext-tag", item.category), centerNode("h3", "", item.title), centerNode("p", "", item.description), centerNode("p", "", `${item.author} · v${item.version}`));
        const actions = centerNode("div", "center-card-actions");
        actions.append(centerButton("Voir les instructions", () => openSkillEditor({ kind: "library", item })));
        const installedKey=libraryInstallKey(item,scope);
        const installed = centerData.skills.find(skill => skill.key === installedKey);
        actions.append(installed?uninstallSkillButton(installed):centerButton("Installer", () => changeExtension("install", {id:item.id, scope}, `${item.title} installé. Tu peux le désactiver dans Mes skills.`), true));
        card.append(actions); list.append(card);
    }
    if (!list.children.length) list.append(centerNode("p", "ext-empty", "Aucun skill ne correspond. Essaie un autre mot ou une autre catégorie."));
}
function renderInstalledSkills() {
    if (!centerData) return;
    const query = $("skills-search").value.toLocaleLowerCase("fr").trim();
    const filter = $("skills-filter").value;
    const list = $("skills-list"); list.replaceChildren();
    const filtered = centerData.skills.filter(skill => `${skill.name} ${skill.description}`.toLocaleLowerCase("fr").includes(query) && (filter === "all" || filter === "active" && !skill.disabled || filter === "disabled" && skill.disabled || filter === "favorites" && skill.favorite || filter === skill.scope));
    for (const skill of filtered.slice(0, installedVisibleCount)) {
        const card = centerNode("article", "center-card"); card.dataset.skillKey = skill.key;
        card.append(centerNode("span", "ext-tag", skill.scope === "motion" ? "Projet EffectCraft" : skill.scope === "projet" ? "Ce projet code" : "Tous mes projets"), centerNode("h3", "", skill.name), centerNode("p", "", skill.description));
        const actions = centerNode("div", "center-card-actions");
        const favorite = centerButton(skill.favorite ? "★" : "☆", () => changeExtension("favorite", {key:skill.key}));
        favorite.setAttribute("aria-label", `${skill.favorite ? "Retirer des" : "Ajouter aux"} favoris : ${skill.name}`);
        favorite.setAttribute("aria-pressed", String(skill.favorite));
        actions.append(favorite, centerButton("Ouvrir", async () => openSkillEditor({kind:"edit", item:await api.extensionAction("read", {key:skill.key}), key:skill.key})), uninstallSkillButton(skill));
        const label = centerNode("label", "skill-enabled");
        const toggle = document.createElement("input"); toggle.type = "checkbox"; toggle.checked = !skill.disabled; toggle.setAttribute("role", "switch"); toggle.setAttribute("aria-label", `Activer ${skill.name}`);
        toggle.onchange = async () => {
            toggle.disabled = true;
            try { await changeExtension("toggle", {key:skill.key, disabled:!toggle.checked}); }
            catch (error) { toggle.checked = !toggle.checked; $("center-message").textContent = error.message; }
            finally { toggle.disabled = false; }
        };
        label.append(toggle, document.createTextNode(skill.disabled ? "Désactivé" : "Activé")); actions.append(label); card.append(actions); list.append(card);
    }
    if (!list.children.length) list.append(centerNode("p", "ext-empty", centerData.skills.length ? "Aucun résultat pour ces filtres." : "Aucun skill installé. Explore la bibliothèque ou crée tes propres instructions avec Nouveau."));
    if (filtered.length > installedVisibleCount) list.append(centerButton(`Afficher la suite (${filtered.length - installedVisibleCount})`, () => { installedVisibleCount += 60; renderInstalledSkills(); }));
}
$("library-search").oninput = renderLibrary;
$("library-category").onchange = renderLibrary;
$("library-scope").onchange = renderLibrary;
$("roblox-search").oninput = renderRobloxLibrary;
$("roblox-category").onchange = renderRobloxLibrary;
$("roblox-open-project").onclick = () => { $("ext-close").click(); $("btn-open-project")?.click(); };
$("skills-search").oninput = () => { installedVisibleCount = 60; renderInstalledSkills(); };
$("skills-filter").onchange = () => { installedVisibleCount = 60; renderInstalledSkills(); };
$("profile-save").onclick = async () => {
    const name = await inputDialog("Nom du profil de skills", "Mon profil");
    if (!name) return;
    try { await changeExtension("profile-save", {name}, `Profil « ${name} » enregistré.`); $("skill-profile").value = name.trim(); }
    catch (error) { $("center-message").textContent = error.message; }
};
for (const action of ["apply", "delete"]) $("profile-" + action).onclick = async () => {
    const name = $("skill-profile").value;
    if (!name) { $("center-message").textContent = "Choisis d’abord un profil."; return; }
    try { await changeExtension("profile-" + action, {name}, action === "apply" ? `Profil « ${name} » appliqué. Les autres skills sont désactivés.` : "Profil supprimé. Les skills restent installés."); }
    catch (error) { $("center-message").textContent = error.message; }
};
function openSkillEditor(state) {
    skillEditorState = state;
    const item = state.item || {};
    const remote = state.kind === "remote";
    const library = state.kind === "library";
    $("skill-editor-title").textContent = library ? item.title : remote ? item.name : state.kind === "edit" ? `Modifier ${item.name}` : "Créer ou importer un skill";
    $("skill-editor-description").textContent = remote ? item.resourceCount ? `Remotion pour le chat code · ${item.resourceCount} ressources annexes incluses. Après installation, active le skill dans Mes skills pour l’utiliser.` : "Skill communautaire : vérifie les instructions et la licence du dépôt. Après installation, active-le dans Mes skills pour l’utiliser. Seul le SKILL.md est copié." : library ? `${item.description} · ${item.category}` : "Écris ou colle les instructions que l’agent doit suivre quand il utilise ce skill.";
    $("skill-editor-name").value = item.id || item.name || "mon-skill";
    $("skill-editor-name").disabled = !["new", "remote", "local"].includes(state.kind);
    if (remote) $("skill-editor-name").value = item.name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80) || "community-skill";
    $("skill-editor-identity").classList.toggle("hidden", state.kind === "edit");
    $("skill-editor-scope").value = library ? $("library-scope").value : item.scope || "utilisateur";
    $("skill-editor-content").value = item.content || "---\nname: mon-skill\ndescription: Quand utiliser ce skill.\n---\n\n# Ma méthode\n\nDécris les étapes et les vérifications à suivre.\n";
    $("skill-editor-content").readOnly = library || remote || state.kind === "local";
    $("skill-editor-content").closest("label").nextElementSibling.textContent = state.kind === "local" || item.resourceCount
        ? "Les instructions et les ressources annoncées seront copiées. Aucun script n’est exécuté pendant l’import."
        : "Tu peux coller un SKILL.md personnel ici. Seules ces instructions sont importées ; les scripts et fichiers annexes ne sont pas copiés.";
    $("skill-editor-save").textContent = remote ? "Installer" : library ? "Installer ce skill" : "Enregistrer";
    $("skill-editor-save").disabled = false;
    $("skill-editor-message").textContent = "";
    if (state.kind === "local") {
        $("skill-editor-title").textContent = "Importer un skill téléchargé";
        $("skill-editor-description").textContent = `${item.resourceCount || 0} ressource(s) annexe(s) incluse(s). Vérifie les instructions et fichiers avant d’activer ce skill dans Mes skills.`;
        $("skill-editor-save").textContent = "Importer";
        $("skill-editor-message").textContent = item.resourceNames?.length ? `Ressources : ${item.resourceNames.join(", ")}` : "Les instructions SKILL.md seront importées.";
    }
    $("skill-editor").showModal();
}
$("btn-skill-new").onclick = () => openSkillEditor({kind:"new"});
for (const id of ["skill-editor-close", "skill-editor-cancel"]) $(id).onclick = () => $("skill-editor").close();
$("skill-editor-form").onsubmit = async event => {
    event.preventDefault();
    const state = skillEditorState;
    $("skill-editor-save").disabled = true;
    try {
        const scope = $("skill-editor-scope").value;
        if (state.kind === "local") {
            centerData = await api.localSkillImport("install", { token: state.item.token, name: $("skill-editor-name").value, scope });
            renderExtensionCenter(); $("center-message").textContent = "Skill importé avec ses ressources. Active-le dans Mes skills quand tu es prêt.";
        }
        else if (state.kind === "library") await changeExtension("install", {id:state.item.id, scope}, "Skill installé.");
        else if (state.kind === "remote") {
            centerData = await api.marketplace("install", {name:$("skill-editor-name").value, scope, url:state.item.url});
            const installed=centerData.skills.find(skill=>skill.key===`${scope}:${$("skill-editor-name").value.trim().toLowerCase()}`);
            if(installed){const links=readStudioStorage("frst.marketplace-installed",{});links[state.item.githubUrl || state.item.url]=installed.key;writeStudioStorage("frst.marketplace-installed",links);}
            renderExtensionCenter(); $("center-message").textContent = "Skill installé. Active-le dans Mes skills pour l’utiliser.";
        }
        else if (state.kind === "edit") await changeExtension("save", {key:state.key, content:$("skill-editor-content").value});
        else await changeExtension("import", {name:$("skill-editor-name").value, content:$("skill-editor-content").value, scope}, "Skill créé et activé.");
        $("skill-editor").close();
    } catch (error) { $("skill-editor-message").textContent = error.message; }
    finally { $("skill-editor-save").disabled = false; }
};

/* ---------- Serveurs MCP ---------- */
function renderMcpCard(server, sub) {
    const labels = {running:"Connecté", failed:"Erreur", disabled:"Désactivé", starting:"Connexion…"};
    const card = extItem(server.name, {dot:server.status, tag:labels[server.status] || server.status, sub:server.status === "running" ? `${server.tools.length} outil(s) disponible(s)` : sub, error:server.status === "failed"});
    const details = centerNode("details", "mcp-details");
    details.append(centerNode("summary", "", "Voir les outils"));
    const list = document.createElement("ul");
    for (const tool of server.tools) list.append(centerNode("li", "", tool));
    if (!server.tools.length) list.append(centerNode("li", "", "Aucun outil disponible dans cet état."));
    details.append(list); card.append(details);
    const actions = centerNode("div", "center-card-actions");
    actions.append(centerButton(server.status === "disabled" ? "Activer" : "Désactiver", async () => {
        await api.mcpManage("toggle", {name:server.name, disabled:server.status !== "disabled"}); await refreshMcp();
    }), centerButton("Retirer la connexion", async () => {
        if (!await confirmStudioAction(`Retirer le serveur « ${server.name} » de mcp.json ? La configuration précédente reste dans mcp.json.backup.`,{title:"Retirer ce serveur MCP",confirmLabel:"Retirer",danger:true})) return;
        await api.mcpManage("remove", {name:server.name}); await refreshMcp();
    }));
    card.append(actions); return card;
}
$("btn-mcp-add").onclick = () => {
    $("mcp-editor-form").reset(); $("mcp-editor-message").textContent = ""; $("mcp-editor").showModal();
};
for (const id of ["mcp-editor-close", "mcp-editor-cancel"]) $(id).onclick = () => $("mcp-editor").close();
$("mcp-editor-form").onsubmit = async event => {
    event.preventDefault(); $("mcp-editor-save").disabled = true;
    try {
        let args, env;
        try { args = JSON.parse($("mcp-args").value); env = JSON.parse($("mcp-env").value); }
        catch { throw new Error('Arguments et variables : utilise du JSON valide, par exemple ["mon-script.js"] et {"MA_CLE":"valeur"}.'); }
        await api.mcpManage("add", {name:$("mcp-name").value, command:$("mcp-command").value, args, env, cwd:$("mcp-cwd").value});
        $("mcp-env").value = "{}"; $("mcp-editor").close(); await refreshMcp();
        $("center-message").textContent = "Serveur enregistré. Son état de connexion apparaît dans la liste.";
    } catch (error) { $("mcp-editor-message").textContent = error.message; }
    finally { $("mcp-editor-save").disabled = false; }
};

/* ---------- Paramètres recherchables et contexte ---------- */
const preferenceFields = { contextMaxFiles:"context-max-files", contextBudgetChars:"context-budget", contextFileChars:"context-file-chars", agentContextChars:"context-agent-chars" };
const customProviderCard = document.createElement("section");
customProviderCard.className = "settings-card beta-card";
customProviderCard.innerHTML = `<h3>Fournisseurs personnalisés <span class="badge">Bêta</span></h3><p class="settings-help">Utilise ta propre clé API. Elle est conservée dans le coffre sécurisé du système et reste séparée du compte FranceStudent.</p><div class="settings-number-grid"><label>Nom<input id="custom-provider-name" maxlength="80" placeholder="Mon fournisseur"></label><label>Fournisseur<select id="custom-provider-kind"><option value="openai">OpenAI</option><option value="openai-compatible">OpenAI-compatible</option><option value="anthropic">Anthropic</option><option value="gemini">Gemini</option></select></label><label>Modèle<input id="custom-provider-model" maxlength="160" placeholder="gpt-4o-mini"></label><label>URL API (compatible)<input id="custom-provider-url" maxlength="500" placeholder="https://api.example.com/v1"></label></div><label>Clé API<input id="custom-provider-key" type="password" autocomplete="new-password" maxlength="4096"></label><div class="buttons"><button type="button" id="custom-provider-save" class="primary">Enregistrer le fournisseur</button></div><p id="custom-provider-message" class="settings-help" role="status"></p><div id="custom-provider-list"></div>`;
$("settings-view").insertBefore(customProviderCard,$("settings-message"));
async function renderCustomProviders(){try{const data=await api.customProviders("list");$("custom-provider-list").replaceChildren(...(data.providers||[]).map(item=>{const row=centerNode("div","settings-help",`${item.name} · ${item.provider} · ${item.model}`);const remove=centerButton("Supprimer",async()=>{await api.customProviders("remove",{id:item.id});renderCustomProviders();});row.append(remove);return row;}));}catch(error){$("custom-provider-message").textContent=error.message;}}
$("custom-provider-save").onclick=async()=>{const message=$("custom-provider-message");try{await api.customProviders("save",{name:$("custom-provider-name").value,provider:$("custom-provider-kind").value,model:$("custom-provider-model").value,baseUrl:$("custom-provider-url").value,apiKey:$("custom-provider-key").value});$("custom-provider-key").value="";message.textContent="Fournisseur enregistré. Ouvre le sélecteur de modèle pour l’utiliser.";renderCustomProviders();}catch(error){message.textContent=error.message;}};
renderCustomProviders();
function showPreferences(data) {
    for (const [key, id] of Object.entries(preferenceFields)) $(id).value = data[key];
    $("settings-default-model").value = data.defaultModel == null ? "" : String(data.defaultModel);
    if (typeof syncSettingsModelMenu === "function") syncSettingsModelMenu($("settings-default-model"));
    renderContextEstimate();
}
function renderContextEstimate() {
    const budget = Number($("context-budget").value);
    $("context-estimate").textContent = `Budget d’indexation : ${budget.toLocaleString("fr-FR")} caractères. Le contexte réellement envoyé dépend aussi des limites du modèle et du prompt.`;
}
async function loadPreferences() {
    try {
        await refreshMarketplaceKey();
        const data = await api.preferences();
        const models = await api.models();
        const select = $("settings-default-model"); select.replaceChildren();
        const defaultOption = centerNode("option", "", "Modèle par défaut de l’application"); defaultOption.value = ""; select.append(defaultOption);
        for (const model of models.agents || []) { const option = centerNode("option", "", model.name); option.value = String(model.id); option.dataset.provider = String(model.provider || ""); option.dataset.model = String(model.model || ""); select.append(option); }
        if (data.defaultModel !== null && ![...select.options].some(option => option.value === String(data.defaultModel))) {
            const option = centerNode("option", "", `Modèle enregistré (${data.defaultModel})`); option.value = String(data.defaultModel); select.append(option);
        }
        showPreferences(data);
    } catch (error) { $("settings-message").textContent = error.message; }
}
for (const id of Object.values(preferenceFields)) $(id).oninput = renderContextEstimate;
const contextPresets = {
    light:{contextMaxFiles:100, contextBudgetChars:100000, contextFileChars:10000, agentContextChars:15000},
    balanced:{contextMaxFiles:500, contextBudgetChars:400000, contextFileChars:30000, agentContextChars:30000},
    large:{contextMaxFiles:3000, contextBudgetChars:1500000, contextFileChars:60000, agentContextChars:60000}
};
for (const button of document.querySelectorAll("[data-context-preset]")) button.onclick = () => {
    for (const [key, id] of Object.entries(preferenceFields)) $(id).value = contextPresets[button.dataset.contextPreset][key];
    renderContextEstimate(); $("settings-message").textContent = "Préréglage préparé. Clique sur Enregistrer ces réglages pour l’appliquer.";
};
$("preferences-reset").onclick = () => document.querySelector('[data-context-preset="balanced"]').click();
$("preferences-save").onclick = async () => {
    if (!Object.values(preferenceFields).every(id => $(id).reportValidity())) return;
    const values = {defaultModel:$("settings-default-model").value};
    for (const [key, id] of Object.entries(preferenceFields)) values[key] = Number($(id).value);
    try { showPreferences(await api.preferences("save", values)); $("settings-message").textContent = "Réglages enregistrés. Le contexte sera utilisé à la prochaine indexation et le modèle au prochain démarrage."; }
    catch (error) { $("settings-message").textContent = error.message; }
};
const defaultModelStatus = document.createElement("p");
defaultModelStatus.id = "settings-default-model-status";
defaultModelStatus.className = "settings-help";
defaultModelStatus.setAttribute("role", "status");
$("settings-default-model").after(defaultModelStatus);
$("settings-default-model").onchange = async () => {
    const select = $("settings-default-model");
    select.disabled = true;
    defaultModelStatus.textContent = "Enregistrement du modèle…";
    try {
        await api.preferences("save", { defaultModel: select.value });
        defaultModelStatus.textContent = "Modèle enregistré automatiquement pour les prochains démarrages.";
    } catch (error) {
        defaultModelStatus.textContent = `Modèle non enregistré : ${error.message}`;
        try { const saved = await api.preferences(); select.value = saved.defaultModel == null ? "" : String(saved.defaultModel); } catch { /* keep visible error */ }
    } finally { select.disabled = false; if (typeof syncSettingsModelMenu === "function") syncSettingsModelMenu(select); }
};

/* ---------- Marketplace en ligne : recherche explicite, aperçu avant installation ---------- */
let marketplacePage = 1;
let marketplaceSearch = null;
let marketplaceSequence = 0;
async function searchMarketplace(page = 1) {
    const query = page === 1 ? $("marketplace-query").value.trim() : marketplaceSearch?.query;
    const sort = page === 1 ? $("marketplace-sort").value : marketplaceSearch?.sort;
    if (!query) return;
    const seq = ++marketplaceSequence;
    marketplaceSearch = {query, sort};
    $("marketplace-search-button").disabled = true;
    $("marketplace-previous").disabled = true; $("marketplace-next").disabled = true;
    $("marketplace-status").textContent = "Recherche sur SkillsMP…";
    try {
        const data = await api.marketplace("search", {query, sort, page});
        if (seq !== marketplaceSequence) return;
        marketplacePage = data.page;
        const list = $("marketplace-results"); list.replaceChildren();
        for (const item of data.items) {
            const card = centerNode("article", "center-card");
            card.append(centerNode("span", "ext-tag", `★ ${item.stars.toLocaleString("fr-FR")}`), centerNode("h3", "", item.name), centerNode("p", "", `par ${item.author}`), centerNode("p", "", item.description));
            card.marketplaceItem=item;renderMarketplaceSkillActions(card);list.append(card);
        }
        $("marketplace-status").textContent = data.items.length ? `${data.items.length} résultat(s) affiché(s)${data.remaining !== null ? ` · ${data.remaining} recherche(s) restante(s) aujourd’hui` : ""}.` : "Aucun résultat. Essaie un autre mot-clé.";
        $("marketplace-page").textContent = `Page ${data.page}`;
        $("marketplace-previous").disabled = data.page <= 1;
        $("marketplace-next").disabled = !data.hasNext;
    } catch (error) { if (seq === marketplaceSequence) $("marketplace-status").textContent = error.message; }
    finally { if (seq === marketplaceSequence) $("marketplace-search-button").disabled = false; }
}
$("marketplace-search-form").onsubmit = event => {event.preventDefault(); searchMarketplace(1);};
$("marketplace-previous").onclick = () => searchMarketplace(marketplacePage - 1);
$("marketplace-next").onclick = () => searchMarketplace(marketplacePage + 1);
async function refreshMarketplaceKey() {
    const data = await api.marketplaceKey();
    $("marketplace-key-status").textContent = data.fromEnvironment ? "Clé fournie par SKILLSMP_API_KEY. Effacer la clé locale ne changera pas cette variable." : data.configured ? "Une clé chiffrée est enregistrée sur cet ordinateur." : "Aucune clé : recherche publique disponible.";
}
for (const action of ["save", "clear"]) $("marketplace-key-" + action).onclick = async () => {
    try {
        await api.marketplaceKey(action, action === "save" ? $("settings-marketplace-key").value : "");
        $("settings-marketplace-key").value = "";
        await refreshMarketplaceKey();
        $("settings-message").textContent = action === "save" ? "Clé enregistrée et chiffrée." : "Clé locale effacée.";
    } catch (error) { $("settings-message").textContent = error.message; }
};
$("marketplace-docs").onclick = () => api.openExternal("https://skillsmp.com/docs/api").catch(error => { $("settings-message").textContent = error.message; });
/* ---------- Cockpit du projet : commandes, qualité et outils locaux ---------- */
let projectStudioData = null;
let studioSelectedRun = null;
let studioRuns = [];
let projectStudioTab = "overview";
let studioSeq = 0;
function studioIcon(name) { return window.StudioVendor?.icon(name); }
function studioAction(label, icon, handler, primary=false) {
    const button=centerButton(label,handler,primary); const svg=studioIcon(icon);
    if(svg)button.prepend(svg); return button;
}
const projectNav=document.createElement("button");
projectNav.type="button";projectNav.className="activity";projectNav.dataset.view="project";projectNav.title="Cockpit du projet (Ctrl+Maj+D)";projectNav.setAttribute("aria-label","Cockpit du projet");
projectNav.append(studioIcon("LayoutDashboard"));
$("activity-bar")?.insertBefore(projectNav,$("activity-bar").firstElementChild);
projectNav.onclick=()=>showSideView("project");
$("sidebar").insertAdjacentHTML("afterbegin",`
<div id="project-studio" class="studio-page">
 <header class="studio-header"><div><span class="studio-eyebrow">FRANCESTUDENT CODE</span><h1>Ton espace de travail.</h1></div><div class="studio-actions"><button type="button" id="studio-refresh" aria-label="Actualiser le projet">Actualiser</button><button type="button" id="studio-close">Retour au code</button></div></header>
 <div class="studio-project-heading"><div><h2 id="studio-project-name">Aucun projet</h2><p id="studio-project-description"></p><p id="studio-project-path"></p></div><div id="studio-stack" class="studio-stack"></div></div>
 <nav class="studio-tabs" aria-label="Cockpit du projet" role="tablist"><button type="button" data-studio-tab="overview" role="tab" aria-selected="true">Vue d’ensemble</button><button type="button" data-studio-tab="tasks" role="tab" aria-selected="false">Exécutions</button><button type="button" data-studio-tab="quality" role="tab" aria-selected="false">Qualité</button><button type="button" data-studio-tab="tools" role="tab" aria-selected="false">Boîte à outils</button><button type="button" data-studio-tab="shortcuts" role="tab" aria-selected="false">Raccourcis</button></nav>
 <p id="studio-message" class="studio-message" role="status"></p>
 <section data-studio-page="overview"><div id="studio-stats" class="studio-stats"></div><div class="studio-section-heading"><h2>Une action, un résultat.</h2><span>Les outils du projet, à portée de main.</span></div><div id="studio-quick-actions" class="studio-quick-grid"></div><div class="studio-two-columns"><article class="studio-card"><h3>Documentation du projet</h3><div id="studio-docs" class="studio-link-list"></div></article><article class="studio-card"><h3>Repères dans le code</h3><p class="studio-muted">Marque une ligne dans l’éditeur avec Ctrl+F2 pour la retrouver ici.</p><div id="studio-bookmarks" class="studio-link-list"></div></article></div><div class="studio-section-heading"><h2>Dernières exécutions</h2><button type="button" id="studio-see-runs">Tout voir</button></div><div id="studio-recent-runs" class="studio-run-list"></div></section>
 <section data-studio-page="tasks" class="hidden"><div class="studio-section-heading"><div><h2>Les commandes de ton projet.</h2><p class="studio-muted">Détectées dans package.json, Cargo.toml et go.mod. Rien ne s’exécute sans un clic.</p></div><button type="button" id="studio-add-task" class="primary">+ Commande personnelle</button></div><div class="center-filters"><input type="search" id="studio-task-filter" placeholder="Filtrer : dev, test, build…" aria-label="Filtrer les commandes"><select id="studio-task-kind" aria-label="Type de commande"><option value="">Tous les types</option><option value="dev">Développement</option><option value="test">Tests</option><option value="build">Construction</option><option value="quality">Qualité</option><option value="custom">Personnelles</option></select></div><div id="studio-task-list" class="studio-task-grid"></div><div class="studio-section-heading"><h2>Exécutions de cette session</h2><button type="button" id="studio-clear-runs">Effacer les exécutions terminées</button></div><div id="studio-runs" class="studio-run-list"></div><article class="studio-card studio-log-card"><div class="studio-section-heading"><div><h3 id="studio-log-title">Sortie de la commande</h3><p id="studio-log-meta" class="studio-muted">Sélectionne une exécution pour lire sa sortie.</p></div><div class="studio-actions"><button type="button" id="studio-copy-log">Copier la sortie</button><label class="studio-muted"><input type="checkbox" id="studio-log-follow" checked> Suivre</label></div></div><pre id="studio-log" class="studio-log" tabindex="0"></pre></article></section>
 <section data-studio-page="quality" class="hidden"><div class="studio-section-heading"><h2>Un environnement prêt à travailler.</h2><button type="button" id="studio-diagnose">Vérifier l’environnement</button></div><div id="studio-environment" class="studio-stats"></div><div class="studio-section-heading"><h2>Problèmes signalés par l’éditeur</h2><span>Diagnostics JS/TS des fichiers ouverts</span></div><div id="studio-problems" class="studio-link-list"></div><div class="studio-section-heading"><h2>Améliorer le projet avec l’agent</h2></div><div id="studio-quality-actions" class="studio-quick-grid"></div></section>
 <section data-studio-page="tools" class="hidden"><div class="studio-section-heading"><h2>Petits outils, sans quitter ton projet.</h2><span>Traitement local · aucun envoi au modèle</span></div><article class="studio-card"><div class="center-filters"><select id="studio-transform" aria-label="Opération"><option value="json">Valider et formater JSON</option><option value="base64-encode">Texte → Base64</option><option value="base64-decode">Base64 → texte</option><option value="url-encode">Encoder une URL</option><option value="url-decode">Décoder une URL</option><option value="sha256">Empreinte SHA-256</option><option value="uuid">Générer un UUID</option><option value="sort">Trier les lignes</option><option value="unique">Supprimer les lignes identiques</option></select><button type="button" id="studio-transform-run" class="primary">Exécuter</button><button type="button" id="studio-transform-copy">Copier le résultat</button></div><div class="studio-two-columns"><label class="center-code-label">Entrée<textarea id="studio-tool-input" rows="12" maxlength="500000" spellcheck="false" placeholder="Colle ton texte ici…"></textarea></label><label class="center-code-label">Résultat<textarea id="studio-tool-output" rows="12" spellcheck="false" readonly></textarea></label></div><p id="studio-tool-status" class="studio-muted" role="status"></p></article><article class="studio-card"><h3>Raccourcis de création</h3><div id="studio-new-file-actions" class="studio-actions"></div></article></section>
 <section data-studio-page="shortcuts" class="hidden"><div class="studio-section-heading"><h2>Moins de clics, plus de fluidité.</h2></div><div id="studio-shortcuts" class="studio-shortcuts"></div><article class="studio-card"><h3>Construit avec l’open source</h3><p class="studio-muted">CodeMirror, Prettier, Marked, DOMPurify, Fuse.js, Lucide, xterm.js et node-pty participent aux outils de cette interface.</p><button type="button" id="studio-licenses">Lire les licences des composants intégrés</button></article></section>
</div>`);
document.body.insertAdjacentHTML("beforeend",`<dialog id="studio-task-dialog" class="center-dialog" aria-labelledby="studio-task-dialog-title"><form id="studio-task-form"><div class="center-dialog-head"><h2 id="studio-task-dialog-title">Ajouter une commande personnelle</h2><button type="button" id="studio-task-close" aria-label="Fermer">×</button></div><p class="studio-muted">La commande sera enregistrée dans ce projet, puis lancée uniquement quand tu cliqueras sur Exécuter. Sous Windows, elle s’exécute dans PowerShell avec les droits de ton compte.</p><label class="center-code-label">Nom<input id="studio-task-name" required maxlength="100" placeholder="Mes tests Python"></label><label class="center-code-label">Commande<textarea id="studio-task-command" required maxlength="8000" rows="4" placeholder="python -m pytest"></textarea></label><p id="studio-task-error" role="status" class="studio-message"></p><div class="center-dialog-actions"><button type="button" id="studio-task-cancel">Annuler</button><button type="submit" class="primary">Enregistrer</button></div></form></dialog><dialog id="studio-licenses-dialog" class="center-dialog" aria-labelledby="studio-licenses-title"><div class="center-dialog-head"><h2 id="studio-licenses-title">Licences open source</h2><button type="button" id="studio-licenses-close">Fermer</button></div><pre id="studio-licenses-content" class="studio-license-text"></pre></dialog>`);
function setStudioTab(tab) {
    projectStudioTab=tab;
    for(const panel of document.querySelectorAll("[data-studio-page]"))panel.classList.toggle("hidden",panel.dataset.studioPage!==tab);
    for(const button of document.querySelectorAll("[data-studio-tab]")){const selected=button.dataset.studioTab===tab;button.setAttribute("aria-selected",String(selected));button.tabIndex=selected?0:-1;}
    if(tab==="quality")renderStudioProblems();
    if(tab==="overview")renderProjectStudio();
}
for(const button of document.querySelectorAll("[data-studio-tab]")) {
    button.onclick=()=>setStudioTab(button.dataset.studioTab);
    button.onkeydown=event=>{
        if(!["ArrowLeft","ArrowRight","Home","End"].includes(event.key))return;
        event.preventDefault();const buttons=[...document.querySelectorAll("[data-studio-tab]")];
        const index=event.key==="Home"?0:event.key==="End"?buttons.length-1:(buttons.indexOf(button)+(event.key==="ArrowRight"?1:buttons.length-1))%buttons.length;
        buttons[index].click();buttons[index].focus();
    };
}
async function refreshProjectStudio() {
    const sequence=++studioSeq;
    $("studio-message").textContent="";
    try {
        const data=await api.projectStudio("overview");if(sequence!==studioSeq)return;
        projectStudioData=data;studioRuns=data.runs;renderProjectStudio();
    }catch(error){$("studio-message").textContent=error.message;}
}
function draftStudioPrompt(prompt) {input.value=prompt;input.dispatchEvent(new Event("input"));showSideView("explorer");input.focus();}
function studioStat(value,label,detail="") {const card=centerNode("article","studio-stat");card.append(centerNode("strong","",String(value)),centerNode("span","",label));if(detail)card.append(centerNode("small","",detail));return card;}
function studioQuick(title,description,icon,handler) {const button=studioAction("",icon,handler);button.classList.add("studio-quick");const text=centerNode("span","");text.append(centerNode("b","",title),centerNode("small","",description));button.append(text);return button;}
function renderProjectStudio() {
    const data=projectStudioData;if(!data)return;
    $("studio-project-name").textContent=data.name;
    $("studio-project-description").textContent=data.description||"Ton code, tes commandes et tes outils dans un seul espace.";
    $("studio-project-path").textContent=data.workspace||"Ouvre un dossier pour retrouver ses commandes et sa documentation.";
    $("studio-stack").replaceChildren(...data.stack.map(label=>centerNode("span","studio-pill",label)));
    $("studio-stats").replaceChildren(studioStat(data.tasks.length,"commandes disponibles",data.packageManager?`Gestionnaire : ${data.packageManager}`:"Scripts détectés dans le projet"),studioStat(studioRuns.filter(run=>run.status==="running").length,"en cours","Exécutions locales"),studioStat(studioRuns.filter(run=>run.status==="passed").length,"réussies","Pendant cette session"),studioStat(data.docs.length,"documents repérés","Guides à la racine du projet"));
    $("studio-quick-actions").replaceChildren(
        studioQuick("Lancer le projet","Choisir un script de développement","Play",()=>setStudioTab("tasks")),
        studioQuick("Comprendre le code","Préparer une exploration avec l’agent","Sparkles",()=>draftStudioPrompt("Explore ce projet et explique les points d’entrée, son architecture et les commandes utiles. Ne modifie aucun fichier.")),
        studioQuick("Terminal","Ouvrir un terminal dans ce dossier","Terminal",()=>{showSideView("explorer");selectPanel("terminal",true);}),
        studioQuick("Aperçu local","Voir un fichier HTML ou le Markdown actif","Eye",()=>{showSideView("explorer");openDocumentPreview();}),
        studioQuick("Vérifier l’environnement","Node.js, npm et Git","Activity",()=>{setStudioTab("quality");diagnoseStudio();}),
        studioQuick("Ouvrir un dossier","Changer de projet","FolderOpen",openProject));
    const docs=$("studio-docs");docs.replaceChildren();
    for(const file of data.docs)docs.append(studioAction(file,"BookOpen",async()=>{showSideView("explorer");await openFile(file);openDocumentPreview();}));
    if(!data.docs.length)docs.append(centerNode("p","studio-muted","Aucun README ou guide repéré à la racine du projet."));
    renderStudioBookmarks();renderStudioTasks();renderStudioRuns();
}
function renderStudioTasks() {
    if(!projectStudioData)return;
    const query=$("studio-task-filter").value.toLowerCase().trim(),kind=$("studio-task-kind").value;
    const list=$("studio-task-list");list.replaceChildren();
    for(const task of projectStudioData.tasks.filter(task=>(!kind||task.kind===kind)&&`${task.name} ${task.description}`.toLowerCase().includes(query))) {
        const card=centerNode("article","studio-card studio-task");card.dataset.taskId=task.id;
        card.append(centerNode("span","studio-pill",task.source),centerNode("h3","",task.name),centerNode("p","studio-muted",task.description),centerNode("code","studio-command",task.command));
        const running=studioRuns.find(run=>run.taskId===task.id&&run.status==="running");
        const button=studioAction(running?"Arrêter":"Exécuter",running?"Square":"Play",async()=>{
            if(running)await api.projectStudio("stop",{id:running.id});
            else {const run=await api.projectStudio("start",{id:task.id});studioSelectedRun=run.id;}
            studioRuns=await api.projectStudio("runs");renderStudioRuns();renderStudioTasks();
        },!running);
        card.append(button);list.append(card);
        if(task.id.startsWith("custom:"))card.append(centerButton("Retirer cette commande",async()=>{await api.projectStudio("remove",{id:task.id});await refreshProjectStudio();setStudioTab("tasks");}));
    }
    if(!list.children.length)list.append(centerNode("p","studio-empty",projectStudioData.tasks.length?"Aucune commande ne correspond à ces filtres.":"Aucun script détecté. Ajoute une commande personnelle pour lancer ton outil de test ou ton serveur."));
}
const studioRunLabels={running:"En cours",passed:"Réussie",failed:"Échec",stopped:"Arrêtée"};
function studioRunRow(run) {
    const row=centerNode("div","studio-run");row.dataset.status=run.status;
    const button=centerButton(run.name,()=>{studioSelectedRun=run.id;setStudioTab("tasks");renderStudioLog();});button.className="studio-run-name";
    row.append(centerNode("span","studio-status-dot"),button,centerNode("span","studio-run-status",studioRunLabels[run.status]),centerNode("span","studio-muted",`${Math.max(0,Math.floor(((run.endedAt||Date.now())-run.startedAt)/1000))} s`));
    if(run.status==="running")row.append(studioAction("Arrêter","Square",()=>api.projectStudio("stop",{id:run.id})));
    else row.append(studioAction("Relancer","Play",async()=>{const next=await api.projectStudio("start",{id:run.taskId});studioSelectedRun=next.id;studioRuns=await api.projectStudio("runs");renderStudioRuns();renderStudioTasks();}));
    return row;
}
function renderStudioRuns() {
    for(const [id,limit]of[["studio-runs",30],["studio-recent-runs",4]]) {
        const list=$(id);list.replaceChildren(...studioRuns.slice().reverse().slice(0,limit).map(studioRunRow));
        if(!list.children.length)list.append(centerNode("p","studio-empty","Aucune exécution pour l’instant."));
    }
    renderStudioLog();
    $("studio-task-badge").textContent=studioRuns.some(run=>run.status==="running")?`${studioRuns.filter(run=>run.status==="running").length} commande(s)` : "";
}
function renderStudioLog() {
    if(!studioSelectedRun&&studioRuns.length)studioSelectedRun=studioRuns.at(-1).id;
    const run=studioRuns.find(run=>run.id===studioSelectedRun);if(!run){$("studio-log").textContent="";return;}
    $("studio-log-title").textContent=run.name;
    $("studio-log-meta").textContent=`${run.command} · ${studioRunLabels[run.status]}${run.exitCode!=null?` · code ${run.exitCode}`:""}`;
    $("studio-log").textContent=(run.truncated?"[… début de la sortie tronqué …]\n":"")+run.output;
    if($("studio-log-follow").checked)$("studio-log").scrollTop=$("studio-log").scrollHeight;
}
async function diagnoseStudio() {
    $("studio-environment").replaceChildren(centerNode("p","studio-muted","Vérification des outils disponibles…"));
    try {const data=await api.environmentDiagnostics();$("studio-environment").replaceChildren(...data.map(item=>studioStat(item.available?"✓":"—",item.name,item.version)));}
    catch(error){$("studio-message").textContent=error.message;}
}
function renderStudioProblems() {
    const list=$("studio-problems");list.replaceChildren();let count=0;
    for(const [file,diagnostics]of lspDiagnosticsByPath)for(const diagnostic of diagnostics) {
        const line=(diagnostic.from?.line||0)+1;
        const button=centerButton(`${diagnostic.severity === "error"?"Erreur":"Diagnostic"} · ${file}:${line} — ${diagnostic.message}`,async()=>{showSideView("explorer");await openFile(file);goToLine(line);});
        list.append(button);count++;
    }
    if(!count)list.append(centerNode("p","studio-empty","Aucun problème signalé pour les fichiers JS/TS ouverts. Lance les tests ou le lint du projet pour une vérification plus large."));
}
function studioBookmarkKey(){return `frst-bookmarks:${ui.workspace||""}`;}
function readStudioBookmarks(){try{return JSON.parse(localStorage.getItem(studioBookmarkKey())||"[]").slice(0,200);}catch{return [];}}
function toggleStudioBookmark() {
    const tab=currentTab();if(!tab)return;
    const line=code.view.state.doc.lineAt(code.selectionStart).number;
    let items=readStudioBookmarks();const exists=items.some(item=>item.file===tab.path&&item.line===line);
    items=exists?items.filter(item=>item.file!==tab.path||item.line!==line):[...items,{file:tab.path,line,text:code.view.state.doc.line(line).text.trim().slice(0,100)}];
    try{localStorage.setItem(studioBookmarkKey(),JSON.stringify(items));}catch{/* stockage indisponible */}
    lspStatus(exists?"Repère retiré":"Ligne marquée dans le cockpit du projet");renderStudioBookmarks();
}
function renderStudioBookmarks() {
    const list=$("studio-bookmarks");if(!list)return;list.replaceChildren();
    for(const item of readStudioBookmarks())list.append(centerButton(`${item.file}:${item.line} ${item.text}`,async()=>{showSideView("explorer");await openFile(item.file);goToLine(item.line);}));
    if(!list.children.length)list.append(centerNode("p","studio-empty","Aucune ligne marquée."));
}
$("studio-refresh").onclick=refreshProjectStudio;$("studio-close").onclick=()=>showSideView("explorer");
$("studio-see-runs").onclick=()=>setStudioTab("tasks");$("studio-diagnose").onclick=diagnoseStudio;
$("studio-task-filter").oninput=renderStudioTasks;$("studio-task-kind").onchange=renderStudioTasks;
$("studio-copy-log").onclick=()=>api.copyText($("studio-log").textContent).catch(error=>{$("studio-message").textContent=error.message;});
$("studio-clear-runs").onclick=async()=>{await api.projectStudio("clear");studioRuns=await api.projectStudio("runs");studioSelectedRun=null;renderStudioRuns();};
$("studio-add-task").onclick=()=>{$("studio-task-form").reset();$("studio-task-error").textContent="";$("studio-task-dialog").showModal();};
for(const id of ["studio-task-close","studio-task-cancel"])$(id).onclick=()=>$("studio-task-dialog").close();
$("studio-task-form").onsubmit=async event=>{
    event.preventDefault();
    try{await api.projectStudio("add",{name:$("studio-task-name").value,command:$("studio-task-command").value});$("studio-task-dialog").close();await refreshProjectStudio();setStudioTab("tasks");}
    catch(error){$("studio-task-error").textContent=error.message;}
};
$("studio-licenses").onclick=async()=>{try{$("studio-licenses-content").textContent=await api.openSourceLicenses();$("studio-licenses-dialog").showModal();}catch(error){$("studio-message").textContent=error.message;}};
$("studio-licenses-close").onclick=()=>$("studio-licenses-dialog").close();
$("studio-quality-actions").append(studioQuick("Revue des changements","Préparer une demande de revue sans modification","GitCompare",()=>draftStudioPrompt("Relis les changements Git actuels. Cherche les régressions et les erreurs concrètes, avec les fichiers et les cas déclencheurs. Ne modifie rien.")),studioQuick("Renforcer les tests","Préparer une demande de tests utiles","Check",()=>draftStudioPrompt("Inspecte les tests de ce projet, identifie les comportements critiques mal couverts et ajoute des tests pertinents. Exécute les tests concernés.")),studioQuick("Examiner la sécurité","Préparer une revue ciblée des entrées et accès","Activity",()=>draftStudioPrompt("Examine les entrées, contrôles d’accès et manipulations de fichiers de ce projet. Identifie les problèmes vérifiables et propose des corrections ciblées. Commence en lecture seule.")));
$("studio-new-file-actions").append(studioAction("Nouveau fichier","FileCode",()=>newEntry("file",".")),studioAction("Nouveau dossier","FolderOpen",()=>newEntry("directory",".")),studioAction("Créer un skill","Sparkles",()=>{showSideView("extensions");setCenterTab("installed");openSkillEditor({kind:"new"});}));
const studioShortcuts=[["Ctrl+P","Rechercher un fichier"],["Ctrl+Maj+P","Palette des commandes"],["Ctrl+Maj+D","Cockpit du projet"],["Ctrl+S","Enregistrer"],["Ctrl+Maj+S","Enregistrer tous les onglets"],["Maj+Alt+F","Formater avec Prettier"],["Ctrl+F2","Ajouter ou retirer un repère"],["Ctrl+Maj+V","Aperçu du document"],["F12","Aller à la définition JS/TS"],["Maj+F12","Rechercher les références"],["F2","Renommer un symbole"],["Ctrl+K","Modifier une sélection avec l’IA"],["Ctrl+L","Écrire à l’agent"],["Ctrl+J","Afficher ou masquer le panneau"],["Ctrl+Maj+F","Rechercher dans le projet"],["Ctrl+O","Ouvrir un dossier"]];
for(const [keys,label]of studioShortcuts){const row=centerNode("div","studio-shortcut");row.append(centerNode("span","",label),centerNode("kbd","",keys));$("studio-shortcuts").append(row);}
const taskBadge=centerNode("button","studio-status-button","");taskBadge.id="studio-task-badge";taskBadge.type="button";taskBadge.onclick=()=>{showSideView("project");setStudioTab("tasks");};$("statusbar").append(taskBadge);
let studioEventFrame=0;
api.onEvent((channel,data)=>{
    if(channel==="projectTask"&&data?.workspace===ui.workspace){const index=studioRuns.findIndex(run=>run.id===data.id);if(index<0)studioRuns.push(data);else studioRuns[index]=data;if(!studioEventFrame)studioEventFrame=requestAnimationFrame(()=>{studioEventFrame=0;renderStudioRuns();renderStudioTasks();});}
    if(channel==="lspDiagnostics"&&projectStudioTab==="quality")renderStudioProblems();
});
$("studio-transform-run").onclick=async()=>{
    const text=$("studio-tool-input").value;let result="";
    try {
        switch($("studio-transform").value){
            case "json":result=JSON.stringify(JSON.parse(text),null,2);break;
            case "base64-encode": {const bytes=new TextEncoder().encode(text);let binary="";for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.slice(i,i+8192));result=btoa(binary);break;}
            case "base64-decode":result=new TextDecoder("utf-8",{fatal:true}).decode(Uint8Array.from(atob(text.trim()),character=>character.charCodeAt(0)));break;
            case "url-encode":result=encodeURIComponent(text);break;
            case "url-decode":result=decodeURIComponent(text);break;
            case "uuid":result=crypto.randomUUID();break;
            case "sha256": {const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(text));result=[...new Uint8Array(digest)].map(byte=>byte.toString(16).padStart(2,"0")).join("");break;}
            case "sort":result=text.split(/\r?\n/).sort((a,b)=>a.localeCompare(b,"fr")).join("\n");break;
            case "unique":result=[...new Set(text.split(/\r?\n/))].join("\n");break;
        }
        $("studio-tool-output").value=result;$("studio-tool-status").textContent=`${result.length.toLocaleString("fr-FR")} caractères · traitement local terminé.`;
    }catch(error){$("studio-tool-status").textContent=`Conversion impossible : ${error.message}`;}
};
$("studio-transform-copy").onclick=()=>api.copyText($("studio-tool-output").value).catch(error=>{$("studio-tool-status").textContent=error.message;});
/* ---------- Préférences de l’éditeur, aperçu isolé et comparaison ---------- */
let studioEditorPreferences={fontSize:13,tabSize:4,wordWrap:false,autoSave:false,formatOnSave:false,reducedMotion:false,theme:"original"};
let studioAutoSaveTimer=null;
let studioFormatting=false;
let studioPreviewVisible=false;
let studioPreviewMode="document";
let studioPreviewUrl="";
let studioPreviewSequence=0;
let studioPreviewTimer=null;
let studioMergeView=null;
const editorToolbar=centerNode("div","studio-editor-toolbar");editorToolbar.id="studio-editor-toolbar";
editorToolbar.append(studioAction("Projet","LayoutDashboard",()=>showSideView("project")),studioAction("Formater","FileCode",()=>formatEditorDocument()),studioAction("Comparer","GitCompare",()=>openStudioCompare()),studioAction("Aperçu","Eye",()=>openDocumentPreview()),studioAction("Marquer la ligne","BookOpen",toggleStudioBookmark));
$("center").insertBefore(editorToolbar,$("breadcrumbs"));
$("editor-area").insertAdjacentHTML("beforeend",`<section id="studio-preview" class="studio-preview hidden" aria-label="Aperçu du document"><div class="studio-preview-header"><b id="studio-preview-title">Aperçu</b><div><button type="button" id="studio-preview-refresh" aria-label="Actualiser l’aperçu">↻</button><button type="button" id="studio-preview-expand" aria-label="Agrandir ou réduire l’aperçu">⛶</button><button type="button" id="studio-preview-close" aria-label="Fermer l’aperçu">×</button></div></div><div class="studio-preview-address"><input id="studio-preview-url" type="url" aria-label="Adresse du serveur local" placeholder="http://localhost:5173"><button type="button" id="studio-preview-go">Ouvrir</button></div><p id="studio-preview-message" class="studio-muted" role="status"></p><article id="studio-markdown-preview" class="studio-markdown"></article><iframe id="studio-web-preview" title="Aperçu local isolé" sandbox="allow-scripts allow-forms" referrerpolicy="no-referrer" class="hidden"></iframe></section>`);
document.body.insertAdjacentHTML("beforeend",`<dialog id="studio-compare-dialog" class="studio-compare-dialog" aria-labelledby="studio-compare-title"><div class="center-dialog-head"><div><h2 id="studio-compare-title">Comparer le document</h2><p id="studio-compare-file" class="studio-muted"></p></div><div class="studio-actions"><select id="studio-compare-base" aria-label="Version de référence"><option value="saved">Version enregistrée</option><option value="git">Dernier commit Git (HEAD)</option></select><button type="button" id="studio-compare-close">Fermer</button></div></div><div class="studio-compare-labels"><span>Version de référence</span><span>Document actuel · lecture seule</span></div><div id="studio-merge-host"></div></dialog>`);
const editorSettings=document.createElement("section");editorSettings.className="settings-card";
editorSettings.setAttribute("aria-labelledby","studio-editor-settings-title");
editorSettings.innerHTML=`<h3 id="studio-editor-settings-title">Éditeur et apparence</h3><p class="settings-help">Ces réglages sont appliqués immédiatement après enregistrement, sans redémarrage.</p><div class="settings-number-grid"><label>Taille du texte<input type="number" id="studio-font-size" min="10" max="24" value="13" required></label><label>Indentation<select id="studio-tab-size"><option value="2">2 espaces</option><option value="4" selected>4 espaces</option><option value="8">8 espaces</option></select></label></div><label class="center-code-label">Thème<select id="studio-theme"><option value="original">Sombre original</option><option value="midnight">Minuit</option></select></label><label class="setting-toggle"><span><b>Retour à la ligne visuel</b><small>Affiche les longues lignes sans défilement horizontal.</small></span><input type="checkbox" role="switch" id="studio-word-wrap"></label><label class="setting-toggle"><span><b>Enregistrement automatique</b><small>Enregistre le fichier actif deux secondes après la dernière modification.</small></span><input type="checkbox" role="switch" id="studio-auto-save"></label><label class="setting-toggle"><span><b>Formater à l’enregistrement</b><small>Prettier pour JS, TS, JSON, CSS, HTML, Vue, Markdown et YAML. Une erreur de syntaxe n’empêche pas de sauvegarder le texte.</small></span><input type="checkbox" role="switch" id="studio-format-save"></label><label class="setting-toggle"><span><b>Réduire les animations</b><small>Limite les transitions et mouvements dans l’interface.</small></span><input type="checkbox" role="switch" id="studio-reduced-motion"></label><button type="button" id="studio-editor-settings-save" class="primary">Enregistrer l’éditeur et l’apparence</button><p id="studio-editor-settings-message" class="settings-help" role="status"></p>`;
$("settings-view").insertBefore(editorSettings,$("settings-message"));
function applyStudioEditorPreferences(value) {
    studioEditorPreferences={...studioEditorPreferences,...value};
    code.configure(studioEditorPreferences);
    document.documentElement.dataset.studioTheme=studioEditorPreferences.theme;
    document.querySelectorAll("[data-theme-choice]").forEach(button=>button.setAttribute("aria-pressed",String(button.dataset.themeChoice===studioEditorPreferences.theme)));
    document.documentElement.classList.toggle("studio-reduced-motion",studioEditorPreferences.reducedMotion);
    $("studio-font-size").value=studioEditorPreferences.fontSize;
    $("studio-tab-size").value=String(studioEditorPreferences.tabSize);
    $("studio-theme").value=studioEditorPreferences.theme;
    for(const [id,key]of[["studio-word-wrap","wordWrap"],["studio-auto-save","autoSave"],["studio-format-save","formatOnSave"],["studio-reduced-motion","reducedMotion"]])$(id).checked=studioEditorPreferences[key];
}
api.editorPreferences().then(applyStudioEditorPreferences).catch(()=>{});
$("studio-editor-settings-save").onclick=async()=>{
    if(!$("studio-font-size").reportValidity())return;
    const value={fontSize:Number($("studio-font-size").value),tabSize:Number($("studio-tab-size").value),theme:$("studio-theme").value,wordWrap:$("studio-word-wrap").checked,autoSave:$("studio-auto-save").checked,formatOnSave:$("studio-format-save").checked,reducedMotion:$("studio-reduced-motion").checked};
    try{applyStudioEditorPreferences(await api.editorPreferences("save",value));$("studio-editor-settings-message").textContent="Éditeur et apparence enregistrés.";}
    catch(error){$("studio-editor-settings-message").textContent=error.message;}
};
async function formatEditorDocument() {
    const tab=currentTab();if(!tab||tab.kind==="asset"||studioFormatting)return false;
    const before=code.value;studioFormatting=true;
    try {
        const result=await api.formatDocument({file:tab.path,text:before,tabSize:studioEditorPreferences.tabSize});
        if(currentTab()!==tab||code.value!==before){lspStatus("Formatage annulé : le document a changé pendant la requête.");return false;}
        if(!result.changed){lspStatus("Document déjà formaté.");return true;}
        const selected=code.selectionStart;
        code.view.dispatch({changes:{from:0,to:code.view.state.doc.length,insert:result.text},selection:{anchor:Math.min(selected,result.text.length)},userEvent:"input.format"});
        lspSyncTabFromEditor(tab);renderTabs();lspScheduleSync();lspStatus("Document formaté avec Prettier · Ctrl+Z pour annuler.");return true;
    }catch(error){lspStatus(`Formatage : ${error.message}`);return false;}
    finally{studioFormatting=false;}
}
async function saveAllStudioFiles() {
    let count=0;
    for(const tab of ui.tabs.filter(tab=>tab.dirty&&tab.kind!=="asset")) {
        const snapshot=tab.content;
        try{await api.writeFile(tab.path,tab.eol==="\r\n"?snapshot.replace(/\n/g,"\r\n"):snapshot,{encoding:tab.encoding||"utf8",bom:tab.bom===true});tab.saved=snapshot;tab.dirty=tab.content!==snapshot;count++;}
        catch(error){lspStatus(`Enregistrement de ${tab.path} : ${error.message}`);}
    }
    renderTabs();scheduleGitRefresh();lspStatus(`${count} fichier(s) enregistré(s).`);
}
function closeDocumentPreview() {
    studioPreviewVisible=false;studioPreviewSequence++;
    $("studio-preview").classList.add("hidden");$("editor-area").classList.remove("studio-preview-open","studio-preview-wide");
    $("studio-web-preview").removeAttribute("src");
    api.localPreview("stop").catch(()=>{});
}
async function openDocumentPreview() {
    studioPreviewMode="document";
    studioPreviewVisible=true;$("studio-preview").classList.remove("hidden");$("editor-area").classList.add("studio-preview-open");
    await updateDocumentPreview();
}
async function updateDocumentPreview() {
    if(!studioPreviewVisible||studioPreviewMode!=="document")return;
    const sequence=++studioPreviewSequence;
    const tab=currentTab();
    $("studio-preview-message").textContent="";
    $("studio-preview-title").textContent=tab?.path.split("/").pop()||"Aperçu local";
    $("studio-markdown-preview").classList.add("hidden");$("studio-web-preview").classList.add("hidden");
    if(!tab){$("studio-preview-message").textContent="Ouvre un fichier Markdown ou HTML. Pour une application web, saisis l’adresse du serveur local ci-dessus.";return;}
    if(/\.(md|markdown)$/i.test(tab.path)) {
        $("studio-web-preview").removeAttribute("src");
        $("studio-markdown-preview").innerHTML=window.StudioVendor.markdown(tab.content);
        $("studio-markdown-preview").classList.remove("hidden");return;
    }
    if(/\.html?$/i.test(tab.path)) {
        if(tab.dirty){$("studio-preview-message").textContent="Enregistre le fichier HTML pour actualiser l’aperçu. Les chemins relatifs sont servis depuis ton projet.";return;}
        try{const result=await api.localPreview("start",{file:tab.path});if(sequence!==studioPreviewSequence)return;studioPreviewUrl=result.url;$("studio-preview-url").value=result.url;$("studio-web-preview").src=result.url;$("studio-web-preview").classList.remove("hidden");}
        catch(error){if(sequence===studioPreviewSequence)$("studio-preview-message").textContent=error.message;}
        return;
    }
    $("studio-preview-message").textContent="L’aperçu documentaire prend en charge Markdown et HTML. Pour Vite, React ou un autre serveur, lance le script de développement et saisis son adresse locale.";
}
$("studio-preview-close").onclick=closeDocumentPreview;
$("studio-preview-expand").onclick=()=>$("editor-area").classList.toggle("studio-preview-wide");
$("studio-preview-refresh").onclick=()=>{if(studioPreviewMode==="document")updateDocumentPreview();else if(studioPreviewUrl)$("studio-web-preview").src=studioPreviewUrl;};
$("studio-preview-go").onclick=()=>openLocalBrowser($("studio-preview-url").value);
$("studio-preview-url").onkeydown=event=>{if(event.key==="Enter"){event.preventDefault();$("studio-preview-go").click();}};
$("studio-markdown-preview").onclick=async event=>{
    const link=event.target.closest("a");if(!link)return;event.preventDefault();
    const href=link.getAttribute("href")||"";
    if(/^https?:\/\//i.test(href)){await api.openExternal(href);return;}
    if(href.startsWith("#")){const heading=[...$("studio-markdown-preview").querySelectorAll("h1,h2,h3,h4")].find(node=>node.textContent.toLowerCase().replace(/\s+/g,"-")===href.slice(1));heading?.scrollIntoView({block:"nearest"});return;}
    const tab=currentTab();if(!tab)return;
    const segments=tab.path.split("/");segments.pop();
    for(const part of href.split("#")[0].split("/")){if(part==="..")segments.pop();else if(part&&part!==".")segments.push(part);}
    if(segments.length)await openFile(segments.join("/"));
};
async function openStudioCompare() {
    if(!currentTab())return;
    if(currentTab().kind==="asset"){lspStatus("La comparaison est disponible pour les documents texte.");return;}
    $("studio-compare-dialog").showModal();await renderStudioCompare();
}
async function renderStudioCompare() {
    const tab=currentTab();if(!tab)return;
    const before=$("studio-compare-base").value==="git"?String(await api.gitShowHead(tab.path)):tab.saved;
    if(studioMergeView)studioMergeView.destroy();$("studio-merge-host").replaceChildren();
    $("studio-compare-file").textContent=tab.path;
    const CM=window.CM;
    const extensions=[CM.basicSetup,CM.EditorView.editable.of(false),CM.EditorState.readOnly.of(true),CM.oneDark,CM.languageFor(extKind(tab.path))];
    studioMergeView=new CM.MergeView({a:{doc:before,extensions},b:{doc:tab.content,extensions},parent:$("studio-merge-host"),highlightChanges:true,gutter:true,collapseUnchanged:{margin:4,minSize:12}});
}
$("studio-compare-base").onchange=()=>renderStudioCompare().catch(error=>lspStatus(error.message));
$("studio-compare-close").onclick=()=>$("studio-compare-dialog").close();
$("studio-compare-dialog").addEventListener("close",()=>{studioMergeView?.destroy();studioMergeView=null;});
function studioWorkspaceChanged() {
    closeDocumentPreview();studioRuns=[];studioSelectedRun=null;
    if(ui.sideView==="project")refreshProjectStudio();
}
code.addEventListener("input",()=>{
    if(studioPreviewVisible&&studioPreviewMode==="document"){clearTimeout(studioPreviewTimer);studioPreviewTimer=setTimeout(updateDocumentPreview,220);}
    clearTimeout(studioAutoSaveTimer);
    if(studioEditorPreferences.autoSave){const tab=currentTab();studioAutoSaveTimer=setTimeout(()=>{if(tab&&currentTab()===tab&&tab.dirty)saveCurrent();},2000);}
});
window.addEventListener("keydown",event=>{
    if(document.querySelector("dialog[open]")||(!event.ctrlKey&&!event.metaKey))return;
    const key=event.key.toLowerCase();let action=null;
    if(event.shiftKey&&key==="d")action=()=>showSideView("project");
    else if(event.shiftKey&&key==="s")action=saveAllStudioFiles;
    else if(event.shiftKey&&key==="v")action=()=>studioPreviewVisible?closeDocumentPreview():openDocumentPreview();
    else if(key==="f2")action=toggleStudioBookmark;
    if(action){event.preventDefault();event.stopImmediatePropagation();Promise.resolve(action()).catch(error=>lspStatus(error.message));}
},true);
const welcomeCockpit=studioQuick("Cockpit du projet","Commandes, qualité, documentation et outils locaux","LayoutDashboard",()=>showSideView("project"));
$("editor-welcome").querySelector(".welcome-grid")?.prepend(welcomeCockpit);
/* Navigation dans le document : symboles LSP et titres Markdown. */
let studioSymbolItems=[];
let studioSymbolPath=null;
let studioSymbolSequence=0;
document.body.insertAdjacentHTML("beforeend",`<dialog id="studio-symbol-dialog" class="center-dialog" aria-labelledby="studio-symbol-title"><div class="center-dialog-head"><h2 id="studio-symbol-title">Naviguer dans le document</h2><button type="button" id="studio-symbol-close">Fermer</button></div><p id="studio-symbol-file" class="studio-muted"></p><input type="search" id="studio-symbol-search" class="studio-symbol-search" placeholder="Rechercher un symbole ou un titre…" aria-label="Filtrer les symboles"><p id="studio-symbol-status" class="studio-muted" role="status"></p><div id="studio-symbol-list" class="studio-symbol-list"></div></dialog>`);
editorToolbar.append(studioAction("Symboles","FileCode",openStudioSymbols));
function renderStudioSymbols() {
    const query=$("studio-symbol-search").value.toLocaleLowerCase("fr").trim();
    const items=studioSymbolItems.filter(item=>`${item.name} ${item.kind}`.toLocaleLowerCase("fr").includes(query));
    const list=$("studio-symbol-list");list.replaceChildren();
    for(const item of items) {
        const button=centerButton("",async()=>{$("studio-symbol-dialog").close();if(currentTab()?.path!==studioSymbolPath)await openFile(studioSymbolPath);goToLine(item.line+1);});
        button.className="studio-symbol-item";button.style.paddingLeft=`${12+Math.min(6,item.depth)*12}px`;
        const text=centerNode("span","");text.append(centerNode("b","",item.name),centerNode("small","",item.kind+(item.detail?` · ${item.detail}`:"")));
        button.append(text,centerNode("span","studio-muted",`L${item.line+1}`));list.append(button);
    }
    if(!items.length)list.append(centerNode("p","studio-muted","Aucun symbole ne correspond."));
}
async function openStudioSymbols() {
    const tab=currentTab();if(!tab){lspStatus("Ouvre un document pour afficher ses symboles.");return;}
    const sequence=++studioSymbolSequence;studioSymbolPath=tab.path;studioSymbolItems=[];
    $("studio-symbol-search").value="";$("studio-symbol-file").textContent=tab.path;$("studio-symbol-status").textContent="Lecture de la structure du document…";$("studio-symbol-list").replaceChildren();
    $("studio-symbol-dialog").showModal();$("studio-symbol-search").focus();
    try {
        let items=[];
        if(/\.(md|markdown)$/i.test(tab.path))tab.content.split("\n").forEach((line,index)=>{const match=/^(#{1,6})\s+(.+)/.exec(line);if(match)items.push({name:match[2],line:index,depth:match[1].length-1,kind:"titre",detail:""});});
        else if(lspEnabledFor(tab.path))items=await api.documentSymbols(tab.path,tab.content);
        else {$("studio-symbol-status").textContent="La navigation structurée est disponible pour JS, TS et Markdown.";return;}
        if(sequence!==studioSymbolSequence||!$("studio-symbol-dialog").open)return;
        studioSymbolItems=items.slice(0,800);$("studio-symbol-status").textContent=`${studioSymbolItems.length} symbole(s) repéré(s).`;renderStudioSymbols();
    }catch(error){if(sequence===studioSymbolSequence)$("studio-symbol-status").textContent=`Symboles indisponibles : ${error.message}`;}
}
$("studio-symbol-search").oninput=renderStudioSymbols;
$("studio-symbol-search").onkeydown=event=>{if(event.key==="ArrowDown"){event.preventDefault();$("studio-symbol-list").querySelector("button")?.focus();}if(event.key==="Enter"){$("studio-symbol-list").querySelector("button")?.click();}};
$("studio-symbol-list").onkeydown=event=>{if(!["ArrowDown","ArrowUp"].includes(event.key))return;const buttons=[...$("studio-symbol-list").querySelectorAll("button")];const index=buttons.indexOf(document.activeElement);if(index<0)return;event.preventDefault();buttons[(index+(event.key==="ArrowDown"?1:buttons.length-1))%buttons.length]?.focus();};
$("studio-symbol-close").onclick=()=>$("studio-symbol-dialog").close();
$("studio-symbol-dialog").addEventListener("close",()=>{studioSymbolSequence++;});
window.addEventListener("keydown",event=>{if((event.ctrlKey||event.metaKey)&&event.shiftKey&&event.key.toLowerCase()==="o"&&!document.querySelector("dialog[open]")){event.preventDefault();event.stopImmediatePropagation();openStudioSymbols();}},true);
/* Fichiers non textuels : aperçu sans écriture et application associée. */
const studioAssetView=centerNode("section","studio-asset-view hidden");studioAssetView.id="studio-asset-view";$("editor-area").append(studioAssetView);
function showStudioAsset(tab) {
    const asset=tab?.kind==="asset"?tab.asset:null;
    studioAssetView.classList.toggle("hidden",!asset);studioAssetView.replaceChildren();
    if(!asset)return;
    $("editor").classList.add("hidden");$("editor-welcome").classList.add("hidden");
    const header=centerNode("div","studio-asset-header");header.append(centerNode("span","studio-pill","Aperçu · lecture seule"),centerNode("h2","",asset.name),centerNode("p","studio-muted",`${formatBytes(asset.size)} · ${asset.mime} · ${new Date(asset.modifiedAt).toLocaleString("fr-FR")}`));
    header.append(studioAction("Ouvrir dans l’application associée","ExternalLink",async()=>{const error=await api.openFileInApp(tab.path);if(error)lspStatus(error);}));studioAssetView.append(header);
    if(asset.dataUrl&&["image","audio","video"].includes(asset.kind)) {
        const media=document.createElement(asset.kind==="image"?"img":asset.kind);media.src=asset.dataUrl;if(asset.kind==="image")media.alt=asset.name;else media.controls=true;
        media.className="studio-asset-media";studioAssetView.append(media);
    }else {
        studioAssetView.append(centerNode("p","studio-muted",asset.kind==="text-preview"?"Extrait du fichier volumineux, non modifiable ici. Ouvre-le dans l’application associée pour accéder à son contenu complet.":"Ce format n’est pas édité comme du texte pour préserver ses données. Voici un aperçu des octets ; utilise son application associée pour le modifier."));
        studioAssetView.append(centerNode("pre","studio-asset-bytes",asset.preview));
        if(asset.truncated)studioAssetView.append(centerNode("p","studio-muted","Aperçu limité aux 16 premiers Ko."));
    }
}

/* Recherches et captures restent en arrière-plan, indépendamment de la saisie. */
const researchTab=centerNode("button","","Internet");researchTab.type="button";researchTab.dataset.studioTab="research";researchTab.setAttribute("role","tab");researchTab.setAttribute("aria-selected","false");researchTab.tabIndex=-1;$("project-studio").querySelector(".studio-tabs").append(researchTab);researchTab.onclick=()=>{setStudioTab("research");refreshStudioResearch();};
researchTab.onkeydown=event=>{if(!["ArrowLeft","ArrowRight"].includes(event.key))return;event.preventDefault();const buttons=[...document.querySelectorAll("[data-studio-tab]")];buttons[(buttons.indexOf(researchTab)+(event.key==="ArrowRight"?1:buttons.length-1))%buttons.length].click();};
const researchPage=centerNode("section","hidden");researchPage.dataset.studioPage="research";
researchPage.innerHTML=`<div class="studio-section-heading"><div><h2>Rechercher sans interrompre le travail.</h2><p class="studio-muted">Les résultats restent disponibles pendant que tu écris à l’agent ou modifies tes fichiers. Les extraits ne remplacent pas la consultation des sources.</p></div></div><form id="studio-research-form" class="center-filters"><input type="search" id="studio-research-query" required maxlength="1000" placeholder="Chercher une documentation ou une réponse sur le web…" aria-label="Recherche Internet"><button type="submit" class="primary">Rechercher en arrière-plan</button></form><div id="studio-research-jobs" class="studio-research-jobs"></div><article class="studio-card"><h3>Capturer une page web</h3><p class="studio-muted">Ouvre Chrome ou Edge sans fenêtre visible, relève le texte et les erreurs de console et enregistre un PNG dans .frst/screenshots. Une capture est distincte de son analyse par le modèle.</p><div class="center-filters"><input type="url" id="studio-capture-url" placeholder="http://localhost:5173" aria-label="Page à capturer"><button type="button" id="studio-capture-button">Prendre une capture</button></div><p id="studio-capture-status" class="studio-muted" role="status"></p><div id="studio-capture-results" class="studio-link-list"></div></article>`;
$("project-studio").append(researchPage);
async function refreshStudioResearch(){renderStudioResearch(await api.webResearch("list"));}
function renderStudioResearch(jobs) {
    const list=$("studio-research-jobs");list.replaceChildren();
    for(const job of jobs.slice().reverse()) {
        const card=centerNode("article","studio-card");card.append(centerNode("span","studio-pill",({running:"En cours",done:"Terminée",failed:"Échec",stopped:"Arrêtée",denied:"Désactivée"})[job.status]||job.status),centerNode("h3","",job.query));
        if(job.status==="running")card.append(centerButton("Arrêter la recherche",async()=>{await api.webResearch("cancel",{id:job.id});await refreshStudioResearch();}));
        if(job.error)card.append(centerNode("p","studio-muted",job.error));
        for(const source of job.result?.results||[]) {
            const row=centerNode("div","studio-research-source");row.append(centerButton(source.title||source.url,()=>api.openExternal(source.url)),centerNode("p","studio-muted",source.snippet));card.append(row);
        }
        if(job.status==="done"&&!job.result?.results?.length)card.append(centerNode("p","studio-muted",job.result?.message||"Aucun résultat exploitable."));
        list.append(card);
    }
    if(!jobs.length)list.append(centerNode("p","studio-empty","Aucune recherche pour l’instant."));
}
$("studio-research-form").onsubmit=async event=>{event.preventDefault();try{const result=await api.webResearch("start",{query:$("studio-research-query").value});if(result.denied)$("studio-message").textContent=result.message;await refreshStudioResearch();}catch(error){$("studio-message").textContent=error.message;}};
$("studio-capture-button").onclick=async()=>{
    $("studio-capture-button").disabled=true;$("studio-capture-status").textContent="Capture en cours. Si un accord est nécessaire, la demande apparaît dans le panneau Agent.";
    try {
        const result=await api.captureWebPage({url:$("studio-capture-url").value,full_page:false});
        $("studio-capture-status").textContent=result.message;
        if(result.screenshot)$("studio-capture-results").prepend(centerButton(`${result.title||"Capture"} · ${result.screenshot}`,async()=>{showSideView("explorer");await openFile(result.screenshot);}));
    }catch(error){$("studio-capture-status").textContent=error.message;}
    finally{$("studio-capture-button").disabled=false;}
};
api.onEvent(channel=>{if(channel==="webResearch")refreshStudioResearch().catch(()=>{});});

/* Paramètres de capture et mises à jour de la version installée. */
const captureSettings=document.createElement("section");captureSettings.className="settings-card";
captureSettings.innerHTML=`<h3>Captures et navigateur de l’agent</h3><p class="settings-help">Autorise l’outil browse à ouvrir une page en arrière-plan et à sauvegarder son rendu. L’outil view_image peut ensuite proposer de transmettre une image au modèle pour l’examiner. La prise en charge de la vision dépend du modèle et du fournisseur.</p><label class="center-code-label">Captures de pages<select id="studio-browser-permission"><option value="ask">Demander l’accord</option><option value="allow">Autoriser les captures de pages</option><option value="deny">Désactiver les captures</option></select></label><p id="studio-browser-permission-status" class="settings-help" role="status"></p>`;
$("settings-view").insertBefore(captureSettings,$("settings-message"));
api.browserPermission().then(value=>{$("studio-browser-permission").value=value;}).catch(()=>{});
$("studio-browser-permission").onchange=async()=>{try{await api.browserPermission("save",$("studio-browser-permission").value);$("studio-browser-permission-status").textContent="Permission de capture enregistrée.";}catch(error){$("studio-browser-permission-status").textContent=error.message;}};
const updateSettings=document.createElement("section");updateSettings.className="settings-card";
updateSettings.innerHTML=`<h3>Application et mises à jour</h3><p id="studio-app-version" class="settings-help"></p><label class="setting-toggle"><span><b>Mises à jour automatiques</b><small>Vérifier et télécharger les versions publiées. Sur Windows installé, une mise à jour téléchargée est appliquée à la fermeture. Sur Mac, la vérification est automatique et l’installation reste manuelle. Les projets et réglages restent dans leurs dossiers.</small></span><input type="checkbox" role="switch" id="studio-automatic-updates"></label><p id="studio-update-message" class="settings-help" role="status"></p><progress id="studio-update-progress" max="100" value="0" class="hidden"></progress><div class="studio-actions"><button type="button" id="studio-update-check">Vérifier maintenant</button><button type="button" id="studio-update-download" class="hidden">Télécharger la mise à jour</button><button type="button" id="studio-update-install" class="primary hidden">Enregistrer et redémarrer</button></div><p class="settings-help">Source prévue : versions GitHub de SrxKirito/FranceStudent-Code. Les nouvelles versions doivent être publiées avec leur installateur et leurs métadonnées de mise à jour. Aucune version n’est publiée automatiquement par cette interface.</p>`;
$("settings-view").insertBefore(updateSettings,$("settings-message"));
function renderStudioUpdates(data){$("studio-app-version").textContent=`Version de l’application : ${data.version}`;$("studio-automatic-updates").checked=data.automatic;$("studio-update-message").textContent=data.message;$("studio-update-progress").value=data.progress;$("studio-update-progress").classList.toggle("hidden",data.status!=="downloading");$("studio-update-check").disabled=["unavailable","unsupported","checking","downloading"].includes(data.status);$("studio-update-download").classList.toggle("hidden",(data.status!=="available"||(data.canInstall===false&&!data.downloadUrl)));$("studio-update-install").classList.toggle("hidden",data.status!=="downloaded");}
api.updates().then(renderStudioUpdates).catch(()=>{});
$("studio-automatic-updates").onchange=()=>api.updates("automatic",{enabled:$("studio-automatic-updates").checked}).then(renderStudioUpdates).catch(error=>{$("studio-update-message").textContent=error.message;});
for(const action of ["check","download","install"])$("studio-update-"+action).onclick=async()=>{try{if(action==="install"){await saveAllStudioFiles();if(ui.tabs.some(tab=>tab.dirty))throw new Error("Certains fichiers n’ont pas pu être enregistrés. Enregistre-les avant de redémarrer.");}renderStudioUpdates(await api.updates(action));}catch(error){$("studio-update-message").textContent=error.message;}};
api.onEvent((channel,data)=>{if(channel==="appUpdate")renderStudioUpdates(data);});

/* Actions explicites pour gérer le contexte de l’agent. */
const contextActions=centerNode("section","starter-context");
contextActions.setAttribute("aria-label","Gérer la conversation");
contextActions.append(centerNode("h3","","Conversation"));
const contextButtons=centerNode("div","starter-context-actions");
for(const [label,description,icon,command] of [
    ["Voir le contexte","Consulter le résumé du projet","BookOpen","/resume"],
    ["Compacter","Alléger la conversation","Command","/compact"]
]){
    const button=studioAction("",icon,()=>{input.value=command;autosizeInput();input.focus();});
    button.setAttribute("aria-label",label);
    button.title=description;
    const text=centerNode("span","starter-context-text");
    text.append(centerNode("b","",label),centerNode("small","",description));
    button.append(text);contextButtons.append(button);
}
contextActions.append(contextButtons);
$("agent-starter")?.append(contextActions);
for(const [index,button] of [...document.querySelectorAll(".starter-prompts button")].entries()){
    const slot=button.querySelector("span"),icon=studioIcon(["Search","GitCompareArrows","Check"][index]);
    if(slot&&icon)slot.replaceChildren(icon);
}

/* A bounded startup check; downloads continue without blocking the editor. */
async function runStartupUpdateCheck() {
    const overlay=$("startup-loading"),message=$("startup-message"),appRoot=$("app");
    const primary=$("startup-update-now"),progress=$("startup-update-progress"),later=$("startup-continue"),openButton=$("startup-update-open");
    let finished=false,deadline=null,finishTimer=null,current=null,off=null;
    appRoot.inert=true;
    const close=()=>{if(finished)return;finished=true;clearTimeout(deadline);clearTimeout(finishTimer);overlay.hidden=true;appRoot.inert=false;if(overlay.contains(document.activeElement))input.focus();};
    const offer=data=>{
        current=data;
        const available=["available","downloading","downloaded"].includes(data.status);
        openButton.classList.toggle("hidden",!available);
        if(finished)return;
        overlay.querySelector(".startup-track").classList.toggle("hidden",data.status!=="checking");
        if(available){
            clearTimeout(deadline);clearTimeout(finishTimer);
            $("startup-heading").textContent=data.status==="downloaded"?"La mise à jour est prête.":`Nouvelle version ${data.availableVersion||"disponible"}`;
            later.textContent="Plus tard";
            primary.classList.remove("hidden");
            primary.textContent=data.canInstall===false?"Télécharger l’installateur":data.status==="downloaded"?"Redémarrer et installer":data.status==="downloading"?"Téléchargement en cours…":"Mettre à jour maintenant";
            primary.disabled=data.status==="downloading";
            progress.classList.toggle("hidden",data.status!=="downloading");progress.value=data.progress||0;
            message.textContent=data.status==="downloading"?`Téléchargement : ${Math.round(data.progress||0)} %`:
                data.status==="downloaded"?"Enregistre ton travail pour redémarrer et installer la nouvelle version.":data.canInstall===false?data.manualPlatform==="darwin"?data.message:"Cette version portable ne s’installe pas automatiquement. Télécharge l’installateur Windows pour passer à la nouvelle version.":"La nouvelle version est disponible. Tu peux l’installer maintenant ou continuer dans l’IDE.";
        }else if(data.status==="error"){
            message.textContent=data.message;progress.classList.add("hidden");primary.classList.remove("hidden");primary.disabled=false;primary.textContent="Réessayer";later.textContent="Ouvrir l’IDE";
        }else if(["current","unavailable"].includes(data.status)){
            message.textContent=data.message;primary.classList.add("hidden");progress.classList.add("hidden");
            clearTimeout(finishTimer);finishTimer=setTimeout(close,650);
        }
    };
    later.onclick=close;later.focus();
    openButton.onclick=()=>{finished=false;overlay.hidden=false;appRoot.inert=true;offer(current);primary.focus();};
    off=api.onEvent((channel,data)=>{if(channel==="appUpdate")offer(data);});
    window.addEventListener("unload",()=>off?.(),{once:true});
    primary.onclick=async()=>{
        primary.disabled=true;
        try{
            if(current?.canInstall===false){if(current.downloadUrl)await api.updates("download");else await api.openExternal("https://github.com/SrxKirito/FranceStudent-Code/releases/latest");close();return;}
            if(current?.status==="downloaded"){
                await saveAllStudioFiles();
                if(ui.tabs.some(tab=>tab.dirty))throw new Error("Enregistre tes fichiers avant de redémarrer.");
                await api.updates("install");return;
            }
            if(current?.status==="error"){offer(await api.updates("check",{startup:true}));return;}
            offer(await api.updates("download"));
        }catch(error){message.textContent=error.message;}
        finally{primary.disabled=current?.status==="downloading";}
    };
    const start=Date.now();
    try {
        const result=await Promise.race([
            api.updates("check",{startup:true}),
            new Promise(resolve=>{deadline=setTimeout(()=>resolve({status:"timeout",message:"La vérification continue en arrière-plan. Ouverture de l’IDE…"}),8000);})
        ]);
        if(finished)return;
        if(["available","downloading","downloaded"].includes(current?.status))return;
        if(["available","downloading","downloaded"].includes(result.status)){offer(result);return;}
        current=result;
        message.textContent=result.status==="unavailable"?"Mode développement : ouverture de l’IDE…":result.message;
    } catch {
        if(!finished)message.textContent="Vérification indisponible. Ouverture de l’IDE…";
    } finally {
        clearTimeout(deadline);
        if(!finished&&!["available","downloading","downloaded"].includes(current?.status))finishTimer=setTimeout(close,Math.max(650,1100-(Date.now()-start)));
    }
}
runStartupUpdateCheck().catch(()=>{$("startup-loading").hidden=true;$("app").inert=false;});
/* Real local browser, presented as an editor tab. */
let localBrowserState=null,localBrowserActive=false,localBrowserBoundsFrame=0;
const localBrowserPanel=document.createElement("section");
localBrowserPanel.id="local-browser-panel";localBrowserPanel.className="local-browser-panel hidden";
localBrowserPanel.innerHTML=`<div class="local-browser-toolbar"><button id="local-browser-back" title="Page précédente" aria-label="Page précédente">←</button><button id="local-browser-forward" title="Page suivante" aria-label="Page suivante">→</button><button id="local-browser-reload" title="Actualiser" aria-label="Actualiser">↻</button><form id="local-browser-form"><input id="local-browser-address" aria-label="Adresse du navigateur local" placeholder="http://localhost:5173" spellcheck="false"><button type="submit">Ouvrir</button></form><button id="local-browser-external" title="Ouvrir dans le navigateur système" aria-label="Ouvrir dans le navigateur système">↗</button><button id="local-browser-devtools" title="Outils de développement" aria-label="Outils de développement">⋯</button></div><div id="local-browser-status" role="status"></div><div id="local-browser-host"><div id="local-browser-error" class="hidden"><h2>Le site n’est pas accessible</h2><p></p><button id="local-browser-retry">Réessayer</button></div></div>`;
$("editor-area").append(localBrowserPanel);
function syncLocalBrowserBounds(){
    cancelAnimationFrame(localBrowserBoundsFrame);
    localBrowserBoundsFrame=requestAnimationFrame(()=>{
        const host=$("local-browser-host"),rect=host.getBoundingClientRect();
        const modal=Boolean(document.querySelector("dialog[open]"))||["connection-guide","palette","context-menu","model-menu"].some(id=>{const el=$(id);return el&&!el.classList.contains("hidden")&&el.checkVisibility();});
        const visible=localBrowserActive&&!localBrowserPanel.classList.contains("hidden")&&host.checkVisibility()&&!modal&&!$("app").inert&&!document.querySelector('#startup-loading:not([hidden])');
        api.localBrowser("bounds",{x:rect.x,y:rect.y,width:rect.width,height:rect.height,visible}).catch(()=>{});
    });
}
function renderLocalBrowserState(data){
    const changedUrl=localBrowserState?.url!==data.url;
    localBrowserState=data;
    window.dispatchEvent(new CustomEvent("frst-local-browser-state", { detail: data }));
    if(changedUrl||document.activeElement!==$("local-browser-address"))$("local-browser-address").value=data.url;
    $("local-browser-back").disabled=!data.canGoBack;$("local-browser-forward").disabled=!data.canGoForward;
    $("local-browser-status").textContent=data.error?"Connexion impossible":data.loading?"Chargement du site…":"";
    $("local-browser-error").classList.toggle("hidden",!data.error);$("local-browser-error").querySelector("p").textContent=data.error||"";
    renderLocalBrowserTab();syncLocalBrowserBounds();
}
function renderLocalBrowserTab(){
    $("local-browser-tab")?.remove();if(!localBrowserState)return;
    const tab=document.createElement("div");tab.id="local-browser-tab";tab.className="tab"+(localBrowserActive?" active":"");tab.title=localBrowserState.url;tab.setAttribute("role","tab");tab.setAttribute("aria-selected",String(localBrowserActive));
    const title=document.createElement("span");title.textContent="◎ "+(localBrowserState.title||"Navigateur local");
    const close=document.createElement("button");close.className="close";close.textContent="×";close.title="Fermer le navigateur local";
    close.onclick=event=>{event.stopPropagation();closeLocalBrowser();};tab.onclick=showLocalBrowser;
    tab.append(title,close);$("tabs").append(tab);
    if(localBrowserActive)for(const fileTab of $("tabs").querySelectorAll(".tab:not(#local-browser-tab)"))fileTab.classList.remove("active");
}
function showLocalBrowser(){
    if (!$ ("app").classList.contains("focus-agent") && ["project", "settings", "extensions"].includes(ui.sideView)) showSideView("explorer");
    closeDocumentPreview();localBrowserActive=true;$("app").classList.add("local-browser-active");localBrowserPanel.classList.remove("hidden");api.localBrowser("show").catch(()=>{});renderLocalBrowserTab();syncLocalBrowserBounds();
}
function hideLocalBrowser(){localBrowserActive=false;$("app").classList.remove("local-browser-active");localBrowserPanel.classList.add("hidden");api.localBrowser("hide").catch(()=>{});renderLocalBrowserTab();}
function closeLocalBrowser(){hideLocalBrowser();localBrowserState=null;$("local-browser-tab")?.remove();api.localBrowser("close").catch(()=>{});renderTabs();}
async function openLocalBrowser(url){
    try{showLocalBrowser();renderLocalBrowserState(await api.localBrowser("open",{url}));}
    catch(error){studioFeedback(error.message);}
}
window.frstBrowserTab=renderLocalBrowserTab;window.frstBrowserHide=hideLocalBrowser;
$("local-browser-form").onsubmit=event=>{event.preventDefault();openLocalBrowser($("local-browser-address").value);};
for(const action of ["back","forward","reload","devtools"])$("local-browser-"+action).onclick=()=>api.localBrowser(action).catch(error=>studioFeedback(error.message));
$("local-browser-retry").onclick=()=>api.localBrowser("reload").catch(()=>{});
$("local-browser-external").onclick=()=>api.openExternal(localBrowserState?.url,true).catch(error=>studioFeedback(error.message));
api.onEvent((channel,data)=>{
    if(channel==="localBrowser"){
        if(data.command==="focus-address"){$("local-browser-address").focus();$("local-browser-address").select();return;}
        if(data.command==="close"){closeLocalBrowser();return;}
        if(localBrowserActive||localBrowserState)renderLocalBrowserState(data);
    }
    if(channel==="localBrowserOpen")openLocalBrowser(data.url);
});
new ResizeObserver(syncLocalBrowserBounds).observe($("editor-area"));
new MutationObserver(syncLocalBrowserBounds).observe($("app"),{attributes:true,attributeFilter:["class","inert"]});
new MutationObserver(syncLocalBrowserBounds).observe(document.body,{subtree:true,attributes:true,attributeFilter:["open"]});
for(const id of ["connection-guide","palette","context-menu","model-menu"]){const el=$(id);if(el)new MutationObserver(syncLocalBrowserBounds).observe(el,{attributes:true,attributeFilter:["class"]});}
window.addEventListener("resize",syncLocalBrowserBounds);
document.addEventListener("keydown",event=>{
    if(!localBrowserActive||!(event.ctrlKey||event.metaKey))return;
    if(event.key.toLowerCase()==="l"){event.preventDefault();event.stopImmediatePropagation();$("local-browser-address").focus();$("local-browser-address").select();}
    if(event.key.toLowerCase()==="w"){event.preventDefault();event.stopImmediatePropagation();closeLocalBrowser();}
},true);
document.addEventListener("click",event=>{
    const link=event.target.closest("a[href]");if(!link)return;
    try{const url=new URL(link.href);if(["http:","https:"].includes(url.protocol)&&["localhost","127.0.0.1"].includes(url.hostname)){event.preventDefault();event.stopImmediatePropagation();openLocalBrowser(url.href);}}catch{/* not a URL */}
},true);
/* ---------- Reprise d’une conversation Codex · Bêta ---------- */
const conversationImportButton = document.createElement("button");
conversationImportButton.type = "button";
conversationImportButton.id = "conversation-import";
conversationImportButton.innerHTML = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3H5a2 2 0 0 0-2 2v12l4-4h5M17 3v10m-4-4 4 4 4-4M13 18h8"/></svg><span>Importer Codex</span><span class="composer-beta">Bêta</span>';
conversationImportButton.setAttribute("aria-label", "Importer une conversation Codex, bêta");
conversationImportButton.title = "Continuer une conversation Codex avec une IA FranceStudent";
$("composer-options").appendChild(conversationImportButton);

const conversationImportDialog = document.createElement("dialog");
conversationImportDialog.id = "conversation-import-dialog";
conversationImportDialog.className = "conversation-import-dialog";
conversationImportDialog.setAttribute("aria-labelledby", "conversation-import-title");
conversationImportDialog.innerHTML = `<h2 id="conversation-import-title">Continuer une conversation Codex <small>Bêta</small></h2>
<p>Ouvre le même projet dans FranceStudent, importe le contexte de ta conversation puis choisis l’IA avec laquelle continuer. Aucun fichier du projet n’est importé ou modifié.</p>
<p id="conversation-import-project" class="settings-help"></p><button type="button" id="conversation-import-open-project">Ouvrir le dossier du projet</button>
<label>Lien de partage Codex<input id="conversation-import-url" type="url" placeholder="https://chatgpt.com/s/cx_…" autocomplete="off"></label>
<p class="settings-help">Un lien privé peut être inaccessible. Tu peux aussi utiliser /export dans Codex, sélectionner un export Markdown, JSON ou JSONL, ou coller le texte.</p>
<div class="studio-actions"><button type="button" id="conversation-import-file">Choisir un export…</button><span id="conversation-import-source" class="settings-help"></span></div>
<label>Ou coller la conversation / l’export<textarea id="conversation-import-text" rows="5" placeholder="Colle ici le texte ou le JSON de la conversation…"></textarea></label>
<div class="studio-actions"><button type="button" id="conversation-import-preview">Analyser la conversation</button></div>
<p id="conversation-import-status" role="status"></p><ul id="conversation-import-warnings" class="settings-help"></ul>
<details id="conversation-import-result" class="hidden"><summary>Aperçu du début et de la fin de la conversation</summary><pre id="conversation-import-excerpt"></pre></details>
<div class="conversation-import-choices"><label>IA pour continuer<select id="conversation-import-model"></select></label><label>Mode<select id="conversation-import-mode"><option value="agent">Agent sur le projet ouvert</option><option value="chat">Discussion</option></select></label></div>
<p class="settings-help">Préparer la reprise crée une nouvelle conversation et joint le contexte au brouillon. Tu peux modifier ta demande avant de l’envoyer. Les images et pièces jointes d’origine ne sont pas transférées automatiquement.</p>
<div class="studio-actions"><button type="button" id="conversation-import-close">Annuler</button><button type="button" id="conversation-import-apply" class="primary" disabled>Préparer la reprise</button></div>`;
document.body.appendChild(conversationImportDialog);
let conversationImportPreview = null;
let conversationImportSequence = 0;
let conversationImportWorking = false;

function conversationImportControls(working) {
    conversationImportWorking = working;
    for (const id of ["url", "text", "file", "preview", "model", "mode", "open-project"]) $("conversation-import-" + id).disabled = working;
    $("conversation-import-apply").disabled = working || !conversationImportPreview || !$("conversation-import-model").value;
}
function invalidateConversationImport() {
    conversationImportPreview = null;
    $("conversation-import-result").classList.add("hidden");
    $("conversation-import-warnings").replaceChildren();
    $("conversation-import-status").textContent = "";
    conversationImportControls(false);
}
function renderConversationImportPreview(result) {
    conversationImportPreview = result;
    $("conversation-import-source").textContent = result.source;
    $("conversation-import-status").textContent = `${result.messageCount} message(s) · ${result.chars.toLocaleString("fr-FR")} caractères. Vérifie l’aperçu avant de préparer la reprise.`;
    const warnings = $("conversation-import-warnings"); warnings.replaceChildren();
    for (const warning of result.warnings) { const item = document.createElement("li"); item.textContent = warning; warnings.appendChild(item); }
    $("conversation-import-excerpt").textContent = result.excerpt.map(message => `${message.role === "user" ? "Vous" : message.role === "assistant" ? "Codex" : "Contexte"}\n${message.text}`).join("\n\n──────────\n\n");
    $("conversation-import-result").classList.remove("hidden");
    $("conversation-import-result").open = true;
}
async function analyzeConversationImport(action, payload) {
    if (conversationImportWorking) return;
    const sequence = ++conversationImportSequence;
    invalidateConversationImport(); conversationImportControls(true);
    $("conversation-import-status").textContent = "Lecture de la conversation…";
    try {
        const result = await api.importConversation(action, payload);
        if (sequence !== conversationImportSequence) return;
        if (result.canceled) { $("conversation-import-status").textContent = "Sélection annulée."; return; }
        if (action === "file") { $("conversation-import-url").value = ""; $("conversation-import-text").value = ""; }
        renderConversationImportPreview(result);
    } catch (error) {
        if (sequence === conversationImportSequence) $("conversation-import-status").textContent = error.message;
    } finally { if (sequence === conversationImportSequence) conversationImportControls(false); }
}

conversationImportButton.onclick = async () => {
    if (ui.status.busy) { studioFeedback("Attends la fin de la tâche avant d’importer une conversation."); return; }
    $("conversation-import-project").textContent = `Projet ouvert : ${ui.workspace || "aucun — ouvre le dossier correspondant pour poursuivre le code"}`;
    $("conversation-import-mode").value = ui.status.mode === "chat" ? "chat" : "agent";
    conversationImportDialog.showModal();
    const sequence = ++conversationImportSequence;
    conversationImportControls(true);
    try {
        const data = await api.models();
        if (sequence !== conversationImportSequence) return;
        const select = $("conversation-import-model"); select.replaceChildren();
        for (const model of data.agents || []) { const option = document.createElement("option"); option.value = model.id; option.textContent = model.name; select.appendChild(option); }
        select.value = String(ui.currentModelId ?? data.current);
        if (!select.value && select.options.length) select.selectedIndex = 0;
    } catch (error) { $("conversation-import-status").textContent = error.message; }
    finally { if (sequence === conversationImportSequence) conversationImportControls(false); }
};
$("conversation-import-url").addEventListener("input", invalidateConversationImport);
$("conversation-import-text").addEventListener("input", invalidateConversationImport);
$("conversation-import-file").onclick = () => analyzeConversationImport("file");
$("conversation-import-preview").onclick = () => {
    const url = $("conversation-import-url").value.trim(), content = $("conversation-import-text").value.trim();
    if (!url && !content) { $("conversation-import-status").textContent = "Colle un lien ou une conversation, ou choisis un export."; return; }
    analyzeConversationImport("preview", url ? { url } : { content });
};
$("conversation-import-open-project").onclick = async () => {
    try { const workspace = await api.openProject(); if (workspace) $("conversation-import-project").textContent = `Projet ouvert : ${workspace}`; }
    catch (error) { $("conversation-import-status").textContent = error.message; }
};
$("conversation-import-close").onclick = () => conversationImportDialog.close();
conversationImportDialog.addEventListener("close", () => { conversationImportSequence++; conversationImportControls(false); });
$("conversation-import-apply").onclick = async () => {
    if (!conversationImportPreview || conversationImportWorking) return;
    conversationImportControls(true);
    try {
        const result = await api.importConversation("apply", { token: conversationImportPreview.token,
            modelId: Number($("conversation-import-model").value), mode: $("conversation-import-mode").value });
        pendingAttachments.push(result.attachment);
        input.value = input.value.trim() ? input.value + "\n\n" + result.prompt : result.prompt;
        renderAttachments(); saveStudioDraft(); autosizeInput(); setAgentTab("conversation");
        conversationImportPreview = null;
        conversationImportDialog.close();
        input.focus();
        studioFeedback("Conversation Codex importée. Modifie ta demande si nécessaire, puis clique sur Envoyer pour continuer.");
    } catch (error) { $("conversation-import-status").textContent = error.message; }
    finally { conversationImportControls(false); }
};
/* ---------- Mode Éco ---------- */
const ecoModeButton = document.createElement("button");
ecoModeButton.id = "eco-mode-toggle";
ecoModeButton.type = "button";
ecoModeButton.innerHTML = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 4c-6-1-13 1-13 7a6 6 0 0 0 6 6c6 0 8-7 7-13ZM4 21 15 10"/></svg><span class="eco-mode-label">Mode Éco</span><span class="eco-mode-indicator" aria-hidden="true"></span>';
ecoModeButton.setAttribute("aria-pressed", "false");
$("conversation-import").after(ecoModeButton);

const ecoModeDialog = document.createElement("dialog");
ecoModeDialog.id = "eco-mode-dialog";
ecoModeDialog.className = "history-delete-dialog";
ecoModeDialog.setAttribute("aria-labelledby", "eco-mode-title");
ecoModeDialog.innerHTML = `<h2 id="eco-mode-title">Activer le mode Éco ?</h2>
<p>Ce mode vise à réduire la consommation de quota, avec des capacités limitées :</p>
<ul><li>Agent limité à 4 tours par demande : les tâches longues peuvent rester incomplètes.</li>
<li>Contexte projet ajouté automatiquement limité à 20 000 caractères. L’IA peut manquer certains éléments et doit lire les fichiers nécessaires.</li>
<li>Pas de sous-agents ni de nouvelle tentative automatique en cas de réponse d’outil invalide.</li>
<li>Recherche web intégrée désactivée et réponses demandées plus concises.</li></ul>
<p>Le modèle sélectionné reste le même. Ce mode ne garantit pas un quota fixe : l’historique existant, les fichiers, leurs pages et les relances réseau peuvent toujours coûter cher. Aucune pièce jointe n’est supprimée.</p>
<p>Le choix est mémorisé pour les prochaines demandes. Tu peux le désactiver à tout moment hors exécution.</p>
<p id="eco-mode-error" role="status"></p>
<div class="studio-actions"><button type="button" id="eco-mode-cancel">Annuler</button><button type="button" id="eco-mode-enable">Activer avec ces limites</button></div>`;
document.body.appendChild(ecoModeDialog);
async function setEcoModeEnabled(enabled) {
    ecoModeButton.disabled = true;
    try { await api.setEcoMode(enabled); applyStatus(await api.status()); }
    finally { ecoModeButton.disabled = Boolean(ui.status.busy); }
}
ecoModeButton.onclick = async () => {
    if (ui.status.busy) return;
    if (ui.status.ecoMode) {
        try { await setEcoModeEnabled(false); }
        catch (error) { studioFeedback(error.message); }
        return;
    }
    $("eco-mode-error").textContent = "";
    ecoModeDialog.showModal();
    $("eco-mode-cancel").focus();
};
$("eco-mode-cancel").onclick = () => ecoModeDialog.close();
$("eco-mode-enable").onclick = async () => {
    $("eco-mode-enable").disabled = true;
    try { await setEcoModeEnabled(true); ecoModeDialog.close(); }
    catch (error) { $("eco-mode-error").textContent = error.message; }
    finally { $("eco-mode-enable").disabled = false; }
};
/* ---------- Serveurs locaux proposés dans les réponses ---------- */
async function attachServerControls(message, text) {
    if (message.dataset.serverChecked || !/https?:\/\/(?:localhost|127\.0\.0\.1)/i.test(text || "")) return;
    message.dataset.serverChecked = "1";
    const workspace = ui.workspace || ui.status.workspace || null;
    try {
        const hint = await api.serverHint(text);
        if (!hint || !message.isConnected) return;
        const card = document.createElement("section");
        card.className = "message-server-controls";
        card.dataset.serverKey = hint.key;
        card.serverWorkspace = workspace;
        const title = document.createElement("b"); title.textContent = "Serveur web local";
        const command = document.createElement("code"); command.textContent = `${hint.command} · dossier : ${hint.cwd}`;
        const address = document.createElement("span"); address.textContent = hint.url;
        const status = document.createElement("p"); status.className = "message-server-status"; status.setAttribute("role", "status");
        status.textContent = "Lance cette commande dans le projet ouvert avec Démarrer.";
        const actions = document.createElement("div"); actions.className = "studio-actions";
        const start = document.createElement("button"); start.type = "button"; start.textContent = "Démarrer";
        const stop = document.createElement("button"); stop.type = "button"; stop.textContent = "Arrêter"; stop.disabled = true;
        const open = document.createElement("button"); open.type = "button"; open.textContent = "Ouvrir le site";
        const details = document.createElement("details"), summary = document.createElement("summary"), output = document.createElement("pre");
        summary.textContent = "Sortie du serveur"; details.append(summary, output); details.hidden = true;
        card.updateServerRun = run => {
            // An initial IPC snapshot may arrive after a newer stop event.
            if (card.serverRun?.id === run.id && card.serverRun.status !== "running" && run.status === "running") return;
            card.serverRun = run;
            const running = run.status === "running";
            start.disabled = running; stop.disabled = !running;
            status.textContent = running ? "Processus en cours. Ouvre le site quand le serveur est prêt." : run.status === "stopped" ? "Serveur arrêté." : `Processus terminé${run.exitCode != null ? ` (code ${run.exitCode})` : ""}. Consulte la sortie si le site est inaccessible.`;
            output.textContent = String(run.output || "").slice(-8000); details.hidden = !output.textContent;
            if (run.status === "failed") details.open = true;
        };
        start.onclick = async () => {
            start.disabled = true; status.textContent = "Démarrage…";
            try { card.updateServerRun(await api.projectStudio("serverStart", { text, workspace })); }
            catch (error) { status.textContent = error.message; start.disabled = false; }
        };
        stop.onclick = async () => {
            stop.disabled = true;
            try { await api.projectStudio("stop", { id: card.serverRun.id }); }
            catch (error) { status.textContent = error.message; stop.disabled = false; }
        };
        open.onclick = () => openLocalBrowser(hint.url);
        actions.append(start, stop, open); card.append(title, command, address, status, actions, details); message.appendChild(card);
        const runs = await api.projectStudio("runs");
        const run = [...runs].reverse().find(item => item.server?.key === hint.key && item.workspace === workspace);
        if (run && card.isConnected) card.updateServerRun(run);
    } catch { /* Ordinary messages remain readable when task controls are unavailable. */ }
}

api.onEvent((channel, run) => {
    if (channel !== "projectTask" || !run.server) return;
    for (const card of document.querySelectorAll(".message-server-controls")) {
        if (card.dataset.serverKey === run.server.key && card.serverWorkspace === run.workspace) card.updateServerRun(run);
    }
});
/* ---------- Quota du compte et compteurs de cette session ---------- */
function usagePercent(value) {
    return value != null && Number.isFinite(Number(value)) ? Math.max(0, Number(value)) : null;
}
function usageTone(value) { return value >= 90 ? "critical" : value >= 75 ? "warning" : "normal"; }
function usageDate(value) {
    const date = value ? new Date(value) : null;
    return date && Number.isFinite(date.getTime()) ? date.toLocaleString("fr-FR", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }) : "Non communiquée";
}
function usageNumber(value) { return Math.max(0, Number(value) || 0).toLocaleString("fr-FR"); }
function usageProgress(value, label, className = "usage-progress") {
    const bounded = Math.min(100, value ?? 0);
    return `<span class="${className} ${usageTone(value)}${value == null ? " unknown" : ""}" role="progressbar" aria-label="${escapeHtml(label)}" aria-valuemin="0" aria-valuemax="100" ${value == null ? 'aria-valuetext="Indisponible"' : `aria-valuenow="${bounded}"`} style="--usage:${bounded}%"><span></span></span>`;
}
function renderUsageMeter() {
    const el = $("st-usage"), quota = ui.quota, percent = usagePercent(quota?.percent);
    const label = percent == null ? "Usage" : `${quota.uncertain ? "≈ " : ""}${percent} %`;
    el.classList.remove("warn", "crit");
    el.innerHTML = usageProgress(percent, "Quota de chat utilisé", "usage-mini-meter") + `<span class="usage-meter-label">${label}</span>`;
    el.title = percent == null ? "Voir la consommation et les compteurs de session" : `${quota.uncertain ? "Environ " : ""}${percent} % du quota de chat utilisé · Cliquer pour les détails`;
    el.setAttribute("aria-label", el.title);
}

function renderUsageDashboard() {
    if ($("agent").dataset.tab !== "usage") return;
    const box = $("usage-dashboard"), quota = ui.quota, usage = ui.status.usage || {};
    const signature = JSON.stringify([quota, usage, ui.quotaLoading, ui.quotaError, ui.quotaUpdatedAt, ui.status.booted, ui.status.ecoMode]);
    if (box.usageSignature === signature) return;
    box.usageSignature = signature;
    const percent = usagePercent(quota?.percent), reported = Number(usage.reported) > 0;
    const total = reported ? Number(usage.inputTokens || 0) + Number(usage.outputTokens || 0) : null;
    const estimate = Math.round(Number(usage.chars || 0) / 3.5);
    const metric = (name, value, detail) => `<div class="usage-metric"><span>${name}</span><strong>${value}</strong><small>${detail}</small></div>`;
    $("usage-refresh").disabled = Boolean(ui.quotaLoading) || !ui.status.booted;
    box.innerHTML = `<div class="usage-quota-card ${usageTone(percent)}">
        <div class="usage-quota-top"><span>Quota de chat</span><span class="usage-badge">${ui.quotaLoading ? "Actualisation…" : quota?.uncertain ? "Estimation serveur" : percent == null ? "Indisponible" : "Compte FranceStudent"}</span></div>
        <div class="usage-quota-main"><div class="usage-ring${percent == null ? " unknown" : ""}" style="--usage:${Math.min(100, percent ?? 0)}%" role="img" aria-label="${percent == null ? "Quota inconnu" : percent + " % utilisés"}"><strong>${percent == null ? "—" : (quota?.uncertain ? "≈ " : "") + percent + "<small>%</small>"}</strong></div><div><b>${percent == null ? "Quota indisponible" : usageNumber(Math.max(0, 100 - percent)) + " % disponibles"}</b><p>${percent == null ? "Les compteurs de session restent accessibles." : "de votre budget de chat"}</p>${quota?.powerUp ? '<span class="usage-badge">Power-up actif</span>' : ""}</div></div>
        <div class="usage-reset"><span>Réinitialisation</span><b>${escapeHtml(usageDate(quota?.resetAt))}</b></div></div>
        ${ui.quotaError ? `<p class="usage-notice" role="status">${escapeHtml(ui.quotaError)}</p>` : !ui.status.booted ? '<p class="usage-notice">Connecte-toi pour consulter le quota du compte.</p>' : ""}
        <div class="usage-section-title"><h3>Cette session</h3><span>${ui.status.ecoMode ? "Mode Éco activé" : "Depuis l’ouverture"}</span></div>
        <div class="usage-metrics">${metric("Requêtes IA", usageNumber(usage.requests), "Relances comprises")}${metric(reported ? "Tokens comptabilisés" : "Tokens estimés", reported ? usageNumber(total) : estimate ? "≈ " + usageNumber(estimate) : "—", reported ? "Données reçues du service" : "Estimation du texte envoyé")}${metric("Entrée", reported ? usageNumber(usage.inputTokens) : "—", "Tokens envoyés au modèle")}${metric("Sortie", reported ? usageNumber(usage.outputTokens) : "—", "Tokens générés")}</div>
        ${reported ? `<p class="usage-cache">${usageNumber(usage.cachedTokens)} tokens en cache, déjà inclus dans l’entrée. Les compteurs couvrent les réponses qui transmettent un relevé.</p>` : '<p class="usage-cache">Sans relevé de tokens du service, l’estimation ne couvre pas les images, les réponses ni tout l’historique serveur.</p>'}
        <p class="usage-updated">${ui.quotaUpdatedAt ? "Quota actualisé le " + escapeHtml(usageDate(ui.quotaUpdatedAt)) : "Le quota ne peut pas être déduit du nombre de tokens de cette session."}</p>`;
    if(percent>=100)mountQuotaRecovery(box,quota?.resetAt);
}
$("usage-refresh").onclick = () => refreshQuota();
/* ---------- Annulation d’une action sans interrompre l’agent ---------- */
const actionControlPanel = document.createElement("section");
actionControlPanel.id = "action-controls";
actionControlPanel.className = "action-controls hidden";
actionControlPanel.setAttribute("aria-label", "Actions en accès complet");
document.querySelector("#agent .agent-context-bar")?.after(actionControlPanel);
if (!actionControlPanel.isConnected) $("agent-activity").before(actionControlPanel);
api.onEvent((channel, action) => {
    if (channel !== "actionControl") return;
    let row = [...actionControlPanel.children].find(item => item.dataset.actionId === action.id);
    if (action.state === "running" && !row) {
        row = document.createElement("div"); row.className = "action-control-row"; row.dataset.actionId = action.id;
        row.dataset.actionName = action.name;
        const label = document.createElement("span"); label.textContent = toolLabel(action.name); label.title = action.description;
        const cancel = document.createElement("button"); cancel.type = "button"; cancel.textContent = "Annuler l’action";
        cancel.title = "Écarter le résultat et arrêter l’opération si possible, sans arrêter l’agent. Les effets déjà produits ne sont pas automatiquement annulés.";
        cancel.onclick = async () => { cancel.disabled = true; try { await api.cancelAction(action.id); } catch (error) { studioFeedback(error.message); cancel.disabled = false; } };
        row.append(label, cancel); actionControlPanel.appendChild(row);
    }
    if (row && action.state === "canceling") { row.querySelector("button").disabled = true; row.querySelector("button").textContent = "Annulation…"; }
    if (row && ["done", "failed", "canceled"].includes(action.state)) {
        row.remove();
        if (action.state === "canceled") studioFeedback("Action annulée. L’agent continue ; les effets déjà produits restent à vérifier.");
    }
    actionControlPanel.classList.toggle("hidden", !actionControlPanel.children.length);
});
/* ---------- Connecteur natif GitHub ---------- */
const githubConnectorDialog = document.createElement("dialog");
githubConnectorDialog.id = "github-connector-dialog";
githubConnectorDialog.className = "conversation-import-dialog github-connector-dialog";
githubConnectorDialog.setAttribute("aria-labelledby", "github-connector-title");
githubConnectorDialog.innerHTML = `<div class="workspace-section-head"><h2 id="github-connector-title">GitHub <small>Bêta</small></h2><button type="button" id="github-connector-close" aria-label="Fermer le connecteur GitHub">×</button></div>
<p id="github-connector-account" class="settings-help"></p><p id="github-connector-repo"></p>
<div class="studio-actions github-connector-nav"><button type="button" data-github-view="releases">Releases</button><button type="button" data-github-view="pull_requests">Pull requests</button><button type="button" data-github-view="issues">Issues</button><button type="button" data-github-view="repositories">Mes dépôts</button><button type="button" id="github-connector-readme">Modifier le README avec l’IA</button></div>
<p id="github-connector-status" role="status"></p><div id="github-connector-list"></div>
<details id="github-connector-create"><summary>Préparer une release</summary><p class="settings-help">Un brouillon sera créé. Ajoute ses fichiers et vérifie ses notes avant de publier.</p><label>Tag<input id="github-release-tag" placeholder="v1.0.0"></label><label>Commit ou branche cible<input id="github-release-target" placeholder="SHA du commit ou main"></label><label>Titre<input id="github-release-title" placeholder="Version 1.0.0"></label><label>Notes<textarea id="github-release-body" rows="4"></textarea></label><button type="button" id="github-release-create">Créer le brouillon</button></details>
<p class="settings-help">Le dépôt vient du remote origin du projet ouvert. Les droits dépendent du token connecté. L’agent dispose de l’outil natif github ; les modifications demandent une confirmation en mode Demander, mais pas en Full accès. Une publication ou un push ne peut pas être annulé comme une lecture locale.</p>`;
document.body.appendChild(githubConnectorDialog);
let githubConnectorView = "releases", githubConnectorLoading = false;
async function githubConnectorWork(operation) {
    if (githubConnectorLoading) return;
    githubConnectorLoading = true;
    const buttons = [...githubConnectorDialog.querySelectorAll("button:not(#github-connector-close)")];
    buttons.forEach(button => { button.disabled = true; });
    $("github-connector-status").textContent = "Chargement…";
    try { await operation(); }
    catch (error) { $("github-connector-status").textContent = error.message; }
    finally { githubConnectorLoading = false; buttons.forEach(button => { if (button.isConnected) button.disabled = false; }); }
}
async function loadGithubConnector() {
    const result = await api.githubConnector({ action: githubConnectorView });
    const list = $("github-connector-list"); list.replaceChildren();
    for (const item of result.items || result.repositories || []) {
        const card = document.createElement("article"); card.className = "github-connector-card";
        const title = document.createElement("b"); title.textContent = item.title || item.name;
        const status = document.createElement("span"); status.textContent = item.draft ? "Brouillon" : item.state || (item.private === true ? "Privé" : item.private === false ? "Public" : "Publié");
        const actions = document.createElement("div"); actions.className = "studio-actions";
        const open = document.createElement("button"); open.textContent = "Voir sur GitHub"; open.onclick = () => api.openExternal(item.url, true).catch(error => { $("github-connector-status").textContent = error.message; });
        actions.append(open);
        if (item.draft && githubConnectorView === "releases") {
            const upload = document.createElement("button"); upload.textContent = "Ajouter un fichier"; upload.onclick = () => githubConnectorWork(async () => { await api.githubUploadAsset(item.id); await loadGithubConnector(); });
            const publish = document.createElement("button"); publish.textContent = "Publier la release"; publish.onclick = () => githubConnectorWork(async () => { await api.githubConnector({ action: "publish_release", id: item.id }); await loadGithubConnector(); });
            actions.append(upload, publish);
        }
        if (githubConnectorView === "repositories") {
            const link = document.createElement("button"); link.textContent = "Lier au projet"; link.onclick = () => githubConnectorWork(async () => {
                const git = await api.gitStatus();
                if (!git.repo) {
                    $("github-connector-status").textContent = "Le dossier ouvert n’est pas un dépôt Git. Ouvre un dépôt existant, clone ce dépôt dans un nouveau dossier ou initialise Git dans le dossier actuel avant de le lier. La liaison ne télécharge aucun fichier.";
                    return;
                }
                const current = await api.githubStatus();
                if (current.remote && !await confirmStudioAction(`Le remote origin est actuellement « ${current.remote} ». Le remplacer par « ${item.name} » ?`, { title: "Modifier le dépôt distant", confirmLabel: "Remplacer", danger: true })) {
                    $("github-connector-status").textContent = "Liaison annulée : le remote existant est conservé.";
                    return;
                }
                await api.githubSetRemote(item.name);
                $("github-connector-repo").textContent = item.name;
                $("github-connector-status").textContent = "Remote origin mis à jour. Aucun fichier n’a été téléchargé.";
            }); actions.append(link);
        }
        card.append(title, status);
        if (item.body) { const details = document.createElement("details"), summary = document.createElement("summary"), body = document.createElement("pre"); summary.textContent = "Notes"; body.textContent = item.body; details.append(summary, body); card.append(details); }
        for (const asset of item.assets || []) { const line = document.createElement("small"); line.textContent = `${asset.name} · ${formatBytes(asset.size)}`; card.append(line); }
        card.append(actions); list.append(card);
    }
    $("github-connector-status").textContent = list.children.length ? `${list.children.length} élément(s)` : "Aucun élément.";
    for (const button of githubConnectorDialog.querySelectorAll("[data-github-view]")) button.setAttribute("aria-pressed", String(button.dataset.githubView === githubConnectorView));
}
$("gh-connector-open").onclick = () => {
    githubConnectorDialog.showModal();
    githubConnectorWork(async () => {
        const account = await api.githubStatus();
        $("github-connector-account").textContent = account.connected ? `Compte connecté : ${account.login || "GitHub"}` : "Connecte ton compte avec le champ sécurisé du panneau Git.";
        $("github-connector-repo").textContent = account.remote || "Aucun dépôt lié au projet.";
        if (!account.connected) { $("github-connector-list").replaceChildren(); $("github-connector-status").textContent = "Connexion GitHub nécessaire."; return; }
        try { const repo = await api.githubConnector({ action: "overview" }); $("github-connector-repo").textContent = `${repo.repository} · ${repo.branch}${repo.private ? " · Privé" : " · Public"}`; $("github-release-target").value = repo.branch; } catch { githubConnectorView = "repositories"; }
        await loadGithubConnector();
    });
};
$("github-connector-close").onclick = () => githubConnectorDialog.close();
for (const button of githubConnectorDialog.querySelectorAll("[data-github-view]")) button.onclick = () => githubConnectorWork(async () => { githubConnectorView = button.dataset.githubView; await loadGithubConnector(); });
$("github-release-create").onclick = () => githubConnectorWork(async () => {
    await api.githubConnector({ action: "create_release", tag: $("github-release-tag").value.trim(), target: $("github-release-target").value.trim(), title: $("github-release-title").value.trim(), body: $("github-release-body").value });
    githubConnectorView = "releases"; await loadGithubConnector();
});
$("github-connector-readme").onclick = () => { githubConnectorDialog.close(); setAgentTab("conversation"); input.value = "Examine le projet et son README, puis mets à jour le README pour expliquer simplement son utilisation. Utilise les outils de fichiers locaux ; prépare un commit et un push uniquement si je te le demande."; autosizeInput(); saveStudioDraft(); input.focus(); };
/* Classe les réglages par catégorie. */
const settingsNavigation = centerNode("nav", "settings-navigation");
settingsNavigation.setAttribute("aria-label", "Catégories des paramètres");
let settingsCategory = "account";
const settingsGroups = [
    ["account", "Compte"], ["general", "Général"],
    ["agent", "IA et contexte"], ["access", "Autorisations"], ["advanced", "Connexions et outils"]
];
const settingsGroupByTitle = {
    "settings-model-title": "general", "studio-editor-settings-title": "general",
    "settings-context-title": "agent", "settings-web-title": "agent",
    "settings-access-title": "access", "settings-tools-title": "advanced",
    "settings-marketplace-title": "advanced", "settings-help-title": "account"
};
captureSettings.dataset.settingsGroup = "access";
updateSettings.dataset.settingsGroup = "general";
function filterSettingsCards() {
    for (const card of $("settings-view").querySelectorAll(".settings-card")) {
        const group = card.dataset.settingsGroup || settingsGroupByTitle[card.getAttribute("aria-labelledby")] || "general";
        card.classList.toggle("hidden", settingsCategory !== group);
    }
    for (const button of settingsNavigation.children) {
        button.setAttribute("aria-pressed", String(button.dataset.category === settingsCategory));
    }
    const title = $("settings-view").querySelector(".settings-layout-main > h1");
    if (title) title.textContent = settingsGroups.find(group => group[0] === settingsCategory)?.[1] || "Paramètres";
}
for (const [id, label] of settingsGroups) {
    const button = centerNode("button");
    const iconPaths = {
        account: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
        general: '<path d="M5 3v7m0 4v7M12 3v3m0 4v11M19 3v11m0 4v3M2 10h6M9 6h6m1 8h6"/>'
    };
    if (iconPaths[id]) {
        const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        icon.setAttribute("viewBox", "0 0 24 24"); icon.setAttribute("aria-hidden", "true"); icon.innerHTML = iconPaths[id]; button.append(icon);
    }
    button.append(document.createTextNode(label));
    button.type = "button"; button.dataset.category = id;
    button.onclick = () => { settingsCategory = id; filterSettingsCards(); };
    settingsNavigation.append(button);
}
$("settings-view").querySelector(".sidebar-header").after(settingsNavigation);
filterSettingsCards();
// Expose icon-only navigation names to keyboard and assistive technology.
for (const button of document.querySelectorAll("#activity-bar button, .agent-actions button, .sidebar-actions button")) {
    if (!button.hasAttribute("aria-label") && button.title) button.setAttribute("aria-label", button.title);
}
/* Explicit progress and cancellation for community instruction downloads. */
function renderMarketplaceSkillActions(card){
    const item=card.marketplaceItem;
    card.querySelector(".center-card-actions")?.remove();
    const actions=centerNode("div","center-card-actions");
    const key=readStudioStorage("frst.marketplace-installed",{})[item.githubUrl];
    const installed=centerData?.skills.find(skill=>skill.key===key);
    actions.append(centerButton("Voir le dépôt",()=>api.openExternal(item.githubUrl)),installed?uninstallSkillButton(installed):centerButton("Lire et installer",()=>downloadSkillPreview(item),true));
    card.append(actions);
}
async function uninstallCenterSkill(skill) {
    if (!skill || !await confirmStudioAction(`Désinstaller « ${skill.name} » ? Il ne sera plus disponible pour l’IA. Son dossier sera conservé dans .trash pour pouvoir le récupérer.`,{title:"Désinstaller ce skill",confirmLabel:"Désinstaller",danger:true})) return;
    await changeExtension("remove", {key:skill.key}, `« ${skill.name} » désinstallé. Son dossier reste récupérable dans .trash.`);
}
const extensionDownloads = new Map();
const extensionDownloadList = centerNode("section", "extension-downloads hidden");
extensionDownloadList.setAttribute("aria-label", "Téléchargements des skills");
$("marketplace-status").after(extensionDownloadList);
function showSkillDownload(job) {
    const card = job.card;
    card.replaceChildren();
    const heading = centerNode("div");
    heading.append(centerNode("b", "", job.item.name));
    const button = centerNode("button", "", job.state === "loading" ? "Annuler" : job.state === "failed" || job.state === "canceled" ? "Réessayer" : "Fermer");
    button.type = "button";
    button.onclick = async () => {
        if (job.state === "loading") {
            button.disabled = true;
            try { await api.marketplace("cancel", {requestId:job.id}); }
            catch (error) { button.disabled = false; card.append(centerNode("p", "", error.message)); }
        } else if (job.state === "failed" || job.state === "canceled") { card.remove(); extensionDownloads.delete(job.id); downloadSkillPreview(job.item); }
        else { card.remove(); extensionDownloads.delete(job.id); extensionDownloadList.classList.toggle("hidden", !extensionDownloadList.children.length); }
    };
    heading.append(button); card.append(heading);
    if (job.state === "loading") {
        const progress = document.createElement("progress"); progress.setAttribute("aria-label", "Téléchargement du SKILL.md");
        if (job.total) { progress.max = job.total; progress.value = Math.min(job.received, job.total); }
        card.append(progress);
    }
    const bytes = count => `${(count / 1024).toLocaleString("fr-FR", {maximumFractionDigits:1})} Ko`;
    card.append(centerNode("p", "", job.message || `${bytes(job.received)} reçus${job.total ? ` sur ${bytes(job.total)}` : " · taille totale inconnue"}`));
}
async function downloadSkillPreview(item) {
    const job = {id:crypto.randomUUID(), item, received:0, total:null, state:"loading", card:centerNode("article", "download-card")};
    extensionDownloads.set(job.id, job); extensionDownloadList.classList.remove("hidden"); extensionDownloadList.append(job.card); showSkillDownload(job);
    // Keep only recent completed entries; in-flight downloads are always visible.
    for (const [id, old] of extensionDownloads) if (extensionDownloads.size > 8 && old.state !== "loading") { old.card.remove(); extensionDownloads.delete(id); }
    try {
        const preview = await api.marketplace("preview", {githubUrl:item.githubUrl, curatedId:item.curatedId, requestId:job.id});
        job.state = "ready"; job.message = "Téléchargé · lis les instructions puis choisis Installer. Tu pourras ensuite l’activer dans Mes skills.";
        showSkillDownload(job); openSkillEditor({kind:"remote", item:{...item, ...preview}});
        if(preview.resourceCount)$("skill-editor-message").textContent=`Ressources incluses : ${preview.resourceNames.join(", ")}`;
    } catch (error) {
        job.state = error.message.includes("annulé") ? "canceled" : "failed"; job.message = error.message; showSkillDownload(job);
    }
}
api.onEvent((channel, data) => {
    if (channel !== "marketplaceDownload") return;
    const job = extensionDownloads.get(data.requestId);
    if (!job || job.state !== "loading") return;
    job.received = data.received; job.total = data.total; showSkillDownload(job);
});
/* The official EffectCraft editor, embedded next to its specialized agent chat. */
const motionNav=document.createElement("button");
motionNav.type="button";motionNav.className="activity";motionNav.dataset.view="motion";motionNav.id="btn-motion";
motionNav.title="Motion design · EffectCraft (Bêta)";motionNav.setAttribute("aria-label","Motion design · EffectCraft, Bêta");
motionNav.innerHTML='<svg class="i" viewBox="0 0 24 24"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="m10 9 5 3-5 3z"/></svg>';
$("activity-bar")?.insertBefore(motionNav,document.querySelector("#activity-bar .spacer"));
const motionView=document.createElement("section");motionView.id="motion-view";motionView.className="motion-page";motionView.setAttribute("aria-label","EffectCraft et agent motion design");
motionView.innerHTML=`<header class="motion-header"><div class="motion-brand"><span class="motion-brand-icon"><svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="m4 17 8-13 8 13H4Zm4-1 4-7 4 7"/></svg></span><div class="motion-brand-copy"><div class="motion-brand-title"><h1>EffectCraft</h1><span class="motion-pill">Bêta</span></div><p>Ton studio d’animation</p></div></div><div class="motion-actions"><button type="button" id="motion-local-save" title="Enregistrer dans le stockage local d’EffectCraft">Enregistrer</button><button type="button" id="motion-close">Retour au code</button></div></header>
<div class="motion-commandbar"><div class="motion-transport" role="group" aria-label="Contrôles de composition"><button type="button" id="motion-undo" title="Annuler la dernière modification"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5 4 10l5 5M4 10h10a6 6 0 0 1 0 12"/></svg>Annuler</button><span class="motion-control-divider" aria-hidden="true"></span><button type="button" id="motion-play" title="Lire l’animation dans l’aperçu"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 5 11 7-11 7Z"/></svg>Lecture</button><button type="button" id="motion-stop" title="Arrêter la lecture de l’animation"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6h12v12H6Z"/></svg>Arrêter</button></div><div class="motion-status-group"><span class="motion-status-dot" aria-hidden="true"></span><span id="motion-engine-status" role="status">EffectCraft attend ton ouverture.</span><button type="button" id="motion-engine-reload" title="Recharger EffectCraft" aria-label="Recharger EffectCraft"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5M5 8a8 8 0 0 1 13-3l2 3M4 16l2 3a8 8 0 0 0 13-3"/></svg></button></div></div>
<div class="motion-stage" aria-label="Chargement d’EffectCraft"><div><h2>Chargement d’EffectCraft…</h2><p>Le véritable éditeur se prépare. Le chat motion design reste à droite.</p><button type="button" id="motion-retry">Réessayer</button></div></div>
<div id="motion-engine" class="motion-engine" hidden><div id="motion-engine-frame" class="motion-engine-frame"></div></div>
<div id="motion-consent" class="motion-consent" role="alertdialog" aria-modal="true" aria-labelledby="motion-consent-title" tabindex="-1"><div class="motion-consent-card"><span class="motion-pill">Bêta</span><h2 id="motion-consent-title">Ton espace motion design</h2><p>EffectCraft à gauche, ton agent spécialisé à droite. Le chat peut modifier les compositions, les calques, les keyframes et les effets. Cette intégration reste expérimentale : conserve une copie des projets importants.</p><div class="motion-consent-actions"><button type="button" id="motion-consent-back">Retour au code</button><button type="button" id="motion-consent-ok" class="primary">J’ai compris, continuer</button></div></div></div>`;
$("app").append(motionView);
const motionEngine={frame:null,loading:false,accepted:false};
function isMotionOpen(){return $("app").classList.contains("view-motion");}
function setMotionEngineStatus(text){$("motion-engine-status").textContent=text;$("motion-engine-status").title=text;}
async function openMotionDesign(){
    if(!await selectMotionChat("motion"))return;
    setAgentFocus(true);
    setActivity(null);$("app").classList.add("view-motion");motionNav.classList.add("active");
    browserHomeShow("motion", { page: true });
    setBrowserHomeOpen(true);
    $("motion-consent").classList.toggle("hidden-consent",motionEngine.accepted);
    if(motionEngine.accepted)loadMotionEngine();else $("motion-consent-ok").focus({preventScroll:true});
    syncMotionChat();
}
async function closeMotionDesign(){
    if(!isMotionOpen() || !await selectMotionChat("code"))return;
    setAgentFocus(true);
    $("app").classList.remove("view-motion");motionNav.classList.remove("active");
    if (browserHomeCurrent === "motion") browserHomeClosePage();
    setActivity($("app").classList.contains("no-sidebar")?null:ui.sideView);syncMotionChat();
}
motionNav.onclick=()=>isMotionOpen()?closeMotionDesign():openMotionDesign();
$("motion-close").onclick=closeMotionDesign;$("motion-consent-back").onclick=closeMotionDesign;
$("motion-consent-ok").onclick=()=>{motionEngine.accepted=true;$("motion-consent").classList.add("hidden-consent");loadMotionEngine();input.focus({preventScroll:true});};
for(const button of document.querySelectorAll("#activity-bar .activity"))if(button!==motionNav)button.addEventListener("click",event=>{
    if(isMotionOpen() && ui.status.busy){event.preventDefault();event.stopImmediatePropagation();studioFeedback("Attends la fin de la tâche ou utilise Stop avant de changer de chat.");return;}
    closeMotionDesign();
},true);
function showMotionEngineFallback(message){$("motion-engine").hidden=true;motionView.querySelector(".motion-stage").hidden=false;motionView.querySelector(".motion-stage h2").textContent="EffectCraft indisponible";motionView.querySelector(".motion-stage p").textContent=message;setMotionEngineStatus(message);}
async function loadMotionEngine(force=false){
    if(motionEngine.loading || motionEngine.frame && !force)return;
    if(force && ui.status.busy){studioFeedback("Arrête d’abord la tâche pour recharger EffectCraft.");return;}
    motionEngine.loading=true;
    try{
        if(motionEngine.frame){motionEngine.frame.remove();motionEngine.frame=null;}
        const info=await api.effectCraft("start"),url=new URL(info.url);
        if(url.protocol!=="http:" || url.hostname!=="127.0.0.1")throw new Error("Adresse EffectCraft inattendue.");
        url.search="?nosw&frameworkers=0&webgl";
        const frame=document.createElement("iframe");frame.className="motion-engine-iframe";frame.title="EffectCraft · Motion design";
        frame.setAttribute("sandbox","allow-scripts allow-same-origin allow-downloads");frame.setAttribute("allow","fullscreen");frame.referrerPolicy="no-referrer";
        frame.addEventListener("load",async()=>{
            for(let attempt=0;attempt<60 && motionEngine.frame===frame;attempt++){
                try{await api.effectCraftControl({method:"host.info",params:{}});await api.effectCraftControl({method:"ui.set",params:{theme:"Dark"}});await applyMotionInterface(motionEngine.advanced,true);setMotionEngineStatus("Prêt · décris ton animation dans le chat");return;}
                catch(error){if(attempt===59){setMotionEngineStatus(error.message);return;}await new Promise(resolve=>setTimeout(resolve,200));}
            }
        });
        frame.src=url.toString();$("motion-engine-frame").replaceChildren(frame);motionEngine.frame=frame;
        $("motion-engine").hidden=false;motionView.querySelector(".motion-stage").hidden=true;setMotionEngineStatus(`EffectCraft ${info.version} · chargement…`);
    }catch(error){showMotionEngineFallback(error.message);}finally{motionEngine.loading=false;}
}
$("motion-engine-reload").onclick=()=>loadMotionEngine(true);$("motion-retry").onclick=()=>loadMotionEngine(true);
async function motionControl(request){
    if(ui.status.busy){studioFeedback("L’agent travaille sur la composition ; attends ou utilise Stop.");return;}
    try{await api.effectCraftControl(request);setMotionEngineStatus("EffectCraft · action effectuée");}catch(error){studioFeedback(error.message);}
}
$("motion-play").onclick=()=>motionControl({method:"ui.playback",params:{action:"play"}});
$("motion-stop").onclick=()=>motionControl({method:"ui.playback",params:{action:"stop"}});
$("motion-undo").onclick=()=>motionControl({method:"engine.execute",params:{command:"edit.undo",params:{}}});
$("motion-local-save").onclick=()=>motionControl({method:"host.save",params:{path:"FranceStudent.ecproj"}});
const motionChat={placeholder:null,badge:null};
function syncMotionChat(){
    updateAgentProjectLabel();
    const bar=document.querySelector("#agent .agent-context-bar");if(!bar)return;
    if(!motionChat.badge){const badge=document.createElement("span");badge.id="agent-motion-badge";badge.className="agent-motion-badge";badge.textContent="Motion design";bar.insertBefore(badge,$("agent-access"));motionChat.badge=badge;}
    const open=isMotionOpen();motionChat.badge.hidden=!open;
    if(motionChat.open!==open){motionChat.open=open;studioActivitySeq++;$("activity-checkpoints").replaceChildren();renderAgentActivity(null);if(studioTab==="activity"||studioTab==="backups")refreshStudioActivity();}
    if(open){if(motionChat.placeholder===null)motionChat.placeholder=input.placeholder;input.placeholder="Décris ton animation… l’agent agit dans EffectCraft.";}
    else if(motionChat.placeholder!==null){input.placeholder=motionChat.placeholder;motionChat.placeholder=null;}
}
new MutationObserver(syncMotionChat).observe($("app"),{attributes:true,attributeFilter:["class"]});syncMotionChat();
/* EffectCraft owns the editor. Reuse the agent UI with independent conversations. */
const motionChats = new Map();
let motionChatMode = "code", motionChatSwitch = false;
let motionChatWorkspace=ui.workspace;
const codeStarter = {title:$("agent-starter").querySelector("h2").textContent,description:$("agent-starter").querySelector("p").textContent,buttons:[...document.querySelectorAll("[data-starter]")].map(button=>({prompt:button.dataset.starter,title:button.querySelector("b").textContent,detail:button.querySelector("small").textContent}))};
function renderMotionStarter(){
    const motion=motionChatMode==="motion",starter=$("agent-starter");
    starter.querySelector("h2").textContent=motion?"Créons ton animation":codeStarter.title;
    starter.querySelector("p").textContent=motion?"Décris ton idée. L’agent agit directement dans EffectCraft.":codeStarter.description;
    const choices=motion?[
        {title:"Créer une animation",detail:"Composition, textes et mouvements",prompt:"Crée une animation de titre dans EffectCraft. Inspecte le projet, découvre les commandes nécessaires et réalise la composition avec des keyframes."},
        {title:"Améliorer la composition",detail:"Rythme, lisibilité et effets",prompt:"Inspecte la composition active dans EffectCraft, analyse son rythme et sa lisibilité, puis améliore-la avec les outils du moteur."},
        {title:"Préparer un export",detail:"Format, durée et rendu",prompt:"Inspecte la composition active et les formats d’export disponibles dans EffectCraft. Prépare un export adapté et vérifie le résultat sans annoncer de réussite avant sa fin."}
    ]:codeStarter.buttons;
    [...document.querySelectorAll("[data-starter]")].forEach((button,index)=>{const item=choices[index];if(!item)return;button.dataset.starter=item.prompt;button.querySelector("b").textContent=item.title;button.querySelector("small").textContent=item.detail;});
}
api.onEvent((channel,status)=>{
    if(channel==="signedOut" || channel==="status" && motionChatWorkspace!==(status.workspace || null)){
        if(channel==="status")motionChatWorkspace=status.workspace || null;
        motionChats.clear();motionChatMode="code";
        $("app").classList.remove("view-motion");motionNav.classList.remove("active");
        input.value=readStudioStorage(studioDraftKey(motionChatWorkspace,"code"),"");
        renderMotionStarter();syncMotionChat();
    }
});
async function selectMotionChat(mode) {
    if(motionChatSwitch) return false;
    if(mode===motionChatMode)return true;
    motionChatSwitch=true;
    try {
        await api.motionConversation(mode);
        finishToolActivity();
        if ($("spinner")?.parentNode === transcript) $("agent").insertBefore($("spinner"), $("prompt-zone"));
        const nodes=document.createDocumentFragment(), scroll=transcript.scrollTop;
        while(transcript.firstChild)nodes.append(transcript.firstChild);
        motionChats.set(motionChatMode,{nodes,starterHidden:$("agent-starter").classList.contains("hidden"),draft:input.value,attachments:pendingAttachments,toolGroup,scroll,following:transcriptFollowing,requestFileChanges,requestDiffPreviews,entries:studioEntries.slice(),history:ui.history,historyIndex:ui.historyIndex});
        const next=motionChats.get(mode);
        transcript.replaceChildren(next?.nodes || document.createDocumentFragment());
        requestFileChanges=next?.requestFileChanges || new Map();requestDiffPreviews=next?.requestDiffPreviews || new Map();
        input.value=next?.draft ?? readStudioStorage(studioDraftKey(studioWorkspace,mode),"");pendingAttachments=next?.attachments || [];toolGroup=next?.toolGroup || null;
        transcript.scrollTop=next?.scroll || 0;
        transcriptFollowing=next?.following ?? true;updateTranscriptScrollControl();
        studioEntries.splice(0,studioEntries.length,...(next?.entries || []));ui.history=next?.history || [];ui.historyIndex=next?.historyIndex || 0;
        motionChatMode=mode;renderAttachments();autosizeInput();saveStudioDraft();
        document.querySelector(".agent-title > span").textContent=mode==="motion"?"Motion design":"Agent";
        // Les notices de session ne sont pas une discussion : elles ne doivent pas
        // masquer l'accueil et faire remonter le formulaire au retour de Motion.
        $("agent-starter").classList.toggle("hidden",next?.starterHidden ?? Boolean(transcript.querySelector(".user,.assistant,.tool,.tool-group,.result,.error,.warn")));
        renderMotionStarter();
        requestAnimationFrame(()=>{transcript.scrollTop=next?.scroll || 0;updateTranscriptScrollControl();});
        return true;
    } catch(error){studioFeedback(error.message);return false;}
    finally {motionChatSwitch=false;}
}
/* ---------- Budget de chat épuisé : message lisible (HTTP 429) ---------- */

const BUDGET_TIME_ZONE = "Europe/Paris";

/** Détecte une erreur « Chat budget exhausted » et en extrait l'heure de reprise (UTC). */
function parseBudgetNotice(text) {
    const raw = String(text ?? "");
    if (!/budget\s+(?:de\s+chat\s+)?(?:exhausted|épuisé)|insufficient_quota|quota.{0,25}(?:exhausted|épuisé|atteint|exceeded)/i.test(raw)) return null;
    const match = /Reset at\s+(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.\d+)?Z/i.exec(raw);
    const resetAt = match ? new Date(`${match[1]}Z`) : null;
    return { resetAt: resetAt && !Number.isNaN(resetAt.getTime()) ? resetAt : null };
}

function budgetDayKey(date) {
    return new Intl.DateTimeFormat("en-CA", { timeZone: BUDGET_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
}

function budgetRemainingLabel(ms) {
    const minutes = Math.ceil(ms / 60000);
    if (minutes <= 1) return "dans moins d'une minute";
    if (minutes < 60) return `dans ${minutes} min`;
    return `dans ${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")}`;
}

/** Textes affichés (heure de Paris). `now` est injectable pour les tests. */
function formatBudgetNotice(notice, now = new Date()) {
    const title = "Budget de chat épuisé";
    const at = notice && notice.resetAt;
    if (!at) {
        return { title, detail: "Le quota de conversation est atteint. Tu pourras reprendre dès qu'il sera renouvelé.", when: "", remaining: "" };
    }
    // Le renouvellement tombe à hh:59:59.999 : on affiche la minute pleine suivante.
    const shown = new Date(Math.ceil(at.getTime() / 60000) * 60000);
    const clock = new Intl.DateTimeFormat("fr-FR", { timeZone: BUDGET_TIME_ZONE, hour: "2-digit", minute: "2-digit" }).format(shown);
    const ms = at.getTime() - now.getTime();
    if (ms <= 0) {
        return { title, detail: "Le budget a dû être renouvelé : tu peux réessayer maintenant.", when: clock, remaining: "" };
    }
    const days = Math.round((Date.parse(`${budgetDayKey(shown)}T00:00:00Z`) - Date.parse(`${budgetDayKey(now)}T00:00:00Z`)) / 86400000);
    let day;
    if (days <= 0) day = "aujourd'hui";
    else if (days === 1) day = "demain";
    else day = `le ${new Intl.DateTimeFormat("fr-FR", { timeZone: BUDGET_TIME_ZONE, weekday: "long", day: "numeric", month: "long" }).format(shown)}`;
    return {
        title,
        detail: `Les échanges avec l'agent reprendront ${day} à ${clock} (heure de Paris).`,
        when: `${day} · ${clock}`,
        remaining: budgetRemainingLabel(ms)
    };
}

/** Carte intégrée au transcript, à la place du JSON brut. */
function renderBudgetEntry(notice, rawText, {projectSummary=false}={}) {
    const f = formatBudgetNotice(notice);
    const chips = [
        f.when ? `<span class="budget-chip"><b>Reprise</b> ${escapeHtml(f.when)}</span>` : "",
        typeof mountQuotaRecovery!=="function" && f.remaining ? `<span class="budget-chip"><b>Dans</b> ${escapeHtml(f.remaining.replace(/^dans\s+/, ""))}</span>` : ""
    ].join("");
    const icon = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/></svg>';
    const el = addEntry("budget-notice",
        `<div class="budget-icon" aria-hidden="true">${icon}</div>` +
        `<div class="budget-body"><div class="budget-title">${escapeHtml(f.title)}</div>` +
        `<div class="budget-detail">${escapeHtml(f.detail)}</div>` +
        (projectSummary?'<p class="budget-context">Le résumé IA du projet n’a pas pu être généré. Un contexte local partiel reste disponible. Après le renouvellement du quota, tu pourras réindexer le projet si nécessaire.</p>':"")+
        (chips ? `<div class="budget-chips">${chips}</div>` : "") +
        `<details class="budget-tech"><summary>Détails techniques</summary><pre>${escapeHtml(String(rawText ?? ""))}</pre></details></div>`);
    el.setAttribute("role", "status");
    if(typeof mountQuotaRecovery==="function")mountQuotaRecovery(el.querySelector(".budget-body"),notice.resetAt);
    return el;
}
/* A beginner workspace inside EffectCraft, with the full editor one click away. */
motionEngine.advanced=readStudioStorage("frst.motion.advanced",false)===true;
motionEngine.changingInterface=false;
const motionModes=centerNode("div","motion-mode-switch");motionModes.setAttribute("role","group");motionModes.setAttribute("aria-label","Niveau de l’interface EffectCraft");
motionModes.innerHTML='<button type="button" id="motion-simple" aria-pressed="true">Simple</button><button type="button" id="motion-advanced" aria-pressed="false">Avancé</button>';
document.querySelector(".motion-header").insertBefore(motionModes,document.querySelector(".motion-actions"));
const tutorialButton=centerNode("button","","Tutos");tutorialButton.type="button";tutorialButton.id="motion-tutorial-open";tutorialButton.title="Apprendre les bases du motion design";
document.querySelector(".motion-actions").prepend(tutorialButton);
const intro=centerNode("ol","motion-intro-steps");
for(const text of ["Décris ton idée dans le chat.","Regarde l’agent créer ton animation.","Teste la lecture, puis enregistre ton projet."])intro.append(centerNode("li","",text));
document.querySelector(".motion-consent-actions").before(intro);
async function applyMotionInterface(advanced,initial=false){
    if(motionEngine.changingInterface)return false;
    if(!initial && ui.status.busy){studioFeedback("Attends la fin de l’action de l’agent avant de changer l’interface.");return false;}
    motionEngine.changingInterface=true;$("motion-simple").disabled=true;$("motion-advanced").disabled=true;
    try{
        await api.effectCraftControl({method:"ui.set",params:{workspace:advanced?"Default":"FranceStudent",menuBar:advanced,viewer:{zoom:null},timeline:{graphEditor:false,showModes:advanced}}});
        for(const column of ["label","num","comment","switches","modes","parent","in","out","duration","stretch"]){
            await api.effectCraftControl({method:"engine.execute",params:{command:"timeline.column",params:{column,visible:advanced}}});
        }
        motionEngine.advanced=advanced;writeStudioStorage("frst.motion.advanced",advanced);
        $("motion-simple").setAttribute("aria-pressed",String(!advanced));$("motion-advanced").setAttribute("aria-pressed",String(advanced));
        motionView.dataset.interface=advanced?"advanced":"simple";
        return true;
    }catch(error){if(initial)throw error;studioFeedback(error.message);return false;}
    finally{motionEngine.changingInterface=false;$("motion-simple").disabled=false;$("motion-advanced").disabled=false;}
}
$("motion-simple").onclick=()=>applyMotionInterface(false);$("motion-advanced").onclick=()=>applyMotionInterface(true);
const motionTutorials=[
    {title:"Ton premier titre",steps:["Choisis le texte à afficher et son ambiance.","Décris-le à l’agent : il crée la composition et l’animation.","Appuie sur Lecture pour voir le résultat."],prompt:"Crée dans EffectCraft un titre « Mon premier projet » qui apparaît en douceur sur un fond sombre. Utilise une composition de 5 secondes au format 16:9. Réalise les modifications et vérifie le rendu."},
    {title:"Donner du mouvement",steps:["Sélectionne un texte ou une forme dans l’animation.","Décris le mouvement simplement : apparaître, glisser, tourner…", "L’agent règle les points de passage de l’animation (keyframes). Tu peux ensuite demander un mouvement plus lent ou plus rapide."],prompt:"Anime l’élément sélectionné dans EffectCraft : fais-le apparaître progressivement puis glisser légèrement vers la droite. Inspecte d’abord la sélection et vérifie le résultat."},
    {title:"Enregistrer et exporter",steps:["Enregistrer conserve ton projet modifiable dans le stockage local d’EffectCraft.","Exporter produit un fichier à partager. Demande à l’agent de vérifier les formats disponibles avant le rendu.","Garde aussi une copie du projet .ecproj et de tes médias avec les fonctions de fichier du mode Avancé."],prompt:"Inspecte mon animation EffectCraft. Vérifie les formats d’export réellement disponibles, prépare un export adapté et explique où retrouver le résultat. Ne déclare pas un export terminé tant qu’il n’a pas réussi."}
];
const motionTutorialPanel=centerNode("section","motion-tutorial hidden");motionTutorialPanel.id="motion-tutorial";motionTutorialPanel.setAttribute("aria-label","Petits tutoriels motion design");motionView.append(motionTutorialPanel);
let motionTutorialIndex=0;
function showMotionTutorial(index=motionTutorialIndex){
    motionTutorialIndex=Math.max(0,Math.min(motionTutorials.length-1,index));
    const tutorial=motionTutorials[motionTutorialIndex];motionTutorialPanel.replaceChildren();
    const header=centerNode("div","motion-tutorial-head");header.append(centerNode("span","",`LES BASES · ${motionTutorialIndex+1}/${motionTutorials.length}`));
    const close=centerNode("button","","Fermer");close.type="button";close.onclick=()=>{motionTutorialPanel.classList.add("hidden");tutorialButton.focus();};header.append(close);motionTutorialPanel.append(header,centerNode("h2","",tutorial.title));
    const list=centerNode("ol");for(const step of tutorial.steps)list.append(centerNode("li","",step));motionTutorialPanel.append(list);
    const actions=centerNode("div","motion-tutorial-actions");
    const prepare=centerNode("button","primary","Préparer la demande");prepare.type="button";prepare.onclick=()=>{
        input.value=input.value.trim()?`${input.value}\n\n${tutorial.prompt}`:tutorial.prompt;
        input.dispatchEvent(new Event("input",{bubbles:true}));autosizeInput();saveStudioDraft();
        motionTutorialPanel.classList.add("hidden");input.focus();studioFeedback("La demande est préparée. Tu peux la modifier puis cliquer sur Envoyer.");
    };
    const next=centerNode("button","",motionTutorialIndex===motionTutorials.length-1?"Revoir le début":"Suivant");next.type="button";next.onclick=()=>showMotionTutorial((motionTutorialIndex+1)%motionTutorials.length);
    actions.append(prepare,next);motionTutorialPanel.append(actions,centerNode("p","motion-tutorial-note","Les tutos sont gratuits à consulter. Une demande envoyée à l’agent utilise ton quota habituel."));
    motionTutorialPanel.classList.remove("hidden");close.focus();
}
tutorialButton.onclick=()=>showMotionTutorial();
motionView.addEventListener("keydown",event=>{if(event.key==="Escape" && !motionTutorialPanel.classList.contains("hidden")){event.preventDefault();event.stopPropagation();motionTutorialPanel.classList.add("hidden");tutorialButton.focus();}});
/* Curated motion workflows; ordinary marketplace searches remain explicit. */
let motionCollection="effectcraft";
function libraryInstallKey(item,scope){return `${item.application==="effectcraft" && scope==="projet"?"motion":scope}:${item.id}`;}
const motionMarket=centerNode("section","motion-marketplace");motionMarket.id="motion-marketplace";
const motionMarketHead=centerNode("div","motion-marketplace-head");
motionMarketHead.innerHTML='<div><span class="ext-tag">Sélection motion design</span><h2>Les bons outils pour tes animations.</h2><p>EffectCraft pour l’éditeur intégré. Remotion pour les projets vidéo en React.</p></div><label>Installer pour<select id="motion-skill-scope" aria-label="Portée des skills motion"><option value="utilisateur">Tous mes projets</option><option value="projet">Ce projet seulement</option></select></label>';
const motionMarketFilters=centerNode("div","motion-marketplace-filters");motionMarketFilters.setAttribute("role","group");motionMarketFilters.setAttribute("aria-label","Moteur de motion design");
for(const [key,label] of [["effectcraft","EffectCraft · intégré"],["code","Remotion · chat code"]]){const button=centerButton(label,()=>{motionCollection=key;renderMotionMarketplace();});button.dataset.motionCollection=key;motionMarketFilters.append(button);}
const motionMarketNote=centerNode("p","settings-help");motionMarketNote.id="motion-marketplace-note";
const motionMarketList=centerNode("div","center-grid");motionMarketList.id="motion-marketplace-list";
motionMarket.append(motionMarketHead,motionMarketFilters,motionMarketNote,motionMarketList);
document.querySelector('[data-center-panel="motion"]').append(motionMarket);
$("library-category").append(centerNode("option","","Motion design"));
$("motion-skill-scope").onchange=renderMotionMarketplace;
function renderMotionMarketplace(){
    if(!centerData)return;
    const scope=$("motion-skill-scope").value;
    $("motion-skill-scope").querySelector('[value="projet"]').disabled=motionCollection!=="effectcraft" && !centerData.workspace;
    $("motion-skill-scope").querySelector('[value="projet"]').textContent=motionCollection==="effectcraft"?"Projet EffectCraft":"Ce projet code";
    for(const button of motionMarketFilters.children)button.setAttribute("aria-pressed",String(button.dataset.motionCollection===motionCollection));
    motionMarketNote.replaceChildren(document.createTextNode(motionCollection==="effectcraft"?"8 skills FranceStudent prêts à installer, sans téléchargement ni clé API. L’agent les utilise dans le chat Motion design ; les consulter ne consomme pas de quota.":"Sélection des 5 skills les plus installés de la collection officielle remotion-dev/skills sur Skills.sh, vérifiée le 23 octobre 2026. Ils nécessitent un projet Remotion dans le chat code ; ils ne pilotent pas EffectCraft. "));
    if(motionCollection==="code")motionMarketNote.append(centerButton("Voir la source du classement",()=>api.openExternal("https://www.skills.sh/remotion-dev/skills")));
    motionMarketList.replaceChildren();
    const entries=motionCollection==="effectcraft"?centerData.library.filter(item=>item.application==="effectcraft"):(centerData.motionCommunity || []);
    for(const item of entries){
        const card=centerNode("article","center-card");card.dataset.motionSkillId=item.id;
        card.append(centerNode("span","ext-tag",motionCollection==="effectcraft"?"EffectCraft · natif":`Remotion · ≈ ${Math.round(item.installs/1000)} k installations`),centerNode("h3","",item.title),centerNode("p","",item.description));
        const actions=centerNode("div","center-card-actions");
        const installed=centerData.skills.find(skill=>skill.key===libraryInstallKey(item,scope));
        if(motionCollection==="effectcraft"){
            actions.append(centerButton("Voir les instructions",()=>{openSkillEditor({kind:"library",item});$("skill-editor-scope").value=scope;}));
            actions.append(installed?uninstallSkillButton(installed):centerButton("Installer",()=>changeExtension("install",{id:item.id,scope},`${item.title} installé pour le chat Motion design.`),true));
        }else{
            actions.append(centerButton("Voir le dépôt",()=>api.openExternal(item.githubUrl)));
            actions.append(installed?uninstallSkillButton(installed):centerButton("Lire et installer",async()=>{await downloadSkillPreview({...item,curatedId:item.id});$("skill-editor-scope").value=scope;},true));
        }
        card.append(actions);motionMarketList.append(card);
    }
}
const motionSkillsButton=centerButton("Skills",async()=>{
    await closeMotionDesign();if(isMotionOpen())return;
    showSideView("extensions");setCenterTab("motion");motionCollection="effectcraft";await loadExtensionCenter();motionMarket.scrollIntoView({block:"start"});
});motionSkillsButton.id="motion-skills";motionSkillsButton.title="Choisir des skills pour ton animation";document.querySelector(".motion-actions").prepend(motionSkillsButton);
/* Visible history is independent of the model's compacted context. */
let replayGeneration=0;
api.onEvent((channel,data)=>{
    if(channel==="clear"){replayGeneration++;ui.replayingConversation=false;return;}
    if(channel!=="conversationReplay")return;
    const generation=++replayGeneration,entries=data.entries || [];let cursor=0;
    ui.replayingConversation=true;
    function draw(){
        if(generation!==replayGeneration)return;
        const end=Math.min(cursor+50,entries.length);
        while(cursor<end)renderEntry({...entries[cursor++],replayed:true});
        if(cursor<entries.length)studioFeedback("Chargement de la discussion…");
        else if($("composer-feedback").textContent==="Chargement de la discussion…")studioFeedback("");
        if(cursor<entries.length)requestAnimationFrame(draw);
        else{finishToolActivity();ui.replayingConversation=false;scrollDown();if(data.resume && data.id)api.resumeChat(data.id).catch(error=>studioFeedback(`Reprise impossible : ${error.message}`));}
    }
    draw();
});
function parseContextLimitNotice(text){
    const value=String(text || "");
    if(!/maximum.{0,20}(?:context|token)|context[_ ]length[_ ]exceeded|conversation.{0,50}token.{0,20}limit/i.test(value))return null;
    const match=/(?:maximum|max)\s+(?:context\s+)?tokens?\s+limit\s*(?:of|is|:|=)?\s*([\d,_ ]+)/i.exec(value);
    const limit=match?Number(match[1].replace(/[, _]/g,"")):null;
    return {limit:Number.isFinite(limit)?limit:null};
}
function renderContextLimitEntry(info,raw){
    const entry=addEntry("error context-limit-notice","");
    const icon=centerNode("span","api-notice-icon");icon.innerHTML=apiNoticeIcon("attachment");entry.append(icon);
    entry.append(centerNode("strong","","Limite de contexte atteinte"),centerNode("p","",info.limit?`Le serveur limite cette conversation à ${info.limit.toLocaleString("fr-FR")} tokens.`:"La conversation dépasse la capacité acceptée par le serveur."),centerNode("p","","La reprise automatique n’a pas abouti. L’historique reste conservé ; tu peux réessayer après une compaction ou préciser la partie du travail à reprendre."));
    const details=centerNode("details");details.append(centerNode("summary","","Détail technique"),centerNode("pre","",raw));entry.append(details);return entry;
}
/* API failures use readable cards; raw responses stay in collapsed details. */
function parseApiErrorNotice(raw){
    const text=String(raw || ""),match=/(?:HTTP|status(?:Code)?["']?\s*[:=])\s*["']?(\d{3})\b/i.exec(text);
    const status=match?Number(match[1]):null;
    if(/\bCHAT_LOCKED\b|flagged by the AI provider|"chat_flagged"\s*:\s*true/i.test(text))return {title:"Conversation verrouillée",detail:"Le fournisseur d’IA a signalé puis verrouillé cette conversation selon ses règles de sécurité ou de modération. L’API ne précise pas le motif exact. Ce fil ne peut plus être utilisé : ouvre une nouvelle conversation avec le bouton + pour poursuivre.",kind:"locked",status};
    if(!status && !/erreur (?:du flux|API)|\bAPI\b|fetch failed|failed to fetch|network|ECONN|ENOTFOUND|ETIMEDOUT|timeout|timed out|Unsupported tool ignored by the backend|invalid[_ ]api[_ ]key|^\s*\{[\s\S]*"(?:error|message|errorCode)"\s*:/i.test(text))return null;
    let title="La requête n’a pas abouti",detail="Le service a renvoyé une erreur. Ton historique et les modifications déjà effectuées sont conservés.",kind="service";
    if(status===401 || /invalid[_ ]api[_ ]key/i.test(text)){title="Connexion à renouveler";detail="Ta session ou ta clé d’accès n’est plus acceptée. Vérifie la connexion dans les paramètres avant de réessayer.";kind="auth";}
    else if(status===403){title="Accès refusé";detail="Ton compte n’a pas accès à cette ressource ou à ce modèle. Vérifie les autorisations ou choisis un autre modèle.";kind="auth";}
    else if(status===429){title="Trop de requêtes à la fois";detail="Le service limite temporairement les demandes. Patiente avant de réessayer ; ce message ne signifie pas forcément que ton quota est épuisé.";kind="wait";}
    else if(status===413 || /image.{0,50}(?:dimension|too large)|file.{0,30}too large/i.test(text)){title="Pièce jointe trop volumineuse";detail="Le service refuse la taille du contenu envoyé. Réduis les pièces jointes ou utilise une capture plus ciblée.";kind="attachment";}
    else if(status===404){title="Ressource introuvable";detail="La conversation, le modèle ou la ressource demandée n’est plus disponible. Vérifie la ressource avant de réessayer.";}
    else if(status===408 || status===504 || /timeout|timed out|ETIMEDOUT/i.test(text)){title="Le service met trop de temps";detail="Le délai de réponse est dépassé. Vérifie la connexion puis réessaie quand le service répond à nouveau.";kind="wait";}
    else if(status>=500){title="Service momentanément indisponible";detail="Le serveur rencontre un problème. Ton travail local est conservé ; réessaie dans quelques instants.";}
    else if(/fetch failed|failed to fetch|network|ECONN|ENOTFOUND/i.test(text)){title="Connexion au service interrompue";detail="Impossible de joindre le service. Vérifie ta connexion Internet, puis réessaie.";kind="network";}
    else if(status===400 || status===422){title="Demande refusée par le service";detail="Le service n’accepte pas le contenu ou les options de cette demande. Vérifie le modèle et les pièces jointes.";}
    return {title,detail,kind,status};
}
function apiNoticeIcon(kind){
    if(kind==="locked")return apiNoticeIcon("auth");
    if(kind==="trash")return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M9 6V3h6v3M5 6l1 15h12l1-15M10 10v7m4-7v7"/></svg>';
    if(kind==="spark")return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z"/></svg>';
    if(kind==="chat")return '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6 3V6a2 2 0 0 1 2-2Z"/><path d="M7 9h10M7 13h7"/></svg>';
    if(kind==="tools")return '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3" width="7" height="7" rx="2"/><rect x="14" y="3" width="7" height="7" rx="2"/><rect x="3" y="14" width="7" height="7" rx="2"/><path d="M17.5 14v7M14 17.5h7"/></svg>';
    const paths={auth:'<rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V6a4 4 0 0 1 8 0v4m-4 5v2"/>',wait:'<circle cx="12" cy="12" r="9"/><path d="M12 6v6l4 2"/>',network:'<path d="m3 3 18 18M2 8a17 17 0 0 1 4-2m4-1a17 17 0 0 1 12 3M5 12a12 12 0 0 1 5-2m4 0a12 12 0 0 1 5 2M8 16a6 6 0 0 1 8 0"/><circle cx="12" cy="20" r="1"/>',attachment:'<rect x="4" y="3" width="16" height="18" rx="2"/><path d="m4 16 5-5 4 4 3-3 4 4"/>',service:'<rect x="4" y="3" width="16" height="7" rx="2"/><rect x="4" y="14" width="16" height="7" rx="2"/><path d="M8 6h1m-1 11h1m7-2v3m0 2h.01"/>'};
    return `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[kind] || paths.service}</svg>`;
}
function renderApiErrorEntry(info,raw){
    const entry=addEntry("api-error-notice","");entry.setAttribute("role","status");
    if(info.kind==="locked"){entry.classList.add("chat-locked-notice");entry.setAttribute("role","alert");}
    const icon=centerNode("span","api-notice-icon");icon.innerHTML=apiNoticeIcon(info.kind);
    const body=centerNode("div","api-notice-body");body.append(centerNode("strong","",info.title),centerNode("p","",info.detail));
    const actions=centerNode("div","api-notice-actions");
    if(info.kind==="locked"){
        const understood=centerNode("button","","J’ai bien compris");understood.type="button";
        understood.onclick=()=>{entry.dataset.acknowledged="true";understood.textContent="Compris";understood.disabled=true;};actions.append(understood);
    }else{
    const settings=centerNode("button","",info.kind==="auth"?"Vérifier ma connexion":"Voir l’usage");settings.type="button";
    settings.onclick=()=>{if(info.kind==="auth")showSideView("settings");else setAgentTab("usage");};actions.append(settings);
    }
    body.append(actions);
    const details=centerNode("details","api-notice-tech");details.append(centerNode("summary","",info.status?`Détails techniques · HTTP ${info.status}`:"Détails techniques"),centerNode("pre","",String(raw || "")));body.append(details);entry.append(icon,body);scrollDown();return entry;
}

const quotaRecoveryState=new WeakMap();
const quotaCheckedDeadlines=new Set();
function quotaCountdown(resetAt,now=Date.now()){
    const end=new Date(resetAt).getTime();
    if(!resetAt || !Number.isFinite(end))return "Heure de réinitialisation non communiquée";
    const minutes=Math.max(0,Math.ceil((end-now)/60000));
    if(!minutes)return "Échéance atteinte · vérification du quota nécessaire";
    return `Réinitialisation dans ${Math.floor(minutes/60)} h ${String(minutes%60).padStart(2,"0")} min`;
}
function mountQuotaRecovery(parent,resetAt){
    const box=centerNode("div","quota-recovery");
    const timer=centerNode("strong","quota-countdown");
    const note=centerNode("p","quota-recovery-note","Le quota est revérifié toutes les 15 minutes. Si le staff t’a accordé un reset, vérifie-le ici.");
    const button=centerNode("button","quota-reset-check","J’ai reçu un reset");button.type="button";
    const feedback=centerNode("p","quota-reset-feedback");feedback.setAttribute("role","status");
    const originalBudget=parent.closest(".budget-notice");
    quotaRecoveryState.set(box,{resetAt,checkedAt:ui.quotaUpdatedAt || null,budgetTitle:originalBudget?.querySelector(".budget-title")?.textContent,budgetDetail:originalBudget?.querySelector(".budget-detail")?.textContent});
    button.onclick=async()=>{
        if(ui.quotaLoading){feedback.textContent="Vérification du quota déjà en cours…";return;}
        button.disabled=true;button.textContent="Vérification…";
        await refreshQuota();
        const recovered=ui.quota?.percent!=null && Number(ui.quota.percent)<100;
        const target=box.isConnected?feedback:document.querySelector("#usage-dashboard .quota-reset-feedback");
        if(target)target.textContent=ui.quotaError?"Vérification indisponible. Réessaie dans quelques instants.":recovered?"Quota disponible. Tu peux envoyer une nouvelle demande.":"Le reset n’est pas encore confirmé par l’API.";
        button.disabled=false;button.textContent="J’ai reçu un reset";
    };
    box.append(timer,note,button,feedback);parent.append(box);updateQuotaRecoveryBox(box);if(box.closest("#transcript"))scrollDown();return box;
}
function updateQuotaRecoveryBox(box){
    const state=quotaRecoveryState.get(box);if(!state)return;
    const resetAt=ui.quota?.resetAt || state.resetAt;
    const checked=ui.quotaUpdatedAt && ui.quotaUpdatedAt!==state.checkedAt;
    if(checked){state.checkedAt=ui.quotaUpdatedAt;state.available=ui.quota?.percent!=null && Number(ui.quota.percent)<100 && !ui.quotaError;}
    if(ui.quotaError || !ui.status.booted)state.available=false;
    box.querySelector(".quota-countdown").textContent=state.available?"Quota disponible · tu peux reprendre":quotaCountdown(resetAt);
    box.classList.toggle("quota-recovered",!!state.available);
    const budget=box.closest(".budget-notice");
    if(budget){budget.querySelector(".budget-title").textContent=state.available?"Quota de chat disponible":state.budgetTitle;budget.querySelector(".budget-detail").textContent=state.available?"Le renouvellement est confirmé par l’API. Tu peux envoyer une nouvelle demande.":state.budgetDetail;if(state.available)budget.querySelector(".budget-chips")?.remove();}
    const end=new Date(resetAt).getTime();
    if(!state.available && resetAt && Number.isFinite(end) && end<=Date.now() && !quotaCheckedDeadlines.has(end) && ui.status.booted && !ui.quotaLoading){
        quotaCheckedDeadlines.add(end);if(quotaCheckedDeadlines.size>50)quotaCheckedDeadlines.delete(quotaCheckedDeadlines.values().next().value);void refreshQuota();
    }
}
function updateQuotaRecoveryCards(){for(const box of document.querySelectorAll(".quota-recovery"))updateQuotaRecoveryBox(box);}
setInterval(updateQuotaRecoveryCards,30000);
/* One welcome card after each installed update; no network request is needed. */
let releaseHighlightsData=null,releaseHighlightsShown=false,releaseDialogStage="notes",releaseAutomatic=false;
const releaseDialog=document.createElement("dialog");releaseDialog.id="release-highlights";releaseDialog.className="release-highlights";releaseDialog.setAttribute("aria-labelledby","release-highlights-title");document.body.append(releaseDialog);
function openReleaseHighlights(data,{automatic=false}={}){
    if(releaseDialog.open)return;
    releaseAutomatic=automatic;releaseDialogStage="notes";
    releaseHighlightsShown=true;releaseDialog.replaceChildren();
    const top=centerNode("div","release-notes-top");top.append(centerNode("span","release-notes-badge",`NOUVEAUTÉS · ${data.version}`));
    const close=centerNode("button","release-notes-close","×");close.type="button";close.setAttribute("aria-label","Fermer les nouveautés");close.onclick=()=>releaseDialog.close();top.append(close);
    const heading=centerNode("h2","",data.headline);heading.id="release-highlights-title";
    releaseDialog.append(top,centerNode("p","release-notes-brand","FranceStudent IDE"),heading,centerNode("p","release-notes-intro","Voici ce qui change dans cette version. Ton travail reste à sa place."));
    const list=centerNode("div","release-notes-list");
    for(const item of data.items){const row=centerNode("div","release-notes-item"),icon=centerNode("span","release-notes-icon");icon.innerHTML=apiNoticeIcon(item.icon==="clock"?"wait":item.icon);const body=centerNode("div");body.append(centerNode("strong","",item.title),centerNode("p","",item.text));row.append(icon,body);list.append(row);}
    const footer=centerNode("div","release-notes-footer"),more=centerNode("button","","Notes complètes");more.type="button";more.onclick=()=>api.openExternal(data.url).catch(error=>studioFeedback(error.message));
    const done=centerNode("button","primary","C’est parti !");done.type="button";done.onclick=()=>releaseDialog.close();footer.append(more,done);releaseDialog.append(list,footer);
    releaseDialog.showModal();done.focus();
}
function openFileVersionsIntro(){
    releaseDialogStage="fileVersions";releaseDialog.replaceChildren();
    const top=centerNode("div","release-notes-top");top.append(centerNode("span","release-notes-badge","NOUVEAU · VERSIONS DES FICHIERS"));
    const close=centerNode("button","release-notes-close","×");close.type="button";close.setAttribute("aria-label","Fermer la présentation");close.onclick=()=>releaseDialog.close();top.append(close);
    const heading=centerNode("h2","","Reviens avant une demande à l’agent");heading.id="release-highlights-title";
    releaseDialog.append(top,centerNode("p","release-notes-brand","FranceStudent IDE"),heading,centerNode("p","release-notes-intro","Si une modification ne te convient pas, tu peux retrouver une version précédente de tes fichiers."));
    const list=centerNode("div","release-notes-list");
    for(const [icon,title,text] of [
        ["clock","Une version locale avant la demande","Pour les projets ouverts, l’agent sauvegarde les fichiers enregistrés et non exclus avant chaque demande modifiable. Si la sauvegarde échoue, la demande est arrêtée."],
        ["tools","Où la retrouver ?","Dans l’espace Agent, ouvre Activité puis Versions des fichiers. Choisis une demande et clique sur Voir et restaurer pour examiner les fichiers concernés avant de confirmer."],
        ["spark","Quelques limites à connaître","Les fichiers non enregistrés, sensibles ou exclus ne sont pas sauvegardés. Une restauration peut retirer des fichiers créés depuis la version choisie ; les actions externes ne sont pas annulées."]
    ]){const row=centerNode("div","release-notes-item"),symbol=centerNode("span","release-notes-icon");symbol.innerHTML=apiNoticeIcon(icon==="clock"?"wait":icon);const body=centerNode("div");body.append(centerNode("strong","",title),centerNode("p","",text));row.append(symbol,body);list.append(row);}
    const footer=centerNode("div","release-notes-footer"),done=centerNode("button","primary","J’ai compris");done.type="button";done.onclick=()=>releaseDialog.close();footer.append(done);releaseDialog.append(list,footer);releaseDialog.showModal();done.focus();
}
let releaseAfterClose=null;
function openRobloxIntro(){
    releaseDialogStage="roblox";releaseAfterClose=null;releaseDialog.replaceChildren();
    const top=centerNode("div","release-notes-top");top.append(centerNode("span","release-notes-badge","NOUVEAU · ROBLOX & BLENDER"));
    const close=centerNode("button","release-notes-close","×");close.type="button";close.setAttribute("aria-label","Fermer la présentation");close.onclick=()=>releaseDialog.close();top.append(close);
    const heading=centerNode("h2","",`Crée des modèles 3D pour Roblox avec Blender`);heading.id="release-highlights-title";
    releaseDialog.append(top,centerNode("p","release-notes-brand","FranceStudent IDE"),heading,centerNode("p","release-notes-intro","Cette intégration provient du projet communautaire francestudents-code-Roblox. L’agent peut concevoir un objet 3D dans Blender, le vérifier puis le préparer pour Roblox Studio, sans quitter l’IDE."));
    const list=centerNode("div","release-notes-list release-notes-list-scroll");
    for(const [icon,title,text] of [
 ["tools","Un sous-agent « Modélisation 3D (Blender → Roblox) »","Demande par exemple « crée un arbre low-poly pour mon jeu Roblox ». L’agent écrit un script Blender et l’exécute en arrière-plan. Il exporte ensuite un fichier GLB, contrôle le modèle et prépare son import dans Roblox Studio."],
        ["spark","Un outil Blender complet pour l’agent","Il détecte ton installation de Blender, inspecte et valide un modèle (géométrie, échelle, matériaux), génère un aperçu et exécute des scripts. Il produit aussi un manifeste et gère l’import et l’export entre Blender et Roblox."],
        ["tools","Des modèles de départ prêts à l’emploi","Caisse, palette, panneau, arbre, arme, sol en tuiles et rig R15, ainsi que des scripts d’aperçu, de validation et d’export pour Roblox. L’agent les adapte à ta demande."],
        ["chat","Des skills Roblox et Blender hors ligne","Dans le centre d’extensions, onglet Roblox · Blender : construction Roblox, modélisation, scripts, optimisation, style low-poly et textures Blender. Ils s’installent et fonctionnent sans connexion."],
        ["clock","À savoir avant de commencer","Blender doit être installé sur ton ordinateur pour générer, valider et rendre des modèles. Roblox Studio reste nécessaire pour tester et publier ton jeu. Ouvre ton projet Roblox dans l’IDE pour que l’agent y range les fichiers."]
    ]){const row=centerNode("div","release-notes-item"),symbol=centerNode("span","release-notes-icon");symbol.innerHTML=apiNoticeIcon(icon==="clock"?"wait":icon);const body=centerNode("div");body.append(centerNode("strong","",title),centerNode("p","",text));row.append(symbol,body);list.append(row);}
    const footer=centerNode("div","release-notes-footer release-notes-footer-wrap");
    const source=centerNode("button","","Voir le projet d’origine sur GitHub");source.type="button";source.onclick=()=>api.openExternal(releaseHighlightsData?.robloxProjectUrl || "https://github.com/leo51500/francestudents-code-Roblox").catch(error=>studioFeedback(error.message));
    const project=centerNode("button","","Ouvrir un projet");project.type="button";project.onclick=()=>{releaseAfterClose=()=>$("btn-open-project")?.click();releaseDialog.close();};
    const skills=centerNode("button","","Ouvrir Roblox · Blender");skills.type="button";skills.onclick=()=>{releaseAfterClose=()=>{showSideView("extensions");setCenterTab("roblox");Promise.resolve(loadExtensionCenter()).catch(error=>studioFeedback(error.message));};releaseDialog.close();};
    const done=centerNode("button","primary","J’ai compris");done.type="button";done.onclick=()=>releaseDialog.close();
    footer.append(source,project,skills,done);releaseDialog.append(list,footer);releaseDialog.showModal();done.focus();
}
releaseDialog.addEventListener("close",()=>{
    if(releaseDialogStage==="notes" && releaseAutomatic && releaseHighlightsData?.showRobloxIntro){openRobloxIntro();return;}
    if(releaseDialogStage==="notes" && releaseAutomatic && releaseHighlightsData?.showFileVersionsIntro){openFileVersionsIntro();return;}
    if(releaseDialogStage==="roblox"){
        const next=releaseAfterClose;releaseAfterClose=null;
        if(releaseHighlightsData)releaseHighlightsData.showRobloxIntro=false;
 api.releaseHighlights("seenRoblox").catch(error=>studioFeedback(error.message));
 if(!next && releaseAutomatic && releaseHighlightsData?.showFileVersionsIntro){openFileVersionsIntro();return;}
        if(releaseHighlightsData)api.releaseHighlights("seen",releaseHighlightsData.version).catch(error=>studioFeedback(error.message));
        if(next)next();
 return;
    }
    if(releaseDialogStage==="fileVersions"){
        api.releaseHighlights("seenFileVersions").then(()=>{releaseHighlightsData.showFileVersionsIntro=false;return api.releaseHighlights("seen",releaseHighlightsData.version);}).catch(error=>studioFeedback(error.message));
    }else if(releaseHighlightsData)api.releaseHighlights("seen",releaseHighlightsData.version).catch(error=>studioFeedback(error.message));
});
function maybeShowReleaseHighlights(){
    if(!releaseHighlightsData?.shouldShow || releaseHighlightsShown || !$("startup-loading").hidden || !$("connection-guide").classList.contains("hidden") || document.querySelector("dialog[open]"))return;
    openReleaseHighlights(releaseHighlightsData,{automatic:true});
}
let checkpointPreferenceAsked=false;
async function maybeAskCheckpointPreference(){
    if(checkpointPreferenceAsked || document.querySelector("dialog[open]"))return;
    try{const value=await api.checkpointPreference("get");if(value!==undefined)return;}catch{return;}
    if(checkpointPreferenceAsked || document.querySelector("dialog[open]"))return;
    checkpointPreferenceAsked=true;
    const dialog=document.createElement("dialog");dialog.className="center-dialog";dialog.innerHTML=`<h2>Activer les points de sauvegarde ?</h2><p class="settings-help">Avant chaque tâche de l’agent, l’IDE peut conserver un point de reprise. Les dossiers release, .frst et les archives .asar restent ignorés.</p><div class="center-dialog-actions"><button type="button" data-backup-choice="off">Garder désactivé</button><button type="button" class="primary" data-backup-choice="on">Activer</button></div>`;
    document.body.append(dialog);dialog.showModal();
    dialog.querySelectorAll("[data-backup-choice]").forEach(button=>button.onclick=async()=>{await api.checkpointPreference("set",button.dataset.backupChoice==="on");dialog.close();dialog.remove();});
}
releaseDialog.addEventListener("close",()=>maybeAskCheckpointPreference());
new MutationObserver(maybeShowReleaseHighlights).observe($("startup-loading"),{attributes:true,attributeFilter:["hidden"]});
new MutationObserver(maybeShowReleaseHighlights).observe($("connection-guide"),{attributes:true,attributeFilter:["class"]});
api.releaseHighlights().then(data=>{releaseHighlightsData=data;maybeShowReleaseHighlights();}).catch(()=>{});
const releaseNotesButton=centerNode("button","","Nouveautés de cette version");releaseNotesButton.type="button";releaseNotesButton.id="release-highlights-open";releaseNotesButton.onclick=async()=>{try{releaseHighlightsData=await api.releaseHighlights();openReleaseHighlights(releaseHighlightsData);}catch(error){studioFeedback(error.message);}};
document.querySelector("#studio-update-check").parentElement.append(releaseNotesButton);
/* Shared identity for secondary flows. Keep existing controls and their handlers. */
function studioSurfaceHeader(dialog,{title,subtitle,icon="spark",badge,close}){
    dialog.classList.add("fs-dialog");
    const header=centerNode("header","fs-dialog-header"),mark=centerNode("span","fs-dialog-icon");mark.innerHTML=icon==="eco"?'<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 4c-6-1-13 1-13 7a6 6 0 0 0 6 6c6 0 8-7 7-13ZM4 21 15 10"/></svg>':apiNoticeIcon(icon);
    const copy=centerNode("div","fs-dialog-heading"),line=centerNode("div","fs-dialog-title-row");
    const old=dialog.querySelector("h2");
    const heading=old || centerNode("h2");heading.textContent=title;
    if(!heading.id)heading.id=dialog.id+"-heading";
    dialog.setAttribute("aria-labelledby",heading.id);
    line.append(heading);if(badge)line.append(centerNode("span","fs-surface-badge",badge));copy.append(line,centerNode("p","",subtitle));
    const dismiss=close || centerNode("button","","×");dismiss.type="button";dismiss.classList.add("fs-dialog-close");dismiss.setAttribute("aria-label",`Fermer : ${title}`);dismiss.onclick=()=>dialog.close();
    header.append(mark,copy,dismiss);dialog.prepend(header);return header;
}
function studioSurfaceSection(title,description,nodes){
    const section=centerNode("section","fs-dialog-section");
    const heading=centerNode("h3","",title);section.append(heading);
    if(description)section.append(centerNode("p","fs-section-description",description));
    for(const node of nodes)if(node)section.append(node);return section;
}
function decorateEcoDialog(){
    const dialog=ecoModeDialog;
    studioSurfaceHeader(dialog,{title:"Activer le mode Éco",subtitle:"Moins de quota, des tâches plus courtes.",icon:"eco",badge:"Optionnel"});
    const items=[...dialog.querySelectorAll("li")];
    const list=centerNode("div","fs-eco-grid");
    for(const [index,item] of items.entries()){
        const card=centerNode("article","fs-feature-card"),number=centerNode("span","fs-feature-number",String(index+1).padStart(2,"0"));
        card.append(number,centerNode("strong","",["Des demandes plus courtes","Un contexte allégé","Moins de relances","Des réponses ciblées"][index]),centerNode("p","",item.textContent));list.append(card);
    }
    dialog.querySelector("ul").replaceWith(list);
    const paragraphs=[...dialog.querySelectorAll(":scope > p")];
    if(paragraphs[1])paragraphs[1].classList.add("fs-dialog-note");
    const footer=dialog.querySelector(".studio-actions");footer.classList.add("fs-dialog-footer");
    $("eco-mode-enable").classList.add("primary");
}
function decorateImportDialog(){
    const dialog=conversationImportDialog;
    studioSurfaceHeader(dialog,{title:"Continuer avec ton IA",subtitle:"Importe les échanges Codex, puis reprends dans FranceStudent IDE.",icon:"chat",badge:"Bêta"});
    const url=$("conversation-import-url").closest("label"),text=$("conversation-import-text").closest("label");
    const file=$("conversation-import-file").parentElement,analyze=$("conversation-import-preview").parentElement;
    const urlHelp=url.nextElementSibling;
    const section=studioSurfaceSection("1. Ajoute ta conversation","Colle un lien de partage, choisis un export ou colle directement le texte.",[url,urlHelp,file,text,analyze]);
    dialog.insertBefore(section,$("conversation-import-status"));
    const choices=dialog.querySelector(".conversation-import-choices");
    const settings=studioSurfaceSection("2. Choisis comment continuer","La reprise prépare un brouillon. Tu décides quand l’envoyer.",[choices]);dialog.insertBefore(settings,dialog.querySelector(":scope > .studio-actions:last-child"));
    dialog.querySelector(":scope > .studio-actions:last-child").classList.add("fs-dialog-footer");
    $("conversation-import-project").classList.add("fs-project-summary");
    $("conversation-import-apply").title="Préparer un brouillon sans lancer de requête IA";
}
function decorateGithubDialog(){
    const dialog=githubConnectorDialog,oldHead=dialog.querySelector(".workspace-section-head");
    studioSurfaceHeader(dialog,{title:"Ton espace GitHub",subtitle:"Dépôts, échanges et versions, au même endroit.",icon:"tools",badge:"Bêta",close:$("github-connector-close")});oldHead.remove();
    const account=studioSurfaceSection("Projet connecté","",[$("github-connector-account"),$("github-connector-repo")]);dialog.querySelector(".fs-dialog-header").after(account);
    const nav=dialog.querySelector(".github-connector-nav");nav.setAttribute("role","group");nav.setAttribute("aria-label","Contenu GitHub");
    const readme=$("github-connector-readme");readme.classList.add("fs-readme-action");nav.after(readme);
    $("github-connector-create").classList.add("fs-dialog-section");$("github-release-create").classList.add("primary");
    const note=dialog.querySelector(":scope > p:last-child");if(note)note.classList.add("fs-dialog-note");
}
decorateEcoDialog();decorateImportDialog();decorateGithubDialog();
for(const [id,subtitle,icon] of [["skill-editor","Les instructions que ton agent pourra utiliser.","tools"],["mcp-editor","Relie un outil externe à ton espace de travail.","tools"]]){
    const dialog=$(id),oldHead=dialog.querySelector(".center-dialog-head");
    studioSurfaceHeader(dialog,{title:dialog.querySelector("h2").textContent,subtitle,icon,close:oldHead.querySelector("button")});oldHead.remove();
}

// Real modal confirmations replace browser-native alerts and restore focus on close.
let studioConfirmationQueue=Promise.resolve();
function confirmStudioAction(message,{title="Confirmer cette action",confirmLabel="Confirmer",danger=true}={}){
    const next=studioConfirmationQueue.then(()=>new Promise(resolve=>{
        const previous=document.activeElement,dialog=document.createElement("dialog");dialog.id="studio-confirm-dialog";dialog.className="fs-dialog fs-confirm-dialog";
        dialog.setAttribute("aria-labelledby","studio-confirm-title");
        const heading=centerNode("h2","",title);heading.id="studio-confirm-title";dialog.append(heading);
        studioSurfaceHeader(dialog,{title,subtitle:danger?"Vérifie l’action avant de continuer.":"Ton choix s’applique à cette action.",icon:danger?"trash":"spark"});
        const body=centerNode("p","fs-confirm-message",message);body.id="studio-confirm-message";dialog.setAttribute("aria-describedby",body.id);
        const footer=centerNode("div","fs-dialog-footer"),cancel=centerNode("button","","Annuler"),accept=centerNode("button",danger?"danger":"primary",confirmLabel);
        cancel.type=accept.type="button";accept.dataset.confirm="accept";cancel.dataset.confirm="cancel";
        let accepted=false;cancel.onclick=()=>dialog.close();accept.onclick=()=>{accepted=true;dialog.close();};footer.append(cancel,accept);dialog.append(body,footer);document.body.append(dialog);
        dialog.addEventListener("close",()=>{dialog.remove();resolve(accepted);requestAnimationFrame(()=>{if(previous?.isConnected)previous.focus();});},{once:true});dialog.showModal();cancel.focus();
    }));
    studioConfirmationQueue=next.catch(()=>false);return next;
}
﻿/* macOS is experimental; show this notice on every launch, never on Windows. */
if(api.platform==="darwin"){
    const macBetaNotice=document.createElement("dialog");
    macBetaNotice.id="mac-beta-notice";
    macBetaNotice.className="fs-dialog";
    document.body.append(macBetaNotice);
    studioSurfaceHeader(macBetaNotice,{title:"Bienvenue sur Mac",subtitle:"Cette version de FranceStudent IDE est en bêta.",badge:"BÊTA"});
    const body=centerNode("div","fs-dialog-section");
    body.append(centerNode("p","","Certaines fonctionnalités peuvent encore présenter des bugs sur macOS. Pense à enregistrer régulièrement ton travail et à nous signaler les problèmes rencontrés."));
    const footer=centerNode("div","release-notes-footer"),done=centerNode("button","primary","Continuer");
    done.type="button";done.onclick=()=>macBetaNotice.close();
    footer.append(done);macBetaNotice.append(body,footer);
    macBetaNotice.showModal();done.focus();
}
/* Crash notices are local, actionable and acknowledged explicitly. */
let stabilityNotice = null, stabilityNoticeShown = false;
function maybeShowStabilityNotice() {
    if (!stabilityNotice || stabilityNoticeShown || !$("startup-loading").hidden || document.querySelector("dialog[open]")) return;
    stabilityNoticeShown = true;
    stabilityNoticeObserver.disconnect();
    document.removeEventListener("close", maybeShowStabilityNotice, true);
    const notice = stabilityNotice, dialog = centerNode("dialog", "fs-dialog");
    dialog.id = "stability-notice";
    studioSurfaceHeader(dialog, { title: "Après un arrêt inattendu", subtitle: "Voici ce que l’application a pu identifier.", badge: notice.code, icon: "clock" });
    const body = centerNode("section", "fs-dialog-section");
    body.append(centerNode("h3", "", notice.title), centerNode("p", "", notice.reasonText), centerNode("p", "fs-dialog-note", notice.advice));
    const report = centerNode("pre", "fs-stability-report", notice.report);
    body.append(report, centerNode("p", "fs-section-description", "Diagnostic local : le texte des conversations et des fichiers, les jetons et les traces complètes ne sont pas collectés. Aucun envoi automatique."));
    if (!notice.persisted) body.append(centerNode("p", "fs-dialog-note", "Le journal local n’a pas pu être sauvegardé. Copie ce diagnostic avant de fermer."));
    const footer = centerNode("div", "fs-dialog-footer"), copy = centerNode("button", "", "Copier le diagnostic"), done = centerNode("button", "primary", "J’ai compris");
    copy.id = "stability-copy"; done.id = "stability-acknowledge"; copy.type = done.type = "button";
    copy.onclick = () => api.copyText(notice.report).then(() => { copy.textContent = "Diagnostic copié"; }).catch(error => studioFeedback(error.message));
    done.onclick = () => dialog.close();
    dialog.addEventListener("close", () => { api.stability("acknowledge", notice.id).catch(error => studioFeedback(error.message)); dialog.remove(); }, { once: true });
    footer.append(copy, done); dialog.append(body, footer); document.body.append(dialog); dialog.showModal(); done.focus();
}
const stabilityNoticeObserver = new MutationObserver(maybeShowStabilityNotice);
stabilityNoticeObserver.observe($("startup-loading"), { attributes: true, attributeFilter: ["hidden"] });
document.addEventListener("close", maybeShowStabilityNotice, true);
api.stability().then(notice => {
    stabilityNotice = notice;
    if (notice) maybeShowStabilityNotice();
    else { stabilityNoticeObserver.disconnect(); document.removeEventListener("close", maybeShowStabilityNotice, true); }
}).catch(() => { stabilityNoticeObserver.disconnect(); document.removeEventListener("close", maybeShowStabilityNotice, true); });
/* Triggered only by the agent's ask_user tool; never inferred from question marks. */
function renderAgentQuestion(prompt, zone) {
    const card = centerNode("section", "fs-agent-question");
    card.setAttribute("aria-labelledby", `agent-question-${prompt.id}`);
    const header = centerNode("div", "fs-agent-question-header");
    header.append(centerNode("span", "fs-surface-badge", "Question de l’agent"), centerNode("span", "muted", "En attente de ta réponse"));
    const heading = centerNode("h3", "", formatAgentQuestion(prompt.question)); heading.id = `agent-question-${prompt.id}`;
    card.append(header, heading);
    const choices = centerNode("fieldset", "fs-agent-choices");
    const legend = centerNode("legend", "", prompt.multiple ? "Tu peux sélectionner plusieurs réponses." : "Choisis une réponse ou écris la tienne.");
    choices.append(legend);
    const inputs = [];
    for (const option of prompt.options || []) {
        const row = centerNode("label", "fs-agent-choice"), field = document.createElement("input");
        field.type = prompt.multiple ? "checkbox" : "radio"; field.name = `agent-question-${prompt.id}`; field.value = option.id;
        const copy = centerNode("span", "fs-agent-choice-copy"), title = centerNode("strong", "", option.label);
        copy.append(title);
        if (option.recommended) title.append(centerNode("span", "fs-surface-badge", "Conseillé"));
        if (option.description) copy.append(centerNode("small", "", option.description));
        row.append(field, copy); choices.append(row); inputs.push(field);
    }
    if (inputs.length) {
        if (!prompt.multiple) {
            const other = centerNode("label", "fs-agent-choice"), radio = document.createElement("input");
            radio.type = "radio"; radio.name = `agent-question-${prompt.id}`; radio.value = "";
            other.append(radio, centerNode("strong", "", "Autre réponse")); choices.append(other); inputs.push(radio);
        }
        card.append(choices);
    }
    const label = centerNode("label", "fs-agent-answer-label", inputs.length ? "Précision ou autre réponse" : "Ta réponse");
    const text = document.createElement("textarea"); text.rows = 2; text.maxLength = 4000; text.placeholder = prompt.placeholder || "Écris ta réponse…";
    text.id = `agent-answer-${prompt.id}`; label.htmlFor = text.id; card.append(label, text);
    const error = centerNode("p", "fs-agent-question-error"); error.setAttribute("role", "alert");
    const footer = centerNode("div", "buttons"), skip = centerNode("button", "", "Passer"), submit = centerNode("button", "primary", "Répondre");
    skip.type = submit.type = "button"; skip.dataset.questionAction = "skip"; submit.dataset.questionAction = "answer";
    let sending = false;
    const refresh = () => { submit.disabled = sending || (!text.value.trim() && !inputs.some(field => field.checked && field.value)); };
    async function answer(skipped) {
        if (sending || (!skipped && submit.disabled)) return;
        sending = true; error.textContent = ""; skip.disabled = true; text.disabled = true;
        inputs.forEach(field => { field.disabled = true; }); refresh();
        try {
            await api.resolvePrompt(prompt.id, skipped ? { skipped: true } : { selected: inputs.filter(field => field.checked && field.value).map(field => field.value), text: text.value });
        } catch (failure) {
            sending = false; error.textContent = failure.message; skip.disabled = false; text.disabled = false;
            inputs.forEach(field => { field.disabled = false; }); refresh();
        }
    }
    inputs.forEach(field => field.addEventListener("change", refresh)); text.addEventListener("input", refresh);
    text.addEventListener("keydown", event => { if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); answer(false); } });
    submit.onclick = () => answer(false); skip.onclick = () => answer(true);
    footer.append(skip, submit); card.append(error, footer); zone.append(card); refresh();
    setTimeout(() => { if (card.isConnected) (inputs[0] || text).focus({ preventScroll: true }); }, 0);
}

// Keep instructions and shell commands readable when a model sends them in a
// single paragraph. Newlines supplied by the model are always preserved.
function formatAgentQuestion(value) {
    const text = String(value || "").replace(/\r\n?/g, "\n").trim();
    if (!text) return "";
    const command = /\s+(?=(?:npm|npx|node|python(?:3)?|pip(?:3)?|git|curl|wget|docker|dotnet|cargo|go|powershell|pwsh|bash|cmd|rm|mkdir|cat|ls|find|echo)(?:\s|$))/gi;
    return text.replace(command, "\n").replace(/\s*(?:&&|;)+\s*/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}
/* Model selection and explicit, opt-in dictation. */
const composerTools = document.createElement("div");
composerTools.className = "chat-composer-tools";
const composerModelRow = document.createElement("div"), composerSettingsRow = document.createElement("div");
composerModelRow.className = "chat-model-row"; composerSettingsRow.className = "chat-settings-row";
composerTools.append(composerModelRow, composerSettingsRow);
function chatControlContent(button, icon, label) {
    button.innerHTML = `<svg class="i" viewBox="0 0 24 24" aria-hidden="true">${icon}</svg><span class="chat-control-label"></span><svg class="chat-control-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m8 10 4 4 4-4"/></svg>`;
    button.querySelector(".chat-control-label").textContent = label;
}
composerModelRow.append($("btn-model"));
const dictationButton = document.createElement("button");
dictationButton.type = "button"; dictationButton.id = "chat-dictation";
dictationButton.title = "Dictée locale · Bêta"; dictationButton.setAttribute("aria-label", dictationButton.title);
dictationButton.setAttribute("aria-pressed", "false");
dictationButton.innerHTML = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 10v2a7 7 0 0 0 14 0v-2M12 19v3m-4 0h8"/></svg><span class="dictation-beta" aria-hidden="true">β</span>';
composerModelRow.append(dictationButton);
$("composer").querySelector(".composer-actions").before(composerTools);
let composerContextKey = null;
function updateComposerContext(status) {
    const key = status.booted ? status.chatContextKey : null;
    if (key !== composerContextKey) {
        composerContextKey = key;
        cancelChatDictation();
    }
}

let chatDictation = null;
function cancelChatDictation() {
    if (!chatDictation) return;
    chatDictation.canceled = true;
    if (chatDictation.recorder?.state === "recording") chatDictation.recorder.stop();
    chatDictation.stream?.getTracks().forEach(track => track.stop());
    clearTimeout(chatDictation.timer);
    api.dictate("cancel").catch(() => {});
    chatDictation = null; paintDictation(false);
}
function paintDictation(recording, processing = false, preparing = false) {
    dictationButton.classList.toggle("recording", recording);
    dictationButton.setAttribute("aria-pressed", String(recording));
    dictationButton.title = recording ? "Terminer et transcrire localement" : preparing ? "Annuler la préparation du modèle local" : processing ? "Annuler la transcription locale" : "Dictée locale · Bêta";
    dictationButton.setAttribute("aria-label", dictationButton.title);
}
async function startChatDictation() {
    let consent = false;
    try { consent = localStorage.getItem("frst.dictation.local-consent-v1") === "yes"; } catch { /* Ask again without persistent storage. */ }
    if (!consent) {
        if (!await confirmStudioAction("La reconnaissance vocale s’effectue sur ton ordinateur, sans envoyer l’audio ni consommer de quota FranceStudent. Le modèle est téléchargé une fois avant l’activation du micro (environ 100 Mo), puis reste disponible hors ligne. Le micro enregistre jusqu’à 2 minutes en mémoire. Le texte reste un brouillon à corriger avant d’envoyer.", { title: "Dictée locale · Bêta", confirmLabel: "Préparer et activer le micro", danger: false })) return;
        try { localStorage.setItem("frst.dictation.local-consent-v1", "yes"); } catch { /* Consent applies to this recording. */ }
    }
    if (chatDictation) return;
    const session = { canceled: false, key: composerContextKey, chunks: [], stage: "preparing" };
    chatDictation = session;
    try {
        paintDictation(false, true, true);
        studioFeedback("Préparation de la dictée locale… Premier téléchargement si nécessaire, avant d’activer le micro. Clique sur le micro pour annuler.");
        await api.dictate("prepare");
        if (session.canceled) return;
        session.stage = "recording";
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
        session.stream = stream;
        if (session.canceled) { stream.getTracks().forEach(track => track.stop()); return; }
        const recorder = new MediaRecorder(stream); session.recorder = recorder;
        recorder.ondataavailable = event => { if (event.data.size) session.chunks.push(event.data); };
        recorder.onstop = async () => {
            stream.getTracks().forEach(track => track.stop()); clearTimeout(session.timer);
            if (session.canceled) return;
            paintDictation(false, true); studioFeedback("Transcription locale en cours… Clique sur le micro pour annuler.");
            let audioContext;
            try {
                audioContext = new AudioContext();
                const decoded = await audioContext.decodeAudioData(await new Blob(session.chunks, { type: recorder.mimeType }).arrayBuffer());
                if (decoded.duration > 121) throw new Error("La dictée dépasse 2 minutes.");
                const offline = new OfflineAudioContext(1, Math.min(16000 * 120, Math.ceil(decoded.duration * 16000)), 16000);
                const source = offline.createBufferSource(); source.buffer = decoded; source.connect(offline.destination); source.start();
                const samples = (await offline.startRendering()).getChannelData(0), pcm = new Int16Array(samples.length);
                for (let i = 0; i < samples.length; i++) pcm[i] = Math.max(-1, Math.min(1, samples[i])) * 32767;
                if (session.canceled) return;
                // The worker may have been released while the system microphone dialog was open.
                await api.dictate("prepare");
                if (session.canceled) { pcm.fill(0); return; }
                let text;
                try { text = await api.dictate("transcribe", pcm); } finally { pcm.fill(0); }
                if (session.canceled || session.key !== composerContextKey) return;
                if (text.trim()) { input.value += `${input.value && !/\s$/.test(input.value) ? " " : ""}${text}`; input.dispatchEvent(new Event("input", { bubbles: true })); input.focus(); }
                studioFeedback(text.trim() ? "Dictée ajoutée au brouillon. Tu peux la corriger avant d’envoyer." : "Aucune parole reconnue. Ton brouillon est conservé.");
            } catch (error) { if (!session.canceled) studioFeedback(error.message || "La transcription a échoué. Ton brouillon est conservé."); }
            finally { session.chunks = []; await audioContext?.close().catch(() => {}); if (chatDictation === session) { chatDictation = null; paintDictation(false); } }
        };
        recorder.onerror = () => { cancelChatDictation(); studioFeedback("L’enregistrement a échoué. Ton brouillon est conservé."); };
        recorder.start(1000); paintDictation(true); studioFeedback("Micro actif · parle, puis clique sur le micro pour transcrire (2 min maximum).");
        session.timer = setTimeout(() => { if (recorder.state === "recording") recorder.stop(); }, 120000);
    } catch (error) {
        if (session.canceled) return;
        cancelChatDictation();
        studioFeedback(session.stage === "preparing" ? error.message || "Le modèle de dictée locale est indisponible. Ton brouillon est conservé." : "Micro indisponible ou autorisation refusée. Vérifie les réglages du système.");
    }
}
dictationButton.onclick = () => {
    if (chatDictation?.recorder?.state === "recording") chatDictation.recorder.stop();
    else if (chatDictation) { cancelChatDictation(); studioFeedback("Dictée annulée. Ton brouillon est conservé."); }
    else startChatDictation();
};
window.addEventListener("beforeunload", cancelChatDictation);
$("composer").addEventListener("submit", cancelChatDictation, true);
updateComposerContext(ui.status);
/* Same permission policy as Settings, available directly in the chat composer. */
const chatAccessButton = document.createElement("button");
chatAccessButton.type = "button"; chatAccessButton.id = "chat-access-button";
chatAccessButton.setAttribute("aria-haspopup", "menu"); chatAccessButton.setAttribute("aria-expanded", "false");
chatAccessButton.setAttribute("aria-controls", "chat-access-menu");
composerSettingsRow.append(chatAccessButton);
chatControlContent(chatAccessButton, '<path d="M12 3 4 6v6c0 4 8 9 8 9s8-5 8-9V6l-8-3Z"/><path d="m9 12 2 2 4-4"/>', "Accès");
const chatAccessMenu = document.createElement("div");
chatAccessMenu.id = "chat-access-menu"; chatAccessMenu.className = "chat-access-menu";
chatAccessMenu.setAttribute("popover", "auto");
chatAccessMenu.innerHTML = '<div class="chat-access-heading">Autorisations de l’agent</div><div class="chat-access-choices" role="menu" aria-label="Niveau d’accès"></div><label class="chat-access-remember"><input type="checkbox"> Mémoriser pour les prochaines sessions</label><p class="chat-access-error" role="status"></p>';
document.body.append(chatAccessMenu);
const chatAccessModes = [
    { id: "ask", label: "Sur approbation", icon: "♧", description: "Demande ton accord pour les modifications et les commandes sensibles." },
    { id: "auto", label: "Automatique", icon: "◈", description: "Approuve les modifications et les commandes autorisées. Les commandes bloquées restent interdites." },
    { id: "full", label: "Accès complet", icon: "◇", description: "Actions sans confirmation, y compris hors du projet. Approuve aussi les actions déjà en attente. Tu peux les annuler pendant leur exécution." }
];
let chatAccessSaving = false;
function chatAccessMode(status) {
    return status.fullAccess ? "full" : status.autoApprove && status.autoApproveCommands ? "auto" : status.autoApprove || status.autoApproveCommands ? "custom" : "ask";
}
function updateChatAccess(status) {
    const mode = chatAccessMode(status || {}), label = chatAccessModes.find(item => item.id === mode)?.label || "Personnalisé";
    chatAccessButton.querySelector(".chat-control-label").textContent = label;
    chatAccessButton.classList.toggle("full-access", mode === "full");
    chatAccessButton.title = `Niveau d’accès : ${label}. Modifier les autorisations de l’agent.`;
    for (const row of chatAccessMenu.querySelectorAll("[data-chat-access]")) {
        const selected = row.dataset.chatAccess === mode;
        row.setAttribute("aria-checked", String(selected)); row.classList.toggle("selected", selected);
        row.querySelector(".chat-access-check").textContent = selected ? "✓" : "";
    }
}
function positionChatAccess() {
    const rect = chatAccessButton.getBoundingClientRect();
    const width = Math.min(370, window.innerWidth - 24);
    chatAccessMenu.style.width = `${width}px`;
    chatAccessMenu.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`;
    chatAccessMenu.style.maxHeight = `${Math.max(80, rect.top - 20)}px`;
    chatAccessMenu.style.top = `${Math.max(12, rect.top - chatAccessMenu.getBoundingClientRect().height - 8)}px`;
}
for (const item of chatAccessModes) {
    const row = document.createElement("button"); row.type = "button"; row.dataset.chatAccess = item.id;
    row.setAttribute("role", "menuitemradio"); row.setAttribute("aria-checked", "false");
    row.innerHTML = '<span class="chat-access-icon" aria-hidden="true"></span><span class="chat-access-copy"><strong></strong><small></small></span><span class="chat-access-check" aria-hidden="true"></span>';
    row.querySelector(".chat-access-icon").textContent = item.icon;
    row.querySelector("strong").textContent = item.label; row.querySelector("small").textContent = item.description;
    row.onclick = async () => {
        if (chatAccessSaving) return;
        chatAccessSaving = true; chatAccessMenu.querySelector(".chat-access-error").textContent = "";
        chatAccessMenu.querySelectorAll("button,input").forEach(control => { control.disabled = true; });
        try {
            const remember = chatAccessMenu.querySelector("input").checked;
            applySettings(await api.setAutoApprove(`access-${item.id}-${remember ? "always" : "session"}`));
            applyStatus(await api.status()); chatAccessMenu.hidePopover(); chatAccessButton.focus();
        } catch (error) { chatAccessMenu.querySelector(".chat-access-error").textContent = error.message; }
        finally { chatAccessSaving = false; chatAccessMenu.querySelectorAll("button,input").forEach(control => { control.disabled = false; }); }
    };
    chatAccessMenu.querySelector(".chat-access-choices").append(row);
}
chatAccessButton.onclick = async () => {
    if (chatAccessMenu.matches(":popover-open")) { chatAccessMenu.hidePopover(); return; }
    hideModelMenu(); updateChatAccess(ui.status); chatAccessMenu.querySelector(".chat-access-error").textContent = "";
    chatAccessMenu.querySelector("input").checked = $("set-remember-access").checked;
    chatAccessMenu.showPopover(); positionChatAccess();
    (chatAccessMenu.querySelector('[aria-checked="true"]') || chatAccessMenu.querySelector("button")).focus();
    try {
        const settings = await api.setAutoApprove("");
        if (!chatAccessMenu.matches(":popover-open") || chatAccessSaving) return;
        applySettings(settings); updateChatAccess(settings);
        chatAccessMenu.querySelector("input").checked = $("set-remember-access").checked;
        positionChatAccess();
    } catch (error) { chatAccessMenu.querySelector(".chat-access-error").textContent = error.message; }
};
chatAccessMenu.addEventListener("toggle", () => chatAccessButton.setAttribute("aria-expanded", String(chatAccessMenu.matches(":popover-open"))));
chatAccessMenu.addEventListener("keydown", event => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const rows = [...chatAccessMenu.querySelectorAll("[data-chat-access]")];
    if (!rows.includes(document.activeElement)) return;
    event.preventDefault();
    const index = rows.indexOf(document.activeElement);
    rows[event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1 : (index + (event.key === "ArrowUp" ? rows.length - 1 : 1)) % rows.length].focus();
});
window.addEventListener("resize", () => { if (chatAccessMenu.matches(":popover-open")) positionChatAccess(); });
updateChatAccess(ui.status);
/* Terminal profile applies to new terminals; running shells are preserved. */
const terminalSettingsCard = document.createElement("section");
terminalSettingsCard.className = "settings-card"; terminalSettingsCard.dataset.settingsGroup = "general";
terminalSettingsCard.setAttribute("aria-labelledby", "settings-terminal-title");
terminalSettingsCard.innerHTML = '<h3 id="settings-terminal-title">Terminal intégré</h3><p class="settings-help">Choisis le terminal des nouveaux onglets. Avec WSL, retrouve les packages et outils déjà installés dans ta distribution Linux. Les terminaux ouverts gardent leur environnement.</p><label class="center-code-label">Terminal par défaut<select id="settings-terminal-profile" disabled></select></label><label id="settings-terminal-distribution-label" class="center-code-label hidden">Distribution WSL<select id="settings-terminal-distribution"><option value="">Distribution par défaut de WSL</option></select></label><div class="studio-actions"><button type="button" id="settings-terminal-save" class="primary" disabled>Enregistrer</button><button type="button" id="settings-terminal-refresh">Actualiser les terminaux</button></div><p id="settings-terminal-message" class="settings-help" role="status"></p><p class="settings-help">Ce réglage concerne le terminal intégré, pas les commandes de l’agent, les serveurs MCP ou les autres outils Windows. WSL doit être installé au préalable. Ouvre un nouveau terminal avec + après avoir enregistré. Le terminal simple de secours ne conserve pas tout l’état d’un shell interactif.</p>';
$("settings-model-title").closest(".settings-card").after(terminalSettingsCard);
const terminalProfileSelect = $("settings-terminal-profile"), terminalDistributionSelect = $("settings-terminal-distribution");
let terminalSettingsLoading = false, terminalDistributionSerial = 0;
function terminalSettingsMessage(text) { $("settings-terminal-message").textContent = text; }
async function refreshTerminalDistributions(selected = "") {
    const serial = ++terminalDistributionSerial;
    const wsl = terminalProfileSelect.value === "wsl";
    $("settings-terminal-distribution-label").classList.toggle("hidden", !wsl);
    if (!wsl) return;
    terminalDistributionSelect.disabled = true; $("settings-terminal-save").disabled = true;
    try {
        const names = await api.terminalPreferences("distributions");
        if (serial !== terminalDistributionSerial || terminalProfileSelect.value !== "wsl") return;
        terminalDistributionSelect.replaceChildren(new Option("Distribution par défaut de WSL", ""));
        for (const name of names) terminalDistributionSelect.append(new Option(name, name));
        if (selected && !names.includes(selected)) terminalSettingsMessage(`La distribution ${selected} est introuvable. Choisis une distribution installée.`);
        terminalDistributionSelect.value = names.includes(selected) ? selected : "";
        if (!names.length) { terminalSettingsMessage("Aucune distribution WSL installée. Installe-la avant de sélectionner WSL."); return; }
        terminalDistributionSelect.disabled = false; $("settings-terminal-save").disabled = false;
    } catch (error) { if (serial === terminalDistributionSerial) terminalSettingsMessage(error.message); }
}
async function loadTerminalSettings() {
    if (terminalSettingsLoading) return;
    terminalSettingsLoading = true; terminalSettingsMessage("Détection des terminaux…");
    terminalProfileSelect.disabled = true; $("settings-terminal-save").disabled = true;
    try {
        const value = await api.terminalPreferences();
        terminalProfileSelect.replaceChildren();
        for (const profile of value.profiles) terminalProfileSelect.append(new Option(profile.name, profile.id));
        if (!value.profiles.some(profile => profile.id === value.profile)) {
            const missing = new Option(`Terminal indisponible (${value.profile})`, value.profile); missing.disabled = true; terminalProfileSelect.append(missing);
        }
        terminalProfileSelect.value = value.profile; terminalProfileSelect.disabled = false;
        $("settings-terminal-save").disabled = false; terminalSettingsMessage("");
        await refreshTerminalDistributions(value.distribution);
    } catch (error) { terminalSettingsMessage(error.message); }
    finally { terminalSettingsLoading = false; }
}
terminalProfileSelect.onchange = () => {
    terminalSettingsMessage(""); $("settings-terminal-save").disabled = false;
    refreshTerminalDistributions();
};
$("settings-terminal-refresh").onclick = loadTerminalSettings;
$("settings-terminal-save").onclick = async () => {
    $("settings-terminal-save").disabled = true; terminalProfileSelect.disabled = true;
    try {
        const value = await api.terminalPreferences("save", { profile: terminalProfileSelect.value, distribution: terminalDistributionSelect.value });
        terminalSettingsMessage(`Terminal enregistré : ${value.profiles.find(item => item.id === value.profile)?.name || value.profile}. Ouvre un nouvel onglet avec +.`);
    } catch (error) { terminalSettingsMessage(error.message); }
    finally { $("settings-terminal-save").disabled = false; terminalProfileSelect.disabled = false; }
};
loadTerminalSettings();
/* FranceStudent stores this preference on the account, not in each chat. */
const reasoningButton = document.createElement("button");
reasoningButton.id = "chat-reasoning"; reasoningButton.type = "button"; reasoningButton.hidden = true;
reasoningButton.setAttribute("aria-haspopup", "menu"); reasoningButton.setAttribute("aria-expanded", "false");
reasoningButton.setAttribute("aria-controls", "chat-reasoning-menu");
composerSettingsRow.append(reasoningButton);
chatControlContent(reasoningButton, '<path d="M9 18h6m-5 3h4M8 14a6 6 0 1 1 8 0c-1 1-1 2-1 3H9c0-1 0-2-1-3Z"/>', "Réflexion");
const reasoningMenu = document.createElement("div");
reasoningMenu.id = "chat-reasoning-menu"; reasoningMenu.className = "chat-access-menu"; reasoningMenu.setAttribute("popover", "auto");
reasoningMenu.innerHTML = '<div class="chat-access-heading">Niveau de réflexion</div><p class="reasoning-account-note">Préférence du compte FranceStudent, commune aux chats GPT. Un niveau élevé peut consommer davantage de quota.</p><div class="chat-access-choices" role="menu" aria-label="Niveau de réflexion du GPT"></div><p class="chat-access-error" role="status"></p>';
document.body.append(reasoningMenu);
const reasoningLabels = { none: ["Désactivée", "Privilégie une réponse rapide, sans raisonnement supplémentaire."], minimal: ["Minimale", "Réflexion très courte."], low: ["Faible", "Privilégie la rapidité et une consommation réduite."], medium: ["Moyenne", "Équilibre entre rapidité et réflexion."], high: ["Élevée", "Davantage de réflexion pour les tâches difficiles."], xhigh: ["Très élevée", "Réflexion approfondie, potentiellement plus lente et coûteuse."] };
let reasoningSnapshot = null, reasoningModelKey = null, reasoningSerial = 0, reasoningLoading = false, reasoningSavingUi = false;
function positionReasoningMenu() {
    const rect = reasoningButton.getBoundingClientRect(), width = Math.min(360, window.innerWidth - 24);
    reasoningMenu.style.width = `${width}px`; reasoningMenu.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`;
    reasoningMenu.style.maxHeight = `${Math.max(80, rect.top - 20)}px`;
    reasoningMenu.style.top = `${Math.max(12, rect.top - reasoningMenu.getBoundingClientRect().height - 8)}px`;
}
function paintReasoning() {
    const focusedLevel = reasoningMenu.contains(document.activeElement) ? document.activeElement.dataset.level : null;
    const snapshot = reasoningSnapshot;
    reasoningButton.hidden = !snapshot?.levels?.length;
    reasoningButton.disabled = reasoningLoading || reasoningSavingUi || Boolean(ui.status.busy);
    if (reasoningButton.hidden) { if (reasoningMenu.matches(":popover-open")) reasoningMenu.hidePopover(); return; }
    const supported = snapshot.levels.includes(snapshot.level);
    const prefix = document.createElement("span"); prefix.className = "chat-control-prefix"; prefix.textContent = "Réflexion · ";
    reasoningButton.querySelector(".chat-control-label").replaceChildren(prefix, document.createTextNode(supported ? reasoningLabels[snapshot.level]?.[0].toLowerCase() || snapshot.level : "à choisir"));
    reasoningButton.title = "Régler la réflexion du GPT · préférence du compte FranceStudent · un niveau élevé peut consommer davantage de quota";
    const choices = reasoningMenu.querySelector(".chat-access-choices"); choices.replaceChildren();
    for (const level of snapshot.levels) {
        const row = document.createElement("button"); row.type = "button"; row.dataset.level = level;
        row.setAttribute("role", "menuitemradio"); row.setAttribute("aria-checked", String(snapshot.level === level));
        row.classList.toggle("selected", snapshot.level === level); row.disabled = reasoningSavingUi || Boolean(ui.status.busy);
        row.innerHTML = '<span class="chat-access-copy"><strong></strong><small></small></span><span class="chat-access-check" aria-hidden="true"></span>';
        row.querySelector("strong").textContent = reasoningLabels[level]?.[0] || level;
        row.querySelector("small").textContent = reasoningLabels[level]?.[1] || "";
        row.querySelector(".chat-access-check").textContent = snapshot.level === level ? "✓" : "";
        row.onclick = () => saveChatReasoning(level); choices.append(row);
    }
    reasoningMenu.querySelector(".chat-access-error").textContent = supported ? "" : "Le réglage actuel du compte n’est pas compatible avec ce GPT ou n’est pas fourni. Choisis un niveau pour l’enregistrer.";
    if (focusedLevel && reasoningMenu.matches(":popover-open")) reasoningMenu.querySelector(`[data-level="${focusedLevel}"]`)?.focus();
}
async function loadChatReasoning() {
    if (!ui.status.booted || reasoningSavingUi) return;
    const serial = ++reasoningSerial; reasoningLoading = true; paintReasoning();
    try {
        const value = await api.reasoning();
        if (serial !== reasoningSerial || value.modelId !== ui.status.modelId) return;
        reasoningSnapshot = value;
    } catch (error) {
        if (serial === reasoningSerial) {
            reasoningSnapshot = null;
            if (reasoningMenu.matches(":popover-open")) studioFeedback(`Réflexion : ${error.message}`);
        }
    } finally {
        if (serial === reasoningSerial) { reasoningLoading = false; paintReasoning(); if (reasoningMenu.matches(":popover-open")) positionReasoningMenu(); }
    }
}
function updateChatReasoning(status) {
    const key = status.booted ? status.modelId : null;
    if (key !== reasoningModelKey) {
        reasoningModelKey = key; reasoningSerial++; reasoningSnapshot = null; reasoningLoading = false;
        if (reasoningMenu.matches(":popover-open")) reasoningMenu.hidePopover();
        if (key !== null) loadChatReasoning();
    }
    paintReasoning();
}
async function saveChatReasoning(level) {
    if (reasoningSavingUi || ui.status.busy || !reasoningSnapshot) return;
    reasoningSavingUi = true; reasoningSerial++; reasoningLoading = false; paintReasoning();
    try {
        const value = await api.reasoning("save", { modelId: reasoningSnapshot.modelId, level });
        if (value.modelId !== ui.status.modelId) return;
        reasoningSnapshot = value; reasoningMenu.hidePopover(); reasoningButton.focus();
        studioFeedback(`Réflexion ${reasoningLabels[level]?.[0].toLowerCase() || level} enregistrée sur ton compte FranceStudent.`);
    } catch (error) { reasoningMenu.querySelector(".chat-access-error").textContent = error.message; studioFeedback(error.message); }
    finally { reasoningSavingUi = false; const message = reasoningMenu.querySelector(".chat-access-error").textContent; paintReasoning(); reasoningMenu.querySelector(".chat-access-error").textContent = message; }
}
reasoningButton.onclick = () => {
    if (reasoningMenu.matches(":popover-open")) { reasoningMenu.hidePopover(); return; }
    hideModelMenu(); if (chatAccessMenu.matches(":popover-open")) chatAccessMenu.hidePopover();
    paintReasoning(); reasoningMenu.showPopover(); positionReasoningMenu();
    (reasoningMenu.querySelector('[aria-checked="true"]') || reasoningMenu.querySelector("button"))?.focus();
    loadChatReasoning();
};
reasoningMenu.addEventListener("toggle", () => reasoningButton.setAttribute("aria-expanded", String(reasoningMenu.matches(":popover-open"))));
reasoningMenu.addEventListener("keydown", event => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const rows = [...reasoningMenu.querySelectorAll("[data-level]")];
    if (!rows.length || !rows.includes(document.activeElement)) return;
    event.preventDefault(); const index = rows.indexOf(document.activeElement);
    rows[event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1 : (index + (event.key === "ArrowUp" ? rows.length - 1 : 1)) % rows.length].focus();
});
window.addEventListener("resize", () => { if (reasoningMenu.matches(":popover-open")) positionReasoningMenu(); });
updateChatReasoning(ui.status);
/* Project execution environment, independent of the terminal-only preference. */
const wslProjectCard = document.createElement("section");
wslProjectCard.className = "settings-card"; wslProjectCard.dataset.settingsGroup = "general";
wslProjectCard.setAttribute("aria-labelledby", "settings-wsl-project-title");
wslProjectCard.innerHTML = '<h3 id="settings-wsl-project-title">Environnement du projet · WSL</h3><p class="settings-help">WSL permet d’utiliser Linux dans Windows. Si tes outils sont déjà installés dans ta distribution, active ce mode pour les utiliser dans le terminal, les commandes de l’agent, les tâches, les serveurs du projet et les diagnostics. Aucune réinstallation automatique.</p><p id="wsl-project-name" class="settings-help"></p><label class="center-code-label">Exécuter ce projet avec<select id="wsl-project-mode"><option value="native">Windows · environnement habituel</option><option value="wsl">WSL · mes outils Linux</option></select></label><label id="wsl-project-distribution-label" class="center-code-label hidden">Distribution Linux<select id="wsl-project-distribution"><option value="">Distribution par défaut</option></select></label><div class="studio-actions"><button type="button" id="wsl-project-save" class="primary">Appliquer à ce projet</button><button type="button" id="wsl-project-check">Vérifier l’environnement</button><button type="button" id="wsl-project-refresh">Actualiser</button></div><p id="wsl-project-message" class="settings-help" role="status"></p><p class="settings-help">Arrête les tâches avant de changer d’environnement, puis ouvre un nouveau terminal. Le choix est conservé pour ce projet. L’interface, l’éditeur, le moteur Motion et les connecteurs natifs Windows restent sur Windows. Ce mode ne déplace pas tes fichiers et n’installe pas WSL.</p>';
terminalSettingsCard.after(wslProjectCard);
terminalSettingsCard.querySelector(":scope > p:last-child").textContent = "Ce choix de terminal seul ne change pas les commandes de l’agent. Pour utiliser aussi tes outils Linux dans les tâches du projet, active l’environnement WSL ci-dessous : il a priorité pour les nouveaux terminaux de ce projet. Les sessions ouvertes sont conservées.";
let wslProjectSnapshot = null, wslProjectKey = null, wslProjectSerial = 0, wslProjectSaving = false;
const wslProjectMode = $("wsl-project-mode"), wslProjectDistribution = $("wsl-project-distribution");
function wslProjectMessage(text) { $("wsl-project-message").textContent = text; }
function setWslProjectDisabled(disabled) { for (const control of wslProjectCard.querySelectorAll("button,select")) control.disabled = disabled; }
async function populateWslProjectDistributions(selected = "") {
    const serial = ++wslProjectSerial, wsl = wslProjectMode.value === "wsl";
    $("wsl-project-distribution-label").classList.toggle("hidden", !wsl);
    if (!wsl) return;
    wslProjectDistribution.disabled = true; $("wsl-project-save").disabled = true; $("wsl-project-check").disabled = true;
    try {
        const distributions = await api.terminalPreferences("distributions");
        if (serial !== wslProjectSerial || wslProjectMode.value !== "wsl") return;
        wslProjectDistribution.replaceChildren(new Option("Distribution par défaut", ""));
        for (const name of distributions) wslProjectDistribution.append(new Option(name, name));
        wslProjectDistribution.value = distributions.includes(selected) ? selected : "";
        if (!distributions.length) { wslProjectMessage("Aucune distribution installée. Installe et initialise WSL avant d’activer cette option."); return; }
        if (selected && !distributions.includes(selected)) wslProjectMessage(`La distribution ${selected} n’est plus disponible. Sélectionne sa remplaçante.`);
        wslProjectDistribution.disabled = false; $("wsl-project-save").disabled = false; $("wsl-project-check").disabled = false;
    } catch (error) { if (serial === wslProjectSerial) wslProjectMessage(error.message); }
}
async function loadWslProject() {
    const serial = ++wslProjectSerial; setWslProjectDisabled(true);
    try {
        const value = await api.projectEnvironment();
        if (serial !== wslProjectSerial) return;
        wslProjectSnapshot = value; $("wsl-project-name").textContent = value.workspace || "Ouvre un projet pour choisir son environnement.";
        wslProjectMode.value = value.mode; $("wsl-project-distribution-label").classList.toggle("hidden", value.mode !== "wsl");
        if (!value.available || !value.workspace) { wslProjectMessage("Cette option est réservée aux projets Code ouverts sur Windows."); return; }
        setWslProjectDisabled(false);
        wslProjectMessage(value.mode === "wsl" ? `Actif : WSL · ${value.distribution}. Les nouveaux terminaux utilisent ce choix.` : "Environnement Windows actif pour ce projet.");
        await populateWslProjectDistributions(value.distribution);
    } catch (error) { if (serial === wslProjectSerial) { wslProjectMessage(error.message); $("wsl-project-refresh").disabled = false; } }
}
function updateWslProject(status) {
    const key = `${status.workspace || ""}:${status.chatContextKey?.split(":")[0] || "false"}`;
    if (key === wslProjectKey) return;
    wslProjectKey = key; loadWslProject();
}
async function applyWslProject(action) {
    if (!wslProjectSnapshot?.workspace || wslProjectSaving) return;
    wslProjectSaving = true; setWslProjectDisabled(true); wslProjectMessage("Vérification du dossier et des outils dans la distribution…");
    const payload = { workspace: wslProjectSnapshot.workspace, mode: wslProjectMode.value, distribution: wslProjectDistribution.value };
    try {
        const value = await api.projectEnvironment(action, payload);
        if (value.workspace !== ui.workspace) return;
        if (action === "save") { await loadWslProject(); }
        const detected = value.detected;
        wslProjectMessage(detected ? `${action === "save" ? "WSL activé pour ce projet" : "Vérification réussie"} · ${detected.distribution}\nDossier Linux : ${detected.linuxRoot}\nNode : ${detected.node || "non trouvé dans Linux"} · npm : ${detected.npm || "non trouvé dans Linux"} · Git : ${detected.git || "non trouvé dans Linux"}\n${action === "save" ? "Ouvre un nouveau terminal (+)." : "Aucun réglage modifié."}` : action === "save" ? "Environnement Windows rétabli. Ouvre un nouveau terminal (+)." : "Environnement Windows sélectionné. Aucun réglage modifié.");
    } catch (error) { wslProjectMessage(error.message); }
    finally { wslProjectSaving = false; if (wslProjectSnapshot?.available && wslProjectSnapshot.workspace === ui.workspace) setWslProjectDisabled(false); }
}
wslProjectMode.onchange = () => { wslProjectMessage(""); $("wsl-project-save").disabled = false; $("wsl-project-check").disabled = false; populateWslProjectDistributions(); };
$("wsl-project-save").onclick = () => applyWslProject("save");
$("wsl-project-check").onclick = () => applyWslProject("check");
$("wsl-project-refresh").onclick = loadWslProject;
updateWslProject(ui.status);
/* Local file selection is performed by the native dialog, never by agent paths. */
for (const [kind, label] of [["file", "Importer un fichier"], ["directory", "Importer un dossier"]]) {
    const button = document.createElement("button"); button.type = "button";
    button.id = `btn-skill-import-${kind}`; button.textContent = label;
    button.title = kind === "file" ? "Importer un SKILL.md ou une archive ZIP téléchargée" : "Importer un dossier de skill avec ses scripts et références";
    $("btn-skill-new").before(button);
    button.onclick = async () => {
        button.disabled = true;
        try { const preview = await api.localSkillImport(kind); if (preview) openSkillEditor({ kind: "local", item: preview }); }
        catch (error) { $("center-message").textContent = error.message; }
        finally { button.disabled = false; }
    };
}
/* One compact chat header and secondary tools on demand, in Code and Motion. */
const chatNavigationActions = document.createElement("div");
chatNavigationActions.className = "chat-navigation-actions";
const chatNavigation = $("agent").querySelector(".agent-navigation");
chatNavigationActions.append(...document.querySelector("#agent .agent-actions").children, $("agent-focus"));
// Le sélecteur de projet reste visible même lorsque la barre de contexte est réduite.
const franceProjectScope = document.querySelector("#agent .chat-project-scope");
const franceProjectCreate = $("agent-fr-project-create");
if (franceProjectScope && franceProjectCreate) {
    const projectControls = document.createElement("div"); projectControls.className = "chat-project-controls";
    const franceProjectRefresh = $("agent-fr-project-refresh");
    projectControls.append(franceProjectScope, ...(franceProjectRefresh ? [franceProjectRefresh] : []), franceProjectCreate);
    // Phrase de confirmation sous les onglets : où vont les nouvelles discussions.
    const franceProjectState = document.createElement("div");
    franceProjectState.id = "agent-fr-project-state"; franceProjectState.className = "chat-project-state";
    franceProjectState.setAttribute("role", "status"); franceProjectState.setAttribute("aria-live", "polite");
    franceProjectState.textContent = "Chargement de vos projets…";
    chatNavigation.after(franceProjectState);
    const franceProjectChats = $("agent-fr-project-chats");
    if (franceProjectChats) projectControls.append(franceProjectChats);
    chatNavigationActions.prepend(projectControls);
}
chatNavigation.append(chatNavigationActions);
document.querySelector("#agent .agent-header").hidden = true;
document.querySelector("#agent .agent-context-bar").hidden = true;
const moreChatTools = document.createElement("button");
moreChatTools.type = "button"; moreChatTools.id = "chat-more-tools"; moreChatTools.className = "attach-btn";
moreChatTools.title = "Outils du chat"; moreChatTools.setAttribute("aria-label", "Outils du chat");
moreChatTools.setAttribute("aria-haspopup", "dialog"); moreChatTools.setAttribute("aria-expanded", "false");
moreChatTools.setAttribute("aria-controls", "chat-tools-menu");
moreChatTools.innerHTML = '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/></svg>';
$("btn-attach").after(moreChatTools);
const moreChatMenu = document.createElement("div");
moreChatMenu.id = "chat-tools-menu"; moreChatMenu.className = "chat-access-menu chat-tools-menu";
moreChatMenu.setAttribute("popover", "auto"); moreChatMenu.setAttribute("aria-label", "Outils du chat");
moreChatMenu.setAttribute("role", "dialog");
const moreChatHeading = document.createElement("div"); moreChatHeading.className = "chat-access-heading"; moreChatHeading.textContent = "Outils du chat";
moreChatMenu.append(moreChatHeading, document.querySelector(".composer-topline"));
const clearChatLabel = document.createElement("span"); clearChatLabel.textContent = "Effacer l’affichage";
$("btn-clear").append(clearChatLabel); moreChatMenu.querySelector(".composer-utilities").append($("btn-clear"));
const modeSetting = document.createElement("label"); modeSetting.className = "chat-mode-setting";
const modeLabel = document.createElement("span"); modeLabel.textContent = "Mode de conversation";
modeSetting.append(modeLabel, $("mode-select")); moreChatMenu.append(modeSetting);
document.body.append(moreChatMenu);
for (const [id, label] of [["favorite-open", "Prompts favoris"], ["draft-save-favorite", "Enregistrer le brouillon en favori"], ["conversation-export", "Exporter la conversation"]]) {
    const text = document.createElement("span"); text.textContent = label; $(id).append(text);
}
function positionMoreChatMenu() {
    const rect = moreChatTools.getBoundingClientRect(), width = Math.min(320, window.innerWidth - 24);
    moreChatMenu.style.width = `${width}px`; moreChatMenu.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`;
    moreChatMenu.style.maxHeight = `${Math.max(80, rect.top - 20)}px`;
    moreChatMenu.style.top = `${Math.max(12, rect.top - moreChatMenu.getBoundingClientRect().height - 8)}px`;
}
moreChatTools.onclick = () => {
    if (moreChatMenu.matches(":popover-open")) { moreChatMenu.hidePopover(); return; }
    hideModelMenu(); moreChatMenu.showPopover(); positionMoreChatMenu(); moreChatMenu.querySelector("button:not(:disabled)")?.focus();
};
moreChatMenu.addEventListener("toggle", () => moreChatTools.setAttribute("aria-expanded", String(moreChatMenu.matches(":popover-open"))));
moreChatMenu.addEventListener("click", event => { if (event.target.closest("button") && moreChatMenu.matches(":popover-open")) moreChatMenu.hidePopover(); });
window.addEventListener("resize", () => { if (moreChatMenu.matches(":popover-open")) positionMoreChatMenu(); });
// Escape always provides a direct way back to the project, after closing menus.
window.addEventListener("keydown", event => {
    if (event.key !== "Escape" || !$("app").classList.contains("focus-agent") || document.querySelector("dialog[open], :popover-open")) return;
    if (ui.status.busy || !$("slash-menu").classList.contains("hidden")) return;
    api.windowFullscreen("status").then(active => {
        if (active) return api.windowFullscreen("exit");
    }).catch(error => studioFeedback(error.message));
});
/* One plan surface, updated in place; transcript events remain in history/export. */
function workPlanItems(items) {
    return (Array.isArray(items) ? items : []).map(item => {
        const value = String(item || "").trim();
        const completed = /^(?:✓|✔|\[[xX]\])\s*/.test(value);
        const current = /^(?:◉|●|\[~\])\s*/.test(value);
        return { step: value.replace(/^(?:✓|✔|◉|●|○|\[[xX ~]?\])\s*/, ""), status: completed ? "completed" : current ? "in_progress" : "pending" };
    });
}
function renderWorkPlan(items, { status = "idle" } = {}) {
    const host = $("agent-live-plan"); if (!host) return;
    const steps = (Array.isArray(items) ? items : []).filter(step => step && typeof step.step === "string" && step.step.trim()).map(step => ({
        step: step.step.trim(), status: ["completed", "in_progress"].includes(step.status) ? step.status : "pending"
    }));
    const signature = JSON.stringify({ steps, status });
    if (host.dataset.signature === signature) return;
    host.dataset.signature = signature;
    if (!steps.length) { host.replaceChildren(); host.classList.add("hidden"); return; }
    const previous = host.querySelector("details"), wasFocused = previous?.querySelector("summary") === document.activeElement;
    const previousScroll = host.querySelector("ol")?.scrollTop || 0;
    const detail = document.createElement("details"); detail.open = previous ? previous.open : status !== "history";
    const done = steps.filter(step => step.status === "completed").length;
    const complete = done === steps.length;
    const label = complete ? "Terminé" : status === "interrupted" ? "Interrompu" : ["done", "failed"].includes(status) ? "À poursuivre" : status === "history" ? "Historique" : "En cours";
    host.dataset.state = complete ? "completed" : status;
    const summary = document.createElement("summary");
    const heading = document.createElement("span"); heading.className = "work-plan-heading";
    const title = document.createElement("strong"); title.textContent = "Plan de travail";
    const count = document.createElement("span"); count.className = "work-plan-count"; count.textContent = `${done}/${steps.length}`;
    const state = document.createElement("span"); state.className = "work-plan-state"; state.textContent = label;
    const chevron = document.createElement("span"); chevron.className = "work-plan-chevron";
    chevron.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m8 10 4 4 4-4"/></svg>';
    heading.append(title, count, state, chevron);
    const progress = document.createElement("progress"); progress.max = steps.length; progress.value = done;
    progress.setAttribute("aria-label", `${done} étape${done > 1 ? "s" : ""} terminée${done > 1 ? "s" : ""} sur ${steps.length}`);
    summary.append(heading, progress);
    const list = document.createElement("ol"); list.className = "work-plan-steps";
    steps.forEach((step, index) => {
        const row = document.createElement("li"); row.dataset.status = step.status;
        if (step.status === "in_progress") row.setAttribute("aria-current", "step");
        const marker = document.createElement("span"); marker.className = "work-plan-marker"; marker.setAttribute("aria-hidden", "true");
        if (step.status === "completed") marker.innerHTML = '<svg viewBox="0 0 24 24"><path d="m6 12 4 4 8-8"/></svg>';
        else marker.textContent = String(index + 1);
        const text = document.createElement("span"); text.className = "work-plan-step-text"; text.textContent = step.step;
        const accessibleStatus = document.createElement("span"); accessibleStatus.className = "work-plan-sr-status";
        accessibleStatus.textContent = step.status === "completed" ? "Terminée : " : step.status === "in_progress" ? "En cours : " : "À venir : ";
        row.append(marker, accessibleStatus, text); list.append(row);
    });
    detail.append(summary, list); host.replaceChildren(detail); host.classList.remove("hidden");
    list.scrollTop = previousScroll;
    if (wasFocused) summary.focus();
}
/* A ZIP is inventoried locally before any model request or upload. */
function chooseZipFiles(attachment){
    return api.zipPreview(attachment).then(entries=>new Promise(resolve=>{
        const previous=document.activeElement,dialog=document.createElement("dialog");
        dialog.id="zip-selection-dialog";dialog.className="fs-dialog zip-selection-dialog";
        studioSurfaceHeader(dialog,{title:"Choisis les fichiers du ZIP",subtitle:attachment.name,icon:"tools"});
        const note=centerNode("p","fs-dialog-note","Inventaire réalisé sur ton ordinateur, sans requête IA. Seuls les fichiers cochés seront accessibles à l’agent. Tu pourras lui demander de lire leur contenu complet.");
        const search=document.createElement("input");search.type="search";search.placeholder="Rechercher un fichier ou un dossier…";search.setAttribute("aria-label","Rechercher dans le ZIP");
        const toolbar=centerNode("div","zip-selection-toolbar"),all=centerNode("button","","Tout sélectionner"),none=centerNode("button","","Tout décocher"),count=centerNode("span","","");
        const list=centerNode("div","zip-selection-list"),more=centerNode("button","","Afficher davantage");
        const footer=centerNode("div","fs-dialog-footer"),cancel=centerNode("button","","Annuler"),accept=centerNode("button","primary","Joindre la sélection");
        const selected=new Set();let limit=200,accepted=false;
        function update(){
            const bytes=entries.reduce((sum,entry)=>sum+(selected.has(entry.name)?entry.size:0),0);
            count.textContent=`${selected.size} / ${entries.length} fichiers · ${formatBytes(bytes)}`;accept.disabled=!selected.size;
        }
        function render(){
            list.replaceChildren();const query=search.value.toLocaleLowerCase(),matching=entries.filter(entry=>entry.name.toLocaleLowerCase().includes(query));
            for(const entry of matching.slice(0,limit)){
                const row=document.createElement("label"),checkbox=document.createElement("input"),name=centerNode("span","zip-selection-name",entry.name),size=centerNode("span","",formatBytes(entry.size));
                checkbox.type="checkbox";checkbox.checked=selected.has(entry.name);checkbox.disabled=Boolean(entry.error);
                checkbox.onchange=()=>{if(checkbox.checked)selected.add(entry.name);else selected.delete(entry.name);update();};
                row.title=entry.error||entry.name;if(entry.error)size.textContent=entry.error;
                row.append(checkbox,name,size);list.append(row);
            }
            if(!matching.length)list.append(centerNode("p","fs-dialog-note","Aucun fichier correspondant."));
            more.hidden=matching.length<=limit;update();
        }
        search.oninput=()=>{limit=200;render();};all.onclick=()=>{for(const entry of entries)if(!entry.error)selected.add(entry.name);render();};none.onclick=()=>{selected.clear();render();};
        more.onclick=()=>{limit+=200;render();};cancel.onclick=()=>dialog.close();accept.onclick=()=>{accepted=true;dialog.close();};
        toolbar.append(all,none,count);footer.append(cancel,accept);dialog.append(note,search,toolbar,list,more,footer);document.body.append(dialog);
        dialog.addEventListener("close",()=>{
            dialog.remove();resolve(accepted?{...attachment,selectedPaths:[...selected]}:null);
            requestAnimationFrame(()=>{if(previous?.isConnected)previous.focus();});
        },{once:true});render();dialog.showModal();search.focus();
    }));
}
/* ---------- IDE Link bêta ---------- */
const chatIdeLinkButton = document.createElement("button");
chatIdeLinkButton.type = "button";
chatIdeLinkButton.id = "chat-ide-link-button";
chatIdeLinkButton.setAttribute("aria-haspopup", "dialog");
chatIdeLinkButton.setAttribute("aria-expanded", "false");
chatIdeLinkButton.setAttribute("aria-controls", "chat-ide-link-menu");
chatControlContent(chatIdeLinkButton, '<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>', "IDE Link");
chatAccessButton.after(chatIdeLinkButton);
const chatIdeLinkMenu = document.createElement("div");
chatIdeLinkMenu.id = "chat-ide-link-menu";
chatIdeLinkMenu.className = "chat-access-menu chat-ide-link-menu";
chatIdeLinkMenu.setAttribute("popover", "auto");
chatIdeLinkMenu.setAttribute("role", "dialog");
chatIdeLinkMenu.setAttribute("aria-labelledby", "chat-ide-link-title");
chatIdeLinkMenu.innerHTML = `<div class="ide-link-heading"><div><div class="chat-access-heading" id="chat-ide-link-title">IDE Link <span class="ide-link-badge">Bêta</span></div><p class="ide-link-subtitle">Retrouve ton agent sur mobile</p></div><button type="button" id="ide-link-close" aria-label="Fermer">×</button></div>
<details class="ide-link-intro" id="ide-link-instructions" open><summary>Comment connecter mon iPhone</summary><ol class="ide-link-steps"><li>Active la connexion sur cet ordinateur.</li><li>Dans l’app FranceStudent, ouvre <strong>France IDE → Scanner le QR code</strong>.</li><li>Envoie tes consignes et suis ton agent depuis ton téléphone.</li></ol><p class="settings-help">Garde l’ordinateur allumé et connecté à Internet. Le QR code donne accès à la conversation et aux actions de l’agent.</p></details>
<section class="ide-link-remember-section"><label class="ide-link-persistent-choice"><input type="checkbox" id="ide-link-remember"><span>Mémoriser cet iPhone pour ce projet</span></label><p class="settings-help">Retrouve ce projet après redémarrage, sans domaine ni serveur à gérer.</p><details class="ide-link-privacy"><summary>Confidentialité et reconnexion</summary><p class="settings-help">La découverte utilise des annonces chiffrées sur le service public ntfy.sh ; les conversations et clés d’accès ne lui sont pas envoyées. Ce service externe peut être indisponible. La mémorisation autorise aussi l’accès aux prochaines conversations de ce projet.</p></details><p id="ide-link-discovery" class="settings-help" role="status"></p></section>
<div id="ide-link-details" hidden><div id="ide-link-pairing"><img id="ide-link-qr" width="256" height="256" alt="QR code privé pour associer un téléphone"><p id="ide-link-expiry" class="settings-help"></p><details><summary>Connexion manuelle avec un PIN</summary><label for="ide-link-address">Adresse de connexion</label><input id="ide-link-address" type="text" readonly><button type="button" id="ide-link-copy">Copier l’adresse</button><label>Code PIN à usage unique</label><div id="ide-link-pin" class="ide-link-pin" aria-live="polite"></div></details></div><p id="ide-link-device" class="settings-help" hidden></p><button type="button" id="ide-link-renew">Nouveau QR code</button></div>
<details class="ide-link-configuration"><summary>Options avancées · adresse fixe</summary><fieldset id="ide-link-config-fields"><label class="ide-link-persistent-choice"><input type="checkbox" id="ide-link-persistent"><span>Utiliser mon propre domaine pour une adresse fixe</span></label><p id="ide-link-saved-address" class="settings-help" hidden></p><div id="ide-link-fixed-settings" hidden><p class="settings-help">Une adresse fixe demande un domaine et un tunnel Cloudflare. L’adresse est conservée après redémarrage. Sans iPhone mémorisé pour ce projet, active IDE Link et scanne à nouveau.</p><details><summary>Créer mon adresse fixe, étape par étape</summary><ol class="ide-link-steps"><li>Crée un compte Cloudflare et ajoute ton domaine.</li><li>Dans <strong>Networking → Tunnels</strong>, crée un tunnel pour cet ordinateur.</li><li>Ajoute une application publiée, par exemple <strong>ide.ton-domaine.fr</strong>, vers le service HTTP <strong id="ide-link-local-target">127.0.0.1:43821</strong>.</li><li>Copie uniquement le jeton de connexion du tunnel dans le champ ci-dessous. L’IDE lance lui-même cloudflared.</li></ol><button type="button" id="ide-link-setup-guide">Ouvrir le guide officiel Cloudflare</button></details><label for="ide-link-fixed-address">Adresse HTTPS fixe</label><input id="ide-link-fixed-address" type="url" placeholder="https://ide.ton-domaine.fr" autocomplete="off" spellcheck="false"><label for="ide-link-tunnel-token">Jeton du tunnel Cloudflare</label><input id="ide-link-tunnel-token" type="password" autocomplete="new-password" spellcheck="false" placeholder="Colle le jeton ici, jamais dans le chat"><p class="settings-help">Le jeton est protégé par le coffre système. Il n’est jamais inclus dans le QR code.</p><details><summary>Port local du service</summary><label for="ide-link-fixed-port">Même port que dans Cloudflare</label><input id="ide-link-fixed-port" type="number" min="1024" max="65535" value="43821"></details></div><div class="ide-link-config-actions"><button type="button" id="ide-link-save-config">Enregistrer le choix</button><button type="button" id="ide-link-forget-config" hidden>Effacer la configuration</button></div></fieldset></details>
<p id="ide-link-status" class="settings-help" role="status">Désactivé.</p>
<div class="ide-link-actions"><button type="button" id="ide-link-start">Activer IDE Link</button><button type="button" id="ide-link-stop" disabled>Arrêter IDE Link</button></div>`;
document.body.append(chatIdeLinkMenu);
chatIdeLinkMenu.querySelector(".ide-link-configuration").addEventListener("toggle", () => { if (chatIdeLinkMenu.matches(":popover-open")) positionChatIdeLink(); });
let ideLinkConfigurationLoaded = false, ideLinkConfigurationDirty = false;
let ideLinkLastError = "", ideLinkIntroState = "";
function positionChatIdeLink() {
    const rect = chatIdeLinkButton.getBoundingClientRect();
    const width = Math.min(370, window.innerWidth - 24);
    chatIdeLinkMenu.style.width = `${width}px`;
    chatIdeLinkMenu.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`;
    chatIdeLinkMenu.style.maxHeight = `${Math.max(80, rect.top - 20)}px`;
    chatIdeLinkMenu.style.overflowY = "auto";
    chatIdeLinkMenu.style.top = `${Math.max(12, rect.top - chatIdeLinkMenu.getBoundingClientRect().height - 8)}px`;
}
chatIdeLinkButton.onclick = () => {
    if (chatIdeLinkMenu.matches(":popover-open")) { chatIdeLinkMenu.hidePopover(); return; }
    chatIdeLinkMenu.showPopover(); positionChatIdeLink(); refreshIdeLink();
};
chatIdeLinkMenu.addEventListener("toggle", () => chatIdeLinkButton.setAttribute("aria-expanded", String(chatIdeLinkMenu.matches(":popover-open"))));
window.addEventListener("resize", () => { if (chatIdeLinkMenu.matches(":popover-open")) positionChatIdeLink(); });
async function refreshIdeLink() {
    try {
        const info = await api.ideLink("status");
        if (ideLinkIntroState !== info.state) { $("ide-link-instructions").open = info.state === "stopped"; ideLinkIntroState = info.state; }
        $("ide-link-remember").checked = info.remembering?.enabled === true;
        $("ide-link-remember").disabled = !info.remembering?.available || info.state === "starting";
        $("ide-link-discovery").textContent = info.remembered ? ["error", "limited"].includes(info.discoveryState) ? "Téléphone mémorisé. La découverte est momentanément indisponible ; la connexion actuelle reste utilisable." : "Téléphone mémorisé. Suspendre coupe la connexion ; décocher cette option ou réassocier un appareil révoque l’association." : info.remembering?.paired ? "Téléphone mémorisé, connexion suspendue. Active IDE Link pour reprendre sans scanner. Décocher cette option retire l’association." : info.remembering?.enabled ? "Le prochain scan dans l’app iPhone à jour sera mémorisé." : !info.remembering?.available ? "La mémorisation nécessite un projet Code et le coffre système." : "Option désactivée : l’association reste temporaire.";
        const config = info.configuration;
        $("ide-link-config-fields").disabled = info.state !== "stopped";
        if (config && !ideLinkConfigurationLoaded && !ideLinkConfigurationDirty) {
            $("ide-link-persistent").checked = config.mode === "fixed";
            $("ide-link-fixed-address").value = config.origin || "";
            $("ide-link-fixed-port").value = config.port || 43821;
            $("ide-link-tunnel-token").value = "";
            $("ide-link-tunnel-token").placeholder = config.hasToken ? "Jeton déjà protégé · laisser vide pour le conserver" : "Colle uniquement le jeton du tunnel";
            $("ide-link-fixed-settings").hidden = config.mode !== "fixed";
            $("ide-link-saved-address").hidden = config.mode !== "fixed";
            $("ide-link-saved-address").textContent = config.mode === "fixed" ? `Adresse conservée : ${config.origin}` : "";
            $("ide-link-forget-config").hidden = !config.hasToken;
            $("ide-link-local-target").textContent = `127.0.0.1:${config.port || 43821}`;
            ideLinkConfigurationLoaded = true;
        }
        $("ide-link-fixed-settings").hidden = info.state !== "stopped" || !$("ide-link-persistent").checked;
        chatIdeLinkMenu.querySelector(".ide-link-config-actions").hidden = info.state !== "stopped";
        $("ide-link-start").disabled = info.state !== "stopped";
        $("ide-link-stop").disabled = info.state === "stopped";
        $("ide-link-stop").textContent = info.remembered ? "Suspendre IDE Link" : "Arrêter IDE Link";
        $("ide-link-details").hidden = info.state !== "running";
        $("ide-link-status").textContent = info.state === "running" ? info.device ? info.remembered ? "Appareil mémorisé pour ce projet." : "Appareil associé. Arrêter IDE Link révoque son accès." : info.pin ? "Prêt à associer ton téléphone." : "Association expirée ou bloquée. Génère un nouveau QR code." : info.state === "starting" ? "Préparation de la connexion…" : ideLinkLastError || "Désactivé.";
        $("ide-link-pairing").hidden = Boolean(info.device);
        $("ide-link-device").hidden = !info.device;
        $("ide-link-device").textContent = info.device ? `${info.device.name} · associé à ${new Date(info.device.connectedAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}` : "";
        $("ide-link-renew").textContent = info.device ? "Révoquer et associer un autre appareil" : "Nouveau QR code";
        $("ide-link-expiry").textContent = info.pin ? `Association unique · expire à ${new Date(info.pinExpires || Date.now() + 600000).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}` : "QR code expiré ou déjà utilisé.";
        $("ide-link-qr").hidden = !info.qr;
        $("ide-link-qr").src = info.qr || "";
        $("ide-link-address").value = info.address || "";
        const pinBox = $("ide-link-pin"); pinBox.replaceChildren();
        if (info.pin) {
            pinBox.setAttribute("aria-label", `Code PIN ${info.pin.split("").join(" ")}`);
            for (const digit of info.pin) { const cell = document.createElement("span"); cell.textContent = digit; cell.setAttribute("aria-hidden", "true"); pinBox.append(cell); }
        } else { pinBox.removeAttribute("aria-label"); pinBox.textContent = "Code utilisé, expiré ou bloqué."; }
        if (chatIdeLinkMenu.matches(":popover-open")) positionChatIdeLink();
    } catch (error) { $("ide-link-status").textContent = error.message; }
}
$("ide-link-close").onclick = () => chatIdeLinkMenu.hidePopover();
setInterval(() => { if (chatIdeLinkMenu.matches(":popover-open")) refreshIdeLink(); }, 30000);
$("ide-link-start").onclick = async () => {
    const rememberNotice = $("ide-link-remember").checked ? " En mémorisant cet iPhone, tu autorises la reprise automatique sur ce projet et ses prochaines conversations lors des ouvertures suivantes de l’IDE. La découverte utilise des annonces chiffrées sur ntfy.sh." : "";
    if (!await confirmStudioAction("Ton téléphone pourra voir la conversation actuelle, y compris les messages précédents, lancer des tâches et répondre aux questions et confirmations avec les autorisations actuelles de l’agent. Toute personne possédant le lien d’association du QR code, ou l’adresse et le PIN, peut associer son appareil. Le code expire après dix minutes et une seule association. Activer IDE Link ?" + rememberNotice, { title: "Connecter mon téléphone", confirmLabel: "Activer", danger: true })) return;
    if (!chatIdeLinkMenu.matches(":popover-open")) { chatIdeLinkMenu.showPopover(); positionChatIdeLink(); }
    $("ide-link-start").disabled = true;
    ideLinkLastError = "";
    try { if (ideLinkConfigurationDirty) await saveIdeLinkConfiguration(); await api.ideLink("start"); } catch (error) { ideLinkLastError = error.message; $("ide-link-status").textContent = error.message; $("ide-link-start").disabled = false; return; }
    await refreshIdeLink();
};
$("ide-link-stop").onclick = async () => { try { await api.ideLink("stop"); await refreshIdeLink(); } catch (error) { $("ide-link-status").textContent = error.message; } };
$("ide-link-renew").onclick = async () => { try { await api.ideLink("renew"); await refreshIdeLink(); } catch (error) { $("ide-link-status").textContent = error.message; } };
$("ide-link-copy").onclick = async () => { try { await navigator.clipboard.writeText($("ide-link-address").value); $("ide-link-status").textContent = "Adresse de connexion copiée. Ne la partage qu’avec une personne de confiance."; } catch { $("ide-link-address").select(); $("ide-link-status").textContent = "Sélectionne et copie l’adresse manuellement."; } };
api.onEvent(channel => { if (channel === "ideLink") refreshIdeLink(); });
refreshIdeLink();
function dirtyIdeLinkConfiguration() { ideLinkConfigurationDirty = true; ideLinkLastError = ""; }
$("ide-link-persistent").onchange = () => { $("ide-link-fixed-settings").hidden = !$("ide-link-persistent").checked; dirtyIdeLinkConfiguration(); positionChatIdeLink(); };
for (const id of ["ide-link-fixed-address", "ide-link-tunnel-token", "ide-link-fixed-port"]) $(id).addEventListener("input", dirtyIdeLinkConfiguration);
$("ide-link-fixed-port").addEventListener("input", () => { $("ide-link-local-target").textContent = `127.0.0.1:${$("ide-link-fixed-port").value}`; });
async function saveIdeLinkConfiguration() {
    await api.ideLink("configure", { mode: $("ide-link-persistent").checked ? "fixed" : "temporary", origin: $("ide-link-fixed-address").value, port: Number($("ide-link-fixed-port").value), token: $("ide-link-tunnel-token").value });
    $("ide-link-tunnel-token").value = ""; ideLinkConfigurationDirty = false; ideLinkConfigurationLoaded = false;
    ideLinkLastError = "";
}
$("ide-link-save-config").onclick = async () => { try { await saveIdeLinkConfiguration(); await refreshIdeLink(); $("ide-link-status").textContent = "Choix enregistré. Active IDE Link pour ouvrir la connexion."; } catch (error) { $("ide-link-status").textContent = error.message; } };
$("ide-link-forget-config").onclick = async () => { try { await api.ideLink("forget"); ideLinkConfigurationDirty = false; ideLinkConfigurationLoaded = false; await refreshIdeLink(); } catch (error) { $("ide-link-status").textContent = error.message; } };
$("ide-link-setup-guide").onclick = () => api.openExternal("https://developers.cloudflare.com/tunnel/get-started/", true).catch(error => { $("ide-link-status").textContent = error.message; });
$("ide-link-remember").onchange = async () => {
    const field = $("ide-link-remember"); field.disabled = true;
    try { await api.ideLink("remember", { enabled: field.checked }); await refreshIdeLink(); }
    catch (error) { await refreshIdeLink(); $("ide-link-status").textContent = error.message; }
};
/* Tool choice belongs to the next Code task; permissions remain independent. */
const chatToolSelections = new Map();
let chatToolCatalog = [], chatToolContext = "", chatToolMotion = false;
const chatToolPresets = { code: ["files", "terminal", "skills"], explore: ["web", "skills"], minimal: [] };
const chatToolButton = document.createElement("button");
chatToolButton.type = "button"; chatToolButton.id = "chat-tool-selection";
chatToolButton.setAttribute("aria-haspopup", "dialog"); chatToolButton.setAttribute("aria-expanded", "false");
chatToolButton.setAttribute("aria-controls", "chat-tool-selection-menu");
chatControlContent(chatToolButton, '<path d="m14 5 5 5M5 19l9-9M16 3a5 5 0 0 0-6 6l-7 7a2 2 0 0 0 3 3l7-7a5 5 0 0 0 6-6l-3 3-3-3 3-3Z"/>', "Outils · Complet");
composerModelRow.insertBefore(chatToolButton, dictationButton);
const chatToolMenu = document.createElement("div");
chatToolMenu.id = "chat-tool-selection-menu"; chatToolMenu.className = "chat-access-menu chat-tool-selection-menu";
chatToolMenu.setAttribute("popover", "auto"); chatToolMenu.setAttribute("role", "dialog");
chatToolMenu.setAttribute("aria-labelledby", "chat-tool-selection-title");
chatToolMenu.innerHTML = '<header><div><h2 id="chat-tool-selection-title">Outils de l’agent</h2><p>Choisis ce qui est utile à la prochaine demande</p></div><button type="button" class="chat-tool-close" aria-label="Fermer">×</button></header><div class="chat-tool-presets" role="group" aria-label="Préréglages des outils"><button type="button" data-tool-preset="minimal">Essentiel</button><button type="button" data-tool-preset="code">Coder</button><button type="button" data-tool-preset="explore">Explorer</button><button type="button" data-tool-preset="all">Complet</button></div><label class="chat-tool-search-label">Rechercher un outil<input type="search" class="chat-tool-search" placeholder="Fichiers, web, MCP…"></label><p class="chat-tool-count" role="status"></p><div class="chat-tool-options"></div><p class="chat-tool-note">Lecture locale, pièces jointes, plan et questions restent disponibles. Les groupes choisis limitent le catalogue envoyé ; les permissions restent indépendantes. Un terminal ou un service MCP peut modifier des fichiers.</p><p class="chat-tool-feedback" role="status"></p>';
document.body.append(chatToolMenu);
function chatToolOptions() {
    if (isMotionOpen() || ui.status.motionDesign) return {};
    return { toolGroups: chatToolSelections.has(chatToolContext) ? [...chatToolSelections.get(chatToolContext)] : null };
}
function refreshChatToolChoice() {
    const selected = chatToolSelections.get(chatToolContext);
    const preset = selected === undefined ? "Complet" : selected.length === chatToolCatalog.length ? "Complet" : Object.entries(chatToolPresets).find(([, ids]) => ids.length === selected.length && ids.every(id => selected.includes(id)))?.[0];
    const label = preset === "code" ? "Coder" : preset === "explore" ? "Explorer" : preset === "minimal" ? "Essentiel" : preset || `${selected.length} groupes`;
    chatToolButton.querySelector(".chat-control-label").textContent = `Outils · ${label}`;
    chatToolButton.title = "Choisir les outils de la prochaine demande à l’agent";
    chatToolMenu.querySelector('.chat-tool-count').textContent=`${selected===undefined?chatToolCatalog.length:selected.length} / ${chatToolCatalog.length} groupes activés · pour le prochain envoi`;
    for (const input of chatToolMenu.querySelectorAll('input[type="checkbox"]')) input.checked = selected === undefined || selected.includes(input.value);
    for (const button of chatToolMenu.querySelectorAll("[data-tool-preset]")) {
        const id = button.dataset.toolPreset, ids = chatToolPresets[id];
        button.setAttribute("aria-pressed", String(id === "all" ? selected === undefined || selected.length === chatToolCatalog.length : selected !== undefined && ids.length === selected.length && ids.every(value => selected.includes(value))));
    }
}
function positionChatToolChoice() {
    const rect = chatToolButton.getBoundingClientRect(), width = Math.min(400, window.innerWidth - 24);
    chatToolMenu.style.width = `${width}px`;
    chatToolMenu.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`;
    chatToolMenu.style.maxHeight = `${Math.max(80, rect.top - 20)}px`;
    chatToolMenu.style.top = `${Math.max(12, rect.top - chatToolMenu.getBoundingClientRect().height - 8)}px`;
}
function updateChatToolSelection(status) {
    chatToolContext = status.workspace || "";
    chatToolMotion = Boolean(status.motionDesign) || isMotionOpen();
    chatToolButton.hidden = chatToolMotion;
    chatToolButton.hidden = chatToolMotion || status.mode==='chat';
    chatToolButton.disabled = !status.booted || !chatToolContext || !chatToolCatalog.length;
    if (chatToolMotion && chatToolMenu.matches(":popover-open")) chatToolMenu.hidePopover();
    refreshChatToolChoice();
}
chatToolButton.onclick = () => {
    if (chatToolMenu.matches(":popover-open")) { chatToolMenu.hidePopover(); return; }
    hideModelMenu(); chatToolMenu.showPopover(); positionChatToolChoice(); chatToolMenu.querySelector("input")?.focus();
};
chatToolMenu.querySelector(".chat-tool-close").onclick = () => { chatToolMenu.hidePopover(); chatToolButton.focus(); };
for (const button of chatToolMenu.querySelectorAll("[data-tool-preset]")) button.onclick = () => {
    if (button.dataset.toolPreset === "all") chatToolSelections.delete(chatToolContext);
    else chatToolSelections.set(chatToolContext, [...chatToolPresets[button.dataset.toolPreset]]);
    refreshChatToolChoice(); chatToolMenu.querySelector(".chat-tool-feedback").textContent = "Choix prêt pour la prochaine demande. La tâche en cours garde ses outils.";
};
chatToolMenu.addEventListener("toggle", () => chatToolButton.setAttribute("aria-expanded", String(chatToolMenu.matches(":popover-open"))));
chatToolMenu.querySelector('.chat-tool-search').oninput=event=>{const query=event.target.value.toLocaleLowerCase('fr');for(const row of chatToolMenu.querySelectorAll('.chat-tool-options > label'))row.hidden=!row.textContent.toLocaleLowerCase('fr').includes(query);};
window.addEventListener("resize", () => { if (chatToolMenu.matches(":popover-open")) positionChatToolChoice(); });
api.agentTools().then(({ groups }) => {
    chatToolCatalog = groups;
    for (const group of groups) {
        const row = document.createElement("label"), input = document.createElement("input"), copy = document.createElement("span");
        input.type = "checkbox"; input.value = group.id;
        const name = document.createElement("strong"), description = document.createElement("small"); name.textContent = group.label; description.textContent = group.description;
        copy.append(name, description); row.append(input, copy); chatToolMenu.querySelector(".chat-tool-options").append(row);
        input.onchange = () => { chatToolSelections.set(chatToolContext, [...chatToolMenu.querySelectorAll("input:checked")].map(field => field.value)); refreshChatToolChoice(); chatToolMenu.querySelector(".chat-tool-feedback").textContent = "Choix prêt pour la prochaine demande."; };
    }
    updateChatToolSelection(ui.status);
}).catch(error => { chatToolButton.disabled = true; chatToolButton.title = error.message; });
updateChatToolSelection(ui.status);
new MutationObserver(() => updateChatToolSelection(ui.status)).observe($("app"), { attributes: true, attributeFilter: ["class"] });
/* Disposition « Codex » : en plein écran du chat, une barre latérale
   Nouveau chat / Rechercher / Récents réutilise l'historique existant
   (api.conversationsRecent + renderHistoryRow). Aucun ID existant n'est modifié. */
const codexRail = document.createElement("nav");
codexRail.id = "codex-rail";
codexRail.className = "codex-rail";
codexRail.setAttribute("aria-label", "Conversations");
codexRail.innerHTML = `
    <div class="codex-rail-brand"><button type="button" id="codex-mode-toggle" aria-haspopup="menu" aria-expanded="false">FranceStudent Code <svg class="codex-mode-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg></button><button type="button" id="codex-rail-brand-search" title="Rechercher une conversation" aria-label="Rechercher une conversation">⌕</button></div>
    <button type="button" id="codex-rail-new" class="codex-rail-item"><svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg><span>Nouveau chat</span></button>
    <button type="button" id="codex-rail-search" class="codex-rail-item"><svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="m21 21-4.3-4.3M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14Z"/></svg><span>Rechercher</span></button>
    <button type="button" id="codex-rail-changes" class="codex-rail-item"><svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3v12M18 9v12M6 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM18 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z"/></svg><span>Fichiers et modifications</span></button>
    <details class="codex-rail-tools-menu"><summary>Outils</summary>
    <div class="codex-rail-tools" role="group" aria-label="Outils de l'IDE">
        <button type="button" class="codex-rail-item" data-rail-tool="explorer"><span>Explorateur</span></button>
 <button type="button" class="codex-rail-item" data-rail-tool="search"><span>Recherche dans le projet</span></button>
 <button type="button" class="codex-rail-item" data-rail-tool="worktrees"><span>Tâches parallèles</span></button>
        <button type="button" class="codex-rail-item" data-rail-tool="project"><span>Cockpit du projet</span></button>
        <button type="button" class="codex-rail-item" data-rail-tool="extensions"><span>Extensions</span></button>
        <button type="button" class="codex-rail-item" data-rail-tool="motion"><span>Motion design</span></button>
 <button type="button" class="codex-rail-item" data-rail-tool="terminal"><span>Terminal</span></button>
        <button type="button" class="codex-rail-item" data-rail-tool="palette"><span>Palette de commandes</span></button>
        <button type="button" class="codex-rail-item" data-rail-tool="settings"><span>Paramètres</span></button>
        <button type="button" class="codex-rail-item" data-rail-tool="help"><span>Connexion et aide</span></button>
    </div></details>
    <div class="codex-rail-section codex-projects-heading"><button type="button" id="codex-rail-add-project" title="Créer un nouveau projet" aria-label="Créer un nouveau projet">+</button><span>Projets</span></div>
    <div id="codex-rail-projects" class="codex-rail-projects"></div>
    <div class="codex-rail-section"><span>Récents</span><button type="button" id="codex-rail-refresh" title="Actualiser les conversations" aria-label="Actualiser les conversations">↻</button></div>
    <div id="codex-rail-list" class="codex-rail-list" role="list"></div>`;
$("agent").prepend(codexRail);
// Poignée indépendante de l’explorateur ; la préférence reste locale à cette fenêtre.
const codexRailResize = document.createElement("div");
codexRailResize.className = "codex-rail-resize"; codexRailResize.tabIndex = 0;
codexRailResize.setAttribute("role", "separator"); codexRailResize.setAttribute("aria-orientation", "vertical");
codexRailResize.setAttribute("aria-label", "Largeur de la barre des conversations");
$("agent").append(codexRailResize);
let codexRailWidth = 260;
try { codexRailWidth = Number(localStorage.getItem("frst.codexRailWidth")) || 260; } catch { /* stockage facultatif */ }
function setCodexRailWidth(value, save = false) {
    const max = Math.max(180, Math.min(480, innerWidth - 420));
    codexRailWidth = Math.max(180, Math.min(max, Math.round(value)));
    $("app").style.setProperty("--codex-rail-width", `${codexRailWidth}px`);
    codexRailResize.setAttribute("aria-valuemin", "180"); codexRailResize.setAttribute("aria-valuemax", String(max)); codexRailResize.setAttribute("aria-valuenow", String(codexRailWidth));
    if (save) try { localStorage.setItem("frst.codexRailWidth", String(codexRailWidth)); } catch { /* stockage facultatif */ }
}
setCodexRailWidth(codexRailWidth);
codexRailResize.addEventListener("pointerdown", event => {
    if (event.button !== 0 || !codexRailResize.checkVisibility()) return;
    event.preventDefault(); const start = event.clientX, initial = codexRailWidth;
    codexRailResize.setPointerCapture(event.pointerId); document.body.classList.add("resizing-x");
    const move = e => { if (!codexRailResize.checkVisibility()) { end(); return; } setCodexRailWidth(initial + e.clientX - start); };
    const end = () => { codexRailResize.removeEventListener("pointermove", move); codexRailResize.removeEventListener("pointerup", end); codexRailResize.removeEventListener("pointercancel", end); codexRailResize.removeEventListener("lostpointercapture", end); if(codexRailResize.hasPointerCapture(event.pointerId))codexRailResize.releasePointerCapture(event.pointerId); document.body.classList.remove("resizing-x"); setCodexRailWidth(codexRailWidth, true); };
    codexRailResize.addEventListener("pointermove", move); codexRailResize.addEventListener("pointerup", end); codexRailResize.addEventListener("pointercancel", end); codexRailResize.addEventListener("lostpointercapture", end);
});
codexRailResize.addEventListener("keydown", event => {
    if (!codexRailResize.checkVisibility() || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault(); setCodexRailWidth(event.key === "Home" ? 180 : event.key === "End" ? 480 : codexRailWidth + (event.key === "ArrowRight" ? 10 : -10), true);
});
window.addEventListener("resize", () => setCodexRailWidth(codexRailWidth));

$("workspace-new-chat").onclick = () => $("codex-rail-new").click();
$("workspace-search").onclick = () => $("codex-rail-search").click();
$("workspace-changes").onclick = () => {
    setAgentFocus(true);
    setBrowserHomeOpen(true);
    browserHomeShow("changes");
};
const workspaceTitlebarProject = $("workspace-titlebar-project");
const syncWorkspaceTitlebarProject = () => {
    const source = $("agent-project-name");
    workspaceTitlebarProject.textContent = source.textContent;
    workspaceTitlebarProject.title = source.title;
};
new MutationObserver(syncWorkspaceTitlebarProject).observe($("agent-project-name"), { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ["title"] });
syncWorkspaceTitlebarProject();

let codexRailRenderSequence = 0;
async function newProjectDiscussion(project, remote=false) {
    if(ui.status.busy || ui.replayingConversation)return studioFeedback("Attends la fin de la demande ou du chargement.");
    try {
        if(remote){const selected=await api.frProjects("select",{id:project.id});franceStudentProjects=selected.projects||franceStudentProjects;renderFranceStudentProjects(selected.selected);}
        else {
            if(ui.tabs.some(tab=>tab.dirty)&&!await confirmStudioAction("Des fichiers ne sont pas enregistrés. Changer de projet quand même ?"))return;
            const workspace=await api.openProject(project.path);if(!workspace) return;
            if(workspace!==ui.workspace){ui.workspace=workspace;onWorkspaceChanged();}
        }
        const result=await api.submit("/new",[],{});if(result?.error)throw Error(result.error);
        browserHomeClosePage();setAgentTab("conversation");
        studioFeedback(`Nouvelle discussion dans « ${project.name || project.path.split(/[\\/]/).pop()} ».`);
        await renderCodexRail();input.focus();
    } catch(error){studioFeedback(error.message);}
}
function projectDiscussionButton(project,remote=false){
    const button=centerNode("button","codex-project-new","+");button.type="button";
    button.title=`Nouvelle discussion dans ${project.name || project.path.split(/[\\/]/).pop()}`;button.setAttribute("aria-label",button.title);
    button.onclick=event=>{event.preventDefault();event.stopPropagation();void newProjectDiscussion(project,remote);};return button;
}
const codexClosedProjects = new Set();
let codexRailMode = null;
async function renderCodexRail() {
    const list = $("codex-rail-list");
    if (!list || !$("app").classList.contains("focus-agent")) return;
    const sequence = ++codexRailRenderSequence;
    if (typeof api === "undefined" || typeof api.conversationsRecent !== "function") {
        list.innerHTML = '<div class="codex-rail-empty">Historique indisponible.</div>';
        return;
    }
    const mode = ui.status.mode === "chat" ? "chat" : "agent";
    if (codexRailMode !== mode) { list.replaceChildren(); $("codex-rail-projects").replaceChildren(); codexRailMode = mode; }
    if (!list.childNodes.length) list.innerHTML = '<div class="codex-rail-empty">Chargement…</div>';
    try {
        if (ui.status.mode === "chat") {
            const projectArea = document.createElement("div");
            try {
                const data = await refreshFranceStudentProjects();
                if (sequence !== codexRailRenderSequence) return;
                for (const project of data.projects || []) {
                    const row = centerNode("button", "codex-remote-chat", `📁  ${project.name || "Projet sans nom"}`);
                    row.type = "button";
                    row.onclick = async () => {
                        try {
                            const selected = await api.frProjects("select", { id: project.id });
                            franceStudentProjects = selected.projects || franceStudentProjects;
                            renderFranceStudentProjects(selected.selected);
                            await openFranceStudentProjectChats(true);
                        } catch (error) { studioFeedback(error.message); }
                    };
                    const group=centerNode("div","codex-remote-project");group.append(row,projectDiscussionButton(project,true));projectArea.append(group);
                }
            } catch (error) { projectArea.append(centerNode("div", "codex-rail-empty", `Projets indisponibles : ${error.message}`)); }
            if (sequence !== codexRailRenderSequence) return;
            $("codex-rail-projects").replaceChildren(...projectArea.childNodes);
            if (!ui.models) { const models = await api.models().catch(() => null); if (models && !ui.models) ui.models = models; }
            if (sequence !== codexRailRenderSequence) return;
            const seen = new Set(); let cursor = "", target = document.createElement("div"), initial = true;
            const more = centerNode("button", "codex-remote-chat", "Charger davantage"); more.type = "button";
            const load = async () => {
                more.disabled = true;
                try {
                    const page = await api.remoteChats(cursor);
                    if (sequence !== codexRailRenderSequence) return;
                    more.remove();
                    for (const chat of [...page.chats].sort ( (a, b) => Number(b.pinned) - Number(a.pinned))) {
                        if (seen.has(chat.id)) continue; seen.add(chat.id);
                        const button = centerNode("button", "codex-remote-chat");
                        const logo = historyModelLogo(chat.model); if (logo) button.append(logo);
                        button.append(centerNode("span", "codex-remote-title", chat.title));
                        button.type = "button"; button.title = chat.title;
                        button.onclick = async () => {
                            if (ui.status.busy) { studioFeedback("Attends la fin de la demande."); return; }
                            try { afterConversationOpened(await api.conversationsOpen(chat.id, { mode: "chat" })); setAgentTab("conversation"); }
                            catch (error) { studioFeedback(error.message); }
                        };
                        const row = centerNode("div", "codex-remote-row");
                        const actions = document.createElement("details"); actions.className = "codex-remote-actions";
                        const summary = centerNode("summary", "", "⋯"); summary.setAttribute("aria-label", `Options de ${chat.title}`); const popup = centerNode("div", "codex-remote-popup"); actions.append(summary, popup);
                        for (const [action, label] of [["rename", "Renommer"], [chat.pinned ? "unpin" : "pin", chat.pinned ? "Désépingler" : "Épingler"], ["delete", "Supprimer"]]) {
                            const control = centerNode("button", "", label); control.type = "button";
                            control.onclick = async () => {
                                actions.open = false;
                                let title = "";
                                if (action === "rename") { title = window.prompt("Nouveau nom de la discussion :", chat.title); if (title === null || !title.trim()) return; }
                                if (action === "delete" && !await confirmStudioAction(`Supprimer la discussion « ${chat.title} » du compte FranceStudent ?`, { title: "Supprimer la discussion", confirmLabel: "Supprimer", danger: true })) return;
                                control.disabled = true;
                                try { await api.remoteChatAction(action, chat.id, title); await renderCodexRail(); }
                                catch (error) { studioFeedback(error.message); control.disabled = false; }
                            };
                            popup.append(control);
                        }
                        if (chat.pinned) button.prepend(centerNode("span", "", "📌"));
                        row.append(button, actions); target.append(row);
                    }
                    if (page.hasMore && page.cursor && page.cursor !== cursor) { cursor = page.cursor; target.append(more); }
                    else if (!seen.size) target.append(centerNode("div", "codex-rail-empty", "Aucune discussion FranceStudent."));
                    if (initial) { list.replaceChildren(...target.childNodes); target = list; initial = false; }
                } catch (error) {
                    if (sequence === codexRailRenderSequence) { more.remove(); studioFeedback(`Historique indisponible : ${error.message}`); if (initial && !list.querySelector(".codex-remote-row")) list.replaceChildren(centerNode("div", "codex-rail-empty", "Historique indisponible.")); }
                } finally { more.disabled = false; }
            };
            more.onclick = load; await load(); return;
        }
        const [items, models, local] = await Promise.all([api.conversationsRecent(200), ui.models ? Promise.resolve(ui.models) : api.models().catch(() => null), api.localProjects("list")]);
        if (models && !ui.models) ui.models = models;
        if (sequence !== codexRailRenderSequence) return;
        const projectKey = value => String(value || "").replace(/\\/g, "/").replace(/\/+$/, "").toLocaleLowerCase();
        const hidden = new Set((local.hidden || []).map(projectKey));
        const shown = (Array.isArray(items) ? items : []).filter(item => !item.motionDesign && item.mode !== "chat" && !hidden.has(projectKey(item.workspace)));
        const projects = $("codex-rail-projects");
        projects.replaceChildren();
        const grouped = new Map();
        for (const project of local.projects || []) grouped.set(project.path, []);
        for (const item of shown) {
            if (!item.workspace) continue;
            if (!grouped.has(item.workspace)) grouped.set(item.workspace, []);
            grouped.get(item.workspace).push(item);
        }
        for (const [workspace, conversations] of grouped) {
            const group = document.createElement("details");
            group.open = !codexClosedProjects.has(workspace);
            group.addEventListener("toggle", () => {
                if (group.open) codexClosedProjects.delete(workspace);
                else codexClosedProjects.add(workspace);
            });
            const heading = document.createElement("summary");
            const projectName = centerNode("span", "codex-project-name", workspace.replace(/[\\/]+$/, "").split(/[\\/]/).pop());
            const options = centerNode("button", "codex-project-options", "⋯"); options.type = "button"; options.title = "Options du projet"; options.setAttribute("aria-label", "Options du projet");
            options.onclick = event => { event.preventDefault(); event.stopPropagation(); showProjectInfo(workspace, conversations.length, options); };
            heading.append(fileIcon(workspace, "directory", true), projectName, projectDiscussionButton({path:workspace,name:projectName.textContent}), options);
            heading.title = workspace;
            api.projectSources("get", { root: workspace }).then(info => { if (projectName.isConnected) projectName.textContent = info.name; }).catch(() => {});
            group.append(heading);
            if (!conversations.length) {
                const open = centerNode("button", "codex-project-empty", "Ouvrir le projet"); open.type = "button";
                open.onclick = async () => {
                    if (ui.status.busy) return studioFeedback("Attends la fin de la demande.");
                    if (ui.tabs.some(tab => tab.dirty) && !await confirmStudioAction("Des fichiers ne sont pas enregistrés. Changer de projet quand même ?")) return;
                    try { const workspace = await api.openProject(workspacePath); if (workspace && workspace !== ui.workspace) { ui.workspace = workspace; onWorkspaceChanged(); } }
                    catch (error) { studioFeedback(error.message); }
                };
                const workspacePath = workspace;
                group.append(open);
            }
            for (const item of conversations) {
                const row = renderHistoryRow(item);
                const logo = historyModelLogo(item.model);
                const icon = logo || document.createElement("span");
                if (!logo) icon.className = "codex-conversation-icon";
                if (!logo) icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h4M9 12h6M9 16h6"/></svg>';
                icon.setAttribute("aria-hidden", "true");
                row.prepend(icon);
                group.append(row);
            }
            projects.append(group);
        }
        const nextRows = document.createDocumentFragment();
        if (!shown.length) { list.innerHTML = '<div class="codex-rail-empty">Aucune conversation enregistrée.</div>'; return; }
        for (const item of shown.slice(0, 30)) {
            const row = renderHistoryRow(item);
            const logo = historyModelLogo(item.model); if (logo) row.prepend(logo);
            row.setAttribute("role", "listitem");
            const open = row.querySelector(".history-open");
            if (open) open.addEventListener("click", () => setTimeout(renderCodexRail, 400));
            nextRows.appendChild(row);
        }
        list.replaceChildren(nextRows);
    } catch (err) {
        if (sequence !== codexRailRenderSequence) return;
        studioFeedback(`Historique indisponible : ${err.message}`);
    }
}

$("codex-rail-new").onclick = () => { $("btn-new").click(); setTimeout(renderCodexRail, 400); $("input").focus(); };
$("codex-rail-add-project").onclick = async () => {
    if (ui.status.busy) return studioFeedback("Attends la fin de la demande.");
    try { if (ui.status.mode === "chat") { await createFranceStudentProject(); await renderCodexRail(); } else await showNewLocalProject(); }
    catch (error) { studioFeedback(error.message); }
};
$("codex-rail-search").onclick = () => toggleHistoryMenu();
$("codex-rail-brand-search").onclick = () => toggleHistoryMenu($("codex-rail-brand-search"));
$("codex-rail-changes").onclick = () => { setBrowserHomeOpen(true); browserHomeShow("changes"); };
$("codex-rail-refresh").onclick = () => renderCodexRail();
window.addEventListener("frst-conversations-changed", () => renderCodexRail());
// Outils de l'IDE (remplacent la barre d'activité supprimée) : chaque bouton réutilise une fonction existante.
const codexRailTools = {
    explorer: () => showSideView("explorer"),
    search: () => showSideView("search"),
    worktrees: () => showSideView("worktrees"),
    project: () => showSideView("project"),
    extensions: () => showSideView("extensions"),
    settings: () => showSideView("settings"),
    motion: () => { if (typeof motionNav !== "undefined") motionNav.click(); },
    terminal: () => { setBrowserHomeOpen(true); browserHomeShow("terminal"); },
    palette: () => openPalette("files"),
    help: () => openConnectionGuide(),
};
for (const button of codexRail.querySelectorAll("[data-rail-tool]")) {
    const run = codexRailTools[button.dataset.railTool];
    if (run) button.onclick = run;
}
for (const button of document.querySelectorAll("[data-settings-agent-view]")) {
    button.onclick = () => {
        browserHomeClosePage();
        setAgentFocus(true);
        setAgentTab(button.dataset.settingsAgentView);
    };
}
// Colonne d'actions accessible depuis le chat.
const codexActivity = document.createElement("nav");
codexActivity.id = "codex-activity";
codexActivity.setAttribute("aria-label", "Navigation principale");
const codexActivityItems = [
    ["chat", "Conversations", '<path d="m3 11 9-8 9 8M5 10v10h5v-6h4v6h5V10"/>', () => { browserHomeClosePage(); setAgentFocus(true); }],
    ["motion", "Motion design · EffectCraft (Bêta)", '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m10 9 5 3-5 3z"/>', () => motionNav.click()],
    ["plugins", "Plugins", '<circle cx="12" cy="12" r="8"/><path d="M9 9h6v6H9zM12 4v2m0 12v2M4 12h2m12 0h2"/>', () => { setCenterTab("mcp"); showSideView("extensions"); }],
    ["project", "Projet", '<rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/>', () => { setBrowserHomeOpen(true); browserHomeShow("projects", { page: true }); }],
    ["settings", "Paramètres", '<circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.5-2.3 1a7 7 0 0 0-1.7-1L14.5 3h-5L9 6a7 7 0 0 0-1.7 1L5 6 3 9.5 5.1 11a7 7 0 0 0 0 2L3 14.5 5 18l2.3-1a7 7 0 0 0 1.7 1l.5 3h5l.5-3a7 7 0 0 0 1.7-1l2.3 1 2-3.5-2.1-1.5a7 7 0 0 0 .1-1Z"/>', () => showSideView("settings")],
];
for (const [key, label, icon, action] of codexActivityItems) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.action = key;
    button.title = label;
    button.setAttribute("aria-label", label);
    button.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icon}</svg>`;
    button.onclick = action;
    codexActivity.append(button);
}
$("agent").prepend(codexActivity);

function toggleCodexRail() {
    const collapsed = $("app").classList.toggle("codex-rail-collapsed");
    $("workspace-toggle-rail").setAttribute("aria-expanded", String(!collapsed));
}
$("workspace-toggle-rail").onclick = toggleCodexRail;
$("workspace-back").onclick = () => $("local-browser-back").click();
$("workspace-forward").onclick = () => $("local-browser-forward").click();
$("workspace-back").disabled = true;
$("workspace-forward").disabled = true;
window.addEventListener("frst-local-browser-state", event => {
    $("workspace-back").disabled = !event.detail.canGoBack;
    $("workspace-forward").disabled = !event.detail.canGoForward;
});
$("workspace-menu-new").onclick = () => $("codex-rail-new").click();
$("workspace-menu-files").onclick = () => showSideView("explorer");
$("workspace-menu-search").onclick = () => showSideView("search");
$("workspace-menu-toggle").onclick = toggleCodexRail;
$("workspace-menu-terminal").onclick = () => { setBrowserHomeOpen(true); browserHomeShow("terminal"); };
$("workspace-menu-help").onclick = () => openConnectionGuide();
for (const button of document.querySelectorAll(".workspace-menu details button")) {
    button.addEventListener("click", () => { button.closest("details").open = false; });
}

// Ne recharge l'historique qu'au passage en plein écran (les classes view-* changent souvent).
let codexRailWasFocused = false;
new MutationObserver(() => {
    const focused = $("app").classList.contains("focus-agent");
    if (focused && !codexRailWasFocused) renderCodexRail();
    codexRailWasFocused = focused;
}).observe($("app"), { attributes: true, attributeFilter: ["class"] });
// Le chat est déjà actif au démarrage ; charger aussi son historique initial.
setAgentFocus(true);
renderCodexRail();

document.addEventListener("click", event => {
    if (!event.target.closest(".codex-remote-actions")) document.querySelectorAll(".codex-remote-actions[open]").forEach(menu => { menu.open = false; });
});
// Panneau « Nouvel onglet » à droite du chat plein écran : onglet, barre d'adresse, Outils, Suggestions.
// Les adresses HTTP(S) s'ouvrent dans le navigateur intégré du panneau.
const BROWSER_HOME_KEY = "fs.browserHome.open";
const browserHomeSuggestions = [
    { title: "FranceStudent Code", detail: "github.com", url: "https://github.com/SrxKirito/FranceStudent-Code", icon: "github" },
    { title: "francestudents-ide", detail: "github.com", url: "https://github.com/extraopaa/francestudents-ide", icon: "github" },
    { title: "SideStore Docs", detail: "docs.sidestore.io", url: "https://docs.sidestore.io", icon: "globe" },
];
const browserHomeIcons = {
    github: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 19c-4 1.5-4-2-6-2.5"/><path d="M15 21v-3.5a3 3 0 0 0-.9-2.3c3-.3 6-1.5 6-6.5a5 5 0 0 0-1.4-3.5 4.7 4.7 0 0 0-.1-3.5s-1.1-.3-3.6 1.4a12.4 12.4 0 0 0-6.5 0C6 1.4 4.9 1.7 4.9 1.7a4.7 4.7 0 0 0-.1 3.5A5 5 0 0 0 3.4 8.7c0 5 3 6.2 6 6.5a3 3 0 0 0-.9 2.3V21"/></svg>',
    globe: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18"/><path d="M12 3a14 14 0 0 0 0 18"/></svg>',
    changes: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="9" r="2"/><path d="M6 8v8"/><path d="M18 11a6 6 0 0 1-6 6H8"/></svg>',
    terminal: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3"/><path d="M12 15h5"/></svg>',
    files: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5a2 2 0 0 1 2-2h5l2 3h5a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/></svg>',
    back: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>',
    forward: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>',
    reload: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>',
    external: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
    close: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12"/><path d="M18 6L6 18"/></svg>',
    plus: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14"/><path d="M5 12h14"/></svg>',
    panel: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/></svg>',
};

function browserHomeButton(icon, label, onClick, className = "browser-home-icon-btn") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.title = label;
    button.setAttribute("aria-label", label);
    button.innerHTML = browserHomeIcons[icon];
    if (onClick) button.onclick = onClick; else button.disabled = true;
    return button;
}

function browserHomeResolve(raw) {
    const text = String(raw || "").trim();
    if (!text) return null;
    let url;
    if (/^[a-z][\w+.-]*:\/\//i.test(text)) url = text;
    else if (/^(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(text)) url = `http://${text}`;
    else if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/.test(text)) url = `https://${text}`;
    else url = `https://www.google.com/search?q=${encodeURIComponent(text)}`;
    try {
        const parsed = new URL(url);
 return /^https?:$/.test(parsed.protocol) ? parsed : null;
    } catch { return null; }
}

function browserHomeOpenExternal(url) {
    Promise.resolve(api.openExternal(url, true)).catch((error) => studioFeedback(`Impossible d'ouvrir ${url} : ${error?.message || error}`));
}

function browserHomeNavigate(raw) {
    const parsed = browserHomeResolve(raw);
    if (!parsed) { studioFeedback("Adresse invalide : seules les adresses http(s) sont acceptées."); return; }
    browserHomeShow("browser");
    Promise.resolve(openLocalBrowser(parsed.href)).catch((error) => studioFeedback(error?.message || String(error)));
}

function setBrowserHomeOpen(open) {
    $("app").classList.toggle("browser-home-open", open);
    localStorage.setItem(BROWSER_HOME_KEY, open ? "1" : "0");
    const toggle = $("browser-home-toggle");
    if (toggle) toggle.setAttribute("aria-pressed", String(open));
}

const browserHome = document.createElement("aside");
browserHome.id = "browser-home";
browserHome.setAttribute("aria-label", "Nouvel onglet");

const browserHomeTabs = document.createElement("div");
browserHomeTabs.className = "browser-home-tabs";
browserHomeTabs.setAttribute("role", "tablist");
const browserHomeTabItems = [];
let browserHomeActiveTab = null;
const browserHomeNewTabButton = browserHomeButton("plus", "Nouvel onglet", () => browserHomeAddTab());
browserHomeTabs.append(browserHomeNewTabButton);

function browserHomeActivateTab(tab) {
    if (browserHomeActiveTab === tab) return;
    if (browserHomeActiveTab) {
        browserHomeActiveTab.view = browserHomeCurrent;
        browserHomeActiveTab.address = browserHomeCurrent === "browser" ? (localBrowserState?.url || browserHomeAddress.value) : browserHomeAddress.value;
    }
    browserHomeActiveTab = tab;
    for (const item of browserHomeTabItems) {
        const active = item === tab;
        item.element.classList.toggle("active", active);
        item.select.setAttribute("aria-selected", String(active));
        item.select.tabIndex = active ? 0 : -1;
    }
    browserHomeAddress.value = tab.address;
    browserHomeShow(tab.view);
    if (tab.view === "browser" && tab.address) openLocalBrowser(tab.address);
}

function browserHomeAddTab() {
    const tab = { view: "home", address: "" };
    const element = document.createElement("div");
    element.className = "browser-home-tab";
    const select = document.createElement("button");
    select.type = "button";
    select.className = "browser-home-tab-title";
    select.setAttribute("role", "tab");
    select.textContent = "Nouvel onglet";
    select.onclick = () => browserHomeActivateTab(tab);
    const close = browserHomeButton("close", "Fermer l’onglet", () => {
        const index = browserHomeTabItems.indexOf(tab);
        const wasActive = tab === browserHomeActiveTab;
        browserHomeTabItems.splice(index, 1);
        element.remove();
        if (!browserHomeTabItems.length) {
            browserHomeActiveTab = null;
            browserHomeShow("home");
            setBrowserHomeOpen(false);
            browserHomeAddTab();
        } else if (wasActive) {
            browserHomeActiveTab = null;
            browserHomeActivateTab(browserHomeTabItems[Math.min(index, browserHomeTabItems.length - 1)]);
        }
    }, "browser-home-tab-close");
    tab.element = element;
    tab.select = select;
    element.append(select, close);
    browserHomeTabItems.push(tab);
    browserHomeTabs.insertBefore(element, browserHomeNewTabButton);
    browserHomeActivateTab(tab);
    browserHomeAddress.focus();
}

const browserHomeToolbar = document.createElement("form");
browserHomeToolbar.className = "browser-home-toolbar";
const browserHomeAddress = document.createElement("input");
browserHomeAddress.id = "browser-home-address";
browserHomeAddress.type = "text";
browserHomeAddress.autocomplete = "off";
browserHomeAddress.spellcheck = false;
browserHomeAddress.placeholder = "Rechercher ou saisir une URL";
browserHomeAddress.setAttribute("aria-label", "Rechercher ou saisir une URL");
const browserHomeBack = browserHomeButton("back", "Page précédente", () => $("local-browser-back").click());
const browserHomeForward = browserHomeButton("forward", "Page suivante", () => $("local-browser-forward").click());
const browserHomeReload = browserHomeButton("reload", "Actualiser", () => $("local-browser-reload").click());
browserHomeBack.disabled = true;
browserHomeForward.disabled = true;
browserHomeToolbar.append(
    browserHomeBack,
    browserHomeForward,
    browserHomeReload,
    browserHomeAddress,
    browserHomeButton("external", "Ouvrir dans le navigateur système", () => { const url = browserHomeResolve(browserHomeAddress.value || "https://www.google.com"); if (url) browserHomeOpenExternal(url.href); }),
);
browserHomeToolbar.onsubmit = (event) => { event.preventDefault(); const value = browserHomeAddress.value; browserHomeAddress.blur(); browserHomeNavigate(value); };
window.addEventListener("frst-local-browser-state", (event) => {
    if (browserHomeCurrent !== "browser") return;
    const state = event.detail;
    if (document.activeElement !== browserHomeAddress) browserHomeAddress.value = state.url || "";
    if (browserHomeActiveTab) browserHomeActiveTab.address = state.url || "";
    browserHomeBack.disabled = !state.canGoBack;
    browserHomeForward.disabled = !state.canGoForward;
});

const browserHomeBody = document.createElement("div");
browserHomeBody.className = "browser-home-body";

const browserHomeTools = [
    // Les trois outils s'affichent dans ce panneau (voir 64-browser-panels.js) sans quitter le plein écran du chat.
    { icon: "changes", label: "Modifications", keys: "Ctrl+Shift+G", run: () => browserHomeShow("changes") },
    { icon: "terminal", label: "Terminal", keys: "Ctrl+`", run: () => browserHomeShow("terminal") },
    { icon: "files", label: "Fichiers", keys: "Ctrl+P", run: () => browserHomeShow("files") },
];
const browserHomeToolsSection = document.createElement("section");
browserHomeToolsSection.className = "browser-home-section";
browserHomeToolsSection.append(centerNode("h2", "browser-home-heading", "Outils"));
const browserHomeToolsList = document.createElement("div");
browserHomeToolsList.className = "browser-home-tools";
for (const tool of browserHomeTools) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "browser-home-tool";
    button.innerHTML = browserHomeIcons[tool.icon];
    button.append(centerNode("span", "browser-home-tool-label", tool.label), centerNode("kbd", "browser-home-kbd", tool.keys));
    button.onclick = tool.run;
    browserHomeToolsList.append(button);
}
browserHomeToolsSection.append(browserHomeToolsList);

const browserHomeSuggestSection = document.createElement("section");
browserHomeSuggestSection.className = "browser-home-section";
browserHomeSuggestSection.append(centerNode("h2", "browser-home-heading", "Suggestions"));
const browserHomeSuggestList = document.createElement("div");
browserHomeSuggestList.className = "browser-home-suggestions";
for (const item of browserHomeSuggestions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "browser-home-suggestion";
    button.title = item.url;
    const icon = document.createElement("span");
    icon.className = "browser-home-suggestion-icon";
    icon.innerHTML = browserHomeIcons[item.icon];
    button.append(icon, centerNode("span", "browser-home-suggestion-title", item.title), centerNode("span", "browser-home-suggestion-detail", item.detail));
    button.onclick = () => browserHomeNavigate(item.url);
    browserHomeSuggestList.append(button);
}
browserHomeSuggestSection.append(browserHomeSuggestList);

browserHomeBody.append(browserHomeToolsSection, browserHomeSuggestSection);
browserHome.append(browserHomeTabs, browserHomeToolbar, browserHomeBody);
$("agent").append(browserHome);

const browserHomeResize = document.createElement("div");
browserHomeResize.className = "browser-home-resize";
browserHomeResize.setAttribute("role", "separator");
browserHomeResize.setAttribute("aria-label", "Redimensionner le panneau droit");
browserHomeResize.setAttribute("aria-orientation", "vertical");
browserHomeResize.tabIndex = 0;
function browserHomeSetWidth(width) {
    const max = Math.max(180, Math.min(900, $("agent").clientWidth - 52));
    const value = Math.max(180, Math.min(max, width));
    $("app").style.setProperty("--browser-home-width", `${value}px`);
    browserHomeResize.setAttribute("aria-valuenow", String(Math.round(value)));
    browserHomeResize.setAttribute("aria-valuemin", "180");
    browserHomeResize.setAttribute("aria-valuemax", String(Math.round(max)));
}
browserHomeResize.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    browserHomeResize.setPointerCapture(event.pointerId);
});
browserHomeResize.addEventListener("pointermove", (event) => {
    if (browserHomeResize.hasPointerCapture(event.pointerId)) browserHomeSetWidth(browserHome.getBoundingClientRect().right - event.clientX);
});
browserHomeResize.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    browserHomeSetWidth(browserHome.getBoundingClientRect().width + (event.key === "ArrowLeft" ? 20 : -20));
});
browserHome.prepend(browserHomeResize);

const browserHomeActions = document.querySelector("#agent .chat-navigation-actions");
if (browserHomeActions) {
    const toggle = browserHomeButton("panel", "Afficher ou masquer le panneau Nouvel onglet", () => setBrowserHomeOpen(!$("app").classList.contains("browser-home-open")), "browser-home-toggle");
    toggle.id = "browser-home-toggle";
    browserHomeActions.append(toggle);
}
setBrowserHomeOpen(localStorage.getItem(BROWSER_HOME_KEY) !== "0");
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
/* Pages de navigation et présentation des réglages. */
if (api.platform === "win32") document.documentElement.classList.add("windows-material");
const settingsLayout = document.createElement("div");
settingsLayout.className = "settings-layout";
const settingsLayoutNav = document.createElement("aside");
settingsLayoutNav.className = "settings-layout-nav";
const settingsLayoutMain = document.createElement("div");
settingsLayoutMain.className = "settings-layout-main";
settingsLayoutNav.append(centerNode("h2", "", "Paramètres"), settingsNavigation);
settingsLayoutMain.append(centerNode("h1", "", settingsGroups.find(group=>group[0]===settingsCategory)?.[1] || "Paramètres"));
for (const child of [...$("settings-view").children]) {
    if (!child.classList.contains("sidebar-header")) settingsLayoutMain.append(child);
}
settingsLayout.append(settingsLayoutNav, settingsLayoutMain);
$("settings-view").append(settingsLayout);

browserHomeViewTitles.projects = "Projets";
browserHomeViews.projects = () => {
    const page = centerNode("div", "projects-page");
    const header = centerNode("div", "projects-heading");
    const search = document.createElement("input");
    search.type = "search"; search.placeholder = "Rechercher des projets"; search.setAttribute("aria-label", "Rechercher des projets");
    const open = centerButton("+ Nouveau projet", () => showNewLocalProject());
    header.append(centerNode("h1", "", "Projets"), search, open);
    const list = centerNode("div", "projects-list", "Chargement…");
    page.append(header, list); browserHomeViewBody.append(page);
    let projectListSequence = 0;
    const render = async () => {
        const sequence = ++projectListSequence;
        try {
            const [local, accountResult] = await Promise.all([api.localProjects("list"), api.frProjects("list").catch(error => ({ error: error.message, projects: [] }))]);
            if (!page.isConnected || sequence !== projectListSequence) return;
            const paths = new Map();
            for (const project of local.projects || []) paths.set(project.path, 0);
            list.replaceChildren();
            const query = search.value.toLocaleLowerCase("fr");
            for (const project of accountResult.projects || []) {
                if (!String(project.name || "").toLocaleLowerCase("fr").includes(query)) continue;
                const row = centerNode("div", "projects-row");
                const button = centerButton(`☁  ${project.name || "Projet sans nom"}`, async () => {
                    try {
                        if (isMotionOpen()) await closeMotionDesign();
                        if (isMotionOpen()) return;
                        if (ui.status.mode !== "chat") afterConversationOpened(await api.switchChatMode("chat"));
                        const selected = await api.frProjects("select", { id: project.id });
                        franceStudentProjects = selected.projects || franceStudentProjects;
                        renderFranceStudentProjects(selected.selected);
                        browserHomeClosePage(); setAgentFocus(true); setAgentTab("conversation");
                        await openFranceStudentProjectChats(true);
                    } catch (error) { studioFeedback(error.message); }
                });
                button.classList.add("projects-open");
                row.append(button, centerNode("span", "projects-path", "Projet FranceStudent")); list.append(row);
            }
            if (accountResult.error) list.append(centerNode("p", "settings-help", `Projets FranceStudent indisponibles : ${accountResult.error}`));
            for (const path of paths.keys()) {
                let info; try { info = await api.projectSources("get", { root: path }); } catch { info = { name: path.replace(/[\\/]+$/, "").split(/[\\/]/).pop(), sources: [] }; }
                if (!page.isConnected || sequence !== projectListSequence) return;
                if (!`${path} ${info.name}`.toLocaleLowerCase("fr").includes(query)) continue;
                const row = centerNode("div", "projects-row");
                const name = info.name;
                const button = centerButton(`📁  ${name}`, async () => {
                    if (path !== ui.workspace) {
                        if (ui.tabs.some(t => t.dirty) && !await confirmStudioAction("Des fichiers ne sont pas enregistrés. Changer de projet quand même ?")) return;
                        try { const ws = await api.openProject(path); if (!ws) return; if (ws !== ui.workspace) { ui.workspace = ws; onWorkspaceChanged(); } }
                        catch (error) { studioFeedback(error.message); return; }
                    }
                    browserHomeShowSideView("project");
                });
                button.classList.add("projects-open"); button.title = path;
                const pathLabel = centerNode("span", "projects-path", path); pathLabel.title = path;
                const edit = centerButton("Modifier", () => showProjectEditor(path)); edit.title = `Modifier ${name}`;
                const remove = centerButton("Supprimer", () => removeLocalProject(path, name)); remove.classList.add("project-remove-action"); remove.title = `Retirer ${name} de la liste`;
                row.append(button, pathLabel, edit, remove); list.append(row);
            }
            if (!list.children.length) list.append(centerNode("p", "settings-help", query ? "Aucun projet trouvé." : "Aucun projet récent. Ouvre un dossier pour commencer."));
        } catch (error) { list.textContent = `Impossible de charger les projets : ${error.message}`; }
    };
    search.addEventListener("input", render); render();
};

// Historique des pages principales, distinct de celui du navigateur web intégré.
const workspacePageHistory = ["chat"];
let workspacePageIndex = 0, workspaceHistoryNavigation = false;
function workspaceRememberPage(page) {
    if (workspaceHistoryNavigation || workspacePageHistory[workspacePageIndex] === page) return;
    workspacePageHistory.splice(workspacePageIndex + 1);
    workspacePageHistory.push(page); workspacePageIndex++;
    workspaceSyncHistory();
}
function workspaceSyncHistory() {
    $("workspace-back").disabled = workspacePageIndex === 0;
    $("workspace-forward").disabled = workspacePageIndex >= workspacePageHistory.length - 1;
}
const workspaceOriginalShow = browserHomeShow;
browserHomeShow = function(name, options = {}) {
    workspaceOriginalShow(name, options);
    if (options.page) workspaceRememberPage(name);
};
const workspaceOriginalClose = browserHomeClosePage;
browserHomeClosePage = function() {
    const wasPage = $("app").classList.contains("browser-home-page");
    workspaceOriginalClose();
    if (wasPage) workspaceRememberPage("chat");
};
function workspaceGo(delta) {
    const index = workspacePageIndex + delta;
    if (index < 0 || index >= workspacePageHistory.length) return;
    workspacePageIndex = index; workspaceHistoryNavigation = true;
    try {
        const page = workspacePageHistory[index];
        if (page === "chat") browserHomeClosePage();
        else { browserHomeShow(page, { page: true }); setBrowserHomeOpen(true); if (page === "settings") { refreshSettings(); loadPreferences(); } if (page === "project") refreshProjectStudio(); }
    } finally { workspaceHistoryNavigation = false; workspaceSyncHistory(); }
}
$("workspace-back").onclick = () => workspaceGo(-1);
$("workspace-forward").onclick = () => workspaceGo(1);
window.addEventListener("frst-local-browser-state", workspaceSyncHistory);
workspaceSyncHistory();

// Commandes disponibles dans les menus de la fenêtre.
function workspaceMenuAction(menu, label, action, shortcut) {
    const button = document.createElement("button"); button.type = "button";
    button.textContent = label; if (shortcut) button.title = shortcut;
    button.addEventListener("mousedown", event => event.preventDefault());
    button.onclick = () => { menu.open = false; action(); };
    menu.querySelector("div").append(button);
}
let workspaceLastEditable = null;
document.addEventListener("focusin", event => { if (isEditable(event.target)) workspaceLastEditable = event.target; });
const workspaceMenus = document.querySelectorAll(".workspace-menu details");
workspaceMenuAction(workspaceMenus[0], "Ouvrir le dossier…", openProject, "Ctrl+O");
for (const [label, command, shortcut] of [["Annuler", "undo", "Ctrl+Z"], ["Rétablir", "redo", "Ctrl+Y"], ["Couper", "cut", "Ctrl+X"], ["Copier", "copy", "Ctrl+C"], ["Coller", "paste", "Ctrl+V"], ["Tout sélectionner", "selectAll", "Ctrl+A"]]) {
    workspaceMenuAction(workspaceMenus[1], label, () => { if (workspaceLastEditable?.isConnected) workspaceLastEditable.focus(); document.execCommand(command); }, shortcut);
}
workspaceMenuAction(workspaceMenus[1], "Paramètres", () => showSideView("settings"));
workspaceMenuAction(workspaceMenus[2], "Projets", () => { setBrowserHomeOpen(true); browserHomeShow("projects", { page: true }); });
workspaceMenuAction(workspaceMenus[2], "Retour", () => workspaceGo(-1));
workspaceMenuAction(workspaceMenus[2], "Suivant", () => workspaceGo(1));
for (const menu of workspaceMenus) menu.addEventListener("toggle", () => { if (menu.open) for (const other of workspaceMenus) if (other !== menu) other.open = false; });
document.addEventListener("pointerdown", event => { if (!event.target.closest(".workspace-menu")) for (const menu of workspaceMenus) menu.open = false; });
/* Sélection du chat normal et de l’agent, avec historiques distincts. */
const chatModeToggle = $("codex-mode-toggle");
const chatModeMenu = document.createElement("div");
chatModeMenu.className = "codex-mode-menu";
chatModeMenu.setAttribute("popover", "auto");
chatModeMenu.setAttribute("role", "menu");
chatModeMenu.setAttribute("aria-label", "Choisir le mode de conversation");
for (const [mode, label, description] of [["chat", "FranceStudent", "Discuter, créer et explorer"], ["agent", "FranceStudent Code", "Développer avec les outils de l’agent"]]) {
    const button = document.createElement("button"); button.type = "button"; button.dataset.chatMode = mode; button.setAttribute("role", "menuitemradio");
    button.append(centerNode("strong", "", label), centerNode("small", "", description));
    button.onclick = async () => {
        chatModeMenu.hidePopover();
        if (isMotionOpen()) { await closeMotionDesign(); if (isMotionOpen()) return; }
        try { afterConversationOpened(await api.switchChatMode(mode)); setAgentTab("conversation"); renderCodexRail(); }
        catch (error) { studioFeedback(error.message); }
    };
    chatModeMenu.append(button);
}
document.body.append(chatModeMenu);
chatModeToggle.onclick = () => {
    if (chatModeMenu.matches(":popover-open")) { chatModeMenu.hidePopover(); return; }
    const rect = chatModeToggle.getBoundingClientRect();
    chatModeMenu.style.left = `${Math.max(8, rect.left)}px`; chatModeMenu.style.top = `${rect.bottom + 6}px`;
    chatModeMenu.showPopover();
};
chatModeMenu.addEventListener("toggle", () => chatModeToggle.setAttribute("aria-expanded", String(chatModeMenu.matches(":popover-open"))));
let lastChatMode = null;
function updateChatModeMenu(status) {
    if (!status?.mode) return;
    const mode = status.mode === "chat" ? "chat" : "agent";
    document.getElementById("app").classList.toggle("classic-chat-mode", mode === "chat" && !status.motionDesign);
    input.placeholder = mode === "chat" ? "Pose ta question…" : "Demande à l’agent… (/ pour les commandes)";
    chatModeToggle.firstChild.textContent = mode === "chat" ? "FranceStudent " : "FranceStudent Code ";
    for (const button of chatModeMenu.children) button.setAttribute("aria-checked", String(button.dataset.chatMode === mode));
    if (lastChatMode !== mode) {
        lastChatMode = mode;
        const selected = franceStudentProjects.find(item => String(item.id) === $("agent-fr-project").value) || null;
        renderFranceStudentProjects(selected);
        renderCodexRail();
    }
}
$("mode-select").onchange = async event => {
    const mode = event.target.value === "chat" ? "chat" : "agent";
    try { afterConversationOpened(await api.switchChatMode(mode)); }
    catch (error) { studioFeedback(error.message); event.target.value = ui.status.mode; }
};
updateChatModeMenu(ui.status);
/* Bibliothèque des discussions du compte, même si elles ont commencé sur mobile. */
browserHomeViewTitles.library = "Bibliothèque";
let rememberedLibraryPage = null, rememberedLibraryCleanup = null, resumeLibraryLoading = null;
api.onEvent(channel => {
    if (channel !== "signedOut") return;
    rememberedLibraryCleanup?.();
    rememberedLibraryPage = rememberedLibraryCleanup = resumeLibraryLoading = null;
});
browserHomeViews.library = () => {
    if (rememberedLibraryPage) {
        browserHomeViewBody.append(rememberedLibraryPage);
        resumeLibraryLoading();
        return;
    }
    const page = centerNode("div", "library-page");
    rememberedLibraryPage=page;
    page.append(centerNode("h1", "", "Bibliothèque"), centerNode("p", "settings-help", "Fichiers et images trouvés dans les discussions synchronisées sur ton compte. Les originaux enregistrés uniquement sur un autre appareil ne sont pas accessibles ici."));
    const search = document.createElement("input"); search.type = "search"; search.placeholder = "Rechercher dans les éléments chargés"; search.setAttribute("aria-label", "Rechercher dans la bibliothèque");
    const status = centerNode("p", "settings-help", "Chargement…"); status.setAttribute("role", "status");
    const grid = centerNode("div", "library-grid-desktop");
    const storedColumns = Number(localStorage.getItem("fs.library.columns"));
    grid.style.setProperty("--library-columns", storedColumns >= 1 && storedColumns <= 4 ? storedColumns : 3);
    const more = centerButton("Réessayer", () => load(retryRefresh)); more.hidden = true;
    const refresh = centerButton("Actualiser la bibliothèque", () => load(true));
    page.append(search, refresh, status, grid, more); browserHomeViewBody.append(page);
    const items = [], activePreviews = new Map(), loadedCursors = new Set();
    let cursor = "", hasMore = true, loading = false, failed = 0, limited = 0;
    let nextPageTimer, loadError = "", retryRefresh = false;
    const observer = new IntersectionObserver(entries => {
        for (const entry of entries) if (entry.isIntersecting) {
            observer.unobserve(entry.target);
            const item = entry.target.libraryItem;
            if (!item?.messageId || item.data || item.loading) continue;
            item.loading = true;
            api.accountLibraryImage(item.conversationId, item.messageId, item.imageId).then(data => {
                item.data = data; item.loading = false;
                const target = activePreviews.get(item); if (target?.isConnected) showImage(target, item);
            }).catch(error => { item.loading = false; const target = activePreviews.get(item); if (target?.isConnected) target.textContent = `Image indisponible : ${error.message}`; });
        }
    }, { root: browserHomeViewBody, rootMargin: "160px" });
    rememberedLibraryCleanup = () => {
        clearTimeout(nextPageTimer);
        observer.disconnect();
        items.length = 0;
        activePreviews.clear();
        page.replaceChildren();
    };
    function showImage(container, item) {
        const image = document.createElement("img"); image.src = item.data; image.alt = "Image générée"; image.loading = "lazy"; container.replaceChildren(image);
        const link = container.parentNode.querySelector("[data-image-download]");
        if (link) { link.href = item.data; link.download = "image-generee" + (item.data.startsWith("data:image/jpeg") ? ".jpg" : item.data.startsWith("data:image/webp") ? ".webp" : item.data.startsWith("data:image/gif") ? ".gif" : ".png"); link.hidden = false; }
    }
    function updateStatus() {
        const count = grid.childElementCount;
        status.textContent = `${count} élément(s) ${search.value ? "trouvé(s)" : "chargé(s)"}`
            + (failed ? ` · ${failed} discussion(s) indisponible(s)` : "")
            + (limited ? ` · ${limited} discussion(s) partiellement indexée(s), à ouvrir pour tout voir` : "")
            + (loadError ? ` · Chargement interrompu : ${loadError}` : hasMore ? " · Analyse des discussions en cours…" : "");
        refresh.disabled = loading;
        more.hidden = !loadError;
        more.disabled = loading;
    }
    function render(start = 0) {
        if (!start) {
            observer.disconnect();
            activePreviews.clear();
            grid.replaceChildren();
        }
        const query = search.value.toLocaleLowerCase("fr");
        const shown = items.slice(start).filter(item => `${item.conversationTitle} ${item.language || "image"} ${item.name || ""} ${item.code || ""}`.toLocaleLowerCase("fr").includes(query));
        for (const item of shown) {
            const card = centerNode("article", "library-card-desktop");
            const first = String(item.code || "").split("\n")[0].trim();
            const named = /^(?:#|\/\/|<!--|\/\*|--|%)/.test(first) ? first.match(/[\w-]+\.[\w]{1,8}/) : null;
            const extByLang = { python:"py", py:"py", javascript:"js", js:"js", typescript:"ts", ts:"ts", html:"html", css:"css", json:"json", text:"txt", txt:"txt", pdf:"pdf", pptx:"pptx", powerpoint:"pptx", svg:"svg" };
            const ext = named ? named[0].split(".").pop().toLowerCase() : extByLang[String(item.language || "").toLowerCase()];
            const name = item.kind === "attachment" ? item.name : named?.[0] || (ext ? `fichier.${ext}` : "Extrait");
            card.append(centerNode("strong", "", item.kind === "image" ? "Image générée" : name), centerNode("small", "", `${item.kind === "attachment" ? "Envoyé · " : ""}${item.conversationTitle}`));
            let preview;
            if (item.kind === "image") { preview = centerNode("div", "library-image-preview", "Chargement de l’image…"); preview.libraryItem = item; card.append(preview); }
            else if (item.kind === "attachment") card.append(centerNode("p", "settings-help", "Fichier envoyé depuis cet ordinateur"));
            else card.append(centerNode("pre", "", item.code.slice(0, 400)));
            const actions = centerNode("div", "library-card-actions");
            if (item.kind === "image") { const link = document.createElement("a"); link.dataset.imageDownload = ""; link.textContent = "Télécharger"; link.hidden = true; actions.append(link); }
            else if (item.kind === "attachment") {
                const previewButton = centerButton("Aperçu", async () => {
                    try { const blob = await attachmentPreviewBlob(item); if (!blob) throw new Error("L’original n’est plus disponible sur cet ordinateur."); await showAttachmentBlob(name, blob, { returnFocus: previewButton }); }
                    catch (error) { studioFeedback(error.message); }
                });
                actions.append(previewButton, centerButton("Télécharger", async () => {
                    try { const blob = await attachmentPreviewBlob(item); if (!blob) throw new Error("L’original n’est plus disponible sur cet ordinateur."); const url = URL.createObjectURL(blob), link = document.createElement("a"); link.href = url; link.download = name; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000); }
                    catch (error) { studioFeedback(error.message); }
                }));
            } else {
                actions.append(centerButton("Copier", async () => { try { await navigator.clipboard.writeText(item.code); studioFeedback("Extrait copié."); } catch (error) { studioFeedback(error.message); } }));
                if (ext) {
                    const fileCode = ext === "pdf" && named ? item.code.slice(item.code.indexOf("\n") + 1) : item.code;
                    const previewButton = centerButton("Aperçu", async () => {
                        try { const blob = ext === "pptx" ? new Blob() : await classicGeneratedBlob(fileCode, ext); await showAttachmentBlob(name, blob, { presentation: ext === "pptx" ? fileCode : null, returnFocus: previewButton }); }
                        catch (error) { studioFeedback(`Aperçu impossible : ${error.message}`); }
                    });
                    actions.append(previewButton);
                    actions.append(centerButton("Télécharger", async () => {
                        try { const blob = await classicGeneratedBlob(fileCode, ext), url = URL.createObjectURL(blob), link = document.createElement("a"); link.href = url; link.download = name; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000); }
                        catch (error) { studioFeedback(`Création impossible : ${error.message}`); }
                    }));
                }
            }
            actions.append(centerButton("Ouvrir la discussion", async () => { try { if (isMotionOpen()) await closeMotionDesign(); if (isMotionOpen()) return; afterConversationOpened(await api.conversationsOpen(item.conversationId, { mode: "chat" })); browserHomeClosePage(); setAgentTab("conversation"); } catch (error) { studioFeedback(error.message); } }));
            card.append(actions); grid.append(card);
            if (preview) { activePreviews.set(item, preview); if (item.data) showImage(preview, item); else if (!item.loading) observer.observe(preview); }
        }
        updateStatus();
    }
    function libraryIsOpen() {
        return rememberedLibraryPage === page && page.isConnected && browserHomeCurrent === "library";
    }
    function scheduleNextPage() {
        clearTimeout(nextPageTimer);
        if (libraryIsOpen() && hasMore && !loading && !loadError) nextPageTimer = setTimeout(() => {
            if (libraryIsOpen()) load();
        }, 100);
    }
    resumeLibraryLoading = scheduleNextPage;
    async function load(force = false) {
        if (loading || (!force && !hasMore)) return;
        clearTimeout(nextPageTimer);
        const requestCursor = force ? "" : cursor;
        loading = true;
        loadError = "";
        updateStatus();
        try {
            const result = await api.accountLibraryPage(requestCursor, force);
            if (rememberedLibraryPage !== page) return;
            if (force) {
                items.length = 0;
                loadedCursors.clear();
                failed = limited = 0;
            }
            const start = items.length;
            items.push(...result.items);
            failed += result.failed;
            limited += result.limited || 0;
            loadedCursors.add(requestCursor);
            cursor = result.cursor;
            hasMore = Boolean(result.hasMore && cursor && !loadedCursors.has(cursor));
            render(start);
        } catch (error) {
            loadError = error.message;
            retryRefresh = force;
        } finally {
            loading = false;
            if (rememberedLibraryPage === page) {
                updateStatus();
                scheduleNextPage();
            }
        }
    }
    search.oninput = () => render();
    load();
};
const libraryActivity = document.createElement("button");
libraryActivity.type = "button"; libraryActivity.dataset.action = "library"; libraryActivity.title = "Bibliothèque"; libraryActivity.setAttribute("aria-label", "Bibliothèque");
libraryActivity.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 5h4v14H4zM10 4h4v15h-4zM16 6l3-1 3 13-3 1z"/></svg>';
libraryActivity.onclick = () => { setBrowserHomeOpen(true); browserHomeShow("library", { page: true }); };
codexActivity.insertBefore(libraryActivity, codexActivity.querySelector('[data-action="settings"]'));
/* Profil FranceStudent dans les réglages, sans exposer les jetons au renderer. */
const accountSettingsCard = document.createElement("section");
accountSettingsCard.className = "settings-card"; accountSettingsCard.dataset.settingsGroup = "account";
accountSettingsCard.setAttribute("aria-labelledby", "account-settings-title");
accountSettingsCard.innerHTML = '<h3 id="account-settings-title">Compte FranceStudent</h3><div class="account-profile"><div class="account-avatar" aria-hidden="true">●</div><div><p id="account-profile-status" role="status">Sélectionne Actualiser pour consulter ton profil.</p><div class="account-profile-actions"><button type="button" id="account-avatar-change">Changer la photo</button><button type="button" id="account-avatar-remove">Retirer</button><button type="button" id="account-profile-refresh">Actualiser le profil</button></div><input id="account-avatar-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden><p class="settings-help">Photo enregistrée uniquement sur cet ordinateur.</p></div></div>';
$("settings-help-title").closest(".settings-card").before(accountSettingsCard);
$("account-profile-refresh").onclick = async event => {
    const epoch = accountSettingsEpoch;
    event.currentTarget.disabled = true; $("account-profile-status").textContent = "Chargement du profil…";
    try { const profile = await api.accountProfile(); if (epoch !== accountSettingsEpoch) return; $("account-profile-status").textContent = [profile.name, profile.email].filter(Boolean).join(" · ") || "Connecté à FranceStudent."; accountAvatarOwner = profile.email || profile.name || ""; renderAccountAvatar(); }
    catch (error) { if (epoch === accountSettingsEpoch) $("account-profile-status").textContent = `Profil indisponible : ${error.message}`; }
    finally { event.currentTarget.disabled = false; }
};
let accountAvatarOwner = "";
function renderAccountAvatar() {
    const avatar = accountSettingsCard.querySelector(".account-avatar");
    let data = "";
    try { if (accountAvatarOwner) data = localStorage.getItem("fs.avatar." + accountAvatarOwner) || ""; } catch {}
    avatar.replaceChildren();
    if (data && /^data:image\/(png|jpeg|webp|gif);base64,/i.test(data)) {
        const image = document.createElement("img"); image.src = data; image.alt = ""; avatar.append(image);
    } else avatar.textContent = accountAvatarOwner ? accountAvatarOwner.slice(0, 1).toLocaleUpperCase("fr") : "●";
}
$("account-avatar-change").onclick = () => { if (accountAvatarOwner) $("account-avatar-input").click(); else $("account-profile-status").textContent = "Connecte-toi et actualise ton profil pour ajouter une photo."; };
$("account-avatar-input").onchange = event => {
    const file = event.target.files?.[0]; event.target.value = "";
    if (!file) return;
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type) || file.size > 1024 * 1024) { $("account-profile-status").textContent = "Choisis une image PNG, JPEG, WebP ou GIF de 1 Mo maximum."; return; }
    const owner = accountAvatarOwner, epoch = accountSettingsEpoch, reader = new FileReader();
    reader.onload = () => { if (epoch !== accountSettingsEpoch || owner !== accountAvatarOwner) return; try { localStorage.setItem("fs.avatar." + owner, reader.result); renderAccountAvatar(); } catch { $("account-profile-status").textContent = "Impossible d’enregistrer la photo sur cet ordinateur."; } };
    reader.readAsDataURL(file);
};
$("account-avatar-remove").onclick = () => { if (!accountAvatarOwner) return; try { localStorage.removeItem("fs.avatar." + accountAvatarOwner); } catch {} renderAccountAvatar(); };
filterSettingsCards();
/* Mode image explicite du chat normal. L’activation met à jour la préférence du compte. */
const chatImageButton = document.createElement("button");
chatImageButton.type = "button"; chatImageButton.id = "chat-image-mode"; chatImageButton.textContent = "Image";
chatImageButton.setAttribute("aria-haspopup", "dialog"); chatImageButton.setAttribute("aria-expanded", "false");
composerSettingsRow.append(chatImageButton);
const chatImageMenu = document.createElement("div"); chatImageMenu.className = "chat-access-menu chat-image-menu";
chatImageMenu.setAttribute("popover", "auto"); chatImageMenu.setAttribute("role", "dialog"); chatImageMenu.setAttribute("aria-label", "Génération d’image");
chatImageMenu.innerHTML = '<div class="chat-access-heading">Génération d’image</div><p>Activer ce mode utilise le modèle choisi sur ton compte FranceStudent.</p><label>Modèle <select aria-label="Modèle d’image"><option value="gpt-image-2.5-flare">GPT Image 2.5 Flare</option><option value="gpt-image-2.5-sunburst">GPT Image 2.5 Sunburst</option><option value="gpt-image-2">GPT Image 2</option></select></label><p data-image-status role="status"></p><button type="button" data-image-action>Activer</button>';
document.body.append(chatImageMenu);
let chatImageEnabled = false;
function updateImageModeUi() { if (!ui.status.booted) chatImageEnabled = false; chatImageButton.hidden = ui.status.mode !== "chat"; chatImageButton.textContent = chatImageEnabled ? "Image · activée" : "Image"; chatImageMenu.querySelector("[data-image-action]").textContent = chatImageEnabled ? "Désactiver" : "Activer"; }
chatImageButton.onclick = async () => {
    if (chatImageMenu.matches(":popover-open")) { chatImageMenu.hidePopover(); return; }
    try { const state = await api.imageMode("status"); chatImageEnabled = state.enabled; chatImageMenu.querySelector("select").value = state.model; updateImageModeUi(); }
    catch (error) { studioFeedback(error.message); return; }
    const rect = (ui.status.mode === "chat" && $("classic-tools-button") ? $("classic-tools-button") : chatImageButton).getBoundingClientRect(); chatImageMenu.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - 300))}px`; chatImageMenu.style.top = `${Math.max(8, rect.top - 200)}px`; chatImageMenu.style.width = "min(290px, calc(100vw - 16px))"; chatImageMenu.showPopover();
};
chatImageMenu.addEventListener("toggle", () => chatImageButton.setAttribute("aria-expanded", String(chatImageMenu.matches(":popover-open"))));
chatImageMenu.querySelector("[data-image-action]").onclick = async event => {
    event.currentTarget.disabled = true; const status = chatImageMenu.querySelector("[data-image-status]"); status.textContent = "";
    try { const state = await api.imageMode(chatImageEnabled ? "disable" : "enable", chatImageMenu.querySelector("select").value); chatImageEnabled = state.enabled; updateImageModeUi(); chatImageMenu.hidePopover(); }
    catch (error) { status.textContent = error.message; } finally { event.currentTarget.disabled = false; }
};
const oldUpdateChatModeMenu = updateChatModeMenu;
updateChatModeMenu = function(status) { oldUpdateChatModeMenu(status); updateImageModeUi(); };
updateImageModeUi();
/* Préférences générales du compte utilisées également par l’application mobile. */
const generalAccountCard = document.createElement("section"); generalAccountCard.className = "settings-card"; generalAccountCard.dataset.settingsGroup = "general";
generalAccountCard.setAttribute("aria-labelledby", "account-general-title");
generalAccountCard.innerHTML = '<h3 id="account-general-title">Personnalisation FranceStudent</h3><p class="settings-help">Ces préférences sont enregistrées sur ton compte et partagées avec l’application mobile.</p><button type="button" data-general-load>Charger les préférences</button><fieldset disabled data-general-fields><label class="center-code-label">Niveau de réflexion GPT<select data-general-reasoning><option value="none">Aucun</option><option value="minimal">Minimal</option><option value="low">Faible</option><option value="medium">Moyen</option><option value="high">Élevé</option><option value="xhigh">Très élevé</option></select></label><label class="center-code-label">Instructions personnalisées<textarea data-general-instructions rows="5" maxlength="2000000"></textarea></label><button type="button" data-general-save>Enregistrer sur le compte</button></fieldset><p class="settings-help" data-general-status role="status"></p>';
$("settings-model-title").closest(".settings-card").after(generalAccountCard);
let accountSettingsEpoch = 0;
const generalAccountFields = generalAccountCard.querySelector("[data-general-fields]");
const generalAccountStatus = generalAccountCard.querySelector("[data-general-status]");
generalAccountCard.querySelector("[data-general-load]").onclick = async event => {
    const epoch = accountSettingsEpoch;
    event.currentTarget.disabled = true; generalAccountStatus.textContent = "Chargement…";
    try { const value = await api.accountPersonalization("get"); if (epoch !== accountSettingsEpoch) return; const select = generalAccountFields.querySelector("select"); select.value = [...select.options].some(option => option.value === value.reasoning) ? value.reasoning : "none"; generalAccountFields.querySelector("textarea").value = value.instructions; generalAccountFields.disabled = false; generalAccountStatus.textContent = ""; }
    catch (error) { if (epoch === accountSettingsEpoch) generalAccountStatus.textContent = error.message; } finally { event.currentTarget.disabled = false; }
};
generalAccountCard.querySelector("[data-general-save]").onclick = async () => {
    const epoch = accountSettingsEpoch;
    generalAccountFields.disabled = true; generalAccountStatus.textContent = "Enregistrement…";
    try { await api.accountPersonalization("save", { reasoning: generalAccountFields.querySelector("select").value, instructions: generalAccountFields.querySelector("textarea").value }); if (epoch === accountSettingsEpoch) generalAccountStatus.textContent = "Préférences enregistrées sur ton compte."; }
    catch (error) { if (epoch === accountSettingsEpoch) generalAccountStatus.textContent = error.message; } finally { if (epoch === accountSettingsEpoch) generalAccountFields.disabled = false; }
};
filterSettingsCards();

function clearAccountSettings() {
    accountSettingsEpoch++;
    if (browserHomeCurrent === "library" && $("app").classList.contains("browser-home-page")) browserHomeClosePage();
    generalAccountFields.disabled = true;
    generalAccountFields.querySelector("textarea").value = "";
    generalAccountFields.querySelector("select").value = "none";
    generalAccountStatus.textContent = "";
    $("account-profile-status").textContent = "Non connecté.";
}
/* Réglages locaux d’un projet et de ses dossiers sources. */
async function showNewLocalProject() {
    if (isMotionOpen()) { await closeMotionDesign(); if (isMotionOpen()) return; }
    const dialog = document.createElement("dialog"); dialog.id = "new-local-project-dialog"; dialog.className = "fs-dialog project-source-dialog";
    studioSurfaceHeader(dialog, { title: "Nouveau projet", subtitle: "Crée un dossier pour ton projet ou ouvre un dossier existant.", icon: "tools" });
    const label = centerNode("label", "project-source-name", "Nom du projet"), name = document.createElement("input");
    name.value = "Mon projet"; name.maxLength = 100; label.append(name);
    let parent = null;
    const location = centerNode("button", "project-source-add", "Choisir l’emplacement…"); location.type = "button";
    const message = centerNode("p", "settings-help", "Un nouveau dossier sera créé à cet emplacement."); message.setAttribute("role", "status");
    const footer = centerNode("div", "fs-dialog-footer"), cancel = centerNode("button", "", "Annuler"), create = centerNode("button", "primary", "Créer le projet");
    cancel.type = create.type = "button"; create.disabled = true; cancel.onclick = () => dialog.close();
    location.onclick = async () => { location.disabled = true; try { const chosen = await api.localProjects("chooseParent"); if (chosen) { parent = chosen; location.textContent = chosen; location.title = chosen; create.disabled = !name.value.trim(); } } catch (error) { message.textContent = error.message; } finally { location.disabled = false; } };
    name.oninput = () => { create.disabled = !parent || !name.value.trim(); };
    name.onkeydown = event => { if (event.key === "Enter" && !create.disabled) { event.preventDefault(); create.click(); } };
    const existing = centerNode("button", "project-source-add", "Ouvrir un dossier existant…"); existing.type = "button";
    existing.onclick = async () => { dialog.close(); await openProject(); await renderCodexRail(); };
    create.onclick = async () => {
        if (ui.tabs.some(tab => tab.dirty) && !await confirmStudioAction("Des fichiers ne sont pas enregistrés. Changer de projet quand même ?")) return;
        create.disabled = true;
        try { const result = await api.localProjects("create", { parent, name: name.value }); if (result.workspace !== ui.workspace) { ui.workspace = result.workspace; onWorkspaceChanged(); } dialog.close(); await renderCodexRail(); if (browserHomeCurrent === "projects") browserHomeShow("projects", { page: true }); studioFeedback("Projet créé."); }
        catch (error) { message.textContent = error.message; create.disabled = false; }
    };
    footer.append(cancel, create); dialog.append(label, location, existing, message, footer); document.body.append(dialog);
    dialog.addEventListener("close", () => dialog.remove(), { once: true }); dialog.showModal(); name.focus(); name.select();
}

async function removeLocalProject(root, name) {
    if (ui.status.busy) return studioFeedback("Attends la fin de la demande.");
    const key = value => String(value || "").replace(/\\/g, "/").replace(/\/+$/, "").toLocaleLowerCase();
    if (key(root) === key(ui.workspace) && ui.tabs.some(tab => tab.dirty) && !await confirmStudioAction("Des fichiers ne sont pas enregistrés. Fermer ce projet quand même ?")) return;
    if (!await confirmStudioAction(`Retirer « ${name} » de la liste des projets ? Les fichiers, les sauvegardes et les conversations sont conservés. Tu pourras le retrouver en ouvrant son dossier.`, { title: "Supprimer le projet de la liste", confirmLabel: "Retirer le projet", danger: true })) return;
    try {
        await api.localProjects("remove", { root });
        window.dispatchEvent(new Event("frst-conversations-changed"));
        if (browserHomeCurrent === "projects") browserHomeShow("projects", { page: true });
        studioFeedback("Projet retiré de la liste. Ses fichiers sont conservés.");
    } catch (error) { studioFeedback(error.message); }
}

async function showProjectEditor(root) {
    let config;
    try { config = await api.projectSources("get", { root }); }
    catch (error) { studioFeedback(error.message); return; }
    const dialog = document.createElement("dialog"); dialog.className = "fs-dialog project-source-dialog";
    studioSurfaceHeader(dialog, { title: "Modifier le projet", subtitle: "Organise les dossiers à étudier ensemble.", icon: "tools" });
    const nameLabel = document.createElement("label"); nameLabel.className = "project-source-name"; nameLabel.append(centerNode("span", "", "Nom du projet"));
    const nameInput = document.createElement("input"); nameInput.value = config.name; nameInput.maxLength = 100; nameInput.required = true; nameLabel.append(nameInput);
    const section = centerNode("section", "project-source-section"); section.append(centerNode("h3", "", "Dossiers sources"));
    const folders = centerNode("div", "project-source-folders"); let paths = config.sources.map(source => source.path);
    function drawFolders() {
        folders.replaceChildren();
        const primary = centerNode("div", "project-source-row"); primary.append(centerNode("span", "project-source-path", config.root), centerNode("span", "project-source-badge", "Principal")); folders.append(primary);
        paths.forEach((source, index) => {
            const row = centerNode("div", "project-source-row");
            const label = centerNode("span", "project-source-path", source); label.title = source;
            const remove = centerNode("button", "project-source-remove", "×"); remove.type = "button"; remove.setAttribute("aria-label", `Retirer ${source}`);
            remove.onclick = () => { paths.splice(index, 1); drawFolders(); };
            row.append(label, remove); folders.append(row);
        });
        const add = centerNode("button", "project-source-add", "+ Ajouter un dossier"); add.type = "button";
        add.onclick = async () => { add.disabled = true; try { const chosen = await api.projectSources("choose"); if (chosen) { paths.push(chosen); drawFolders(); } } catch (error) { message.textContent = error.message; } finally { add.disabled = false; } };
        folders.append(add);
    }
    const message = centerNode("p", "settings-help", "L’outil de sources les consulte en lecture seule. Les sauvegardes avant demande couvrent uniquement le dossier principal."); message.setAttribute("role", "status");
    section.append(folders, message); drawFolders();
    const footer = centerNode("div", "fs-dialog-footer"), cancel = centerNode("button", "", "Annuler"), save = centerNode("button", "primary", "Enregistrer");
    cancel.type = save.type = "button"; cancel.onclick = () => dialog.close();
    save.onclick = async () => {
        save.disabled = true;
        try { await api.projectSources("save", { root: config.root, name: nameInput.value, paths }); dialog.close(); renderCodexRail(); if (browserHomeCurrent === "projects") browserHomeShow("projects", { page: true }); studioFeedback("Projet enregistré."); }
        catch (error) { message.textContent = error.message; save.disabled = false; }
    };
    footer.append(cancel, save); dialog.append(nameLabel, section, footer); document.body.append(dialog);
    dialog.addEventListener("close", () => dialog.remove(), { once: true }); dialog.showModal(); nameInput.focus(); nameInput.select();
}
async function showProjectInfo(root, count, anchor) {
    const old = document.querySelector(".project-info-popover"); if (old) old.remove();
    const popover = centerNode("div", "project-info-popover"); popover.setAttribute("popover", "auto"); popover.setAttribute("aria-label", "Informations sur le projet");
    popover.append(centerNode("strong", "", "Chargement…")); document.body.append(popover);
    popover.addEventListener("toggle", () => { if (!popover.matches(":popover-open")) popover.remove(); });
    const rect = anchor.getBoundingClientRect(); popover.style.left = `${Math.max(8, Math.min(innerWidth - 330, rect.right + 8))}px`; popover.style.top = `${Math.max(8, Math.min(innerHeight - 240, rect.top))}px`; popover.showPopover();
    try {
        const info = await api.projectSources("get", { root }); if (!popover.isConnected) return;
        popover.replaceChildren(centerNode("strong", "", info.name), centerNode("p", "", `${count} discussion(s)`));
        for (const item of [info.root, ...info.sources.map(source => source.path)]) { const line = centerNode("div", "project-info-path", item); line.title = item; popover.append(line); }
        const edit = centerNode("button", "", "Modifier le projet"); edit.type = "button"; edit.onclick = () => { popover.hidePopover(); showProjectEditor(info.root); }; popover.append(edit);
        const remove = centerNode("button", "project-remove-action", "Supprimer le projet de la liste"); remove.type = "button";
        remove.onclick = () => { popover.hidePopover(); removeLocalProject(info.root, info.name); }; popover.append(remove);
    } catch (error) {
        popover.replaceChildren(centerNode("p", "", error.message));
        const remove = centerNode("button", "project-remove-action", "Supprimer le projet de la liste"); remove.type = "button";
        remove.onclick = () => { popover.hidePopover(); removeLocalProject(root, root.replace(/[\\/]+$/, "").split(/[\\/]/).pop()); }; popover.append(remove);
    }
}
/* Logos existants des fournisseurs ; aucun fournisseur n’est deviné si le modèle est inconnu. */
function historyModelLogo(value) {
    let model = value && typeof value === "object" ? value : { id: value, name: String(value || "") };
    const known = ui.models?.agents?.find(item => String(item.id) === String(model.id));
    if (known) model = { ...model, ...known };
    const logo = modelLogo(model, "history-model-logo");
    if (logo) { logo.alt = ""; logo.title = model.name || model.model || "Modèle"; logo.setAttribute("aria-hidden", "true"); }
    return logo;
}
/* Réglages généraux et compte organisés comme dans l’application mobile. */
const mobileLibrarySettings = document.createElement("section"); mobileLibrarySettings.className = "settings-card mobile-settings-card"; mobileLibrarySettings.dataset.settingsGroup = "general";
mobileLibrarySettings.innerHTML = '<h3>Affichage de la bibliothèque</h3><p class="settings-help">Nombre de colonnes sur cet ordinateur.</p><div class="mobile-setting-choices" role="group" aria-label="Colonnes de la bibliothèque"></div>';
const libraryChoices = mobileLibrarySettings.querySelector(".mobile-setting-choices");
function libraryColumnCount() { const value = Number(localStorage.getItem("fs.library.columns")); return value >= 1 && value <= 4 ? value : 3; }
function refreshLibraryChoices() {
    for (const button of libraryChoices.children) button.setAttribute("aria-pressed", String(Number(button.dataset.columns) === libraryColumnCount()));
    document.querySelectorAll(".library-grid-desktop").forEach(grid => grid.style.setProperty("--library-columns", libraryColumnCount()));
}
for (let count = 1; count <= 4; count++) {
    const button = centerNode("button", "library-choice"); button.type = "button"; button.dataset.columns = String(count);
    const preview = centerNode("span", "library-choice-preview"); preview.setAttribute("aria-hidden", "true"); preview.style.setProperty("--choice-columns", count);
    for (let i = 0; i < count * 3; i++) preview.append(document.createElement("i"));
    button.append(preview, centerNode("span", "", `${count} colonne${count > 1 ? "s" : ""}`));
    button.onclick = () => { localStorage.setItem("fs.library.columns", String(count)); refreshLibraryChoices(); }; libraryChoices.append(button);
}
$("settings-model-title").closest(".settings-card").before(mobileLibrarySettings); refreshLibraryChoices();
const mobileImageSettings = document.createElement("section"); mobileImageSettings.className = "settings-card mobile-settings-card"; mobileImageSettings.dataset.settingsGroup = "general";
mobileImageSettings.innerHTML = '<h3>Génération d’images</h3><fieldset data-image-fields disabled><label class="setting-toggle"><span><b>Générer des images dans le chat</b><small>Autorise le modèle à utiliser l’outil de génération d’image.</small></span><input type="checkbox" data-image-enabled role="switch"></label><div class="center-code-label"><span id="settings-image-model-label">Modèle d’image</span><select data-image-model aria-labelledby="settings-image-model-label"><option value="gpt-image-2.5-flare">GPT Image 2.5 Flare</option><option value="gpt-image-2.5-sunburst">GPT Image 2.5 Sunburst</option><option value="gpt-image-2">GPT Image 2</option></select></div><button type="button" data-image-save>Enregistrer sur le compte</button></fieldset><p class="settings-help" data-image-feedback role="status"></p><button type="button" data-image-retry hidden>Réessayer</button>';
$("settings-model-title").closest(".settings-card").after(mobileImageSettings);
const mobileImageFields = mobileImageSettings.querySelector("[data-image-fields]"), mobileImageFeedback = mobileImageSettings.querySelector("[data-image-feedback]");
let mobileImageLoadingEpoch = -1;
async function loadMobileImageSettings() {
    const epoch = accountSettingsEpoch;
    if (mobileImageLoadingEpoch === epoch) return;
    mobileImageLoadingEpoch = epoch; mobileImageSettings.querySelector("[data-image-retry]").hidden = true; mobileImageFeedback.textContent = "Chargement…";
    try {
        const value = await api.accountPersonalization("get"); if (epoch !== accountSettingsEpoch) return;
        const select = mobileImageFields.querySelector("select");
        if (![...select.options].some(option => option.value === value.imageModel)) throw new Error("Le modèle enregistré n’est pas reconnu ; aucun réglage n’a été modifié.");
        select.value = value.imageModel; mobileImageFields.querySelector("input").checked = value.imageEnabled;
        mobileImageFields.disabled = false; mobileImageFeedback.textContent = "";
        if (typeof syncSettingsModelMenu === "function") syncSettingsModelMenu(select);
    } catch (error) { if (epoch === accountSettingsEpoch) { mobileImageFeedback.textContent = `Chargement impossible : ${error.message}`; mobileImageSettings.querySelector("[data-image-retry]").hidden = false; } }
    finally { if (mobileImageLoadingEpoch === epoch) mobileImageLoadingEpoch = -1; }
}
mobileImageSettings.querySelector("[data-image-retry]").onclick = () => void loadMobileImageSettings();
mobileImageSettings.querySelector("[data-image-save]").onclick = async () => {
    const epoch = accountSettingsEpoch;
    mobileImageFields.disabled = true; mobileImageFeedback.textContent = "Enregistrement…";
    try {
        await api.accountPersonalization("image", { enabled: mobileImageFields.querySelector("input").checked, model: mobileImageFields.querySelector("select").value });
        const mode = await api.imageMode("status"); if (epoch !== accountSettingsEpoch) return; chatImageEnabled = mode.enabled; updateImageModeUi();
        mobileImageFeedback.textContent = "Réglages enregistrés sur ton compte.";
    } catch (error) { if (epoch === accountSettingsEpoch) mobileImageFeedback.textContent = error.message; }
    finally { if (epoch === accountSettingsEpoch) mobileImageFields.disabled = false; }
};
const accountUsageButton = centerNode("button", "", "Voir mon utilisation"); accountUsageButton.type = "button";
accountUsageButton.onclick = () => { browserHomeClosePage(); setAgentTab("usage"); };
accountSettingsCard.append(accountUsageButton);
let mobileGeneralRequested = false, mobileAccountRequested = false;
function loadMobileSettingsSection() {
    if (!ui.status.booted) { mobileImageFeedback.textContent = "Connecte-toi pour modifier les réglages d’image."; return; }
    if (settingsCategory === "general" && !mobileGeneralRequested) {
        mobileGeneralRequested = true; generalAccountCard.querySelector("[data-general-load]").click(); void loadMobileImageSettings();
    }
    if (settingsCategory === "account" && !mobileAccountRequested) {
        mobileAccountRequested = true; $("account-profile-refresh").click();
        if (typeof loadDesktopAccountActivity === "function") void loadDesktopAccountActivity();
    }
}
for (const button of settingsNavigation.children) button.addEventListener("click", loadMobileSettingsSection);
const oldSettingsBrowserView = browserHomeViews.settings;
browserHomeViews.settings = () => { oldSettingsBrowserView(); loadMobileSettingsSection(); };
const oldClearAccountSettings = clearAccountSettings;
clearAccountSettings = function() { oldClearAccountSettings(); mobileImageFields.disabled = true; mobileImageFields.querySelector("select").selectedIndex = 0; mobileImageFields.querySelector("input").checked = false; if (typeof syncSettingsModelMenu === "function") syncSettingsModelMenu(mobileImageFields.querySelector("select")); mobileImageFeedback.textContent = "Connecte-toi pour modifier les réglages d’image."; mobileImageSettings.querySelector("[data-image-retry]").hidden = true; mobileGeneralRequested = false; mobileAccountRequested = false; };
filterSettingsCards();
/* Fichiers issus des blocs de code d’une réponse classique. */
async function classicGeneratedBlob(code, ext) {
    if (ext === "pptx") return new Blob([await makePowerPoint(code)], {type:"application/vnd.openxmlformats-officedocument.presentationml.presentation"});
    if (ext === "pdf") { const encoded=await api.createTextPdf(code), raw=atob(encoded); return new Blob([Uint8Array.from(raw, char=>char.charCodeAt(0))], {type:"application/pdf"}); }
    if (ext === "svg") return new Blob([code], {type:"image/svg+xml"});
    return new Blob([code], {type:"text/plain;charset=utf-8"});
}
function appendClassicGeneratedFiles(message, source) {
    const extensions = { python:"py", py:"py", javascript:"js", js:"js", typescript:"ts", ts:"ts", html:"html", css:"css", json:"json", csv:"csv", markdown:"md", md:"md", java:"java", c:"c", cpp:"cpp", "c++":"cpp", csharp:"cs", bash:"sh", sh:"sh", shell:"sh", powershell:"ps1", sql:"sql", xml:"xml", yaml:"yml", yml:"yml", php:"php", ruby:"rb", go:"go", rust:"rs", kotlin:"kt", swift:"swift", latex:"tex", text:"txt", txt:"txt", svg:"svg", pptx:"pptx", powerpoint:"pptx", pdf:"pdf" };
    const files = document.createElement("div"); files.className = "classic-generated-files";
    for (const match of String(source || "").matchAll(/```([^\s`]*)[^\n]*\n([\s\S]*?)```/g)) {
        let ext = extensions[match[1].toLowerCase()];
        let code = match[2]; const first = code.split("\n")[0].trim();
        const named = /^(?:#|\/\/|<!--|\/\*|--|%)/.test(first) ? first.match(/[\w-]+\.[\w]{1,8}/) : null;
        const requested = conversationRequestBefore(message)?.text || "";
        if (named && /\.pdf$/i.test(named[0]) && /\bpdf\b/i.test(requested)) {
            ext = "pdf"; code = code.slice(code.indexOf("\n") + 1);
        }
        if (!ext) continue;
        const name = ext === "pptx" ? powerPointFileName(code) : named && named[0].toLowerCase().endsWith(`.${ext}`) ? named[0] : `fichier.${ext}`;
        const card = document.createElement("div"); card.className = "classic-generated-file";
        const preview = document.createElement("button"); preview.type = "button";
        const icons = { py:"python", js:"javascript", ts:"typescript", html:"html5", css:"css3", java:"java", go:"go", rs:"rust", php:"php" };
        if (icons[ext]) { const icon = document.createElement("img"); icon.className = "classic-file-icon"; icon.src = `assets/filetypes/${icons[ext]}.svg`; icon.alt = ""; preview.append(icon); }
        else preview.append(fileIcon(name, "file"));
        preview.append(document.createTextNode(name)); preview.title = `Aperçu de ${name}`;
        preview.onclick = async () => {
            preview.disabled = true;
            try { const blob=ext === "pptx" ? new Blob() : await classicGeneratedBlob(code,ext); await showAttachmentBlob(name,blob,{ presentation:ext === "pptx" ? code : null, returnFocus:preview }); }
            catch(error) { studioFeedback(`Aperçu impossible : ${error.message}`); }
            finally { preview.disabled = false; }
        };
        const download = document.createElement("button"); download.type = "button"; download.textContent = "Télécharger"; download.setAttribute("aria-label", `Télécharger ${name}`);
        download.onclick = async () => {
            let blob;
            try { blob = await classicGeneratedBlob(code,ext); }
            catch (error) { studioFeedback(`Création impossible : ${error.message}`); return; }
            const url = URL.createObjectURL(blob);
            const link = document.createElement("a"); link.href = url; link.download = name; document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 5000);
        };
        if (ext === "svg") {
            const thumb=document.createElement("img"); thumb.className="classic-generated-thumbnail"; thumb.alt="Aperçu de l’image générée";
            thumb.src=`data:image/svg+xml;charset=utf-8,${encodeURIComponent(code)}`;
            const picture=document.createElement("button"); picture.type="button"; picture.className="classic-generated-image-preview"; picture.setAttribute("aria-label",`Aperçu de ${name}`); picture.append(thumb); picture.onclick=()=>preview.click(); card.append(picture);
        }
        card.append(preview, download); files.append(card);
    }
    if (files.children.length) { message.querySelectorAll(".classic-generating-file").forEach(node=>node.remove()); message.append(files); }
}
/* Compositeur du chat classique : les actions réutilisent les contrôles existants. */
const classicToolsButton = document.createElement("button");
classicToolsButton.type = "button"; classicToolsButton.id = "classic-tools-button";
classicToolsButton.textContent = "+"; classicToolsButton.title = "Outils du chat";
classicToolsButton.setAttribute("aria-label", "Outils du chat"); classicToolsButton.setAttribute("aria-haspopup", "menu"); classicToolsButton.setAttribute("aria-expanded", "false");
$("btn-attach").before(classicToolsButton);
const classicToolsMenu = document.createElement("div"); classicToolsMenu.className = "classic-tools-menu";
classicToolsMenu.setAttribute("popover", "auto"); classicToolsMenu.setAttribute("role", "menu"); classicToolsMenu.setAttribute("aria-label", "Outils du chat");
for (const [label, icon, action] of [
    ["Fichiers", "📎", () => $("btn-attach").click()],
    ["Recherche web", "◎", () => $("set-web-search").click()],
    ["Image", "▧", () => chatImageButton.click()]
]) {
    const button = document.createElement("button"); button.type = "button"; button.setAttribute("role", "menuitem");
    const symbol = document.createElement("span"); symbol.textContent = icon; symbol.setAttribute("aria-hidden", "true");
    const text = document.createElement("span"); text.textContent = label; button.append(symbol, text);
    if (label === "Recherche web") { button.id = "classic-web-search"; button.setAttribute("role", "menuitemcheckbox"); }
    button.onclick = () => { classicToolsMenu.hidePopover(); action(); };
    classicToolsMenu.append(button);
}
document.body.append(classicToolsMenu);
classicToolsButton.onclick = () => {
    if (classicToolsMenu.matches(":popover-open")) { classicToolsMenu.hidePopover(); return; }
    $("classic-web-search").setAttribute("aria-checked", String($("set-web-search").checked));
    classicToolsMenu.showPopover();
    const rect = classicToolsButton.getBoundingClientRect(), menu = classicToolsMenu.getBoundingClientRect();
    classicToolsMenu.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - menu.width - 8))}px`;
    classicToolsMenu.style.top = `${Math.max(8, rect.top - menu.height - 8)}px`;
    classicToolsMenu.querySelector("button")?.focus();
};
classicToolsMenu.addEventListener("toggle", () => classicToolsButton.setAttribute("aria-expanded", String(classicToolsMenu.matches(":popover-open"))));
'use strict';

// Quiz interactifs et cartes mémoire du mode étudiant.
// Le modèle renvoie un bloc ```quiz ou ```cards contenant du JSON ; render.js appelle renderStudyBlock().

const FENCE = '`'.repeat(3);
const QUIZ_EXAMPLE = { title: 'Titre du quiz', questions: [
  { type: 'qcm', question: '...', choices: ['A', 'B', 'C', 'D'], answer: 0, explanation: '...' },
  { type: 'vf', question: '...', answer: true, explanation: '...' },
  { type: 'open', question: '...', answer: 'réponse attendue', explanation: '...' }
] };
const CARDS_EXAMPLE = { title: 'Titre', cards: [{ q: 'Question courte', a: 'Réponse concise' }] };
const STUDY_RULES = `Appuie-toi sur le contenu fourni ; s'il n'y en a pas mais qu'un sujet est indiqué, utilise tes connaissances ; sinon demande-moi le cours ou le PDF.`;
const QUIZ_INSTRUCTION = `Mode étudiant — QUIZ INTERACTIF. Crée un quiz en français d'environ 10 questions (QCM à 4 propositions, vrai/faux et quelques questions ouvertes) de difficulté progressive. Réponds par une courte phrase d'introduction puis UN SEUL bloc de code ${FENCE}quiz contenant uniquement du JSON valide (guillemets doubles, sans virgule finale), de cette forme : ${JSON.stringify(QUIZ_EXAMPLE)}. Pour un qcm, "answer" est l'index (dès 0) de la bonne proposition ; pour un vf, true ou false ; pour une question ouverte, la réponse attendue. Mets les explications dans "explanation" et n'écris aucune correction hors du bloc. ${STUDY_RULES}`;
const CARDS_INSTRUCTION = `Mode étudiant — CARTES MÉMOIRE. Génère une vingtaine de cartes mémoire (flashcards) en français si le contenu le permet, avec des questions courtes et des réponses concises. Réponds par une courte phrase d'introduction puis UN SEUL bloc de code ${FENCE}cards contenant uniquement du JSON valide (guillemets doubles, sans virgule finale), de cette forme : ${JSON.stringify(CARDS_EXAMPLE)}. ${STUDY_RULES}`;

// Détecte une demande explicite de quiz / cartes / fiches dans le message.
function detectStudyIntent(text) {
  const t = String(text || '');
  const ask = /(g[ée]n[èe]re|cr[ée]+|fais|fait|donne|pr[ée]pare|propose|r[ée]dige|produis|make|generate|create|teste|interroge)/i.test(t);
  if (!ask) return '';
  if (/(cartes?\s+(?:m[ée]moire|de\s+r[ée]vision)|flash\s?cards?)/i.test(t)) return 'cartes';
  if (/\b(quiz+|qcm|questionnaire|interro(?:gation)?|teste[- ]?moi|interroge[- ]?moi)\b/i.test(t)) return 'quiz';
  if (/fiches?\s+(?:de\s+)?r[ée]vision/i.test(t)) return 'fiches';
  return '';
}

function parseStudyJson(code) {
  const s = String(code || '').trim();
  try { return JSON.parse(s); } catch (e) { /* tentative suivante */ }
  try { return JSON.parse(s.replace(/,\s*([}\]])/g, '$1')); } catch (e) { return null; }
}

function normalizeQuiz(data) {
  const list = data && Array.isArray(data.questions) ? data.questions : [];
  const questions = [];
  for (const item of list) {
    if (!item || !item.question) continue;
    const q = { q: String(item.question), e: item.explanation ? String(item.explanation) : '' };
    const type = String(item.type || '').toLowerCase();
    const choices = Array.isArray(item.choices) ? item.choices.map(String) : null;
    const ans = String(item.answer);
    if (type === 'vf' || typeof item.answer === 'boolean' || (!choices && /^(vrai|faux|true|false)$/i.test(ans))) {
      q.c = ['Vrai', 'Faux'];
      q.a = item.answer === true || /^(vrai|true)$/i.test(ans) ? 0 : 1;
    } else if (choices && choices.length > 1) {
      let a = Number(item.answer);
      if (!Number.isInteger(a)) {
        a = choices.indexOf(ans);
        if (a < 0) a = 'ABCDEFGH'.indexOf(ans.trim().toUpperCase());
      }
      if (a < 0 || a >= choices.length) continue;
      q.c = choices;
      q.a = a;
    } else {
      q.a = item.answer == null ? '' : ans;
    }
    questions.push(q);
  }
  return { title: data && data.title ? String(data.title) : 'Quiz', questions };
}

function quizHtml(quiz) {
  const items = quiz.questions.map((q, i) => {
    const body = q.c
      ? `<div class="quiz-choices">${q.c.map((c, j) => `<button type="button" class="quiz-choice" data-c="${j}"><span class="quiz-letter">${String.fromCharCode(65 + j)}</span><span>${inline(c)}</span></button>`).join('')}</div>`
      : '<button type="button" class="quiz-reveal">Voir la réponse</button>';
    return `<div class="quiz-q" data-i="${i}"><div class="quiz-qtext"><b>${i + 1}.</b> ${inline(q.q)}</div>${body}<div class="quiz-feedback" hidden></div></div>`;
  }).join('');
  return `<div class="quiz-block" data-quiz="${escapeHtml(JSON.stringify(quiz))}"><div class="quiz-head"><span class="quiz-title">${escapeHtml(quiz.title)}</span><span class="quiz-score">0 / ${quiz.questions.length}</span></div>${items}<div class="quiz-result" hidden></div></div>`;
}

function cardsHtml(data) {
  const cards = data.cards.filter(c => c && c.q && c.a);
  const items = cards.map((c, i) => `<button type="button" class="flashcard"><span class="fc-num">Carte ${i + 1}</span><span class="fc-q">${inline(String(c.q))}</span><span class="fc-a">${inline(String(c.a))}</span><span class="fc-hint">Toucher pour retourner</span></button>`).join('');
  return `<div class="cards-block"><div class="quiz-head"><span class="quiz-title">${escapeHtml(data.title || 'Cartes mémoire')}</span><span class="quiz-score">${cards.length} cartes</span></div><div class="cards-grid">${items}</div></div>`;
}

// Retourne le HTML interactif, un indicateur de chargement (bloc encore ouvert) ou '' (bloc de code classique).
function renderStudyBlock(code, lang, open) {
  const kind = String(lang || '').toLowerCase();
  if (kind !== 'quiz' && kind !== 'cards') return '';
  const data = parseStudyJson(code);
  if (kind === 'quiz') {
    const quiz = data ? normalizeQuiz(data) : null;
    if (quiz && quiz.questions.length) return quizHtml(quiz);
  } else if (data && Array.isArray(data.cards) && data.cards.some(c => c && c.q && c.a)) {
    return cardsHtml(data);
  }
  if (!open) return '';
  return `<div class="study-loading"><span class="study-spinner"></span>${kind === 'quiz' ? 'Création du quiz…' : 'Création des cartes…'}</div>`;
}

function updateQuizScore(block, quiz) {
  const done = block.querySelectorAll('.quiz-q.answered');
  let good = 0;
  done.forEach(el => { if (el.dataset.ok === '1') good++; });
  const total = quiz.questions.length;
  block.querySelector('.quiz-score').textContent = good + ' / ' + total;
  if (done.length < total) return;
  const pct = Math.round(good * 100 / total);
  const note = pct >= 80 ? 'Excellent travail !' : pct >= 50 ? 'Pas mal, continue à réviser.' : 'Relis ton cours et réessaie.';
  const result = block.querySelector('.quiz-result');
  result.innerHTML = `<div class="quiz-final"><b>Score : ${good} / ${total} (${pct} %)</b><span>${note}</span></div><button type="button" class="quiz-retry">Recommencer</button>`;
  result.hidden = false;
  result.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

// Gère les clics sur les quiz et cartes ; renvoie true si le clic a été traité.
function handleQuizClick(event) {
  const card = event.target.closest('.flashcard');
  if (card) {
    card.classList.toggle('flipped');
    return true;
  }
  const block = event.target.closest('.quiz-block');
  if (!block) return false;
  let quiz;
  try { quiz = JSON.parse(block.dataset.quiz); } catch (e) { return true; }
  if (event.target.closest('.quiz-retry')) {
    block.outerHTML = quizHtml(quiz);
    return true;
  }
  const qEl = event.target.closest('.quiz-q');
  if (!qEl || qEl.classList.contains('answered')) return true;
  const q = quiz.questions[Number(qEl.dataset.i)];
  if (!q) return true;
  const feedback = qEl.querySelector('.quiz-feedback');
  const explain = q.e ? `<div class="quiz-explain">${inline(q.e)}</div>` : '';
  const choice = event.target.closest('.quiz-choice');
  const reveal = event.target.closest('.quiz-reveal');
  const self = event.target.closest('.quiz-self');
  if (choice) {
    const picked = Number(choice.dataset.c);
    const ok = picked === q.a;
    qEl.classList.add('answered');
    qEl.dataset.ok = ok ? '1' : '0';
    qEl.querySelectorAll('.quiz-choice').forEach(b => {
      const j = Number(b.dataset.c);
      if (j === q.a) b.classList.add('correct');
      else if (j === picked) b.classList.add('wrong');
      b.disabled = true;
    });
    feedback.innerHTML = `<b>${ok ? '✓ Bonne réponse !' : '✗ Mauvaise réponse.'}</b>${explain}`;
    feedback.hidden = false;
  } else if (reveal) {
    reveal.hidden = true;
    feedback.innerHTML = `<div><b>Réponse attendue :</b> ${inline(q.a)}</div>${explain}<div class="quiz-selfrow"><button type="button" class="quiz-self" data-ok="1">Je savais</button><button type="button" class="quiz-self" data-ok="0">À revoir</button></div>`;
    feedback.hidden = false;
    return true;
  } else if (self) {
    qEl.classList.add('answered');
    qEl.dataset.ok = self.dataset.ok;
    const row = qEl.querySelector('.quiz-selfrow');
    if (row) row.remove();
  } else {
    return true;
  }
  updateQuizScore(block, quiz);
  return true;
}

let classicStudyMode = "";
const studyControl = document.createElement("button"); studyControl.type = "button"; studyControl.setAttribute("role", "menuitem"); studyControl.textContent = "🎓  Étudiant"; classicToolsMenu.append(studyControl);
const studyMenu = document.createElement("div"); studyMenu.className = "classic-tools-menu"; studyMenu.setAttribute("popover", "auto"); studyMenu.setAttribute("role", "menu"); studyMenu.setAttribute("aria-label", "Mode étudiant");
for (const [mode, label] of [["", "Désactivé"], ["fiches", "Fiches de révision"], ["quiz", "Quiz interactif"], ["cartes", "Cartes mémoire"]]) {
 const button = document.createElement("button"); button.type = "button"; button.textContent = label; button.setAttribute("role", "menuitemradio"); button.dataset.study = mode;
 button.onclick = () => { classicStudyMode = mode; studyControl.textContent = mode ? `🎓  Étudiant · ${label}` : "🎓  Étudiant"; studyMenu.hidePopover(); input.focus(); }; studyMenu.append(button);
}
document.body.append(studyMenu);
studyControl.onclick = () => { classicToolsMenu.hidePopover(); for (const button of studyMenu.children) button.setAttribute("aria-checked", String(button.dataset.study === classicStudyMode)); studyMenu.showPopover(); const rect = classicToolsButton.getBoundingClientRect(), box = studyMenu.getBoundingClientRect(); studyMenu.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - box.width - 8))}px`; studyMenu.style.top = `${Math.max(8, rect.top - box.height - 8)}px`; studyMenu.querySelector("button")?.focus(); };
transcript.addEventListener("click", event => { if (event.target.closest(".quiz-block, .flashcard")) handleQuizClick(event); });
"use strict";

const POWERPOINT_INSTRUCTION = 'Création PowerPoint. Crée une présentation visuelle et soignée. Réponds par une courte introduction puis un seul bloc pptx contenant du JSON valide : {"filename":"presentation.pptx","title":"Titre","subtitle":"Sous-titre","slides":[{"title":"Titre court","layout":"visual","illustration":"earth","bullets":["Idée clé","Explication concise"],"notes":"Explications orales","image":{"url":"URL HTTPS vérifiée facultative","caption":"Légende et crédit"}}]}. L’application produit un vrai PowerPoint modifiable et sait intégrer des images : ne dis jamais que le format est limité aux titres, points et notes. Choisis une illustration pertinente parmi energy, earth, science, technology, education, economy : elle sera réellement intégrée dans la diapositive. Les photos sont facultatives : utilise image.url seulement avec une URL directe de photo vérifiée dans les sources ou fournie par l’utilisateur, jamais de lien inventé. Sans photo, les illustrations intégrées sont utilisées automatiquement ; ne remplace pas les visuels par une note « Image suggérée ». Varie layout entre hero (ouverture ou section), visual (texte et image), cards (2 à 4 idées). Limite chaque diapositive à 2 à 4 points courts, 100 caractères par point environ ; place les détails dans notes. Respecte le nombre de diapositives demandé (1 à 40), sans ajouter de couverture. La première diapositive sert d’introduction. Évite les affirmations et chiffres inventés. Ne fournis ni Python ni JavaScript ni base64 ni faux lien de téléchargement. Utilise la langue de la demande et les documents joints. Si le sujet manque, demande-le avant de produire le fichier.';

function detectsPowerPointRequest(text) {
  const value = String(text || '');
  return /\b(power\s?point|pptx|diaporama|pr[ée]sentation)\b/i.test(value) &&
    /(cr[ée]+|g[ée]n[èe]re|fais|faire|pr[ée]pare|r[ée]alise|produis|make|create|generate|je veux|j.aimerais)/i.test(value);
}

function isPowerPointPrompt(text) {
  return String(text || '').startsWith('Création PowerPoint.');
}

function isPowerPointFollowup(text, conversation) {
  const messages = conversation && conversation.messages || [];
  const previous = messages.filter(m => m.role === 'user').pop();
  return Boolean(previous && isPowerPointPrompt(previous.prompt) &&
    /ajout|modifi|refai|recommence|amélior|change|remplace|avec.{0,30}(image|photo|visuel)|plus.{0,20}(beau|visuel|moderne)/i.test(text));
}

function parsePowerPoint(code) {
  const source = String(code || '').trim();
  if (source.length > 200000) throw new Error('Cette présentation est trop volumineuse.');
  let data;
  try { data = JSON.parse(source); } catch { throw new Error('La présentation est incomplète ou son format est invalide. Demandez de la régénérer.'); }
  if (!data || !Array.isArray(data.slides) || !data.slides.length || data.slides.length > 40) throw new Error('La présentation doit contenir entre 1 et 40 diapositives.');
  const text = (value, max, label) => {
    if (value == null) return '';
    if (typeof value !== 'string' || value.length > max) throw new Error(label + ' invalide ou trop long.');
    return value.trim();
  };
  return {
    title: text(data.title, 180, 'Titre') || 'Présentation',
    subtitle: text(data.subtitle, 350, 'Sous-titre'),
    filename: typeof data.filename === 'string' ? data.filename : '',
    slides: data.slides.map((slide, index) => {
      if (!slide || typeof slide !== 'object') throw new Error('Diapositive invalide.');
      const bullets = slide.bullets ?? (typeof slide.content === 'string' ? slide.content.split('\n').filter(Boolean) : []);
      if (!Array.isArray(bullets) || bullets.length > 40) throw new Error('Liste de points invalide.');
      return {
        title: text(slide.title, 180, 'Titre de diapositive') || 'Diapositive ' + (index + 1),
        bullets: bullets.map(item => text(item, 3000, 'Point')).filter(Boolean),
        notes: text(slide.notes, 15000, 'Notes'),
        layout: ['hero', 'visual', 'cards'].includes(slide.layout) ? slide.layout : '',
        illustration: ['energy', 'earth', 'science', 'technology', 'education', 'economy'].includes(slide.illustration) ? slide.illustration : '',
        image: slide.image && typeof slide.image.url === 'string' && /^https:\/\//i.test(slide.image.url) ? {
          url: text(slide.image.url, 2048, 'URL image'), caption: text(slide.image.caption, 300, 'Légende')
        } : null
      };
    })
  };
}

function powerPointFileName(code) {
  let name = 'presentation';
  try {
    const data = parsePowerPoint(code);
    name = data.filename || data.title;
  } catch { /* Le téléchargement expliquera le problème de format. */ }
  name = name.replace(/\.pptx$/i, '').replace(/[<>:"/\\|?*\x00-\x1f]/g, '-').replace(/^\.+|[. ]+$/g, '').slice(0, 100);
  return (name || 'presentation') + '.pptx';
}

// Paginate dense content rather than dropping points or shrinking to unreadable text.
function powerPointPages(data) {
  const pages = [];
  for (const slide of data.slides) {
    let items = [], lines = 0, part = 0;
    const flush = () => {
      pages.push({ ...slide, title: slide.title + (part ? ' (suite)' : ''), bullets: items, notes: slide.notes });
      items = []; lines = 0; part++;
    };
    for (const bullet of slide.bullets) {
      // Keep each paragraph at a readable size while retaining every character.
      const segments = bullet.match(/[\s\S]{1,350}(?:\s|$)|[\s\S]{1,350}/g) || [];
      for (const segment of segments) {
        const cost = Math.ceil(segment.length / 48) + 1;
        if (items.length && lines + cost > 10) flush();
        items.push(segment.trim()); lines += cost;
      }
    }
    if (items.length || !part) flush();
  }
  return pages;
}

async function makePowerPoint(code) {
  const data = parsePowerPoint(code);
  const Generator = typeof PptxGenJS === 'function' ? PptxGenJS : window.pptxgen;
  if (typeof Generator !== 'function') throw new Error('Le générateur PowerPoint est indisponible. Relancez l’application.');
  const deck = new Generator();
  deck.layout = 'LAYOUT_WIDE';
  deck.author = 'FranceStudent';
  deck.subject = data.subtitle;
  deck.title = data.title;
  deck.lang = 'fr-FR';
  deck.theme = { headFontFace: 'Aptos Display', bodyFontFace: 'Aptos', lang: 'fr-FR' };
  const pages = powerPointPages(data);
  for (const [index, page] of pages.entries()) {
    const slide = deck.addSlide();
    const hero = page.layout === 'hero' || (!page.layout && index === 0);
    const cards = !hero && (page.layout === 'cards' || (!page.layout && index % 3 === 2)) && page.bullets.length >= 2 && page.bullets.length <= 4 && page.bullets.every(item => item.length <= 150);
    const bg = hero ? '142D3B' : 'F5F4EE';
    const ink = hero ? 'EDF5EB' : '142D3B';
    const accent = hero ? '87DEC1' : '247D68';
    slide.background = { color: bg };
    const rect = (x,y,w,h,color) => slide.addShape(deck.ShapeType.rect, { x,y,w,h,fill:{color},line:{transparency:100} });
    const label = (value,x,y,w,h,size,color=ink,bold=false,extra={}) => slide.addText(value,{x,y,w,h,fontFace:'Aptos',fontSize:size,color,bold,margin:0,breakLine:false,fit:'shrink',valign:'mid',...extra});
    rect(.6,.5,.45,.06,accent);
    label(String(index+1).padStart(2,'0')+'  /  '+String(pages.length).padStart(2,'0'),1.2,.38,2,.3,10,accent,true);
    label(page.title,.65,.95,cards?12:7,hero?1.65:1.35,hero?36:30,ink,true);
    if (cards) {
      const n=Math.max(page.bullets.length,1), columns=n>2?2:n;
      page.bullets.forEach((item,i)=>{
        const x=.65+(i%columns)*6.1, y=2.65+Math.floor(i/columns)*1.8;
        rect(x,y,5.75,1.55,'FFFFFF'); rect(x,y,.05,1.55,accent);
        label(String(i+1).padStart(2,'0'),x+.25,y+.2,.5,.35,14,accent,true);
        label(item,x+.95,y+.18,4.5,1.15,22);
      });
    } else {
      if (page.bullets.length) {
        const runs=page.bullets.map(item=>({text:item,options:{bullet:{indent:17},hanging:4,breakLine:true}}));
        label(runs,.75,hero?3:2.65,6.65,hero?3.45:3.85,22,ink,false,{paraSpaceAfter:17,valign:'top'});
      } else if (index===0 && data.subtitle) label(data.subtitle,.75,3,6.4,2,25,ink);
      let picture = null;
      if (page.image) picture = await loadPowerPointPhoto(page.image.url);
      const key = page.illustration || powerPointIllustration(page.title+' '+page.bullets.join(' '));
      if (!picture && typeof POWERPOINT_VISUALS !== 'undefined') picture = POWERPOINT_VISUALS[key];
      if (picture) slide.addImage({data:picture,x:8,y:1.7,w:4.65,h:4.185});
      if (page.image && picture && picture !== (typeof POWERPOINT_VISUALS !== 'undefined' && POWERPOINT_VISUALS[key])) label(page.image.caption,8,6.3,4.65,.35,10,hero?'A6C0BE':'526B71');
    }
    rect(.65,6.92,12,.012,hero?'345360':'D3DCD6');
    label(data.title,.65,7.08,10.6,.2,9,hero?'A6C0BE':'526B71');
    label(String(index+1),11.65,7.04,1,.26,11,accent,true,{align:'right'});
    if (page.notes) slide.addNotes(page.notes);
  }
  return new Uint8Array(await deck.write({ outputType: 'arraybuffer', compression: true }));
}

function powerPointIllustration(text) {
  if (/énerg|energ|solaire|électri|electric/i.test(text)) return 'energy';
  if (/climat|terre|planet|environ|écolog|ocean|océan/i.test(text)) return 'earth';
  if (/scien|chim|moléc|molec|biolog|santé|physiq/i.test(text)) return 'science';
  if (/tech|numéri|digital|informati|intelligence|réseau/i.test(text)) return 'technology';
  if (/économ|econom|financ|marché|entreprise|croissance/i.test(text)) return 'economy';
  return 'education';
}

async function loadPowerPointPhoto(url) {
  // Le téléchargement se fait uniquement à la création explicite du fichier.
  if (typeof fetch !== 'function' || typeof FileReader !== 'function') return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000);
  try {
    const response = await fetch(url, { signal: controller.signal, credentials: 'omit' });
    if (!response.ok || !/^image\/(png|jpeg|webp)/i.test(response.headers.get('content-type') || '')) return null;
    const blob = await response.blob();
    if (blob.size > 8*1024*1024) return null;
    const data = await new Promise((resolve, reject) => {
      const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(blob);
    });
    // Recadrage sans déformation, au format de la zone de la diapositive.
    const image = new Image();
    image.src = data;
    await image.decode();
    const canvas = document.createElement('canvas');
    canvas.width = 1000; canvas.height = 900;
    const ctx = canvas.getContext('2d');
    const scale = Math.max(1000 / image.width, 900 / image.height);
    ctx.drawImage(image, (1000-image.width*scale)/2, (900-image.height*scale)/2, image.width*scale, image.height*scale);
    return canvas.toDataURL('image/png');
  } catch { return null; } finally { clearTimeout(timer); }
}
"use strict";
const POWERPOINT_VISUALS = {"energy": "data:image/png;base64,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", "earth": "data:image/png;base64,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", "science": "data:image/png;base64,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", "technology": "data:image/png;base64,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", "education": "data:image/png;base64,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", "economy": "data:image/png;base64,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"};
/* Aperçus locaux des pièces jointes et documents générés. */
let previewDbPromise = null;
const sessionPreviewFiles = new Map();
function openAttachmentPreviewDb() {
    if (!previewDbPromise) previewDbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open("francestudent-desktop-previews", 1);
        request.onupgradeneeded = () => request.result.createObjectStore("files", { keyPath:"id" });
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
    });
    return previewDbPromise;
}
async function rememberAttachmentPreview(file, name) {
    const id = crypto.randomUUID();
    if (ui.status.incognito) { sessionPreviewFiles.set(id, { blob:file, name }); return id; }
    try {
        const db = await openAttachmentPreviewDb();
        await new Promise((resolve, reject) => {
            const transaction = db.transaction("files", "readwrite"), store = transaction.objectStore("files");
            store.put({ id, name, blob:file, size:file.size, created:Date.now() });
            const request = store.getAll();
            request.onsuccess = () => {
                const records = request.result.sort((a,b) => a.created - b.created);
                let total = records.reduce((sum, item) => sum + (item.size || 0), 0);
                for (const item of records) { if (total <= 200 * 1024 * 1024) break; if (item.id !== id) { store.delete(item.id); total -= item.size || 0; } }
            };
            transaction.oncomplete = resolve; transaction.onerror = () => reject(transaction.error); transaction.onabort = () => reject(transaction.error);
        });
        return id;
    } catch { studioFeedback("L’aperçu local ne peut pas être conservé après l’envoi."); return null; }
}
async function attachmentPreviewBlob(item) {
    if (item.previewId) {
        const memory = sessionPreviewFiles.get(item.previewId); if (memory) return memory.blob;
        try {
            const db = await openAttachmentPreviewDb();
            const saved = await new Promise((resolve,reject) => { const r=db.transaction("files").objectStore("files").get(item.previewId); r.onsuccess=()=>resolve(r.result); r.onerror=()=>reject(r.error); });
            if (saved?.blob) return saved.blob;
        } catch { /* données anciennes ou stockage indisponible */ }
    }
    if (typeof item.data === "string" && /^data:/i.test(item.data)) {
        const match = /^data:([^;,]*)(?:;[^,]*)?;base64,([a-z0-9+/=\s]+)$/i.exec(item.data);
        if (!match || item.data.length > 36 * 1024 * 1024) throw new Error("Pièce jointe illisible ou trop volumineuse.");
        const raw = atob(match[2].replace(/\s/g, "")), bytes = new Uint8Array(raw.length);
        for (let i=0;i<raw.length;i++) bytes[i]=raw.charCodeAt(i);
        return new Blob([bytes], {type:match[1] || "application/octet-stream"});
    }
    if (item.kind === "text" && typeof item.data === "string") return new Blob([item.data], {type:"text/plain"});
    throw new Error("L’original n’est plus disponible sur cet ordinateur. Joins-le à nouveau.");
}
async function openAttachmentPreview(item) {
    try { await showAttachmentBlob(item.name || "Fichier", await attachmentPreviewBlob(item)); }
    catch (error) { studioFeedback(`Aperçu impossible : ${error.message}`); }
}
function previewButtonFor(item, content) {
    const button = document.createElement("button"); button.type="button"; button.className="attachment-preview-button";
    button.title=`Aperçu de ${item.name}`; button.setAttribute("aria-label", `Aperçu de ${item.name}`);
    button.append(content); button.onclick=()=>openAttachmentPreview(item); return button;
}
async function showAttachmentBlob(name, blob, options = {}) {
    const dialog = document.createElement("dialog"); dialog.className="fs-dialog attachment-preview-dialog"; dialog.setAttribute("aria-label", `Aperçu de ${name}`);
    const title=document.createElement("h2"); title.textContent=name;
    const close=document.createElement("button"); close.type="button"; close.textContent="Fermer"; close.onclick=()=>dialog.close();
    const head=document.createElement("header"); head.append(title,close);
    const body=document.createElement("div"); body.className="attachment-preview-body";
    const status=document.createElement("p"); status.setAttribute("role","status"); status.textContent="Chargement de l’aperçu…"; body.append(status);
    dialog.append(head,body); document.body.append(dialog); let objectUrl=null, pdf=null;
    dialog.addEventListener("close",()=>{ pdf?.destroy().catch(()=>{}); if(objectUrl) URL.revokeObjectURL(objectUrl); dialog.remove(); options.returnFocus?.focus(); },{once:true});
    dialog.showModal(); close.focus();
    try {
        const ext = fileExtension(name);
        if (options.presentation) {
            const presentation=parsePowerPoint(options.presentation); body.replaceChildren();
            const note=document.createElement("p"); note.className="settings-help"; note.textContent="Aperçu du contenu des diapositives ; la mise en page du fichier téléchargé peut différer."; body.append(note);
            presentation.slides.forEach((slide,index)=>{ const card=document.createElement("section"); card.className="attachment-preview-slide"; const heading=document.createElement("h3"); heading.textContent=`${index+1}. ${slide.title}`; card.append(heading); const list=document.createElement("ul"); for(const value of slide.bullets){const li=document.createElement("li");li.textContent=value;list.append(li);} card.append(list); body.append(card); });
        } else if (blob.type === "application/pdf" || ext === "pdf") {
            const pdfjs=await import(new URL("vendor/pdf.min.mjs", location.href).href);
            pdfjs.GlobalWorkerOptions.workerSrc=new URL("vendor/pdf.worker.min.mjs", location.href).href;
            pdf=await pdfjs.getDocument({ data:new Uint8Array(await blob.arrayBuffer()), isEvalSupported:false }).promise;
            if (!dialog.open) { await pdf.destroy(); pdf=null; return; }
            body.replaceChildren();
            for(let pageNo=1;pageNo<=Math.min(pdf.numPages,20);pageNo++) {
                const page=await pdf.getPage(pageNo), base=page.getViewport({scale:1});
                const scale=Math.min(1.3,1200/Math.max(base.width,base.height),Math.sqrt(2000000/(base.width*base.height)));
                const viewport=page.getViewport({scale});
                const canvas=document.createElement("canvas"); canvas.width=Math.max(1,Math.ceil(viewport.width));canvas.height=Math.max(1,Math.ceil(viewport.height));canvas.setAttribute("aria-label",`Page ${pageNo}`);body.append(canvas);
                await page.render({canvasContext:canvas.getContext("2d"),viewport}).promise; if(!dialog.open)return; page.cleanup();
            }
            if(pdf.numPages>20){const more=document.createElement("p");more.textContent=`20 pages affichées sur ${pdf.numPages}.`;body.append(more);}
        } else if (/^image\/(?:png|jpeg|webp|gif|svg\+xml)$/i.test(blob.type) || /^(?:png|jpg|jpeg|webp|gif|svg)$/.test(ext)) {
            const imageType = ({jpg:"image/jpeg",jpeg:"image/jpeg",png:"image/png",webp:"image/webp",gif:"image/gif",svg:"image/svg+xml"})[ext];
            objectUrl=URL.createObjectURL(imageType && !blob.type.startsWith("image/") ? new Blob([blob],{type:imageType}) : blob); const img=document.createElement("img"); img.src=objectUrl; img.alt=`Aperçu de ${name}`; body.replaceChildren(img);
        } else if (["docx","pptx","xlsx","odt","odp","ods"].includes(ext)) {
            const extracted=await api.previewOffice(name, await readAsDataUrl(blob));
            const note=document.createElement("p");note.className="settings-help";note.textContent="Texte extrait localement ; la mise en page et les images peuvent différer.";
            const pre=document.createElement("pre");pre.textContent=extracted || "Aucun texte disponible.";body.replaceChildren(note,pre);
        } else if (/^(txt|md|csv|json|js|ts|py|html|css|xml|yml|yaml|log|sql|sh|java|c|cpp|rs|go|tex)$/.test(ext) || blob.type.startsWith("text/")) {
            const pre=document.createElement("pre"); pre.textContent=(await blob.text()).slice(0,1000000); body.replaceChildren(pre);
        } else { status.textContent="Aperçu indisponible pour ce format. Le fichier peut être téléchargé ou ouvert dans une application compatible."; }
    } catch(error) { if(dialog.open) { status.textContent=`Aperçu impossible : ${error.message}`; body.replaceChildren(status); } }
}
/* Budget et historique du compte, issus des mêmes données que le mobile. */
const desktopAppearanceCard = document.createElement("section");
desktopAppearanceCard.className = "settings-card";
desktopAppearanceCard.dataset.settingsGroup = "general";
desktopAppearanceCard.innerHTML = '<h3>Apparence</h3><p class="settings-help">Thèmes disponibles sur cet ordinateur.</p><div class="appearance-choices" role="group" aria-label="Thème de l’application"><button type="button" data-theme-choice="original"><span class="appearance-preview appearance-original" aria-hidden="true"></span>Sombre original</button><button type="button" data-theme-choice="midnight"><span class="appearance-preview appearance-midnight" aria-hidden="true"></span>Minuit</button></div><p class="settings-help" data-appearance-status role="status"></p>';
mobileLibrarySettings.before(desktopAppearanceCard);
function renderDesktopAppearance() {
    desktopAppearanceCard.querySelectorAll("[data-theme-choice]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.themeChoice === studioEditorPreferences.theme)));
}
desktopAppearanceCard.querySelectorAll("[data-theme-choice]").forEach(button => button.onclick = async () => {
    const status = desktopAppearanceCard.querySelector("[data-appearance-status]");
    desktopAppearanceCard.querySelectorAll("button").forEach(item => item.disabled = true);
    try { applyStudioEditorPreferences(await api.editorPreferences("save", { ...studioEditorPreferences, theme: button.dataset.themeChoice })); status.textContent = "Apparence enregistrée."; }
    catch (error) { status.textContent = error.message; }
    finally { desktopAppearanceCard.querySelectorAll("button").forEach(item => item.disabled = false); }
});
renderDesktopAppearance();
const desktopAccountDetails = document.createElement("section");
desktopAccountDetails.className = "settings-card account-activity-card";
desktopAccountDetails.dataset.settingsGroup = "account";
desktopAccountDetails.innerHTML = '<div class="account-section-heading"><h3>Budget du jour</h3><button type="button" data-budget-refresh aria-label="Actualiser le budget">↻</button></div><div class="account-budget-line"><span>Utilisé</span><strong data-budget-value>—</strong></div><progress data-budget-progress max="100" value="0" aria-label="Budget utilisé"></progress><p class="settings-help" data-budget-status>Chargement du budget…</p><div class="account-section-heading account-activity-heading"><h3>Activité tokens</h3><button type="button" data-activity-refresh aria-label="Actualiser l’activité">↻</button></div><p class="settings-help" data-activity-status role="status">Historique journalier sur les 343 derniers jours.</p><div data-activity-content></div>';
accountSettingsCard.after(desktopAccountDetails);
const previousAccountQuotaRender = renderQuota;
renderQuota = function() {
    previousAccountQuotaRender();
    const quota = ui.quota, percent = quota?.percent == null ? null : Math.max(0, Math.min(100, Number(quota.percent)));
    desktopAccountDetails.querySelector("[data-budget-value]").textContent = percent == null || !Number.isFinite(percent) ? "—" : `${quota.uncertain ? "≈ " : ""}${percent} %`;
    desktopAccountDetails.querySelector("[data-budget-progress]").value = Number.isFinite(percent) ? percent : 0;
    const reset = quota?.resetAt ? new Date(quota.resetAt) : null;
    desktopAccountDetails.querySelector("[data-budget-status]").textContent = ui.quotaError || (percent == null ? (ui.quotaLoading ? "Chargement du budget…" : "Budget indisponible.") : `${100 - percent} % restant${reset && !Number.isNaN(reset.getTime()) ? " · Réinitialisation le " + reset.toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" }) : ""}`);
};
desktopAccountDetails.querySelector("[data-budget-refresh]").onclick = () => void refreshQuota();
desktopAccountDetails.querySelector("[data-activity-refresh]").onclick = () => void loadDesktopAccountActivity();
const desktopActivityNumber = value => new Intl.NumberFormat("fr-FR", { notation: "compact", maximumFractionDigits: 1 }).format(value);
async function loadDesktopAccountActivity() {
    const epoch = accountSettingsEpoch, button = desktopAccountDetails.querySelector("[data-activity-refresh]");
    const status = desktopAccountDetails.querySelector("[data-activity-status]"), content = desktopAccountDetails.querySelector("[data-activity-content]");
    if (button.disabled) return;
    button.disabled = true; status.textContent = "Chargement de l’activité…";
    try {
        const data = await api.accountTokenActivity();
        if (epoch !== accountSettingsEpoch) return;
        const days = new Map(data.rows.map(row => [row.date, row])), rows = [...days.values()];
        const sum = key => rows.reduce((total, row) => total + row[key], 0);
        const peak = rows.reduce((best, row) => row.totalTokens > best.totalTokens ? row : best, { date: "", totalTokens: 0 });
        const metrics = centerNode("div", "account-activity-metrics");
        for (const [label, value] of [["Tokens totaux", data.totalTokenCount], ["Pic journalier", rows.length ? peak.totalTokens : null], ["Jours actifs", rows.length ? rows.filter(row => row.totalTokens > 0).length : null], ["Moyenne / jour renseigné", rows.length ? sum("totalTokens") / rows.length : null]]) {
            const metric = centerNode("div"); metric.append(centerNode("strong", "", value == null ? "—" : desktopActivityNumber(value)), centerNode("span", "", label)); metrics.append(metric);
        }
        content.replaceChildren(metrics);
        if (rows.length) {
            const calendar = centerNode("div", "account-calendar-box");
            calendar.append(centerNode("strong", "", `${new Intl.NumberFormat("fr-FR").format(sum("totalTokens"))} tokens · ${rows.length} jours renseignés`));
            const scroll = centerNode("div", "account-calendar-scroll"), grid = centerNode("div", "account-calendar-grid");
            const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
            const end = new Date(today + "T00:00:00Z").getTime();
            for (let index = 0; index < 343; index++) {
                const date = new Date(end - (342 - index) * 86400000).toISOString().slice(0, 10), row = days.get(date);
                const cell = centerNode("button", "account-calendar-cell"); cell.type = "button";
                cell.dataset.level = row && row.totalTokens > 0 ? String(Math.max(1, Math.ceil(row.totalTokens / Math.max(peak.totalTokens, 1) * 4))) : "0";
                cell.classList.toggle("unreported", !row);
                cell.title = `${date} : ${row ? new Intl.NumberFormat("fr-FR").format(row.totalTokens) + " tokens" : "aucune donnée reçue"}`;
                cell.setAttribute("aria-label", cell.title); cell.tabIndex = index === 0 ? 0 : -1;
                cell.onclick = () => { status.textContent = cell.title; };
                cell.onkeydown = event => {
                    const delta = { ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 }[event.key];
                    if (!delta) return;
                    event.preventDefault(); const next = grid.children[Math.max(0, Math.min(grid.children.length - 1, index + delta))];
                    if (next) { cell.tabIndex = -1; next.tabIndex = 0; next.focus(); }
                };
                grid.append(cell);
            }
            scroll.append(grid); calendar.append(scroll, centerNode("p", "settings-help", "Clair = activité élevée · pointillés = aucune donnée reçue.")); content.append(calendar);
            const breakdown = centerNode("p", "settings-help", `Entrée : ${desktopActivityNumber(sum("inputTokens"))} · Sortie : ${desktopActivityNumber(sum("outputTokens"))} · Réflexion : ${desktopActivityNumber(sum("reasoningTokens"))}`);
            content.append(breakdown);
        }
        status.textContent = rows.length ? "Historique journalier disponible sur les 343 derniers jours." : "Aucun historique journalier disponible.";
    } catch (error) { if (epoch === accountSettingsEpoch) status.textContent = `Activité indisponible : ${error.message}`; }
    finally { button.disabled = false; }
}
const clearActivityAccountSettings = clearAccountSettings;
clearAccountSettings = function() {
    clearActivityAccountSettings(); accountAvatarOwner = ""; renderAccountAvatar();
    desktopAccountDetails.querySelector("[data-activity-content]").replaceChildren();
    desktopAccountDetails.querySelector("[data-activity-status]").textContent = "Connecte-toi pour consulter ton activité.";
};
renderQuota();
filterSettingsCards();
/* Sélecteurs des paramètres : le select existant reste la source de vérité. */
const settingsModelMenus = new WeakMap();
let settingsModelMenuSequence = 0;
function syncSettingsModelMenu(select) {
    const menu = settingsModelMenus.get(select);
    if (menu) menu.sync();
}
function createSettingsModelMenu(select, label, imageModels = false) {
    const root = centerNode("div", "settings-model-picker");
    const trigger = centerNode("button", "settings-model-trigger"); trigger.type = "button";
    const icon = centerNode("span", "settings-model-icon"); icon.setAttribute("aria-hidden", "true");
    const name = centerNode("span", "settings-model-name");
    const chevron = centerNode("span", "settings-model-chevron", "⌄"); chevron.setAttribute("aria-hidden", "true");
    trigger.append(icon, name, chevron);
    trigger.setAttribute("aria-label", label); trigger.setAttribute("aria-haspopup", "listbox"); trigger.setAttribute("aria-expanded", "false");
    const list = centerNode("div", "settings-model-list"); list.id = `settings-model-list-${++settingsModelMenuSequence}`;
    list.setAttribute("role", "listbox"); list.setAttribute("aria-label", label); list.hidden = true; trigger.setAttribute("aria-controls", list.id);
    select.hidden = true; select.setAttribute("aria-hidden", "true"); select.tabIndex = -1;
    select.after(root); root.append(trigger, list);
    function info(option) { return { name: option.textContent, provider: imageModels ? "OpenAI" : option.dataset.provider, model: option.dataset.model }; }
    function optionIcon(option) {
        if (!option || (!imageModels && option.value === "")) return centerNode("span", "settings-model-sparkle", "✧");
        const logo = modelLogo(info(option), "settings-model-logo");
        if (logo) { logo.alt = ""; return logo; }
        const mark = centerNode("span", "settings-model-generic", "◇"); mark.setAttribute("aria-hidden", "true"); return mark;
    }
    function close(restoreFocus = false) {
        list.hidden = true; trigger.setAttribute("aria-expanded", "false");
        if (restoreFocus && !trigger.disabled && trigger.isConnected) trigger.focus();
    }
    function sync() {
        const option = select.selectedOptions[0];
        name.textContent = option?.textContent || "Choisir un modèle";
        trigger.setAttribute("aria-label", `${label} : ${name.textContent}`);
        icon.replaceChildren(optionIcon(option));
        trigger.disabled = select.matches(":disabled");
        if (trigger.disabled) close();
        if (!list.hidden) renderList();
    }
    function renderList() {
        list.replaceChildren();
        let lastGroup = "";
        for (const option of select.options) {
            if (option.hidden) continue;
            const vendor = modelVendor(info(option));
            const group = !imageModels && !option.value ? "" : vendor === "gpt" ? "OpenAI" : vendor === "claude" ? "Anthropic" : vendor === "gemini" ? "Google" : "Autres modèles";
            if (!imageModels && group && group !== lastGroup) {
                const heading = centerNode("div", "settings-model-group", group); heading.setAttribute("aria-hidden", "true"); list.append(heading);
            }
            lastGroup = group;
            const item = centerNode("button", "settings-model-option"); item.type = "button";
            item.setAttribute("role", "option"); item.setAttribute("aria-selected", String(option.selected)); item.disabled = option.disabled; item.tabIndex = -1;
            const mark = optionIcon(option); mark.setAttribute("aria-hidden", "true");
            const text = centerNode("span", "settings-model-option-name", option.textContent);
            const check = centerNode("span", "settings-model-check", option.selected ? "✓" : ""); check.setAttribute("aria-hidden", "true");
            item.append(mark, text, check);
            item.onclick = () => {
                if (select.value !== option.value) { select.value = option.value; select.dispatchEvent(new Event("change", { bubbles: true })); }
                sync(); close(true);
            };
            list.append(item);
        }
    }
    function open() {
        if (trigger.disabled) return;
        document.querySelectorAll(".settings-model-picker").forEach(other => { if (other !== root) other.dispatchEvent(new Event("settings-model-close")); });
        renderList(); list.hidden = false; trigger.setAttribute("aria-expanded", "true");
        (list.querySelector('[aria-selected="true"]:not(:disabled)') || list.querySelector('[role="option"]:not(:disabled)'))?.focus();
    }
    trigger.onclick = () => { if (list.hidden) open(); else close(); };
    trigger.onkeydown = event => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); open(); } };
    list.onkeydown = event => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); return; }
        const options = [...list.querySelectorAll('[role="option"]:not(:disabled)')], index = options.indexOf(document.activeElement);
        if (!options.length) return;
        let next;
        if (event.key === "ArrowDown") next = (index + 1) % options.length;
        else if (event.key === "ArrowUp") next = (index - 1 + options.length) % options.length;
        else if (event.key === "Home") next = 0;
        else if (event.key === "End") next = options.length - 1;
        else return;
        event.preventDefault(); options[next].focus();
    };
    root.addEventListener("settings-model-close", () => close());
    root.addEventListener("keydown", event => { if (event.key === "Tab") setTimeout(() => close(), 0); });
    document.addEventListener("click", event => { if (!root.contains(event.target)) close(); });
    select.addEventListener("change", sync);
    const observer = new MutationObserver(sync);
    observer.observe(select, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled", "label", "selected", "hidden"] });
    const fieldset = select.closest("fieldset");
    if (fieldset) observer.observe(fieldset, { attributes: true, attributeFilter: ["disabled"] });
    settingsModelMenus.set(select, { sync }); sync();
}
createSettingsModelMenu($("settings-default-model"), "Modèle par défaut");
createSettingsModelMenu(mobileImageFields.querySelector("[data-image-model]"), "Modèle d’image", true);
/* Indicateur de la copie expérimentale ; les contrôles habituels restent disponibles. */
const codexEngineBadge=document.createElement("span");
codexEngineBadge.id="codex-engine-status";
codexEngineBadge.setAttribute("role","status");
codexEngineBadge.textContent="Codex · expérimental";
codexEngineBadge.title="Moteur Codex avec les modèles du compte FranceStudent";
codexEngineBadge.style.cssText="font-size:12px;color:var(--fg-dim);margin-left:8px";
document.title="FranceStudent IDE — Codex (copie expérimentale)";
(document.querySelector("#agent .agent-tabs")||document.querySelector(".workspace-titlebar-brand"))?.append(codexEngineBadge);
api.onEvent((channel,data)=>{
    if(channel!=="status")return;
    codexEngineBadge.textContent=ui.motionDesign?"Motion":data.mode==="chat"?"Chat FranceStudent":data.agentEngine==="codex"?"Codex · expérimental":"Agent historique";
});
/* Connexions Code : aucune modification de préférences dans Studio ou Blender. */
async function showCreativePlugin(kind) {
    const blender = kind === "blender", title = blender ? "Blender · FranceStudent Connect" : "Roblox Studio · MCP officiel";
    const dialog = document.createElement("dialog"); dialog.id = `creative-plugin-${kind}`; dialog.className = "fs-dialog creative-plugin-dialog";
    studioSurfaceHeader(dialog, { title, subtitle: "Connecte l’agent Code à une application ouverte sur cet ordinateur.", icon: "tools" });
    const status = centerNode("p", "creative-plugin-status", "Vérification de l’installation…"); status.setAttribute("role", "status");
    const instructions = centerNode("p", "settings-help", blender
        ? "Ouvre une nouvelle fenêtre Blender connectée, ou ajoute FranceStudent Connect à une fenêtre existante. Les scripts Python restent désactivés tant que tu ne les autorises pas dans Blender."
        : "Dans Roblox Studio à jour : Assistant → … → Manage MCP Servers → Enable Studio as MCP server. Le plugin utilise le serveur fourni par Roblox.");
    const actions = centerNode("div", "creative-plugin-actions"), message = centerNode("p", "settings-feedback", ""); message.setAttribute("role", "status");
    let data;
    const refresh = async () => {
        data = await api.creativePlugins("status"); const item = data[kind];
        placeInstalledPlugin(kind, Boolean(item.installed)); filterPlugins();
        status.textContent = `${item.available ? "Application détectée" : blender ? "Exécutable Blender à choisir" : "Lanceur MCP Studio non détecté"} · ${item.configured ? "MCP configuré" : "MCP à configurer"}`;
    };
    const action = (label, callback, primary = false) => {
        const button = centerNode("button", primary ? "primary" : "", label); button.type = "button";
        button.onclick = async () => {
            for (const control of actions.querySelectorAll("button")) control.disabled = true;
            message.textContent = "En cours…";
            try { await callback(); await refresh(); }
            catch (error) { message.textContent = error.message; }
            finally { for (const control of actions.querySelectorAll("button")) control.disabled = false; }
        };
        actions.append(button); return button;
    };
    action("Configurer le plugin", async () => { await api.creativePlugins("configure", kind); message.textContent = "MCP configuré. Vérifie maintenant la connexion avec l’application ouverte."; }, true);
    if (blender) {
        action("Choisir Blender…", async () => { const selected = await api.creativePlugins("chooseBlender"); message.textContent = selected ? "Exécutable Blender enregistré." : "Sélection annulée."; });
        action("Ouvrir Blender connecté", async () => { const result = await api.creativePlugins("launchBlender"); message.textContent = result.message; });
        action("Enregistrer l’extension Blender…", async () => { const result = await api.creativePlugins("exportAddon"); message.textContent = result ? "Extension enregistrée. Dans Blender : Préférences → Extensions/Add-ons → Installer depuis un fichier. Active-la, puis indique le fichier IDE ci-dessous dans le panneau FranceStudent de la vue 3D." : "Enregistrement annulé."; });
    } else action("Guide officiel Roblox", async () => { await api.openExternal("https://create.roblox.com/docs/studio/mcp", true); message.textContent = "Guide officiel ouvert."; });
    action("Vérifier la connexion", async () => {
        const result = await api.creativePlugins("verify", kind);
        const text = JSON.stringify(result.result, null, 2);
        message.textContent = result.message + "\n" + text.slice(0, 12000);
    });
    const details = centerNode("details", "creative-plugin-details"), summary = centerNode("summary", "", "Détails de connexion"), pathLabel = centerNode("code", "");
    details.append(summary, pathLabel);
    const close = centerNode("button", "", "Fermer"); close.type = "button"; close.onclick = () => dialog.close();
    const footer = centerNode("div", "fs-dialog-footer"); footer.append(close);
    dialog.append(status, instructions, actions, details, message, footer); document.body.append(dialog);
    dialog.addEventListener("close", () => dialog.remove(), { once: true }); dialog.showModal();
    try { await refresh(); pathLabel.textContent = blender ? `Fichier IDE : ${data.blender.sessionFile}\nLes connexions sont locales ; aucune scène n’est publiée automatiquement.` : "Serveur : Roblox_Studio\nCommence par lister les sessions Studio, puis choisis leur studio_id. Les outils de génération Roblox peuvent utiliser les crédits de Roblox."; }
    catch (error) { status.textContent = error.message; }
}
// Logos Simple Icons (CC0) ; voir assets/plugin-logos-NOTICE.md.
const creativePluginLogos = {"roblox":"<svg aria-hidden=\"true\" fill=\"#00a2ff\" viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M 13.936 15.356 L 1.826 12.112 L 0 18.93 L 18.928 24 L 21.608 14.01 L 14.79 12.18 L 13.936 15.356 Z M 5.072 0 L 2.394 9.992 L 9.21 11.822 L 10.064 8.644 L 22.174 11.89 L 24 5.072 L 5.072 0 Z\"/></svg>","blender":"<svg aria-hidden=\"true\" fill=\"#e87d0d\" viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M12.51 13.214c.046-.8.438-1.506 1.03-2.006a3.424 3.424 0 0 1 2.212-.79c.85 0 1.631.3 2.211.79.592.5.983 1.206 1.028 2.005.045.823-.285 1.586-.865 2.153a3.389 3.389 0 0 1-2.374.938 3.393 3.393 0 0 1-2.376-.938c-.58-.567-.91-1.33-.865-2.152M7.35 14.831c.006.314.106.922.256 1.398a7.372 7.372 0 0 0 1.593 2.757 8.227 8.227 0 0 0 2.787 2.001 8.947 8.947 0 0 0 3.66.76 8.964 8.964 0 0 0 3.657-.772 8.285 8.285 0 0 0 2.785-2.01 7.428 7.428 0 0 0 1.592-2.762 6.964 6.964 0 0 0 .25-3.074 7.123 7.123 0 0 0-1.016-2.779 7.764 7.764 0 0 0-1.852-2.043h.002L13.566 2.55l-.02-.015c-.492-.378-1.319-.376-1.86.002-.547.382-.609 1.015-.123 1.415l-.001.001 3.126 2.543-9.53.01h-.013c-.788.001-1.545.518-1.695 1.172-.154.665.38 1.217 1.2 1.22V8.9l4.83-.01-8.62 6.617-.034.025c-.813.622-1.075 1.658-.563 2.313.52.667 1.625.668 2.447.004L7.414 14s-.069.52-.063.831zm12.09 1.741c-.97.988-2.326 1.548-3.795 1.55-1.47.004-2.827-.552-3.797-1.538a4.51 4.51 0 0 1-1.036-1.622 4.282 4.282 0 0 1 .282-3.519 4.702 4.702 0 0 1 1.153-1.371c.942-.768 2.141-1.183 3.396-1.185 1.256-.002 2.455.41 3.398 1.175.48.391.87.854 1.152 1.367a4.28 4.28 0 0 1 .522 1.706 4.236 4.236 0 0 1-.239 1.811 4.54 4.54 0 0 1-1.035 1.626\"/></svg>"};
for (const entry of document.querySelectorAll("[data-creative-plugin]")) {
    entry.querySelector(".plugin-entry-icon").innerHTML = creativePluginLogos[entry.dataset.creativePlugin];
    entry.onclick = () => showCreativePlugin(entry.dataset.creativePlugin);
}
/* Destination et budget réel du prochain envoi, indépendants des messages de statut. */
const composerStatus=document.createElement('div');composerStatus.className='composer-status-line';
const composerScope=centerNode('span','composer-scope');composerScope.id='composer-scope';
const composerQuota=centerNode('button','composer-quota');composerQuota.type='button';composerQuota.id='composer-quota';
composerQuota.innerHTML='<span class="composer-quota-label"></span><span class="composer-quota-track" role="progressbar" aria-label="Quota restant" aria-valuemin="0" aria-valuemax="100"><span></span></span>';
composerQuota.onclick=()=>{browserHomeClosePage();setAgentTab('usage');};
composerStatus.append(composerScope,composerQuota);$('composer-feedback').before(composerStatus);
function renderComposerQuota(){
 const button=$('composer-quota');if(!button)return;
 const used=ui.quota?.percent==null?null:Number(ui.quota.percent),known=used!==null&&Number.isFinite(used),remaining=known?Math.max(0,Math.min(100,100-used)):null;
 const bar=button.querySelector('[role="progressbar"]');
 button.dataset.tone=!known?'unknown':used>=90?'red':used>=75?'orange':used>=50?'yellow':'green';
 button.querySelector('.composer-quota-label').textContent=known?`Quota restant : ${ui.quota.uncertain?'≈ ':''}${Math.round(remaining*10)/10} %`:ui.quotaLoading?'Quota : actualisation…':'Quota indisponible';
 bar.style.setProperty('--remaining',`${remaining??0}%`);
 if(known){bar.setAttribute('aria-valuenow',String(remaining));bar.removeAttribute('aria-valuetext');}else{bar.removeAttribute('aria-valuenow');bar.setAttribute('aria-valuetext','Indisponible');}
 button.title=ui.quotaError||`Quota du compte FranceStudent${ui.quotaUpdatedAt?' · actualisé à '+new Date(ui.quotaUpdatedAt).toLocaleTimeString('fr-FR',{hour:'2-digit',minute:'2-digit'}):''} · Voir les détails`;
}
function renderComposerScope(){
 if(!$('composer-scope'))return;
 if(isMotionOpen())composerScope.textContent='Motion · Projet EffectCraft';
 else if(ui.status.mode==='chat'){const selected=franceStudentProjects.find(project=>String(project.id)===$('agent-fr-project').value);composerScope.textContent=selected?`Chat · ${selected.name}`:'Chat · Historique général';}
 else composerScope.textContent=ui.workspace?`Code · ${ui.workspace.replace(/[\\/]+$/,'').split(/[\\/]/).pop()}`:'Code · Choisis un projet';
 composerScope.title=ui.status.mode==='chat'?composerScope.textContent:ui.workspace||composerScope.textContent;
 const button=$('codex-rail-new');if(button)button.title='Nouvelle discussion · '+composerScope.textContent;
}
$('agent-fr-project').addEventListener('change',renderComposerScope);
api.onEvent(channel=>{if(channel==='status'||channel==='signedOut'){renderComposerScope();renderComposerQuota();}});
new MutationObserver(renderComposerScope).observe($('app'),{attributes:true,attributeFilter:['class']});
renderComposerScope();renderComposerQuota();
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
        const result = await api.bootstrap();
        if (result.origin) connectionOrigin = result.origin;
        if(result.credentialWarning)studioFeedback(result.credentialWarning);
        if (!result.ok) {
            openConnectionGuide(1);
            if (!result.needsLogin) guideError(result.reason);
        }
    } catch (err) {
        openConnectionGuide(1);
        guideError(err);
    }
    refreshQuota();
    setInterval(refreshQuota, 15 * 60 * 1000);
})();
