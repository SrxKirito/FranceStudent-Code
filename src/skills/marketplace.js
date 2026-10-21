"use strict";

/**
 * Marketplace de skills : télécharge des skills depuis un dépôt GitHub publié
 * au format « plugin marketplace » de Claude Code (.claude-plugin/marketplace.json),
 * par exemple le dépôt officiel anthropics/skills.
 *
 *   - fetchMarketplace(source) : liste à plat des skills proposés ;
 *   - installSkill(name, opts) : copie le dossier du skill (SKILL.md + annexes)
 *     dans le dossier utilisateur ou projet.
 *
 * Sécurité : noms et chemins validés (pas de .., pas de chemin absolu), limites
 * de taille et de nombre de fichiers, SKILL.md obligatoire, écriture dans un
 * dossier temporaire puis renommage.
 */

const fs = require("node:fs/promises");
const path = require("node:path");
const { SKILL_FILE, parseFrontmatter, userSkillsDir, projectSkillsDir } = require("./index");

const DEFAULT_SOURCE = "anthropics/skills";
const MARKETPLACE_FILE = ".claude-plugin/marketplace.json";
const MAX_FILES = 200;
const MAX_FILE_BYTES = 2_000_000;
const MAX_TOTAL_BYTES = 10_000_000;
const MAX_DEPTH = 6;
const TIMEOUT_MS = 20_000;
const USER_AGENT = "francestudents-ide";

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const SEGMENT_RE = /^[A-Za-z0-9_.@+ -]+$/;

/** "owner/repo", "owner/repo@ref" ou URL github.com → { owner, repo, ref, id }. */
function parseSource(source) {
    const raw = String(source || DEFAULT_SOURCE).trim()
        .replace(/^https?:\/\/github\.com\//i, "")
        .replace(/\.git$/i, "")
        .replace(/\/+$/, "");
    const m = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)(?:@([A-Za-z0-9_.\/-]+))?$/.exec(raw);

    if (!m || m[1].startsWith(".") || m[2].startsWith(".") || (m[3] && m[3].includes(".."))) {
        throw new Error(`Source de marketplace invalide : ${source}. Format attendu : owner/repo[@ref].`);
    }

    return { owner: m[1], repo: m[2], ref: m[3] || "HEAD", id: `${m[1]}/${m[2]}` };
}

/** Chemin relatif sûr ("./skills/xlsx" → "skills/xlsx", "./" → ""), ou null. */
function safeRelPath(value) {
    if (typeof value !== "string") return null;
    if (value.startsWith("/") || value.startsWith("\\") || /^[A-Za-z]:/.test(value)) return null;
    const parts = value.replace(/\\/g, "/").split("/").filter(p => p && p !== ".");
    if (parts.some(p => p === ".." || !SEGMENT_RE.test(p))) return null;
    return parts.join("/");
}

function encodePath(p) {
    return p.split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

function rawUrl(src, p) {
    return `https://raw.githubusercontent.com/${src.owner}/${src.repo}/${encodeURIComponent(src.ref)}/${encodePath(p)}`;
}

function contentsUrl(src, p) {
    return `https://api.github.com/repos/${src.owner}/${src.repo}/contents/${encodePath(p)}?ref=${encodeURIComponent(src.ref)}`;
}

async function request(url, opts = {}) {
    const doFetch = opts.fetch || globalThis.fetch;
    const headers = { "User-Agent": USER_AGENT };
    const isApi = url.startsWith("https://api.github.com/");

    if (isApi) {
        headers.Accept = "application/vnd.github+json";
        if (process.env.GITHUB_TOKEN) headers.Authorization = `Bearer ${process.env.GITHUB_TOKEN}`;
    }

    const init = { headers };
    if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) init.signal = AbortSignal.timeout(TIMEOUT_MS);

    const res = await doFetch(url, init);
    if (!res.ok) {
        const hint = res.status === 403 && isApi ? " (limite de l'API GitHub atteinte ? définissez GITHUB_TOKEN)" : "";
        throw new Error(`HTTP ${res.status} sur ${url}${hint}`);
    }
    return res;
}

