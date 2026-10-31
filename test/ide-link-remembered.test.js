"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), crypto = require("node:crypto");
const { createRememberedLink, seal, mac, AAD } = require("../desktop/ide-link-remembered");
function fixture() {
    let saved = {};
    const settings = { load: () => structuredClone(saved), save: patch => { saved = { ...saved, ...structuredClone(patch) }; } };
    // Test-only envelope; the real implementation uses the OS vault.
    const secrets = { available: () => true, protect: text => ({ data: Buffer.from(text).toString("base64") }), unprotect: value => value ? Buffer.from(value.data, "base64").toString() : null };
    const requests = [], timers = [];
    const options = { settings, secrets, fetchImpl: async (url, options) => { requests.push({ url, options }); return { ok: true, body: { cancel: async () => {} } }; }, schedule: (callback, delay) => { timers.push({ callback, delay }); return 1; }, unschedule() {} };
    const store = createRememberedLink(options); store.configure("project-a", true);
    return { store, options, settings, secrets, requests, timers };
}
test("une association reste chiffrée et réserve de nouvelles séquences après redémarrage", () => {
    const f = fixture(), first = f.store.create("project-a", "iPhone");
    const disk = JSON.stringify(f.settings.load());
    assert.equal(disk.includes(first.credential), false); assert.equal(disk.includes(first.discoveryKey), false);
    const restarted = createRememberedLink(f.options).load("project-a");
    assert.equal(restarted.credential, first.credential); assert.equal(restarted.id, first.id); assert.ok(restarted.sequence > first.sequence);
    assert.equal(f.store.load("project-b"), null);
    f.store.forget("project-a"); assert.equal(f.store.load("project-a"), null);
});
test("les annonces ne contiennent ni l’adresse ni les clés en clair", async () => {
    const f = fixture(), identity = f.store.create("project-a", "iPhone");
    const publisher = f.store.publisher(identity, "https://example.trycloudflare.com");
    await publisher.stop({ revoked: true });
    assert.ok(f.requests.length >= 1);
    const body = f.requests.at(-1).options.body;
    assert.equal(body.includes("trycloudflare"), false); assert.equal(body.includes(identity.credential), false);
    const envelope = JSON.parse(body), bytes = Buffer.from(envelope.data, "base64url");
    const decipher = crypto.createDecipheriv("aes-256-gcm", Buffer.from(identity.discoveryKey, "base64url"), Buffer.from(envelope.iv, "base64url"));
    decipher.setAAD(Buffer.from(AAD)); decipher.setAuthTag(bytes.subarray(-16));
    const record = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(0, -16)), decipher.final()]).toString());
    assert.equal(record.revoked, true); assert.equal(record.online, false);
});
test("preuve serveur et réponse client sont distinctes, et un coffre indisponible refuse l’opt-in", () => {
    const f = fixture(), identity = f.store.create("project-a", "iPhone");
    const signed = f.store.proof(identity, "https://example.trycloudflare.com", "n".repeat(43), "c".repeat(43));
    assert.equal(f.store.verify(identity, signed.proof, signed.mac), false);
    assert.equal(f.store.verify(identity, signed.proof, mac(identity.credential, "client", signed.proof)), true);
    assert.notEqual(seal({ online: true }, identity.discoveryKey), seal({ online: true }, identity.discoveryKey));
    f.secrets.available = () => false;
    assert.throws(() => f.store.configure("other-project", true), /coffre/);
    f.store.clearAll(); assert.equal(f.store.status("project-a").paired, false);
});
