"use strict";

// IDE Link is opt-in. It exposes only a narrow, authenticated chat/queue API,
// never Electron's preload bridge or arbitrary filesystem/terminal operations.
const http = require("node:http");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

function createIdeLink({ workspace, enqueue, snapshot, queueAction = null, resolvePrompt = null, onChange = () => {}, spawnProcess = spawn, cloudflaredPath = "cloudflared", tunnelConfig = () => ({ mode: "temporary" }), probeOrigin = null, rememberedLink = null }) {
    let server = null, tunnel = null, origin = "", secret = "", scope = "", state = "stopped";
    let generation = 0, attempts = [], history = [], live = "", historyWorkspace = null;
    let plan = { steps: [], status: "idle" };
    let pairingPin = "", pairingTicket = "", pairingExpires = 0, pairingFailures = 0, device = null;
    let probeNonce = "", tunnelMode = "temporary";
    let rememberedIdentity = null, discoveryPublisher = null, discoveryState = "idle", contextEpoch = 0;
    const resumeChallenges = new Map(); let proofRequests = [];
    const pending = new Map();
    const token = () => crypto.randomBytes(32).toString("base64url");
    const pairingAvailable = () => Boolean(pairingPin && Date.now() < pairingExpires && pairingFailures < 5);
    const status = () => ({ state, url: origin, address: origin, tunnelMode, remembered: Boolean(rememberedIdentity), discoveryState, pairingUrl: pairingAvailable() ? `${origin}/#ide-link=${pairingTicket}` : "", pin: pairingAvailable() ? pairingPin : "", pinExpires: pairingExpires, workspace: scope, device });
    const emit = () => onChange(status());
    const safeText = (value, max = 30000) => typeof value === "string" ? value.slice(0, max) : "";
    function announceRemembered() {
        const identity = rememberedIdentity; discoveryState = "publishing";
        discoveryPublisher = rememberedLink.publisher(identity, origin, value => { if (rememberedIdentity === identity && state === "running") { discoveryState = value; emit(); } });
    }
    function renewPairing() {
        if (state !== "running" || !scope || workspace() !== scope) throw new Error("Active IDE Link sur le projet courant avant de réassocier un appareil.");
        if (rememberedIdentity) {
            rememberedLink.forget(scope);
            discoveryPublisher?.stop({ revoked: true }).catch(() => {});
            discoveryPublisher = null; rememberedIdentity = null; discoveryState = "idle"; resumeChallenges.clear();
        }
        secret = ""; device = null; pairingTicket = token();
        pairingPin = String(crypto.randomInt(1000000)).padStart(6, "0");
        pairingExpires = Date.now() + 10 * 60 * 1000; pairingFailures = 0; emit();
        return status();
    }
    function matchesSecret(candidate, expected) {
        const a = Buffer.from(typeof candidate === "string" ? candidate : ""), b = Buffer.from(expected);
        return Boolean(expected && a.length === b.length && crypto.timingSafeEqual(a, b));
    }
    function validateUploads(files) {
        if (!Array.isArray(files) || files.length > 4) throw new Error("Maximum quatre pièces jointes.");
        let totalBytes = 0;
        return files.map(file => {
            if (!file || typeof file.name !== "string" || !file.name.trim() || file.name.length > 200 || !["file", "image"].includes(file.kind) || typeof file.data !== "string") throw new Error("Pièce jointe invalide.");
            const match = /^data:([a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/]*={0,2})$/.exec(file.data);
            if (!match || match[2].length % 4 !== 0 || (file.kind === "image" && !match[1].toLowerCase().startsWith("image/"))) throw new Error("Pièce jointe invalide.");
            const size = Buffer.from(match[2], "base64").length;
            totalBytes += size;
            if (totalBytes > 2 * 1024 * 1024) throw new Error("Pièces jointes trop volumineuses.");
            return { name: file.name.replace(/[\r\n]/g, " "), kind: file.kind, mime: match[1], size, data: file.data };
        });
    }
    function setPlan(items, status) {
        const steps = (Array.isArray(items) ? items : []).slice(0, 100).map(item => {
            if (typeof item === "string") {
                const value = safeText(item, 4000).trim();
                const stepStatus = /^(?:✓|✔|\[[xX]\])\s*/.test(value) ? "completed" : /^(?:◉|●|\[~\])\s*/.test(value) ? "in_progress" : "pending";
                return { step: value.replace(/^(?:✓|✔|◉|●|○|\[[xX ~]?\])\s*/, ""), status: stepStatus };
            }
            return { step: safeText(item?.step, 4000).trim(), status: ["completed", "in_progress"].includes(item?.status) ? item.status : "pending" };
        }).filter(item => item.step);
        plan = { steps, status: ["running", "done", "failed", "interrupted", "history"].includes(status) ? status : "idle" };
    }
    function record(channel, data) {
        const currentWorkspace = workspace();
        if (historyWorkspace !== currentWorkspace) { historyWorkspace = currentWorkspace; history = []; live = ""; pending.clear(); setPlan([], "idle"); }
        if (state !== "stopped" && currentWorkspace !== scope) { stop({ preservePairing: true }).catch(() => {}); return; }
        if (channel === "clear") { contextEpoch++; resumeChallenges.clear(); history = []; live = ""; pending.clear(); setPlan([], "idle"); return; }
        if (!currentWorkspace) return;
        if (channel === "conversationReplay") {
            history = []; live = ""; setPlan([], "idle");
            for (const entry of Array.isArray(data?.entries) ? data.entries : []) {
                if (entry?.type === "plan") setPlan(Array.isArray(entry.steps) ? entry.steps : entry.items, "history");
                else record("entry", entry);
            }
            return;
        }
        if (channel === "agentActivity") {
            if (data?.workspace === currentWorkspace && !data.motionDesign) setPlan(data.steps, data.status);
            return;
        }
        if (channel === "entry" && data?.type === "plan") {
            setPlan(Array.isArray(data.steps) ? data.steps : data.items, "running");
            return;
        }
        if (channel === "promptResolved") { pending.delete(data?.id); return; }
        if (channel === "prompt" && Number.isSafeInteger(data?.id) && ["confirm", "command", "ask", "question"].includes(data.kind)) {
            pending.set(data.id, { id: data.id, kind: data.kind, question: safeText(data.question, 12000), prefix: safeText(data.prefix, 12000), multiple: data.multiple === true, placeholder: safeText(data.placeholder, 200), options: Array.isArray(data.options) ? data.options.slice(0, 8).map(o => ({ id: safeText(o.id, 32), label: safeText(o.label, 200), description: safeText(o.description, 500) })) : [] });
            return;
        }
        if (channel === "entry" && !data?.debug && ["user", "assistant", "reason", "info", "warn", "error", "print", "tool", "result"].includes(data?.type)) {
            const entry = { type: data.type };
            for (const field of ["text", "name", "arg", "tone"]) if (typeof data[field] === "string") entry[field] = safeText(data[field], 100000);
            if (data.type === "print" && Array.isArray(data.lines)) entry.lines = data.lines.slice(0, 1000).map(line => safeText(line, 10000));
            history.push(entry);
            if (history.length > 1000) history.shift();
        } else if (channel === "liveStart") live = "";
        else if (channel === "liveAppend") live = (live + safeText(data, 100000)).slice(-100000);
        else if (channel === "liveEnd" && live) { history.push({ type: "assistant", text: live }); live = ""; if (history.length > 1000) history.shift(); }
    }
    function headers(res) {
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Referrer-Policy", "no-referrer");
        res.setHeader("Content-Security-Policy", "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'");
    }
    function json(res, code, value) { headers(res); res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" }); res.end(JSON.stringify(value)); }
    function authorized(req) {
        const value = String(req.headers.authorization || "").replace(/^Bearer /, "");
        const a = Buffer.from(value), b = Buffer.from(secret);
        return Boolean(secret && a.length === b.length && crypto.timingSafeEqual(a, b));
    }
    function request(req, res) {
        if (!origin || req.headers.host !== new URL(origin).host) return json(res, 403, { error: "Origine invalide." });
        // Exact Capacitor origins only; a QR ticket or bearer is still required.
        const nativeOrigin = ["capacitor://localhost", "https://localhost", "http://localhost"].includes(req.headers.origin);
        const validOrigin = req.headers.origin === origin || nativeOrigin;
        if (nativeOrigin) {
            res.setHeader("Access-Control-Allow-Origin", req.headers.origin);
            res.setHeader("Vary", "Origin");
        }
        if (req.method === "OPTIONS") {
            const requestedHeaders = String(req.headers["access-control-request-headers"] || "").toLowerCase().split(",").map(h => h.trim()).filter(Boolean);
            if (!nativeOrigin || req.headers["access-control-request-method"] !== "POST" || requestedHeaders.some(h => !["authorization", "content-type"].includes(h))) return json(res, 403, { error: "Origine ou format invalide." });
            res.setHeader("Access-Control-Allow-Methods", "POST");
            res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
            headers(res); res.writeHead(204); res.end(); return;
        }
        let pathname;
        try { pathname = new URL(req.url, origin).pathname; }
        catch { return json(res, 400, { error: "Adresse invalide." }); }
        if (req.method === "GET" && pathname === "/api/link-probe" && state === "starting" && probeNonce) return json(res, 200, { instance: probeNonce });
        if (req.method === "GET" && pathname === "/api/identity" && rememberedIdentity && state === "running" && workspace() === scope && validOrigin) {
            const nonce = new URL(req.url, origin).searchParams.get("nonce");
            if (!/^[A-Za-z0-9_-]{43}$/.test(nonce || "")) return json(res, 400, { error: "Défi invalide." });
            const now = Date.now(); proofRequests = proofRequests.filter(time => now - time < 60000);
            if (proofRequests.length >= 60) return json(res, 429, { error: "Trop de demandes de reconnexion. Réessaie dans une minute." });
            proofRequests.push(now);
            for (const [key, proof] of resumeChallenges) if (proof.expiresAt <= now) resumeChallenges.delete(key);
            if (resumeChallenges.size >= 20) resumeChallenges.delete(resumeChallenges.keys().next().value);
            const signed = rememberedLink.proof(rememberedIdentity, origin, nonce, token());
            resumeChallenges.set(signed.proof.challenge, signed.proof); return json(res, 200, signed);
        }
        if (req.method === "POST" && pathname === "/api/resume") {
            if (!validOrigin || !/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || "")) return json(res, 403, { error: "Origine ou format invalide." });
            const version = generation, epoch = contextEpoch;
            let body = "", size = 0, tooLarge = false;
            req.on("data", chunk => { if (tooLarge) return; size += chunk.length; if (size > 1024) { tooLarge = true; json(res, 413, { error: "Demande trop longue." }); req.pause(); res.once("finish", () => req.destroy()); } else body += chunk; });
            req.on("end", () => {
                if (tooLarge) return;
                if (version !== generation || epoch !== contextEpoch || state !== "running" || workspace() !== scope || !rememberedIdentity) return json(res, 409, { error: "L’association n’est plus disponible." });
                let parsed; try { parsed = JSON.parse(body); } catch { return json(res, 400, { error: "Demande invalide." }); }
                const proof = resumeChallenges.get(parsed?.challenge); resumeChallenges.delete(parsed?.challenge);
                if (!proof || proof.expiresAt <= Date.now() || !rememberedLink.verify(rememberedIdentity, proof, parsed.mac)) return json(res, 401, { error: "Reconnexion refusée." });
                device = { name: rememberedIdentity.name, connectedAt: Date.now(), remembered: true }; emit();
                return json(res, 200, { token: secret, protocolVersion: 2 });
            }); return;
        }
        if (req.method === "GET" && ["/", "/app.js", "/style.css", "/studio.js", "/render.js"].includes(pathname)) {
            const file = pathname === "/" ? "index.html" : pathname.slice(1);
            const fs = require("node:fs");
            const path = require("node:path");
            const asset = file === "studio.js" ? path.join(__dirname, "renderer/vendor/studio.js") : file === "render.js" ? path.join(__dirname, "renderer/src/01-render.js") : path.join(__dirname, "ide-link-web", file);
            const content = fs.readFileSync(asset);
            headers(res); res.writeHead(200, { "Content-Type": file.endsWith(".js") ? "text/javascript; charset=utf-8" : file.endsWith(".css") ? "text/css; charset=utf-8" : "text/html; charset=utf-8" }); res.end(content); return;
        }
        if (req.method === "POST" && pathname === "/api/pair") {
            if (!validOrigin || !/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || "")) return json(res, 403, { error: "Origine ou format invalide." });
            if (!scope || workspace() !== scope || state !== "running") return json(res, 409, { error: "Session ou projet modifié." });
            if (!pairingPin || Date.now() >= pairingExpires || pairingFailures >= 5) return json(res, 429, { error: "Code indisponible. Relance IDE Link sur l’ordinateur." });
            const version = generation;
            let body = "", size = 0, tooLarge = false;
            req.on("data", chunk => {
                size += chunk.length;
                if (size > 1024) { tooLarge = true; pairingFailures++; json(res, 413, { error: "Demande trop longue." }); req.pause(); res.once("finish", () => req.destroy()); return; }
                body += chunk;
            });
            req.on("end", () => {
                if (tooLarge) return;
                if (version !== generation || workspace() !== scope || state !== "running") return json(res, 409, { error: "Session ou projet modifié." });
                if (!pairingPin || Date.now() >= pairingExpires || pairingFailures >= 5) return json(res, 429, { error: "Code indisponible. Relance IDE Link sur l’ordinateur." });
                let candidate = {};
                try { candidate = JSON.parse(body) || {}; } catch { /* Compte comme une tentative incorrecte. */ }
                if (!(candidate.ticket !== undefined ? matchesSecret(candidate.ticket, pairingTicket) : matchesSecret(candidate.pin, pairingPin))) { pairingFailures++; if (pairingFailures >= 5) emit(); return json(res, 401, { error: "Code incorrect ou expiré." }); }
                const name = safeText(candidate.deviceName, 80).replace(/[\x00-\x1f\x7f]/g, "").trim() || "Mobile";
                if (candidate.remember === true && rememberedLink?.status(scope).enabled) {
                    try { rememberedIdentity = rememberedLink.create(scope, name); } catch { return json(res, 503, { error: "L’association durable ne peut pas être enregistrée dans le coffre système." }); }
                }
                pairingPin = ""; pairingTicket = ""; secret = token();
                device = { name, connectedAt: Date.now(), remembered: Boolean(rememberedIdentity) };
                if (rememberedIdentity) announceRemembered(); emit();
                return json(res, 200, { token: secret, protocolVersion: 2, ...(rememberedIdentity ? { remembered: rememberedLink.descriptor(rememberedIdentity) } : {}) });
            });
            return;
        }
        if (!validOrigin || !authorized(req)) {
            const now = Date.now(); attempts = attempts.filter(t => now - t < 60000); attempts.push(now);
            return json(res, attempts.length > 30 ? 429 : 401, { error: "Accès non autorisé." });
        }
        if (workspace() !== scope || !scope) {
            json(res, 409, { error: "Le projet a changé. Relance IDE Link." });
            stop({ preservePairing: true }).catch(() => {});
            return;
        }
        if (req.method === "POST" && pathname === "/api/state") {
            const queue = snapshot();
            const data = { protocolVersion: 2, toolGroups: require("../src/tools/selection").groups(), session: { project: require("node:path").basename(scope), device }, history, live, plan, pending: [...pending.values()], queue: { enabled: queue.enabled, busy: queue.busy === true, canSteer: queue.canSteer === true, tasks: queue.tasks.map(t => ({ id: t.id, prompt: safeText(t.prompt), mode: t.mode === "plan" ? "plan" : "agent", toolGroups: t.toolGroups ?? null, status: t.status, message: safeText(t.message, 12000), attachments: Array.isArray(t.attachments) ? t.attachments.map(f => ({ name: safeText(f.name, 200) })) : [] })) } };
            const serialized = JSON.stringify(data);
            const revision = crypto.createHash("sha256").update(serialized).digest("hex");
            if (new URL(req.url, origin).searchParams.get("since") === revision) return json(res, 200, { unchanged: true, revision });
            headers(res); res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
            res.end(serialized.slice(0, -1) + `,"revision":"${revision}"}`); return;
        }
        if (req.method === "POST" && pathname === "/api/disconnect") {
            renewPairing(); return json(res, 200, { ok: true });
        }
        if (req.method === "POST" && ["/api/tasks", "/api/queue", "/api/prompt"].includes(pathname)) {
            if (!/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || "")) return json(res, 415, { error: "Format invalide." });
            const requestGeneration = generation;
            const requestEpoch = contextEpoch;
            let body = "", size = 0, tooLarge = false;
            req.on("data", chunk => {
                size += chunk.length;
                if (size > (pathname === "/api/tasks" || pathname === "/api/queue" ? 3 * 1024 * 1024 : 40000)) {
                    tooLarge = true;
                    json(res, 413, { error: "Demande trop longue." });
                    req.pause();
                    res.once("finish", () => req.destroy());
                    return;
                }
                body += chunk;
            });
            req.on("end", () => {
                if (tooLarge) return;
                if (requestGeneration !== generation || requestEpoch !== contextEpoch || workspace() !== scope || state !== "running") return json(res, 409, { error: "Session ou projet modifié." });
                // A desktop revocation may happen while an upload is arriving.
                if (!authorized(req)) return json(res, 401, { error: "Accès révoqué. Associe de nouveau ton appareil." });
                try {
                    const parsed = JSON.parse(body);
                    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return json(res, 400, { error: "Demande invalide." });
                    if (pathname === "/api/prompt") {
                        const item = pending.get(parsed.id);
                        if (!item || typeof resolvePrompt !== "function") return json(res, 409, { error: "Demande déjà résolue ou indisponible." });
                        let answer = parsed.answer;
                        if (["confirm", "command"].includes(item.kind)) {
                            if (!["o", "n"].includes(answer)) return json(res, 400, { error: "Réponse invalide." });
                        } else if (item.kind === "ask") {
                            if (typeof answer !== "string" || answer.length > 4000) return json(res, 400, { error: "Réponse invalide." });
                        } else {
                            require("../src/user-questions").normalizeAnswer(item, answer);
                        }
                        if (!resolvePrompt(item.id, answer)) { pending.delete(item.id); return json(res, 409, { error: "Demande déjà résolue." }); }
                        pending.delete(item.id);
                        return json(res, 200, { ok: true });
                    }
                    if (pathname === "/api/queue") {
                        if (typeof queueAction !== "function") return json(res, 404, { error: "Action indisponible." });
                        if (!["start", "pause", "remove", "retry", "interrupt", "move", "edit", "steer", "attach"].includes(parsed.action)) return json(res, 400, { error: "Action invalide." });
                        if (["remove", "retry", "move", "edit", "steer", "attach"].includes(parsed.action) && (typeof parsed.id !== "string" || !parsed.id || parsed.id.length > 128)) return json(res, 400, { error: "Tâche invalide." });
                        if (parsed.action === "attach") {
                            const task = snapshot().tasks.find(t => t.id === parsed.id && t.status === "pending");
                            if (!task) return json(res, 409, { error: "Demande en attente indisponible." });
                            const additions = validateUploads(parsed.attachments);
                            if (!additions.length) return json(res, 400, { error: "Aucun fichier sélectionné." });
                            const existing = queueAction("attachments", { id: task.id }).attachments;
                            if (!Array.isArray(existing) || existing.length + additions.length > 4) return json(res, 400, { error: "Maximum quatre pièces jointes par demande." });
                            queueAction("edit", { id: task.id, prompt: task.prompt, attachments: [...existing, ...additions] });
                            return json(res, 200, { ok: true });
                        }
                        if (parsed.action === "move" && !["up", "down"].includes(parsed.direction)) return json(res, 400, { error: "Direction invalide." });
                        if (parsed.action === "edit" && (typeof parsed.prompt !== "string" || !parsed.prompt.trim() || parsed.prompt.length > 30000 || parsed.prompt.trim().startsWith("/"))) return json(res, 400, { error: "Demande invalide." });
                        queueAction(parsed.action, { id: parsed.id, direction: parsed.direction, prompt: parsed.prompt });
                        return json(res, 200, { ok: true });
                    }
                    const prompt = typeof parsed.prompt === "string" ? parsed.prompt.trim() : "";
                    if (!prompt || prompt.length > 30000 || prompt.startsWith("/")) return json(res, 400, { error: "Demande invalide : les commandes / ne sont pas acceptées." });
                    const files = parsed.attachments === undefined ? [] : parsed.attachments;
                    if (!Array.isArray(files) || files.length > 4) return json(res, 400, { error: "Maximum quatre pièces jointes." });
                    const attachments = validateUploads(files);
                    const mode = parsed.mode === undefined ? "agent" : parsed.mode;
                    if (!["agent", "plan"].includes(mode)) return json(res, 400, { error: "Mode invalide." });
                    const toolGroups = require("../src/tools/selection").normalize(parsed.toolGroups);
                    enqueue(prompt, attachments, mode, toolGroups); return json(res, 200, { ok: true });
                } catch { return json(res, 400, { error: "Impossible d’ajouter cette demande." }); }
            });
            return;
        }
        return json(res, 404, { error: "Introuvable." });
    }
    async function stop({ preservePairing = false } = {}) {
        const wasStarting = state === "starting";
        const identity = rememberedIdentity, publisher = discoveryPublisher, previousScope = scope;
        rememberedIdentity = null; discoveryPublisher = null; discoveryState = "idle"; resumeChallenges.clear(); proofRequests = [];
        generation++; state = "stopped"; origin = ""; secret = ""; scope = ""; attempts = []; probeNonce = "";
        pairingPin = ""; pairingTicket = ""; pairingExpires = 0; pairingFailures = 0; device = null; pending.clear();
        const child = tunnel, old = server; tunnel = null; server = null;
        if (child) child.kill();
        const offline = publisher?.stop({ revoked: !preservePairing }).catch(() => {});
        let forgetError = null;
        if (identity && !preservePairing) { try { rememberedLink.forget(previousScope); } catch (error) { forgetError = error; } }
        // Before listen completes, start() owns cleanup: closing here can suppress
        // the listen callback and leave the pending start promise unresolved.
        if (old && (!wasStarting || child)) { old.closeAllConnections?.(); await new Promise(resolve => old.close(() => resolve())); }
        emit();
        await offline;
        if (forgetError) throw forgetError;
    }
    async function start() {
        if (state !== "stopped") throw new Error("IDE Link est déjà actif ou en cours de démarrage.");
        const selected = workspace();
        if (!selected) throw new Error("Ouvre un projet avant d’activer IDE Link.");
        const config = tunnelConfig();
        const fixed = config.mode === "fixed";
        if (fixed && (!config.token || !Number.isInteger(config.port) || config.port < 1024 || config.port > 65535)) throw new Error("Configuration du tunnel fixe incomplète.");
        const fixedUrl = fixed ? require("./ide-link-settings").fixedOrigin(config.origin) : "";
        rememberedIdentity = rememberedLink?.load(selected) || null;
        tunnelMode = fixed ? "fixed" : "temporary";
        if (historyWorkspace !== selected) { historyWorkspace = selected; history = []; live = ""; pending.clear(); }
        const version = ++generation; state = "starting"; scope = selected; secret = ""; emit();
        try {
            const localServer = http.createServer(request);
            localServer.headersTimeout = 10000;
            localServer.requestTimeout = 15000;
            server = localServer;
            await new Promise((resolve, reject) => { localServer.once("error", error => reject(error.code === "EADDRINUSE" ? new Error("Le port local IDE Link est déjà utilisé. Choisis un autre port et adapte le service du tunnel Cloudflare.") : new Error("Le serveur local IDE Link n’a pas pu démarrer."))); localServer.listen(fixed ? config.port : 0, "127.0.0.1", resolve); });
            if (version !== generation) {
                localServer.closeAllConnections?.();
                await new Promise(resolve => localServer.close(() => resolve()));
                throw new Error("Démarrage annulé.");
            }
            const port = localServer.address().port;
            const childEnv = { ...process.env }; delete childEnv.TUNNEL_TOKEN; delete childEnv.TUNNEL_TOKEN_FILE;
            if (fixed) childEnv.TUNNEL_TOKEN = config.token;
            const args = fixed ? ["tunnel", "--no-autoupdate", "run"] : ["tunnel", "--url", `http://127.0.0.1:${port}`, "--no-autoupdate"];
            const child = spawnProcess(cloudflaredPath, args, { env: childEnv, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
            tunnel = child;
            const url = await new Promise((resolve, reject) => {
                let output = "", done = false;
                const timer = setTimeout(() => finish(new Error("Le tunnel n’a pas démarré à temps.")), 30000);
                function finish(error, result) { if (done) return; done = true; clearTimeout(timer); error ? reject(error) : resolve(result); }
                function consume(chunk) { output = (output + String(chunk)).slice(-12000); if (fixed) { if (/Registered tunnel connection/i.test(output)) finish(null, fixedUrl); } else { const match = output.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com\b/i); if (match) finish(null, match[0].toLowerCase()); } }
                child.stdout?.on("data", consume); child.stderr?.on("data", consume);
                child.once("error", () => finish(new Error("cloudflared est introuvable ou n’a pas pu démarrer.")));
                child.once("exit", () => finish(new Error("Le tunnel s’est arrêté au démarrage.")));
            });
            if (version !== generation || workspace() !== scope) throw new Error("Démarrage annulé : le projet ou la session a changé.");
            if (child.exitCode !== null && child.exitCode !== undefined) throw new Error("Le tunnel s’est arrêté au démarrage.");
            child.once("exit", () => { if (version === generation) stop({ preservePairing: true }).catch(() => {}); });
            if (fixed) {
                origin = url; probeNonce = token();
                let reachable = false;
                const deadline = Date.now() + 15000;
                while (!reachable && Date.now() < deadline && version === generation) {
                    try {
                        if (probeOrigin) reachable = await probeOrigin(url, probeNonce);
                        else {
                            const response = await fetch(`${url}/api/link-probe`, { redirect: "error", signal: AbortSignal.timeout(2000), cache: "no-store" });
                            const reader = response.body?.getReader();
                            let text = "", bytes = 0;
                            if (reader) {
                                try {
                                    for (;;) {
                                        const next = await reader.read(); if (next.done) break;
                                        bytes += next.value.length; if (bytes > 1024) break;
                                        text += Buffer.from(next.value).toString("utf8");
                                    }
                                } finally { await reader.cancel().catch(() => {}); }
                            }
                            reachable = response.ok && bytes <= 1024 && text === JSON.stringify({ instance: probeNonce });
                        }
                    } catch { /* The public route may still be connecting. Never expose provider output or credentials. */ }
                    if (!reachable) await new Promise(resolve => setTimeout(resolve, 500));
                }
                if (version !== generation || workspace() !== scope) throw new Error("Démarrage annulé : le projet ou la session a changé.");
                if (!reachable) throw new Error("Le tunnel est connecté mais l’adresse fixe ne rejoint pas cet IDE. Vérifie le domaine et le service HTTP 127.0.0.1 dans Cloudflare.");
                probeNonce = "";
            }
            origin = url; state = "running";
            if (rememberedIdentity) { secret = token(); device = { name: rememberedIdentity.name, connectedAt: rememberedIdentity.connectedAt, remembered: true }; pairingPin = ""; pairingTicket = ""; announceRemembered(); emit(); }
            else renewPairing();
            return status();
        } catch (error) { if (version === generation) await stop({ preservePairing: true }); throw error; }
    }
    return { start, stop, status, record, renewPairing };
}
module.exports = { createIdeLink };
