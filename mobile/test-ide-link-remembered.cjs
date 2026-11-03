"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), vm = require("node:vm"), crypto = require("node:crypto");
function envelope(record, key) {
  const iv = crypto.randomBytes(12), cipher = crypto.createCipheriv("aes-256-gcm", Buffer.from(key, "base64url"), iv);
  cipher.setAAD(Buffer.from("frst-ide-link-discovery-v1"));
  const data = Buffer.concat([cipher.update(JSON.stringify(record)), cipher.final(), cipher.getAuthTag()]);
  return JSON.stringify({ v: 1, iv: iv.toString("base64url"), data: data.toString("base64url") });
}
const id = crypto.randomBytes(32).toString("base64url"), key = crypto.randomBytes(32).toString("base64url"), credential = crypto.randomBytes(32).toString("base64url"), origin = "https://example.trycloudflare.com";
const saved = { v: 1, relay: "https://ntfy.sh", id, discoveryKey: key, credential, name: "PC" }, requests = [];
let stored = "", forged = false, revoked = false, proof;
const hmac = (purpose, value) => crypto.createHmac("sha256", Buffer.from(credential, "base64url")).update(purpose + ":" + JSON.stringify(value)).digest("base64url");
const context = vm.createContext({ URL, URLSearchParams, crypto: crypto.webcrypto, TextEncoder, TextDecoder, Uint8Array, atob, btoa, Date, ideLinkAddress: value => ({ origin: new URL(value).origin }),
  window: { Capacitor: { isNativePlatform: () => true, Plugins: {
    IDELinkVault: { save: async ({ value }) => { stored = value; }, read: async () => ({ value: stored }), remove: async () => { stored = ""; } },
    CapacitorHttp: { request: async options => {
      requests.push(options);
      if (options.url.startsWith("https://ntfy.sh/")) return { status: 200, data: JSON.stringify({ event: "message", message: envelope({ v: 1, id, seq: 5, origin, online: !revoked, revoked, expiresAt: Date.now() + 60000 }, key) }) + "\n" };
      if (options.url.includes("/api/identity")) { proof = { v: 1, id, origin, nonce: new URL(options.url).searchParams.get("nonce"), challenge: "c".repeat(43), expiresAt: Date.now() + 30000 }; return { status: 200, data: JSON.stringify({ proof, mac: forged ? "x".repeat(43) : hmac("server", proof) }) }; }
      assert.equal(options.data.mac, hmac("client", proof));
      return { status: 200, data: JSON.stringify({ token: "t".repeat(43) }) };
    } }
  } } } });
vm.runInContext(fs.readFileSync(__dirname + "/www/js/ide-link-remembered.js", "utf8"), context);
(async () => {
  const session = await context.resumeRememberedLink(saved);
  assert.equal(session.origin, origin); assert.equal(session.token, "t".repeat(43));
  assert.equal(JSON.stringify(requests).includes(credential), false); assert.equal(JSON.stringify(requests).includes(key), false);
  assert.equal(JSON.parse(stored).lastSeq, 5);
  forged = true; const before = requests.filter(request => request.url.endsWith("/api/resume")).length;
  await assert.rejects(() => context.resumeRememberedLink(saved), /identité/);
  assert.equal(requests.filter(request => request.url.endsWith("/api/resume")).length, before);
  forged = false; revoked = true;
  await assert.rejects(() => context.resumeRememberedLink(saved), error => error.revoked === true);
  // Reading during a queued removal must not restore the forgotten identity.
  const forgetting = context.forgetRememberedLink(), reading = context.loadRememberedLink();
  await forgetting; assert.equal(await reading, null); assert.equal(stored, "");
  assert.equal(vm.runInContext('franceIDERemembered', context), null);
  console.log("OK : annonce AES-GCM Node/WebCrypto, preuve mutuelle, coffre et révocation simulés.");
})().catch(error => { console.error(error); process.exitCode = 1; });
