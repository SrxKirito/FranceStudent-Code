"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const { EventEmitter } = require("node:events");
const { PassThrough } = require("node:stream");
const { createIdeLink } = require("../desktop/ide-link");

function fakeTunnel() {
    let port;
    function spawn(_command, args) {
        port = Number(new URL(args[args.indexOf("--url") + 1]).port);
        const child = new EventEmitter();
        child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null;
        child.kill = () => { child.exitCode = 0; child.emit("exit", 0); return true; };
        setImmediate(() => child.stderr.write("https://example.trycloudflare.com\n"));
        return child;
    }
    return { spawn, port: () => port };
}
function request(port, route, { token = "", origin = "https://example.trycloudflare.com", host = "example.trycloudflare.com", body = "{}", method = "POST", headers = {} } = {}) {
    return new Promise((resolve, reject) => {
        const req = http.request({ host: "127.0.0.1", port, path: route, method, headers: { host, origin, authorization: `Bearer ${token}`, "content-type": "application/json", ...headers } }, res => {
            let text = ""; res.on("data", chunk => { text += chunk; }); res.on("end", () => resolve({ status: res.statusCode, body: text ? JSON.parse(text) : null, headers: res.headers }));
        });
        req.on("error", reject); req.end(method === "POST" ? body : undefined);
    });
}

async function pair(port, info) {
    const result = await request(port, "/api/pair", { body: JSON.stringify({ pin: info.pin }) });
    assert.equal(result.status, 200);
    assert.ok(result.body.token.length >= 40);
    return result.body.token;
}
async function startAndPair(link, fake) {
    const info = await link.start();
    return pair(fake.port(), info);
}

test("le téléphone mémorisé reprend un nouveau tunnel par défi unique, sans envoyer sa clé durable", async t => {
    const crypto = require("node:crypto");
    let saved = {}, runs = 0, port;
    const settings = { load: () => structuredClone(saved), save: patch => { saved = { ...saved, ...structuredClone(patch) }; } };
    const secrets = { available: () => true, protect: value => ({ data: Buffer.from(value).toString("base64") }), unprotect: value => value ? Buffer.from(value.data, "base64").toString() : null };
    const remembered = require("../desktop/ide-link-remembered").createRememberedLink({ settings, secrets, fetchImpl: async () => ({ ok: true, body: { cancel: async () => {} } }), schedule: () => 1, unschedule() {} });
    remembered.configure("projet", true);
    const spawnProcess = (_file, args) => {
        port = Number(new URL(args[args.indexOf("--url") + 1]).port);
        const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null;
        child.kill = () => { child.exitCode = 0; child.emit("exit", 0); return true; };
        const address = `https://restart-${++runs}.trycloudflare.com`;
        setImmediate(() => child.stderr.write(address + "\n")); return child;
    };
    const link = createIdeLink({ workspace: () => "projet", enqueue() {}, snapshot: () => ({ tasks: [] }), spawnProcess, rememberedLink: remembered });
    t.after(() => link.stop());
    const first = await link.start();
    const headers = origin => ({ origin, host: new URL(origin).host });
    const pair = await request(port, "/api/pair", { ...headers(first.address), body: JSON.stringify({ pin: first.pin, remember: true, deviceName: "iPhone" }) });
    assert.equal(pair.status, 200); assert.ok(pair.body.remembered);
    const credential = pair.body.remembered.credential;
    await link.stop({ preservePairing: true });
    const next = await link.start(); assert.notEqual(next.address, first.address); assert.equal(next.remembered, true); assert.equal(next.pin, "");
    assert.equal((await request(port, "/api/state", { ...headers(next.address), token: pair.body.token })).status, 401);
    const challenge = async () => (await request(port, "/api/identity?nonce=" + crypto.randomBytes(32).toString("base64url"), { ...headers(next.address), method: "GET" })).body;
    const firstProof = await challenge();
    assert.equal((await request(port, "/api/resume", { ...headers(next.address), body: JSON.stringify({ challenge: firstProof.proof.challenge, mac: firstProof.mac }) })).status, 401);
    const secondProof = await challenge();
    const mac = require("../desktop/ide-link-remembered").mac(credential, "client", secondProof.proof);
    const body = JSON.stringify({ challenge: secondProof.proof.challenge, mac });
    assert.equal(body.includes(credential), false);
    const resumed = await request(port, "/api/resume", { ...headers(next.address), body });
    assert.equal(resumed.status, 200);
    assert.equal((await request(port, "/api/resume", { ...headers(next.address), body })).status, 401);
    assert.equal((await request(port, "/api/state", { ...headers(next.address), token: resumed.body.token })).status, 200);
    link.renewPairing(); assert.equal(remembered.status("projet").paired, false);
    assert.equal((await request(port, "/api/state", { ...headers(next.address), token: resumed.body.token })).status, 401);
});

