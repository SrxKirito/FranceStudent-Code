"use strict";
// Shared discovery service; no private backend, domain, or provider account is required.
const IDE_LINK_RELAY = "https://ntfy.sh", IDE_LINK_AAD = "frst-ide-link-discovery-v1";
let franceIDERemembered = null;
let ideLinkVaultQueue = Promise.resolve();
let ideLinkRememberEpoch = 0;
function ideLinkBytes(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Donnée d’association invalide.");
  const base = value.replace(/-/g, "+").replace(/_/g, "/");
  return Uint8Array.from(atob(base + "=".repeat((4 - base.length % 4) % 4)), char => char.charCodeAt(0));
}
function ideLinkBase64(bytes) { return btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); }
function validRememberedLink(value) {
  if (!value || value.v !== 1 || value.relay !== IDE_LINK_RELAY || ![value.id, value.discoveryKey, value.credential].every(key => typeof key === "string" && /^[A-Za-z0-9_-]{43}$/.test(key))) throw new Error("L’association mémorisée est invalide. Scanne un nouveau QR code.");
  return { v: 1, relay: IDE_LINK_RELAY, id: value.id, discoveryKey: value.discoveryKey, credential: value.credential, name: String(value.name || "Ordinateur").slice(0, 80), lastSeq: Number.isSafeInteger(value.lastSeq) && value.lastSeq >= 0 ? value.lastSeq : 0 };
}
function ideLinkVault() { return window.Capacitor?.Plugins?.IDELinkVault; }
async function saveRememberedLink(value, { guard = () => true, resume = false } = {}) {
  if (!resume) ideLinkRememberEpoch++;
  const vault = ideLinkVault(); if (!vault?.save) throw new Error("Mets à jour l’app mobile pour conserver cette association.");
  const normalized = validRememberedLink(value);
  const operation = ideLinkVaultQueue.then(async () => { if (!guard()) throw new Error("Reconnexion annulée."); await vault.save({ value: JSON.stringify(normalized) }); franceIDERemembered = normalized; return normalized; });
  ideLinkVaultQueue = operation.catch(() => {}); return operation;
}
async function loadRememberedLink() {
  const epoch = ideLinkRememberEpoch;
  const vault = ideLinkVault(); if (!vault?.read) return null;
  const operation = ideLinkVaultQueue.then(async () => {
    if (epoch !== ideLinkRememberEpoch) return null;
    const result = await vault.read();
    if (epoch !== ideLinkRememberEpoch) return null;
    if (!result.value) { franceIDERemembered = null; return null; }
    if (result.value.length > 16384) throw new Error("Association mémorisée trop longue.");
    franceIDERemembered = validRememberedLink(JSON.parse(result.value)); return franceIDERemembered;
  });
  ideLinkVaultQueue = operation.catch(() => {}); return operation;
}
async function forgetRememberedLink() { ideLinkRememberEpoch++; const operation = ideLinkVaultQueue.then(async () => { if (ideLinkVault()?.remove) await ideLinkVault().remove(); franceIDERemembered = null; }); ideLinkVaultQueue = operation.catch(() => {}); return operation; }
async function rememberedTransport(url, { method = "GET", data } = {}) {
  const native = window.Capacitor?.Plugins?.CapacitorHttp;
  if (!native?.request || !window.Capacitor?.isNativePlatform?.()) throw new Error("La reconnexion durable nécessite l’app mobile.");
  const response = await native.request({ url, method, headers: { Origin: "capacitor://localhost", ...(method === "POST" ? { "Content-Type": "application/json" } : {}) }, ...(data === undefined ? {} : { data }), connectTimeout: 8000, readTimeout: 10000, disableRedirects: true, responseType: "text" });
  if (response.status < 200 || response.status >= 300) throw new Error("Le service de découverte ou l’ordinateur est momentanément indisponible.");
  const text = typeof response.data === "string" ? response.data : JSON.stringify(response.data);
  if (text.length > 65536) throw new Error("Réponse de découverte trop volumineuse.");
  return text;
}
async function ideLinkHmac(credential, purpose, proof) {
  const key = await crypto.subtle.importKey("raw", ideLinkBytes(credential), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
  const data = new TextEncoder().encode(purpose + ":" + JSON.stringify(proof));
  return { key, data };
}
async function resumeRememberedLink(saved, { canceled = () => false } = {}) {
  if (!globalThis.crypto?.subtle) throw new Error("Le chiffrement sécurisé est indisponible dans cette version de l’app. Mets-la à jour ou utilise une association temporaire.");
  const epoch = ideLinkRememberEpoch;
  const stop = () => { if (canceled() || epoch !== ideLinkRememberEpoch) throw new Error("Reconnexion annulée."); };
  stop(); saved = validRememberedLink(saved);
  const text = await rememberedTransport(`${saved.relay}/frst-ide-${saved.id}/json?poll=1&since=1h`); stop();
  const key = await crypto.subtle.importKey("raw", ideLinkBytes(saved.discoveryKey), "AES-GCM", false, ["decrypt"]);
  let latest = null;
  for (const line of text.split("\n").slice(-100)) {
    try {
      const event = JSON.parse(line); if (event.event !== "message" || typeof event.message !== "string" || event.message.length > 4096) continue;
      const envelope = JSON.parse(event.message); if (envelope.v !== 1 || ideLinkBytes(envelope.iv).length !== 12) continue;
      const bytes = await crypto.subtle.decrypt({ name: "AES-GCM", iv: ideLinkBytes(envelope.iv), additionalData: new TextEncoder().encode(IDE_LINK_AAD), tagLength: 128 }, key, ideLinkBytes(envelope.data));
      const record = JSON.parse(new TextDecoder().decode(bytes));
      if (record.v !== 1 || record.id !== saved.id || !Number.isSafeInteger(record.seq) || record.seq < saved.lastSeq || !Number.isFinite(record.expiresAt) || record.expiresAt < Date.now() || record.expiresAt > Date.now() + 46 * 60000 || typeof record.online !== "boolean" || typeof record.revoked !== "boolean") continue;
      if (!latest || record.seq > latest.seq) latest = record;
    } catch { /* Forged or damaged broker messages never authorize a connection. */ }
  }
  stop();
  if (!latest) throw new Error("Ordinateur hors ligne ou annonce expirée. Ouvre le projet dans l’IDE.");
  if (latest.revoked) { const error = new Error("Association révoquée depuis l’IDE. Scanne un nouveau QR code."); error.revoked = true; throw error; }
  if (!latest.online) throw new Error("L’ordinateur est hors ligne ou IDE Link est suspendu.");
  const origin = ideLinkAddress(latest.origin).origin;
  const nonce = ideLinkBase64(crypto.getRandomValues(new Uint8Array(32)));
  const signed = JSON.parse(await rememberedTransport(origin + "/api/identity?nonce=" + nonce)); stop();
  const p = signed.proof;
  if (!p || p.v !== 1 || p.id !== saved.id || p.origin !== origin || p.nonce !== nonce || !/^[A-Za-z0-9_-]{43}$/.test(p.challenge || "") || !Number.isFinite(p.expiresAt) || p.expiresAt < Date.now() || p.expiresAt > Date.now() + 35000) throw new Error("L’identité de l’ordinateur n’a pas pu être vérifiée.");
  const proof = { v: 1, id: p.id, origin: p.origin, nonce: p.nonce, challenge: p.challenge, expiresAt: p.expiresAt };
  const server = await ideLinkHmac(saved.credential, "server", proof);
  if (!await crypto.subtle.verify("HMAC", server.key, ideLinkBytes(signed.mac), server.data)) throw new Error("L’identité de l’ordinateur n’a pas pu être vérifiée.");
  const client = await ideLinkHmac(saved.credential, "client", proof), mac = ideLinkBase64(await crypto.subtle.sign("HMAC", client.key, client.data)); stop();
  const result = JSON.parse(await rememberedTransport(origin + "/api/resume", { method: "POST", data: { challenge: p.challenge, mac } })); stop();
  if (!/^[A-Za-z0-9_-]{43}$/.test(result.token || "")) throw new Error("Réponse de reconnexion invalide.");
  await saveRememberedLink({ ...saved, lastSeq: latest.seq }, { guard: () => !canceled() && epoch === ideLinkRememberEpoch, resume: true }); stop();
  return { origin, token: result.token, remembered: true };
}
