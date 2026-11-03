"use strict";
// Lecture des sources supplémentaires explicitement choisies ; aucun accès Motion.
const fs = require("node:fs/promises"), path = require("node:path");
const { state } = require("../state"), { CONFIG } = require("../config");
const { resolveInWorkspace, assertRealInside, normalizeRelative } = require("./security");
const { readTextFile } = require("./core/freshness"), { walkFiles } = require("./core/walk");
const { requireString, optionalString, optionalInt } = require("./core/args");
async function run(args) {
    if (state.motionDesign) throw new Error("Les dossiers code ne sont pas accessibles en Motion design.");
    if (!state.workspace) throw new Error("Aucun projet ouvert.");
    const config = await require("../project/project-sources").get(state.workspace);
    if (args.action === "sources") return { sources: config.sources.map(source => ({ id: source.id, name: path.basename(source.path), path: source.path })), message: "Dossiers supplémentaires accessibles en lecture seule." };
    const source = config.sources.find(item => item.id === args.source);
    if (!source) throw new Error("Dossier source introuvable ou retiré du projet.");
    const root = await fs.realpath(source.path);
    normalizeRelative(path.relative(path.parse(root).root, root) || ".");
    const norm = value => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
    if (norm(root) !== norm(source.path)) throw new Error("Le dossier source a changé depuis sa sélection ; ajoute-le à nouveau.");
    const { rel, target } = await resolveInWorkspace(root, args.path || ".");
    await assertRealInside(root, target);
    if (args.action === "list") {
        const entries = [];
        for (const item of await fs.readdir(target, { withFileTypes: true })) {
            if (item.isSymbolicLink()) continue;
            const child = rel === "." ? item.name : `${rel}/${item.name}`;
            try { normalizeRelative(child); } catch { continue; }
            if (item.isDirectory() || item.isFile()) entries.push({ path: child, type: item.isDirectory() ? "directory" : "file" });
        }
        entries.sort((a, b) => a.type === b.type ? a.path.localeCompare(b.path, "fr") : a.type === "directory" ? -1 : 1);
        return { source: source.id, path: rel, entries: entries.slice(0, CONFIG.maxDirectoryEntries), truncated: entries.length > CONFIG.maxDirectoryEntries };
    }
    if (args.action === "read") {
        const text = await readTextFile(target), lines = text.split("\n"), start = Math.max(1, args.start_line || 1), end = Math.min(lines.length, args.end_line || lines.length);
        if (start > end) throw new Error("Plage de lignes invalide.");
        const content = lines.slice(start - 1, end).join("\n");
        return { source: source.id, path: rel, range: [start, end], total_lines: lines.length, content: content.slice(0, CONFIG.maxReadChars), truncated: content.length > CONFIG.maxReadChars };
    }
    const files = await walkFiles(target, rel, { maxFiles: CONFIG.maxSearchFiles }), matches = [], query = args.query.toLocaleLowerCase("fr");
    let scanned = 0;
    for (const file of files) {
        if (matches.length >= CONFIG.maxSearchResults) break;
        try {
            await resolveInWorkspace(root, file.rel); await assertRealInside(root, file.abs);
            const text = await readTextFile(file.abs); scanned++;
            if (!text.toLocaleLowerCase("fr").includes(query)) continue;
            const lines = text.split("\n");
            for (let i = 0; i < lines.length && matches.length < CONFIG.maxSearchResults; i++) if (lines[i].toLocaleLowerCase("fr").includes(query)) matches.push({ path: file.rel, line: i + 1, text: lines[i].trim().slice(0, 200) });
        } catch { /* Fichier illisible, binaire ou devenu inaccessible. */ }
    }
    return { source: source.id, query: args.query, matches, scanned, truncated: matches.length >= CONFIG.maxSearchResults || files.length >= CONFIG.maxSearchFiles, message: `${matches.length} résultat(s) dans ${scanned} fichier(s).` };
}
function check(args) {
    if (!["sources", "list", "read", "search"].includes(args.action)) throw new Error("Action invalide : sources, list, read ou search.");
    if (args.action !== "sources") requireString(args.source, "source");
    if (args.action === "read") requireString(args.path, "path"); else optionalString(args.path, "path");
    if (args.action === "search") { const query = requireString(args.query, "query"); if (query.length > 500) throw new Error("Recherche trop longue."); }
    optionalInt(args.start_line, "start_line"); optionalInt(args.end_line, "end_line");
}
module.exports = { name: "project_sources", run, check, describe: args => `${args.action} · ${args.source || "dossiers"}${args.path ? ` · ${args.path}` : ""}` };
