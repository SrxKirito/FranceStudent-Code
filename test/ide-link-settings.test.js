"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const { createIdeLinkSettings, fixedOrigin } = require("../desktop/ide-link-settings");
function fixture() {
    let saved = {};
    const settings = { load: () => structuredClone(saved), save: patch => { saved = { ...saved, ...structuredClone(patch) }; } };
    // Deterministic test vault, only for checking the persistence boundary.
    const secrets = { available: () => true, protect: value => ({ format: "test-vault", data: Buffer.from(value).toString("base64") }), unprotect: value => value?.format === "test-vault" ? Buffer.from(value.data, "base64").toString() : null };
    return { settings, secrets, store: createIdeLinkSettings({ settings, secrets }) };
}
test("l’adresse fixe et le port survivent à une nouvelle instance sans jeton en clair", () => {
    const f = fixture(), token = "DEMO_TUNNEL_TOKEN_" + "A".repeat(80);
    f.store.save({ mode: "fixed", origin: "https://ide.example.com/", port: 43821, token });
    assert.doesNotMatch(JSON.stringify(f.settings.load()), new RegExp(token));
    assert.equal(f.store.status().hasToken, true); assert.equal(f.store.status().token, undefined);
    const reopened = createIdeLinkSettings(f);
    assert.equal(reopened.status().origin, "https://ide.example.com");
    assert.equal(reopened.connection().token, token); assert.equal(reopened.connection().port, 43821);
    reopened.save({ mode: "fixed", origin: "https://ide.example.com", port: 43821, token: "" });
    assert.equal(reopened.connection().token, token);
    reopened.save({ mode: "temporary" }); assert.deepEqual(reopened.connection(), { mode: "temporary" });
    reopened.forget(); assert.equal(reopened.status().hasToken, false);
});
test("une adresse fixe refuse les URL locales, temporaires ou enrichies", () => {
    for (const url of ["http://ide.example.com", "https://localhost", "https://pc.local", "https://127.0.0.1", "https://[::1]", "https://1234", "https://demo.trycloudflare.com", "https://ide.example.com:8443", "https://ide.example.com/path", "https://user:pass@ide.example.com", "https://ide.example.com/#ide-link=secret"]) assert.throws(() => fixedOrigin(url));
    assert.equal(fixedOrigin(" https://IDE.example.com/ "), "https://ide.example.com");
});
test("le coffre indisponible ou un port invalide n’écrit aucune configuration", () => {
    const f = fixture(), input = { mode: "fixed", origin: "https://ide.example.com", port: 43821, token: "A".repeat(80) };
    f.secrets.available = () => false;
    assert.throws(() => f.store.save(input), /coffre/); assert.deepEqual(f.settings.load(), {});
    f.secrets.available = () => true;
    assert.throws(() => f.store.save({ ...input, port: 0 }), /port/);
    assert.deepEqual(f.settings.load(), {});
});
