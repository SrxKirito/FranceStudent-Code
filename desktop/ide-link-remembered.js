"use strict";
const crypto = require("node:crypto");
const RELAY = "https://ntfy.sh", AAD = "frst-ide-link-discovery-v1";
const random = () => crypto.randomBytes(32).toString("base64url");
const validKey = value => typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
function mac(key, purpose, proof) { return crypto.createHmac("sha256", Buffer.from(key, "base64url")).update(`${purpose}:${JSON.stringify(proof)}`).digest("base64url"); }
function equal(a, b) { const x = Buffer.from(String(a || "")), y = Buffer.from(String(b || "")); return x.length === y.length && crypto.timingSafeEqual(x, y); }
function seal(record, key) {
    const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", Buffer.from(key, "base64url"), iv);
    cipher.setAAD(Buffer.from(AAD));
    const data = Buffer.concat([cipher.update(JSON.stringify(record)), cipher.final(), cipher.getAuthTag()]);
    return JSON.stringify({ v: 1, iv: iv.toString("base64url"), data: data.toString("base64url") });
}
function createRememberedLink({ settings = require("../src/settings"), secrets = require("../src/secret-storage"), fetchImpl = fetch, now = Date.now, schedule = setTimeout, unschedule = clearTimeout } = {}) {
    const activePublishers = new Map();
    const keyFor = workspace => crypto.createHash("sha256").update(process.platform === "win32" ? workspace.toLowerCase() : workspace).digest("hex");
    const entries = () => settings.load().ideLinkDevices || {};
    function write(key, entry) { settings.save({ ideLinkDevices: { ...entries(), [key]: entry } }); }
    function status(workspace) {
        const entry = workspace ? entries()[keyFor(workspace)] : null;
        return { available: Boolean(workspace) && secrets.available(), enabled: entry?.enabled === true, paired: Boolean(entry?.protectedPair), relay: RELAY };
    }
    function configure(workspace, enabled) {
        if (!workspace || typeof enabled !== "boolean") throw new Error("Ouvre un projet Code avant de mémoriser un téléphone.");
        if (enabled && !secrets.available()) throw new Error("Le coffre système est indisponible. L’association temporaire reste disponible.");
        const key = keyFor(workspace), entry = entries()[key] || {};
        write(key, enabled ? { ...entry, enabled: true } : { enabled: false });
        return status(workspace);
    }
    function persist(identity, nextSeq, replace = false) {
        const current = entries()[identity.workspaceKey];
        if (!current?.enabled || !replace && current.pairId !== identity.id) throw new Error("Cette association a été retirée.");
        const encoded = secrets.protect(JSON.stringify({ v: 1, id: identity.id, discoveryKey: identity.discoveryKey, credential: identity.credential, name: identity.name, connectedAt: identity.connectedAt, nextSeq }));
        if (!encoded) throw new Error("L’association ne peut pas être enregistrée sans coffre système.");
        write(identity.workspaceKey, { enabled: true, pairId: identity.id, protectedPair: encoded });
    }
    function create(workspace, name) {
        const identity = { id: random(), discoveryKey: random(), credential: random(), name, connectedAt: now(), workspaceKey: keyFor(workspace), sequence: 0, sequenceEnd: 4096 };
        persist(identity, identity.sequenceEnd, true); return identity;
    }
    function load(workspace) {
        if (!status(workspace).enabled) return null;
        const entry = entries()[keyFor(workspace)]; if (!entry?.protectedPair) return null;
        let decoded;
        try { decoded = JSON.parse(secrets.unprotect(entry.protectedPair)); } catch { /* Fail closed on unreadable credentials. */ }
        if (!decoded || ![decoded.id, decoded.discoveryKey, decoded.credential].every(validKey) || !Number.isSafeInteger(decoded.nextSeq) || decoded.nextSeq < 0 || decoded.nextSeq > Number.MAX_SAFE_INTEGER - 8192) throw new Error("L’association mémorisée est illisible. Oublie le téléphone puis scanne un nouveau QR code.");
        const identity = { ...decoded, name: String(decoded.name || "iPhone").slice(0, 80), workspaceKey: keyFor(workspace), sequence: decoded.nextSeq, sequenceEnd: decoded.nextSeq + 4096 };
        persist(identity, identity.sequenceEnd); return identity;
    }
    function forget(workspace) { if (workspace) write(keyFor(workspace), { enabled: status(workspace).enabled }); }
    function descriptor(identity) { return { v: 1, relay: RELAY, id: identity.id, discoveryKey: identity.discoveryKey, credential: identity.credential, name: identity.name }; }
    function proof(identity, origin, nonce, challenge) {
        const value = { v: 1, id: identity.id, origin, nonce, challenge, expiresAt: now() + 30000 };
        return { proof: value, mac: mac(identity.credential, "server", value) };
    }
    function verify(identity, proofValue, candidate) { return validKey(candidate) && equal(mac(identity.credential, "client", proofValue), candidate); }
    function publisher(identity, origin, onChange = () => {}) {
        let timer = null, ended = false, chain = Promise.resolve(), failures = 0;
        const owner = Symbol("publisher"); activePublishers.set(identity.id, owner);
        function send(online, revoked = false) {
            chain = chain.then(async () => {
                if (activePublishers.get(identity.id) !== owner) return false;
                const day = new Date(now()).toISOString().slice(0, 10), previous = settings.load().ideLinkDiscoveryBudget;
                const used = previous?.day === day ? Number(previous.used) || 0 : 0;
                if (used >= 150) { onChange("limited"); return false; }
                settings.save({ ideLinkDiscoveryBudget: { day, used: used + 1 } });
                if (identity.sequence >= identity.sequenceEnd) { identity.sequenceEnd += 4096; persist(identity, identity.sequenceEnd); }
                const record = { v: 1, id: identity.id, seq: ++identity.sequence, origin: online ? origin : "", online, revoked, expiresAt: now() + 45 * 60000 };
                const body = seal(record, identity.discoveryKey);
                try {
                    const response = await fetchImpl(`${RELAY}/frst-ide-${identity.id}`, { method: "POST", headers: { "Content-Type": "text/plain", "X-Firebase": "no" }, body, redirect: "error", signal: AbortSignal.timeout(5000) });
                    await response.body?.cancel().catch(() => {});
                    if (!response.ok) { onChange(response.status === 429 ? "limited" : "error"); return false; }
                    onChange(online ? "online" : "offline"); return true;
                } catch { onChange("error"); return false; }
            }).catch(() => { onChange("error"); return false; });
            return chain;
        }
        async function tick() {
            const ok = await send(true); failures = ok ? 0 : Math.min(failures + 1, 5);
            if (!ended) { timer = schedule(tick, ok ? 30 * 60000 : Math.min(30 * 60000, 60000 * 2 ** failures)); timer?.unref?.(); }
        }
        tick();
        return { stop({ revoked = false } = {}) { ended = true; if (timer !== null) unschedule(timer); return send(false, revoked).finally(() => { if (activePublishers.get(identity.id) === owner) activePublishers.delete(identity.id); }); } };
    }
    return { status, configure, create, load, forget, descriptor, proof, verify, publisher, clearAll: () => settings.save({ ideLinkDevices: {} }) };
}
module.exports = { createRememberedLink, seal, mac, RELAY, AAD };