test("un tunnel fixe retrouve la même adresse après arrêt et nouvelle instance", async t => {
    const reserved = http.createServer();
    await new Promise(resolve => reserved.listen(0, "127.0.0.1", resolve));
    const port = reserved.address().port; await new Promise(resolve => reserved.close(resolve));
    const origin = "https://ide.example.com", tunnelToken = "DEMO_TUNNEL_" + "A".repeat(80), launches = [];
    const spawnProcess = (_file, args, options) => {
        launches.push({ args, env: options.env });
        const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.exitCode = null;
        child.kill = () => { child.exitCode = 0; child.emit("exit", 0); return true; };
        setImmediate(() => child.stderr.write("Registered tunnel connection connIndex=0\n")); return child;
    };
    const config = { workspace: () => "projet", enqueue() {}, snapshot: () => ({ tasks: [] }), spawnProcess,
        tunnelConfig: () => ({ mode: "fixed", origin, port, token: tunnelToken }),
        probeOrigin: async (url, nonce) => {
            const result = await request(port, "/api/link-probe", { method: "GET", origin: url, host: new URL(url).host });
            return result.body.instance === nonce;
        } };
    const first = createIdeLink(config); t.after(() => first.stop());
    const before = await first.start(); assert.equal(before.address, origin); assert.equal(before.tunnelMode, "fixed");
    assert.equal(launches[0].args.includes(tunnelToken), false); assert.equal(launches[0].env.TUNNEL_TOKEN, tunnelToken);
    assert.equal(JSON.stringify(first.status()).includes(tunnelToken), false);
    const paired = await request(port, "/api/pair", { origin, host: new URL(origin).host, body: JSON.stringify({ pin: before.pin }) });
    assert.equal(paired.status, 200);
    await first.stop();
    const next = createIdeLink(config); t.after(() => next.stop());
    const after = await next.start(); assert.equal(after.address, before.address);
    assert.equal((await request(port, "/api/state", { origin, host: new URL(origin).host, token: paired.body.token })).status, 401);
    assert.equal((await request(port, "/api/link-probe", { method: "GET", origin, host: new URL(origin).host })).status, 401);
});

test("IDE Link limite l'accès et ajoute les tâches dans la file", async t => {
    let project = "project-a";
    const tasks = [], fake = fakeTunnel();
    const link = createIdeLink({ workspace: () => project, spawnProcess: fake.spawn, enqueue: prompt => tasks.push({ prompt, status: "pending" }), snapshot: () => ({ enabled: true, tasks }) });
    t.after(() => link.stop());
    const info = await link.start();
    assert.equal(info.state, "running");
    const port = fake.port();
    assert.equal(new URL(info.url).hash, "");
    assert.equal((await request(port, "/api/state", { token: "secret-test" })).status, 401);
    const token = await pair(port, info);
    assert.equal((await request(port, "/api/state")).status, 401);
    assert.equal((await request(port, "/api/state", { token, origin: "https://evil.example" })).status, 401);
    assert.equal((await request(port, "/api/state", { token, host: "evil.example" })).status, 403);
    assert.equal((await request(port, "/api/tasks", { token, body: JSON.stringify({ prompt: "/logout" }) })).status, 400);
    assert.equal((await request(port, "/api/tasks", { token, body: JSON.stringify({ prompt: "Ajouter une page" }) })).status, 200);
    link.record("entry", { type: "assistant", text: "Bonjour" });
    const state = await request(port, "/api/state", { token });
    assert.equal(state.status, 200);
    assert.equal(state.body.queue.tasks[0].prompt, "Ajouter une page");
    assert.equal(state.body.history[0].text, "Bonjour");
    project = "project-b";
    link.record("status", {});
    assert.equal(link.status().state, "stopped");
});

