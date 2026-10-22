"use strict";

/**
 * Backend des modules 22 (centre d'extensions), 23 (cockpit du projet) et 26 (recherche).
 * Portage adapté de extraopaa/francestudents-ide : les API d'origine (extensionAction,
 * mcpManage, projectStudio, webResearch) sont recréées ici en réutilisant les modules
 * locaux (src/skills, src/mcp/manager, src/tools/web-fetch).
 * Aucune commande n'est lancée sans action explicite de l'utilisateur dans l'interface.
 */

const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const { spawn, execFile } = require("node:child_process");

const MAX_LOG_CHARS = 200_000;
const MAX_RUNS = 30;
const MAX_JOBS = 20;
const IS_WINDOWS = process.platform === "win32";

function classify(name) {
    const n = String(name).toLowerCase();
    if (/(^|:)(dev|start|serve|watch|preview)/.test(n)) return "dev";
    if (/test|spec|e2e/.test(n)) return "test";
    if (/build|compile|bundle|dist|pack/.test(n)) return "build";
    if (/lint|format|prettier|eslint|check|type/.test(n)) return "quality";
    return "other";
}

async function readJson(file) {
    try {
        return JSON.parse((await fsp.readFile(file, "utf8")).replace(/^\uFEFF/, ""));
    } catch {
        return null;
    }
}

function exists(file) {
    try {
        return fs.existsSync(file);
    } catch {
        return false;
    }
}

function killTree(child) {
    if (!child || child.exitCode !== null) return;
    if (IS_WINDOWS) {
        execFile("taskkill", ["/pid", String(child.pid), "/T", "/F"], () => {});
    } else {
        try {
            process.kill(-child.pid, "SIGTERM");
        } catch {
            child.kill("SIGTERM");
        }
    }
}

