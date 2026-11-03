"use strict";
// Métadonnées locales du projet : les dossiers ne sont jamais déplacés ni copiés.
const fs = require("node:fs/promises"), path = require("node:path"), { randomUUID } = require("node:crypto");
const FILE = path.join(require("../config").CONFIG.dataDir, "project-sources.json");
const key = value => process.platform === "win32" ? path.resolve(value).toLowerCase() : path.resolve(value);
let pending = Promise.resolve();
async function read() {
    try { const data = JSON.parse(await fs.readFile(FILE, "utf8")); return data && typeof data === "object" && !Array.isArray(data) ? data : {}; }
    catch (error) { if (error.code === "ENOENT") return {}; throw new Error(`Configuration des projets illisible : ${error.message}`); }
}
function defaultName(root) { return path.basename(root.replace(/[\\/]+$/, "")) || root; }
async function get(root) {
    if (!root) throw new Error("Aucun dossier principal.");
    const entry = (await read())[key(root)];
    return { root, name: typeof entry?.name === "string" && entry.name.trim() ? entry.name : defaultName(root), sources: Array.isArray(entry?.sources) ? entry.sources.filter(item => item && typeof item.id === "string" && typeof item.path === "string") : [] };
}
async function save(root, name, paths) {
    if (!root || !path.isAbsolute(root)) throw new Error("Dossier principal invalide.");
    if (typeof name !== "string" || !name.trim() || name.trim().length > 100) throw new Error("Le nom doit contenir entre 1 et 100 caractères.");
    if (!Array.isArray(paths) || paths.length > 20 || paths.some(item => typeof item !== "string" || !path.isAbsolute(item))) throw new Error("Liste de dossiers invalide (20 maximum).");
    const job = pending.catch(() => {}).then(async () => {
        const primary = await fs.realpath(root);
        if (!(await fs.stat(primary)).isDirectory()) throw new Error("Le dossier principal doit être un dossier.");
        const old = await get(primary), seen = new Set([key(primary)]), sources = [];
        for (const value of paths) {
            const real = await fs.realpath(value), info = await fs.stat(real);
            if (!info.isDirectory()) throw new Error("Chaque source doit être un dossier.");
            require("../tools/security").normalizeRelative(path.relative(path.parse(real).root, real) || ".");
            if (seen.has(key(real))) throw new Error("Ce dossier est déjà présent dans le projet.");
            seen.add(key(real));
            const previous = old.sources.find(item => key(item.path) === key(real));
            sources.push({ id: previous?.id || `source-${randomUUID()}`, path: real });
        }
        const records = await read(); records[key(primary)] = { name: name.trim(), sources };
        await fs.mkdir(path.dirname(FILE), { recursive: true, mode: 0o700 });
        const tmp = `${FILE}.${process.pid}.tmp`;
        await fs.writeFile(tmp, JSON.stringify(records, null, 2), { mode: 0o600 }); await fs.rename(tmp, FILE);
        return { root: primary, name: name.trim(), sources };
    });
    pending = job; return job;
}
module.exports = { get, save, FILE };