async function fetchJson(url, opts) {
    const res = await request(url, opts);
    try {
        return await res.json();
    } catch {
        throw new Error(`JSON invalide : ${url}`);
    }
}

async function fetchText(url, opts) {
    const res = await request(url, opts);
    return res.text();
}

async function fetchBuffer(url, opts) {
    const res = await request(url, opts);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_FILE_BYTES) throw new Error(`Fichier trop volumineux : ${url}`);
    return buf;
}

/**
 * Liste des skills d'un marketplace.
 * @returns {Promise<{source:string, name:string, skills:Array<{name:string, plugin:string, description:string, path:string}>}>}
 */
async function fetchMarketplace(source, opts = {}) {
    const src = parseSource(source);
    const index = await fetchJson(rawUrl(src, MARKETPLACE_FILE), opts);
    const plugins = Array.isArray(index && index.plugins) ? index.plugins : [];
    const skills = [];
    const seen = new Set();

    for (const plugin of plugins) {
        if (!plugin || typeof plugin.source !== "string" || !Array.isArray(plugin.skills)) continue;
        const base = safeRelPath(plugin.source);
        if (base === null) continue;

        for (const entry of plugin.skills) {
            const rel = safeRelPath(entry);
            if (!rel) continue;
            const full = base ? `${base}/${rel}` : rel;
            const name = path.posix.basename(full).toLowerCase();
            if (!NAME_RE.test(name) || seen.has(name)) continue;
            seen.add(name);
            skills.push({
                name,
                plugin: String(plugin.name || ""),
                description: String(plugin.description || "").replace(/\s+/g, " ").trim(),
                path: full
            });
        }
    }

    if (opts.descriptions !== false) {
        await Promise.all(skills.map(async skill => {
            try {
                const text = await fetchText(rawUrl(src, `${skill.path}/${SKILL_FILE}`), opts);
                const desc = String(parseFrontmatter(text).meta.description || "").replace(/\s+/g, " ").trim();
                if (desc) skill.description = desc;
            } catch {
                // description du plugin conservée
            }
        }));
    }

    return { source: src.id, name: String((index && index.name) || src.id), skills };
}

/** Liste récursive des fichiers d'un dossier via l'API contents de GitHub. */
async function listRemoteFiles(src, root, opts, rel = "", depth = 0, acc = []) {
    if (depth > MAX_DEPTH) throw new Error(`Arborescence trop profonde : ${root}`);
    const dirPath = rel ? `${root}/${rel}` : root;
    const entries = await fetchJson(contentsUrl(src, dirPath), opts);
    if (!Array.isArray(entries)) throw new Error(`Dossier introuvable dans ${src.id} : ${dirPath}`);

    for (const entry of entries) {
        if (!entry || typeof entry.name !== "string") continue;
        if (entry.name === "." || entry.name === ".." || !SEGMENT_RE.test(entry.name)) continue;
        const childRel = rel ? `${rel}/${entry.name}` : entry.name;

        if (entry.type === "dir") {
            await listRemoteFiles(src, root, opts, childRel, depth + 1, acc);
        } else if (entry.type === "file") {
            if (Number(entry.size) > MAX_FILE_BYTES) throw new Error(`Fichier trop volumineux : ${childRel}`);
            acc.push({ rel: childRel, size: Number(entry.size) || 0 });
            if (acc.length > MAX_FILES) throw new Error(`Trop de fichiers dans le skill (max ${MAX_FILES}).`);
        }
        // liens symboliques et sous-modules ignorés
    }
    return acc;
}

async function exists(p) {
    try {
        await fs.access(p);
        return true;
    } catch {
        return false;
    }
}

/**
 * Télécharge et installe un skill du marketplace.
 * @param {string} name
 * @param {{source?:string, scope?:string, workspace?:string, force?:boolean, fetch?:Function}} opts
 */
async function installSkill(name, opts = {}) {
    const wanted = String(name || "").trim().toLowerCase();
    if (!NAME_RE.test(wanted)) throw new Error(`Nom de skill invalide : ${name}`);

    const src = parseSource(opts.source);
    const market = await fetchMarketplace(opts.source, { ...opts, descriptions: false });
    const skill = market.skills.find(s => s.name === wanted);
    if (!skill) {
        const names = market.skills.map(s => s.name);
        throw new Error(`Skill absent du marketplace ${src.id} : ${name}. Disponibles : ${names.join(", ") || "aucun"}.`);
    }

    return installFolder(src, skill.path, skill.name, skill.plugin, opts);
}