test("le QR associe une fois l’app native et la révocation invalide ses accès", async t => {
    const fake = fakeTunnel(), tasks = [];
    const link = createIdeLink({ workspace: () => "projet", spawnProcess: fake.spawn, enqueue: prompt => tasks.push(prompt), snapshot: () => ({ enabled: true, tasks: [] }) });
    t.after(() => link.stop());
    const initial = await link.start(), port = fake.port(), origin = "capacitor://localhost";
    const ticket = new URLSearchParams(new URL(initial.pairingUrl).hash.slice(1)).get("ide-link");
    assert.match(ticket, /^[A-Za-z0-9_-]{43}$/);
    const body = JSON.stringify({ ticket, deviceName: "Mon iPhone" });
    assert.equal((await request(port, "/api/pair", { origin: "https://evil.example", body })).status, 403);
    assert.equal((await request(port, "/api/state", { origin })).status, 401);
    const paired = await request(port, "/api/pair", { origin, body });
    assert.equal(paired.status, 200);
    const token = paired.body.token;
    assert.notEqual(token, ticket);
    assert.equal(link.status().device.name, "Mon iPhone");
    assert.equal(link.status().pin, ""); assert.equal(link.status().pairingUrl, "");
    assert.equal((await request(port, "/api/pair", { origin, body })).status, 429);
    const state = await request(port, "/api/state", { origin, token });
    assert.equal(state.status, 200); assert.equal(state.headers["access-control-allow-origin"], origin);
    assert.equal((await request(port, "/api/tasks", { origin, token, body: JSON.stringify({ prompt: "Depuis le téléphone" }) })).status, 200);
    assert.deepEqual(tasks, ["Depuis le téléphone"]);
    const renewed = link.renewPairing();
    assert.notEqual(renewed.pairingUrl, initial.pairingUrl);
    assert.equal((await request(port, "/api/state", { origin, token })).status, 401);
    assert.equal((await request(port, "/api/pair", { origin, body })).status, 401);
    const next = await pair(port, renewed);
    assert.equal((await request(port, "/api/disconnect", { origin, token: next })).status, 200);
    assert.equal((await request(port, "/api/state", { origin, token: next })).status, 401);
    assert.equal(link.status().device, null); assert.ok(link.status().pairingUrl);
});

test("le prévol natif refuse les origines et en-têtes étrangers", async t => {
    const fake = fakeTunnel();
    const link = createIdeLink({ workspace: () => "projet", spawnProcess: fake.spawn, enqueue() {}, snapshot: () => ({ tasks: [] }) });
    t.after(() => link.stop()); await link.start();
    const options = { method: "OPTIONS", origin: "capacitor://localhost", headers: { "access-control-request-method": "POST", "access-control-request-headers": "authorization, content-type" } };
    assert.equal((await request(fake.port(), "/api/pair", options)).status, 204);
    assert.equal((await request(fake.port(), "/api/pair", { ...options, origin: "capacitor://evil.example" })).status, 403);
    assert.equal((await request(fake.port(), "/api/pair", { ...options, headers: { ...options.headers, "access-control-request-headers": "x-other" } })).status, 403);
});

