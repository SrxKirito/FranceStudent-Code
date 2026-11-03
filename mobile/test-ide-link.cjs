"use strict";
// Prepared for release validation. No native device or real tunnel is simulated
// as having passed by these focused transport/address checks.
const assert = require("node:assert/strict"), fs = require("node:fs"), vm = require("node:vm");
const sent = [];
const context = vm.createContext({ URL, URLSearchParams, AbortSignal, window: { Capacitor: { isNativePlatform: () => true, Plugins: { CapacitorHttp: { request: async options => { sent.push(options); return { status: 200, data: { token: "paired" } }; } } } } } });
vm.runInContext(fs.readFileSync(__dirname + "/www/js/ide-link.js", "utf8"), context);
const ticket = "A".repeat(43), origin = "https://example.trycloudflare.com";
assert.equal(context.ideLinkAddress(origin + "/#ide-link=" + ticket).ticket, ticket);
assert.equal(context.ideLinkAddress("https://ide.example.com/#ide-link=" + ticket).origin, "https://ide.example.com");
for (const value of ["http://example.trycloudflare.com", "https://localhost/", "https://127.0.0.1/", "https://[::1]/", "https://ordinateur.local/", origin + ":8443/", origin + "/api/state", origin + "/?token=secret", origin + "/#ide-link=short", "https://example.trycloudflare.com.evil.example/", "https://secret@example.trycloudflare.com/"]) assert.throws(() => context.ideLinkAddress(value));
(async () => {
  await context.franceIDECall({ origin, token: "" }, "/api/pair", { ticket });
  assert.equal(sent[0].url, origin + "/api/pair");
  assert.equal(sent[0].headers.Origin, "capacitor://localhost");
  assert.equal(sent[0].data.ticket, ticket);
  assert.equal(sent[0].disableRedirects, true);
  await context.franceIDECall({ origin, token: "paired" }, "/api/tasks", { prompt: "Une seule demande" });
  assert.equal(sent[1].headers.Authorization, "Bearer paired");
  context.window.Capacitor.Plugins.CapacitorHttp.request = async () => ({ status: 401, data: { error: "Révoqué" } });
  await assert.rejects(() => context.franceIDECall({ origin, token: "paired" }, "/api/state"), error => error.status === 401);
  let calls = 0;
  context.window.Capacitor.Plugins.CapacitorHttp.request = async () => { calls++; throw new Error("Transport interrompu"); };
  await assert.rejects(() => context.franceIDECall({ origin, token: "paired" }, "/api/tasks", { prompt: "Ne pas doubler" }));
  assert.equal(calls, 1, "Une action dont la réception est incertaine n’est jamais renvoyée automatiquement");
  console.log("OK : adresses QR, transport natif, révocation et absence de renvoi automatique.");
})().catch(error => { console.error(error); process.exitCode = 1; });