/** Copie un dossier distant (SKILL.md + annexes) dans le dossier des skills utilisateur ou projet. */
async function installFolder(src, remotePath, skillName, plugin, opts = {}) {
    const skill = { name: skillName, plugin: String(plugin || ""), path: remotePath };
    const projectScope = opts.scope === "projet" || opts.scope === "project";
    const base = projectScope ? projectSkillsDir(opts.workspace) : userSkillsDir();
    if (!base) throw new Error("Aucun projet ouvert : impossible d'installer le skill dans le projet.");

    const dest = path.join(base, skill.name);
    const already = await exists(dest);
    if (already && !opts.force) {
        throw new Error(`Le skill existe déjà : ${dest} (utilisez l'option force pour le remplacer).`);
    }

    const files = await listRemoteFiles(src, skill.path, opts);
    if (!files.some(f => f.rel === SKILL_FILE)) throw new Error(`${SKILL_FILE} absent du skill ${skill.name}.`);

    await fs.mkdir(base, { recursive: true });
    const tmp = path.join(base, `.${skill.name}.tmp-${process.pid}-${Date.now()}`);
    let total = 0;

    try {
        await fs.mkdir(tmp, { recursive: true });

        for (const file of files) {
            const target = path.resolve(tmp, ...file.rel.split("/"));
            const relCheck = path.relative(tmp, target);
            if (!relCheck || relCheck.startsWith("..") || path.isAbsolute(relCheck)) {
                throw new Error(`Chemin refusé : ${file.rel}`);
            }

            const buf = await fetchBuffer(rawUrl(src, `${skill.path}/${file.rel}`), opts);
            total += buf.length;
            if (total > MAX_TOTAL_BYTES) throw new Error(`Skill trop volumineux (max ${MAX_TOTAL_BYTES} octets).`);

            await fs.mkdir(path.dirname(target), { recursive: true });
            await fs.writeFile(target, buf);
        }

        const { meta } = parseFrontmatter(await fs.readFile(path.join(tmp, SKILL_FILE), "utf8"));
        if (!meta.name && !meta.description) {
            throw new Error(`${SKILL_FILE} invalide : frontmatter name/description manquant.`);
        }

        if (already) {
            const backup = `${tmp}.old`;
            await fs.rename(dest, backup);
            try {
                await fs.rename(tmp, dest);
            } catch (err) {
                await fs.rename(backup, dest).catch(() => {});
                throw err;
            }
            await fs.rm(backup, { recursive: true, force: true });
        } else {
            await fs.rename(tmp, dest);
        }
    } catch (err) {
        await fs.rm(tmp, { recursive: true, force: true }).catch(() => {});
        throw err;
    }

    return {
        name: skill.name,
        plugin: skill.plugin,
        source: src.id,
        scope: projectScope ? "projet" : "utilisateur",
        dir: dest,
        file: path.join(dest, SKILL_FILE),
        files: files.length,
        bytes: total,
        replaced: already
    };
}

/* ---------- SkillsMP (https://skillsmp.com) : recherche dans l'annuaire, puis téléchargement GitHub ---------- */

const SKILLSMP_SEARCH = "https://skillsmp.com/api/v1/skills/search";

/** "https://github.com/owner/repo/tree/<branche>/<chemin>" (ou dépôt seul) → { src, path }. */
function parseGithubUrl(url) {
    const m = /^https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/tree\/([A-Za-z0-9_.-]+)(?:\/(.*))?)?\/?$/.exec(String(url || "").trim());
    if (!m || m[1].startsWith(".") || m[2].startsWith(".") || (m[3] && m[3].includes(".."))) {
        throw new Error(`URL GitHub invalide : ${url}`);
    }
    let decoded;
    try {
        decoded = decodeURIComponent(m[4] || "");
    } catch {
        throw new Error(`URL GitHub invalide : ${url}`);
    }
    const rel = safeRelPath(decoded);
    if (rel === null) throw new Error(`Chemin refusé dans l'URL : ${url}`);
    return {
        src: { owner: m[1], repo: m[2], ref: m[3] || "HEAD", id: `${m[1]}/${m[2]}` },
        path: rel
    };
}