test("le ticket QR expiré ne donne aucun accès", async t => {
    const fake = fakeTunnel();
    const link = createIdeLink({ workspace: () => "projet", spawnProcess: fake.spawn, enqueue() {}, snapshot: () => ({ tasks: [] }) });
    t.after(() => link.stop()); const info = await link.start();
    const ticket = new URLSearchParams(new URL(info.pairingUrl).hash.slice(1)).get("ide-link");
    t.mock.method(Date, "now", () => info.pinExpires + 1);
    assert.equal(link.status().pairingUrl, "");
    assert.equal((await request(fake.port(), "/api/pair", { body: JSON.stringify({ ticket }) })).status, 429);
    assert.equal(link.status().device, null);
});

test("IDE Link transmet la sélection et évite les réponses d’état identiques", async t => {
    const fake = fakeTunnel(), received = [];
    const link = createIdeLink({ workspace: () => "projet", spawnProcess: fake.spawn, enqueue: (...args) => received.push(args), snapshot: () => ({ tasks: [] }) });
    t.after(() => link.stop()); const token = await startAndPair(link, fake), port = fake.port();
    const first = await request(port, "/api/state", { token });
    assert.ok(first.body.toolGroups.some(group => group.id === "terminal"));
    const same = await request(port, "/api/state?since=" + first.body.revision, { token });
    assert.equal(same.body.unchanged, true); assert.equal(same.body.history, undefined);
    link.record("entry", { type: "assistant", text: "Nouvelle activité" });
    const changed = await request(port, "/api/state?since=" + first.body.revision, { token });
    assert.notEqual(changed.body.revision, first.body.revision); assert.equal(changed.body.history[0].text, "Nouvelle activité");
    const body = JSON.stringify({ prompt: "Coder", toolGroups: ["files", "terminal"] });
    assert.equal((await request(port, "/api/tasks", { token, body })).status, 200);
    assert.deepEqual(received[0][3], ["files", "terminal"]);
    assert.equal((await request(port, "/api/tasks", { token, body: JSON.stringify({ prompt: "Refuser", toolGroups: ["shell-libre"] }) })).status, 400);
    assert.equal(received.length, 1);
});

test("révoquer un téléphone refuse aussi la consigne encore en cours d’envoi", async t => {
    const fake = fakeTunnel(), received = [];
    const link = createIdeLink({ workspace: () => "projet", spawnProcess: fake.spawn, enqueue: prompt => received.push(prompt), snapshot: () => ({ tasks: [] }) });
    t.after(() => link.stop()); const token = await startAndPair(link, fake);
    const body = JSON.stringify({ prompt: "Ne doit pas être exécuté après révocation" });
    let revoke;
    const revoked = new Promise(resolve => { revoke = resolve; });
    const response = new Promise((resolve, reject) => {
        const req = http.request({ host: "127.0.0.1", port: fake.port(), path: "/api/tasks", method: "POST", headers: { host: "example.trycloudflare.com", origin: "capacitor://localhost", authorization: `Bearer ${token}`, "content-type": "application/json", "content-length": Buffer.byteLength(body), expect: "100-continue" } }, res => {
            res.resume(); res.on("end", () => resolve(res.statusCode));
        });
        req.on("error", reject);
        req.on("continue", () => {
            // Receiving 100 Continue guarantees the request reached the server;
            // its body is held back until the desktop has revoked the session.
            link.renewPairing(); revoke(); req.end(body);
        });
        req.flushHeaders();
    });
    await revoked;
    assert.equal(await response, 401);
    assert.deepEqual(received, []);
});

