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