function toSkillName(value) {
    return String(value || "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^[-_]+|[-_]+$/g, "").slice(0, 64);
}

/**
 * Recherche par mot-clé dans l'annuaire SkillsMP (50 requêtes/jour sans clé ; clé gratuite via SKILLSMP_API_KEY).
 * @returns {Promise<{skills:Array, pagination:object}>}
 */
async function searchSkillsmp(query, opts = {}) {
    const q = String(query || "").trim();
    // Requête vide autorisée seulement pour le « top » trié par étoiles (sortBy: "stars").
    const top = !q && opts.sortBy === "stars";
    if (!top && !/[\p{L}\p{N}]/u.test(q)) throw new Error("Saisis un mot-clé (lettres ou chiffres).");

    const params = new URLSearchParams();
    // L'API exige un q concret (400 MISSING_QUERY sinon, jokers non supportés) : le « top » utilise un mot-clé générique trié par étoiles.
    params.set("q", top ? "skill" : q.slice(0, 200));
    params.set("page", String(Math.max(1, Math.floor(Number(opts.page)) || 1)));
    params.set("limit", String(Math.min(50, Math.max(1, Math.floor(Number(opts.limit)) || 20))));
    if (opts.sortBy === "recent" || opts.sortBy === "stars") params.set("sortBy", opts.sortBy);

    const headers = { "User-Agent": USER_AGENT, Accept: "application/json" };
    const key = opts.apiKey || process.env.SKILLSMP_API_KEY;
    if (key) headers.Authorization = `Bearer ${key}`;
    const init = { headers };
    if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) init.signal = AbortSignal.timeout(TIMEOUT_MS);

    const res = await (opts.fetch || globalThis.fetch)(`${SKILLSMP_SEARCH}?${params}`, init);
    let body = null;
    try {
        body = await res.json();
    } catch {
        // réponse non JSON
    }
    if (!res.ok || !body || body.success === false) {
        const code = body && body.error && body.error.code;
        const hint = res.status === 429
            ? " Quota SkillsMP atteint (50 recherches/jour sans clé) : définis SKILLSMP_API_KEY (clé gratuite sur skillsmp.com/developers)."
            : "";
        throw new Error(`SkillsMP : HTTP ${res.status}${code ? ` ${code}` : ""}.${hint}`);
    }

    const data = body.data || {};
    const skills = (Array.isArray(data.skills) ? data.skills : [])
        .filter(s => s && typeof s.githubUrl === "string")
        .map(s => ({
            id: String(s.id || ""),
            name: String(s.name || ""),
            installName: toSkillName(s.name),
            author: String(s.author || ""),
            description: String(s.description || "").replace(/\s+/g, " ").trim(),
            githubUrl: s.githubUrl,
            skillUrl: typeof s.skillUrl === "string" ? s.skillUrl : "",
            stars: Number(s.stars) || 0,
            updatedAt: Number(s.updatedAt) || 0
        }));

    return { skills, pagination: data.pagination || {} };
}

/**
 * Télécharge un skill depuis l'URL GitHub de son dossier (ex. githubUrl renvoyé par SkillsMP).
 * @param {string} url
 * @param {{name?:string, scope?:string, workspace?:string, force?:boolean, fetch?:Function}} opts
 */
async function installFromGithub(url, opts = {}) {
    const { src, path: remotePath } = parseGithubUrl(url);
    const name = toSkillName(opts.name || path.posix.basename(remotePath) || src.repo);
    if (!NAME_RE.test(name)) throw new Error(`Nom de skill invalide : ${opts.name || url}`);
    return installFolder(src, remotePath, name, src.id, opts);
}

module.exports = {
    DEFAULT_SOURCE,
    parseSource,
    safeRelPath,
    parseGithubUrl,
    fetchMarketplace,
    installSkill,
    searchSkillsmp,
    installFromGithub
};