function createStudioBackend({ getWorkspace, send }) {
    const runs = [];
    const children = new Map();
    const jobs = [];
    let seq = 0;

    function workspace() {
        const ws = getWorkspace();
        if (!ws) throw new Error("Aucun projet ouvert.");
        return ws;
    }

    /* ---------- Cockpit du projet ---------- */

    function customFile(ws) {
        return path.join(ws, ".frst", "tasks.json");
    }

    async function customTasks(ws) {
        const data = await readJson(customFile(ws));
        return Array.isArray(data) ? data.filter((t) => t && t.id && t.name && t.command) : [];
    }

    async function detectTasks(ws) {
        const tasks = [];
        const pkg = await readJson(path.join(ws, "package.json"));
        let packageManager = null;
        if (pkg) {
            packageManager = exists(path.join(ws, "pnpm-lock.yaml")) ? "pnpm"
                : exists(path.join(ws, "yarn.lock")) ? "yarn"
                    : exists(path.join(ws, "bun.lockb")) ? "bun" : "npm";
            for (const [name, script] of Object.entries(pkg.scripts || {})) {
                tasks.push({
                    id: `npm:${name}`,
                    name,
                    description: String(script).slice(0, 300),
                    command: `${packageManager} run ${name}`,
                    source: "package.json",
                    kind: classify(name)
                });
            }
        }
        if (exists(path.join(ws, "Cargo.toml"))) {
            for (const [name, kind] of [["build", "build"], ["test", "test"], ["run", "dev"], ["clippy", "quality"]]) {
                tasks.push({ id: `cargo:${name}`, name: `cargo ${name}`, description: "Commande Cargo", command: `cargo ${name}`, source: "Cargo.toml", kind });
            }
        }
        if (exists(path.join(ws, "go.mod"))) {
            for (const [name, kind] of [["build", "build"], ["test", "test"], ["vet", "quality"]]) {
                tasks.push({ id: `go:${name}`, name: `go ${name}`, description: "Commande Go", command: `go ${name} ./...`, source: "go.mod", kind });
            }
        }
        for (const task of await customTasks(ws)) {
            tasks.push({ id: task.id, name: task.name, description: "Commande personnelle", command: task.command, source: "personnelle", kind: "custom" });
        }
        return { tasks, pkg, packageManager };
    }

    function detectStack(ws, pkg) {
        const stack = [];
        const deps = pkg ? { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) } : {};
        if (pkg) stack.push("Node.js");
        for (const [dep, label] of [["typescript", "TypeScript"], ["react", "React"], ["vue", "Vue"], ["svelte", "Svelte"], ["next", "Next.js"], ["vite", "Vite"], ["electron", "Electron"], ["express", "Express"]]) {
            if (deps[dep]) stack.push(label);
        }
        if (exists(path.join(ws, "Cargo.toml"))) stack.push("Rust");
        if (exists(path.join(ws, "go.mod"))) stack.push("Go");
        if (exists(path.join(ws, "pyproject.toml")) || exists(path.join(ws, "requirements.txt"))) stack.push("Python");
        if (exists(path.join(ws, ".git"))) stack.push("Git");
        return stack;
    }

    async function detectDocs(ws) {
        let entries = [];
        try {
            entries = await fsp.readdir(ws, { withFileTypes: true });
        } catch {
            return [];
        }
        return entries
            .filter((e) => e.isFile() && /^(readme|contributing|changelog|architecture|guide|docs?|agents|claude)[\w.-]*\.(md|markdown|txt)$/i.test(e.name))
            .map((e) => e.name)
            .sort();
    }

    function publicRun(run) {
        const { log, ...rest } = run;
        return { ...rest, logChars: log.length };
    }

    async function overview() {
        const ws = getWorkspace();
        if (!ws) {
            return { workspace: null, name: "Aucun projet", description: "", stack: [], tasks: [], docs: [], packageManager: null, runs: runs.map(publicRun) };
        }
        const { tasks, pkg, packageManager } = await detectTasks(ws);
        return {
            workspace: ws,
            name: (pkg && pkg.name) || path.basename(ws),
            description: (pkg && pkg.description) || "",
            stack: detectStack(ws, pkg),
            tasks,
            docs: await detectDocs(ws),
            packageManager,
            runs: runs.map(publicRun)
        };
    }

    async function start(id) {
        const ws = workspace();
        const { tasks } = await detectTasks(ws);
        const task = tasks.find((t) => t.id === id);
        if (!task) throw new Error("Commande introuvable.");
        if (runs.some((r) => r.taskId === id && r.status === "running")) throw new Error("Cette commande est déjà en cours.");
        const run = { id: `run-${++seq}`, taskId: id, name: task.name, command: task.command, status: "running", startedAt: Date.now(), endedAt: null, exitCode: null, log: "" };
        runs.push(run);
        while (runs.length > MAX_RUNS) {
            const index = runs.findIndex((r) => r.status !== "running");
            if (index < 0) break;
            runs.splice(index, 1);
        }
        const child = IS_WINDOWS
            ? spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", task.command], { cwd: ws, windowsHide: true })
            : spawn("/bin/sh", ["-c", task.command], { cwd: ws, detached: true });
        children.set(run.id, child);
        const append = (chunk) => {
            run.log += chunk.toString("utf8");
            if (run.log.length > MAX_LOG_CHARS) run.log = "[…début tronqué…]\n" + run.log.slice(-MAX_LOG_CHARS);
            send("projectStudio", { type: "output", id: run.id });
        };
        child.stdout.on("data", append);
        child.stderr.on("data", append);
        child.on("error", (error) => {
            run.log += `\n${error.message}\n`;
        });
        child.on("close", (codeValue) => {
            children.delete(run.id);
            run.endedAt = Date.now();
            run.exitCode = codeValue;
            if (run.status === "running") run.status = codeValue === 0 ? "passed" : "failed";
            send("projectStudio", { type: "status", id: run.id, status: run.status });
        });
        send("projectStudio", { type: "status", id: run.id, status: run.status });
        return publicRun(run);
    }

    function stop(id) {
        const run = runs.find((r) => r.id === id);
        if (!run) throw new Error("Exécution introuvable.");
        if (run.status === "running") {
            run.status = "stopped";
            killTree(children.get(id));
        }
        return publicRun(run);
    }

    async function addCustom(name, command) {
        const ws = workspace();
        const label = String(name || "").trim().slice(0, 100);
        const cmd = String(command || "").trim().slice(0, 8000);
        if (!label || !cmd) throw new Error("Nom et commande obligatoires.");
        const list = await customTasks(ws);
        const id = `custom:${Date.now().toString(36)}`;
        list.push({ id, name: label, command: cmd });
        await fsp.mkdir(path.dirname(customFile(ws)), { recursive: true });
        await fsp.writeFile(customFile(ws), JSON.stringify(list, null, 2) + "\n", "utf8");
        return { id };
    }

    async function removeCustom(id) {
        const ws = workspace();
        if (!String(id).startsWith("custom:")) throw new Error("Seules les commandes personnelles peuvent être retirées.");
        const list = (await customTasks(ws)).filter((t) => t.id !== id);
        await fsp.writeFile(customFile(ws), JSON.stringify(list, null, 2) + "\n", "utf8");
        return true;
    }

    function version(program, args) {
        return new Promise((resolve) => {
            execFile(program, args, { timeout: 8000, windowsHide: true, shell: IS_WINDOWS }, (error, stdout) => {
                resolve(error ? { ok: false, value: "introuvable" } : { ok: true, value: String(stdout).trim().split("\n")[0] });
            });
        });
    }

    async function environment() {
        const [node, npm, git] = await Promise.all([version("node", ["--version"]), version("npm", ["--version"]), version("git", ["--version"])]);
        return [{ name: "Node.js", ...node }, { name: "npm", ...npm }, { name: "Git", ...git }];
    }

    async function projectStudio(action, payload = {}) {
        switch (action) {
case "overview": return overview();
        case "runs": return runs.map(publicRun);
        case "log": {
            const run = runs.find((r) => r.id === payload.id);
            if (!run) throw new Error("Exécution introuvable.");
            return { ...publicRun(run), log: run.log };
        }
        case "start": return start(String(payload.id || ""));
        case "stop": return stop(String(payload.id || ""));
        case "clear":
            for (let i = runs.length - 1; i >= 0; i--) if (runs[i].status !== "running") runs.splice(i, 1);
            return runs.map(publicRun);
        case "add": return addCustom(payload.name, payload.command);
        case "remove": return removeCustom(String(payload.id || ""));
        case "environment": return environment();
        default: throw new Error(`Action inconnue : ${action}`);
        }
    }

    /* ---------- Recherche Internet en arrière-plan (DuckDuckGo HTML) ---------- */

    function cleanHtml(text) {
        const { decodeEntities } = require("../src/tools/web-fetch");
        return decodeEntities(String(text).replace(/<[^>]+>/g, "")).replace(/\s+/g, " ").trim();
    }

    function realUrl(href) {
        try {
            const url = new URL(href.replace(/&amp;/g, "&"), "https://duckduckgo.com");
            const target = url.searchParams.get("uddg");
            return target ? decodeURIComponent(target) : url.href;
        } catch {
            return null;
        }
    }

    function parseResults(html) {
        const results = [];
        const re = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="result__snippet"[^>]*>([\s\S]*?)<\/a>|(?=<a[^>]+class="result__a"))/g;
        let m;
        while ((m = re.exec(html)) && results.length < 10) {
            const url = realUrl(m[1]);
            if (!url || !/^https?:\/\//i.test(url) || /duckduckgo\.com\/y\.js/.test(url)) continue;
            results.push({ title: cleanHtml(m[2]), url, snippet: cleanHtml(m[3] || "") });
        }
        return results;
    }

    async function runJob(job, controller) {
        const timer = setTimeout(() => controller.abort(), 20_000);
        try {
            const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(job.query)}`, {
                headers: { "User-Agent": "Mozilla/5.0 FranceStudent-Code", Accept: "text/html" },
                signal: controller.signal
            });
            if (!res.ok) throw new Error(`Le moteur de recherche a répondu ${res.status}.`);
            const results = parseResults(await res.text());
            job.result = { results, message: results.length ? "" : "Aucun résultat exploitable." };
            job.status = "done";
        } catch (error) {
            if (job.status === "running") {
                job.status = controller.signal.aborted? "stopped" : "failed";
                job.error = controller.signal.aborted ? "Recherche arrêtée ou délai dépassé." : error.message;
            }
        } finally {
            clearTimeout(timer);
            job.controller = null;
            send("webResearch", { id: job.id, status: job.status });
        }
    }

    function publicJob(job) {
        const { controller, ...rest } = job;
        return rest;
    }

    async function webResearch(action, payload = {}) {
        if (action === "list") return jobs.map(publicJob);
        if (action === "start") {
            const query = String(payload.query || "").trim().slice(0, 1000);
            if (!query) throw new Error("Recherche vide.");
            const job = { id: `search-${++seq}`, query, status: "running", startedAt: Date.now(), result: null, error: null };
            job.controller = new AbortController();
            jobs.push(job);
            while (jobs.length > MAX_JOBS) jobs.shift();
            runJob(job, job.controller);
            return publicJob(job);
        }
        if (action === "cancel") {
            const job = jobs.find((j) => j.id === payload.id);
            if (job && job.status === "running") {
                job.status = "stopped";
                job.error = "Recherche arrêtée.";
                if (job.controller) job.controller.abort();
            }
            return jobs.map(publicJob);
        }
        throw new Error(`Action inconnue : ${action}`);
    }

    /* ---------- Centre d'extensions : skills et serveurs MCP ---------- */

    async function findSkill(name) {
        const skills = require("../src/skills");
        const wanted = String(name || "").toLowerCase();
        const list = await skills.listSkills(getWorkspace() || null);
        const skill = list.find((s) => String(s.name).toLowerCase() === wanted && s.scope === "projet")
            || list.find((s) => String(s.name).toLowerCase() === wanted);
        if (!skill) throw new Error(`Skill introuvable : ${name}`);
        return skill;
    }

    function assertSkillFile(skill) {
        const skills = require("../src/skills");
        const roots = [skills.userSkillsDir(), skills.projectSkillsDir(getWorkspace() || null)].filter(Boolean).map((d) => path.resolve(d));
        const file = path.resolve(skill.file);
        if (!roots.some((root) => file.startsWith(root + path.sep))) throw new Error("Fichier de skill hors des dossiers de skills.");
        return file;
    }

    async function extensionAction(action, payload = {}) {
        const skills = require("../src/skills");
        if (action === "read") {
            const skill = await findSkill(payload.name);
            return { name: skill.name, scope: skill.scope, file: skill.file, content: await fsp.readFile(assertSkillFile(skill), "utf8") };
        }
        if (action === "save") {
            const skill = await findSkill(payload.name);
            const content = String(payload.content ?? "");
            if (!content.trim()) throw new Error("Le contenu du skill est vide.");
            if (content.length > 200_000) throw new Error("Skill trop volumineux (200 000 caractères max).");
            await fsp.writeFile(assertSkillFile(skill), content, "utf8");
            return { name: skill.name, file: skill.file };
        }
        if (action === "remove") {
            const skill = await findSkill(payload.name);
            const dir = path.dirname(assertSkillFile(skill));
            await fsp.rm(dir, { recursive: true, force: true });
            return { name: skill.name, dir };
        }
        if (action === "import") {
            const content = String(payload.content ?? "");
            if (!content.trim()) throw new Error("Contenu SKILL.md vide.");
            const scope = payload.scope === "projet" ? "projet" : "utilisateur";
            const created = await skills.createSkill(String(payload.name || ""), { workspace: getWorkspace() || null, scope });
            await fsp.writeFile(created.file, content, "utf8");
            return created;
        }
        if (action === "mcp-toggle" || action === "mcp-remove") {
            const { manager, defaultConfigFile } = require("../src/mcp/manager");
            const file = defaultConfigFile();
            const config = await readJson(file);
            const name = String(payload.name || "");
            if (!config || !config.mcpServers || !Object.prototype.hasOwnProperty.call(config.mcpServers, name)) {
                throw new Error(`Serveur MCP introuvable dans mcp.json : ${name}`);
            }
            if (action === "mcp-remove") delete config.mcpServers[name];
            else config.mcpServers[name].disabled = payload.disabled === true;
            await fsp.writeFile(file, JSON.stringify(config, null, 2) + "\n", "utf8");
            return { configFile: file, servers: await manager.restart() };
        }
        throw new Error(`Action inconnue : ${action}`);
    }

    function dispose() {
        for (const child of children.values()) killTree(child);
        for (const job of jobs) if (job.controller) job.controller.abort();
    }

    return { projectStudio, webResearch, extensionAction, dispose, parseResults, classify };
}

module.exports = { createStudioBackend, classify };