test("les pièces jointes distantes sont authentifiées et limitées", async t => {
    const fake = fakeTunnel(), received = [];
    const link = createIdeLink({ workspace: () => "projet", spawnProcess: fake.spawn, enqueue: (prompt, files) => received.push({ prompt, files }), snapshot: () => ({ enabled: false, tasks: [] }) });
    t.after(() => link.stop());
    const token = await startAndPair(link, fake), port = fake.port();
    const file = { name: "note.txt", kind: "file", data: "data:text/plain;base64,SGVsbG8=" };
    const body = JSON.stringify({ prompt: "Lis ce fichier", attachments: [file] });
    assert.equal((await request(port, "/api/tasks", { body })).status, 401);
    assert.equal((await request(port, "/api/tasks", { token, body })).status, 200);
    assert.equal(received[0].files[0].size, 5);
    assert.equal(received[0].files[0].data, file.data);
    assert.equal((await request(port, "/api/tasks", { token, body: JSON.stringify({ prompt: "test", attachments: [file, file, file, file, file] }) })).status, 400);
    assert.equal((await request(port, "/api/tasks", { token, body: JSON.stringify({ prompt: "test", attachments: [{ ...file, data: "file:///etc/passwd" }] }) })).status, 400);
    assert.equal((await request(port, "/api/tasks", { token, body: JSON.stringify({ prompt: "test", attachments: [{ ...file, data: "data:text/plain;base64," + Buffer.alloc(2 * 1024 * 1024 + 1).toString("base64") }] }) })).status, 400);
    assert.equal(received.length, 1);
});

test("une pièce jointe distante parvient à la vraie file et à son exécution", async t => {
    const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ide-link-queue-")), fake = fakeTunnel();
    let finished; const done = new Promise(resolve => { finished = resolve; });
    const queue = require("../desktop/task-queue").createTaskQueue({ file: path.join(dir, "queue.json"), workspace: () => "projet", canRun: () => true, run: async (prompt, options) => { finished({ prompt, files: options.attachments, mode: options.mode }); return { ok: true }; } });
    const link = createIdeLink({ workspace: () => "projet", spawnProcess: fake.spawn, snapshot: () => queue.snapshot(), enqueue: (prompt, attachments, mode) => { queue.action("add", { prompt, attachments, mode }); queue.action("start"); } });
    t.after(async () => { await link.stop(); await new Promise(resolve => setTimeout(resolve, 20)); fs.rmSync(dir, { recursive: true, force: true }); });
    const token = await startAndPair(link, fake);
    const response = await request(fake.port(), "/api/tasks", { token, body: JSON.stringify({ prompt: "Lis le fichier", mode: "plan", attachments: [{ name: "note.txt", kind: "file", data: "data:text/plain;base64,SGVsbG8=" }] }) });
    assert.equal(response.status, 200);
    const result = await Promise.race([done, new Promise((_, reject) => setTimeout(() => reject(new Error("Exécution expirée")), 3000))]);
    assert.equal(result.prompt, "Lis le fichier");
    assert.equal(result.mode, "plan");
    assert.equal((await request(fake.port(), "/api/tasks", { token, body: JSON.stringify({ prompt: "Test", mode: "invalide" }) })).status, 400);
    assert.equal(result.files[0].data, "data:text/plain;base64,SGVsbG8=");
});

test("ajouter un fichier à une tâche conserve ses pièces jointes et reste authentifié", async t => {
    const fs = require("node:fs"), os = require("node:os"), path = require("node:path");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ide-link-attach-")), fake = fakeTunnel();
    const queue = require("../desktop/task-queue").createTaskQueue({ file: path.join(dir, "queue.json"), workspace: () => "projet", canRun: () => false, run: async () => ({ ok: true }) });
    const original = { name: "initial.txt", kind: "file", data: "data:text/plain;base64,SGVsbG8=" };
    queue.action("add", { prompt: "Lire les fichiers", attachments: [original] });
    const id = queue.snapshot().tasks[0].id;
    const link = createIdeLink({ workspace: () => "projet", spawnProcess: fake.spawn, enqueue() {}, snapshot: () => ({ ...queue.snapshot(), canSteer: true }), queueAction: (action, payload) => queue.action(action, payload) });
    t.after(async () => { await link.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
    const token = await startAndPair(link, fake), port = fake.port();
    const file = { name: "ajout.txt", kind: "file", data: "data:text/plain;base64,QQ==" };
    const body = JSON.stringify({ action: "attach", id, attachments: [file] });
    assert.equal((await request(port, "/api/queue", { body })).status, 401);
    assert.equal((await request(port, "/api/queue", { token, body: JSON.stringify({ action: "attach", id, attachments: [{ ...file, data: "file:///secret" }] }) })).status, 400);
    assert.equal((await request(port, "/api/queue", { token, body })).status, 200);
    const stored = queue.action("attachments", { id }).attachments;
    assert.deepEqual(stored.map(f => f.name), ["initial.txt", "ajout.txt"]);
    assert.equal(stored[0].data, original.data);
    assert.equal(stored[1].data, file.data);
    const state = (await request(port, "/api/state", { token })).body;
    assert.equal(state.queue.canSteer, true);
    assert.deepEqual(state.queue.tasks[0].attachments, [{ name: "initial.txt" }, { name: "ajout.txt" }]);
    assert.equal((await request(port, "/api/queue", { token, body: JSON.stringify({ action: "attach", id: "missing", attachments: [file] }) })).status, 409);
    assert.equal((await request(port, "/api/queue", { token, body: JSON.stringify({ action: "attach", id, attachments: [file, file, file] }) })).status, 400);
    assert.equal(queue.action("attachments", { id }).attachments.length, 2);
});

test("les actions de file distantes sont authentifiées et limitées", async t => {
    const fake = fakeTunnel(), calls = [];
    const link = createIdeLink({ workspace: () => "projet", spawnProcess: fake.spawn, enqueue() {}, snapshot: () => ({ enabled: false, tasks: [] }), queueAction: (action, payload) => calls.push({ action, id: payload.id }) });
    t.after(() => link.stop());
    const token = await startAndPair(link, fake), port = fake.port();
    const body = JSON.stringify({ action: "remove", id: "task-1" });
    assert.equal((await request(port, "/api/queue", { body })).status, 401);
    assert.equal((await request(port, "/api/queue", { token, origin: "https://evil.example", body })).status, 401);
    assert.equal((await request(port, "/api/queue", { token, body: JSON.stringify({ action: "clear" }) })).status, 400);
    assert.equal((await request(port, "/api/queue", { token, body: JSON.stringify({ action: "remove" }) })).status, 400);
    assert.equal(calls.length, 0);
    assert.equal((await request(port, "/api/queue", { token, body })).status, 200);
    assert.equal((await request(port, "/api/queue", { token, body: JSON.stringify({ action: "pause" }) })).status, 200);
    assert.equal((await request(port, "/api/queue", { body: JSON.stringify({ action: "interrupt" }) })).status, 401);
    assert.equal((await request(port, "/api/queue", { token, body: JSON.stringify({ action: "interrupt" }) })).status, 200);
    assert.equal((await request(port, "/api/queue", { token, body: JSON.stringify({ action: "move", id: "task-1", direction: "sideways" }) })).status, 400);
    assert.equal((await request(port, "/api/queue", { token, body: JSON.stringify({ action: "edit", id: "task-1", prompt: "/logout" }) })).status, 400);
    assert.equal((await request(port, "/api/queue", { token, body: JSON.stringify({ action: "move", id: "task-1", direction: "up" }) })).status, 200);
    assert.equal((await request(port, "/api/queue", { token, body: JSON.stringify({ action: "edit", id: "task-1", prompt: "Nouvelle demande" }) })).status, 200);
    assert.equal((await request(port, "/api/queue", { token, body: JSON.stringify({ action: "steer", id: "task-1" }) })).status, 200);
    assert.deepEqual(calls, [{ action: "remove", id: "task-1" }, { action: "pause", id: undefined }, { action: "interrupt", id: undefined }, { action: "move", id: "task-1" }, { action: "edit", id: "task-1" }, { action: "steer", id: "task-1" }]);
});

test("le PIN est limité, à usage unique et lié à la session", async t => {
    const fake = fakeTunnel();
    const link = createIdeLink({ workspace: () => "projet", spawnProcess: fake.spawn, enqueue() {}, snapshot: () => ({ enabled: false, tasks: [] }) });
    t.after(() => link.stop());
    const info = await link.start(), port = fake.port(), pin = info.pin;
    assert.match(pin, /^\d{6}$/);
    const body = JSON.stringify({ pin });
    assert.equal((await request(port, "/api/pair", { origin: "https://evil.example", body })).status, 403);
    const paired = await request(port, "/api/pair", { body });
    assert.equal(paired.status, 200);
    assert.equal(new URL(info.url).hash, "");
    assert.ok(paired.body.token.length >= 40);
    assert.equal((await request(port, "/api/state", { token: paired.body.token })).status, 200);
    assert.equal((await request(port, "/api/pair", { body })).status, 429);
    assert.equal(link.status().pin, "");
    await link.stop();
    const next = await link.start(), wrong = next.pin === "000000" ? "000001" : "000000";
    for (let i = 0; i < 5; i++) assert.equal((await request(fake.port(), "/api/pair", { body: JSON.stringify({ pin: wrong }) })).status, 401);
    assert.equal((await request(fake.port(), "/api/pair", { body: JSON.stringify({ pin: next.pin }) })).status, 429);
    assert.equal(link.status().pin, "");
});

test("arrêter puis relancer révoque le lien précédent", async t => {
    const fake = fakeTunnel();
    const link = createIdeLink({ workspace: () => "projet", spawnProcess: fake.spawn, enqueue() {}, snapshot: () => ({ enabled: false, tasks: [] }) });
    t.after(() => link.stop());
    const first = await startAndPair(link, fake);
    await link.stop();
    const second = await startAndPair(link, fake);
    assert.notEqual(first, second);
    assert.equal((await request(fake.port(), "/api/state", { token: first })).status, 401);
    assert.equal((await request(fake.port(), "/api/state", { token: second })).status, 200);
});

test("une interruption pendant le démarrage ne laisse pas de session active", async () => {
    const fake = fakeTunnel();
    const link = createIdeLink({ workspace: () => "projet", spawnProcess: fake.spawn, enqueue() {}, snapshot: () => ({ enabled: false, tasks: [] }) });
    const starting = link.start();
    await link.stop();
    await assert.rejects(starting, /annul/i);
    assert.equal(link.status().state, "stopped");
    assert.equal(link.status().url, "");
});

test("les demandes interactives distantes respectent les autorisations et les refus", async t => {
    const fake = fakeTunnel(), answers = [];
    const link = createIdeLink({ workspace: () => "projet", spawnProcess: fake.spawn, enqueue() {}, snapshot: () => ({ enabled: false, tasks: [] }), resolvePrompt: (id, answer) => { answers.push({ id, answer }); return true; } });
    t.after(() => link.stop());
    const token = await startAndPair(link, fake), port = fake.port();
    link.record("prompt", { id: 1, kind: "confirm", question: "Autoriser ?" });
    link.record("prompt", { id: 2, kind: "secret", question: "Mot de passe" });
    let state = await request(port, "/api/state", { token });
    assert.deepEqual(state.body.pending.map(p => p.id), [1]);
    const refusal = JSON.stringify({ id: 1, answer: "n" });
    assert.equal((await request(port, "/api/prompt", { body: refusal })).status, 401);
    assert.equal((await request(port, "/api/prompt", { token, origin: "https://evil.example", body: refusal })).status, 401);
    assert.equal((await request(port, "/api/prompt", { token, body: JSON.stringify({ id: 1, answer: "t" }) })).status, 400);
    assert.equal(answers.length, 0);
    assert.equal((await request(port, "/api/prompt", { token, body: refusal })).status, 200);
    assert.deepEqual(answers, [{ id: 1, answer: "n" }]);
    assert.equal((await request(port, "/api/prompt", { token, body: refusal })).status, 409);
    link.record("prompt", { id: 3, kind: "question", question: "Choix ?", options: [{ id: "1", label: "Oui" }, { id: "2", label: "Non" }] });
    assert.equal((await request(port, "/api/prompt", { token, body: JSON.stringify({ id: 3, answer: { selected: ["99"], text: "" } }) })).status, 400);
    const skip = { skipped: true };
    assert.equal((await request(port, "/api/prompt", { token, body: JSON.stringify({ id: 3, answer: skip }) })).status, 200);
    assert.deepEqual(answers[1], { id: 3, answer: skip });
    link.record("prompt", { id: 4, kind: "command", question: "Exécuter ?" });
    link.record("promptResolved", { id: 4 });
    assert.equal((await request(port, "/api/prompt", { token, body: JSON.stringify({ id: 4, answer: "o" }) })).status, 409);
});

test("un démarrage sans projet est refusé", async () => {
    const link = createIdeLink({ workspace: () => null, enqueue() {}, snapshot: () => ({ tasks: [] }) });
    await assert.rejects(link.start(), /projet/i);
    assert.equal(link.status().state, "stopped");
});

test("IDE Link reprend les messages avant activation et isole les projets", async t => {
    let project = "projet-a";
    const fake = fakeTunnel();
    const link = createIdeLink({ workspace: () => project, spawnProcess: fake.spawn, enqueue() {}, snapshot: () => ({ enabled: false, tasks: [] }) });
    t.after(() => link.stop());
    link.record("conversationReplay", { entries: [{ type: "user", text: "Ancienne demande" }, { type: "reason", text: "Analyse" }, { type: "tool", name: "read_file", arg: "note.txt" }] });
    link.record("liveStart"); link.record("liveAppend", "Réponse en cours");
    const token = await startAndPair(link, fake);
    const state = await request(fake.port(), "/api/state", { token });
    assert.deepEqual(state.body.history.map(item => item.type), ["user", "reason", "tool"]);
    assert.equal(state.body.history[0].text, "Ancienne demande");
    assert.equal(state.body.live, "Réponse en cours");
    link.record("liveEnd");
    assert.equal((await request(fake.port(), "/api/state", { token })).body.history.at(-1).text, "Réponse en cours");
    project = "projet-b"; link.record("entry", { type: "user", text: "Autre projet" });
    assert.equal(link.status().state, "stopped");
    link.record("entry", { type: "user", text: "Nouveau projet" });
    const next = await startAndPair(link, fake);
    const stateNext = await request(fake.port(), "/api/state", { token: next });
    assert.ok(!stateNext.body.history.some(item => item.text === "Ancienne demande"));
    assert.equal(stateNext.body.history.at(-1).text, "Nouveau projet");
});


test("les commandes IDE distantes exigent une association et cessent à sa révocation", async t => {
    const fake = fakeTunnel(); let release, called = 0;
    const started = new Promise(resolve => { release = resolve; });
    let proceed; const gate = new Promise(resolve => { proceed = resolve; });
    const link = createIdeLink({ workspace: () => "projet", enqueue() {}, snapshot: () => ({tasks:[]}), spawnProcess: fake.spawn,
        remoteControl: async (action, payload, scope, isCurrent) => {
            called++; assert.equal(scope, "projet"); assert.equal(action, "catalog"); assert.equal(isCurrent(), true);
            release(); await gate; assert.equal(isCurrent(), false); return {models:[]};
        } });
    t.after(() => link.stop());
    const info = await link.start();
    assert.equal((await request(fake.port(), "/api/ide", {body:JSON.stringify({action:"catalog"})})).status, 401);
    assert.equal(called, 0);
    const token = await pair(fake.port(), info);
    assert.equal((await request(fake.port(), "/api/ide", {token, body:JSON.stringify({action:"inconnue"})})).status, 400);
    const pending = request(fake.port(), "/api/ide", {token, body:JSON.stringify({action:"catalog"})});
    await started; link.renewPairing(); proceed();
    assert.equal((await pending).status, 409);
    assert.equal((await request(fake.port(), "/api/ide", {token, body:JSON.stringify({action:"catalog"})})).status, 401);
});
