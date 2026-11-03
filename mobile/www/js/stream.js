"use strict";

function createSseParser(onEvent) {
  let buffer = "";
  let name = "";
  let data = [];
  let eventId = "";

  function dispatch() {
    const payload = data.join("\n");
    const eventName = name;
    name = "";
    data = [];
    if (payload) onEvent(eventName, payload, eventId);
  }

  function handleLine(line) {
    if (line === "") {
      dispatch();
      return;
    }
    if (line.startsWith(":")) return;
    const index = line.indexOf(":");
    const field = index < 0 ? line : line.slice(0, index);
    let value = index < 0 ? "" : line.slice(index + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "id" && !value.includes("\0")) eventId = value;
    if (field === "event") name = value;
    else if (field === "data") data.push(value);
  }

  return {
    feed(chunk) {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf("\n")) >= 0) {
        let line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.endsWith("\r")) line = line.slice(0, -1);
        handleLine(line);
      }
    },
    end() {
      if (buffer) {
        handleLine(buffer.replace(/\r$/, ""));
        buffer = "";
      }
      dispatch();
    }
  };
}

function describeStreamError(error) {
  if (!error) return "Erreur inconnue.";
  if (typeof error === "string") return error;
  if (error.message) return String(error.message);
  if (error.error && error.error.message) return String(error.error.message);
  return JSON.stringify(error).slice(0, 500);
}

const TYPING_HTML = "<span class=\"typing-indicator\" role=\"status\" aria-label=\"Génération en cours\"><span></span><span></span><span></span></span>";

function friendlyError(error) {
  const raw = error && error.message ? String(error.message) : String(error || "");
  if (error && error.auth) return raw || "Session expirée : reconnecte-toi.";
  if (error && error.upload) return raw || "L'envoi de la pièce jointe a été refusé par le serveur.";
  if (navigator.onLine === false) {
    return "Pas de connexion Internet. Vérifie ton Wi-Fi ou tes données mobiles, puis appuie sur « Réessayer ». Ton message est conservé.";
  }
  if ((error && error.name === "TypeError") || /failed to fetch|networkerror|network request|load failed|réseau indisponible|timeout|timed out/i.test(raw)) {
    return "Impossible de joindre le serveur. Vérifie ta connexion Internet, puis appuie sur « Réessayer ». Ton message est conservé.";
  }
  const code = String((error && error.code) || "") + " " + String((error && error.type) || "");
  if (/moderation_blocked|CONTENT_POLICY_VIOLATION|image_generation_user_error/i.test(code + " " + raw)) {
    const stage = error && error.moderation && error.moderation.moderation_stage;
    if (stage === "output") return "L'image générée a été bloquée par un contrôle de sécurité. Modifie ta demande, puis réessaie.";
    return "Cette demande n'a pas pu être traitée, car elle ne respecte pas les règles de sécurité. Reformule-la, puis réessaie.";
  }
  if (/insufficient_quota|quota exceeded|billing/i.test(code + " " + raw)) {
    return "Le quota du service est épuisé pour le moment. Réessayer tout de suite ne servira à rien : patiente ou contacte l'administrateur.";
  }
  if (/at capacity|overloaded|server_is_overloaded|\b429\b|rate.?limit|too many requests/i.test(raw + " " + code)) {
    return "Ce modèle est saturé pour le moment. Réessaie dans quelques instants avec « Réessayer », ou choisis un autre modèle. Ton message est conservé.";
  }
  if (/\b50[234]\b|BAD_GATEWAY|SERVICE_UNAVAILABLE|GATEWAY_TIMEOUT/i.test(raw)) {
    return "Le fournisseur du modèle ne répond pas pour le moment. Réessaie dans un instant ou choisis un autre modèle. Ton message est conservé.";
  }
  let status = error && Number(error.status);
  if (!status) {
    const match = raw.match(/HTTP (\d{3})/);
    status = match ? Number(match[1]) : 0;
  }
  if (status === 401 || status === 403) return "Accès refusé par le serveur (HTTP " + status + "). Reconnecte-toi puis réessaie.";
  if (status === 413) return "Le message ou la pièce jointe est trop volumineux (HTTP 413).";
  if (status === 429) return "Trop de requêtes en peu de temps (HTTP 429). Patiente quelques instants, puis réessaie.";
  if (status >= 500) return "Le serveur rencontre un problème (HTTP " + status + "). Réessaie dans un instant.";
  return "La réponse n'a pas pu être générée : " + (raw || "erreur inconnue.");
}

function updateNetworkBanner() {
  let banner = $("network-banner");
  if (navigator.onLine !== false) {
    if (banner) banner.classList.add("hidden");
    return;
  }
  if (!banner) {
    banner = document.createElement("div");
    banner.id = "network-banner";
    banner.className = "network-banner";
    banner.setAttribute("role", "status");
    banner.textContent = "Hors connexion : tes messages sont conservés. Renvoie-les avec « Réessayer » quand le réseau revient.";
    document.body.appendChild(banner);
  }
  banner.classList.remove("hidden");
}

window.addEventListener("online", updateNetworkBanner);
window.addEventListener("offline", updateNetworkBanner);
if (document.body) updateNetworkBanner();
else document.addEventListener("DOMContentLoaded", updateNetworkBanner);

async function attachmentBlob(file) {
  if (/^data:/.test(String(file.data || ""))) {
    const response = await fetch(file.data);
    return response.blob();
  }
  return new Blob([String(file.data || "")], { type: file.mime || "text/plain" });
}

function uploadErrorDetail(text) {
  const raw = String(text || "");
  try {
    const data = JSON.parse(raw);
    const message = data && (data.message || data.detail || (data.error && (data.error.message || data.error)));
    if (message) return String(typeof message === "string" ? message : JSON.stringify(message)).slice(0, 200);
  } catch {
  }
  return raw.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 200);
}

async function postAttachment(path, file) {
  const form = new FormData();
  form.append("file", await attachmentBlob(file), file.name || "fichier");
  const response = await apiFetch(path, { method: "POST", body: form });
  if (!response.ok) {
    const detail = uploadErrorDetail(await response.text().catch(() => ""));
    const error = new Error("Envoi de " + (file.name || "fichier") + " refusé par le serveur (code " + response.status + ")" + (detail ? " : " + detail : "."));
    error.upload = true;
    error.httpStatus = response.status;
    throw error;
  }
  const data = await response.json().catch(() => ({}));
  const id = data.id || data.uuid || (data.file && (data.file.id || data.file.uuid));
  if (!id) {
    const error = new Error("Aucun identifiant reçu pour " + (file.name || "le fichier") + ".");
    error.upload = true;
    throw error;
  }
  return String(id);
}

async function uploadAttachment(file) {
  if (file.remoteId) return file.remoteId;
  if (file.kind === "image") {
    file.remoteId = await postAttachment("/files/upload", file);
    file.remoteKind = "image";
    return file.remoteId;
  }
  try {
    file.remoteId = await postAttachment("/filesv2", file);
    file.remoteKind = "file";
  } catch (error) {
    if (error.upload && error.httpStatus === 403) {
      error.message = "Le serveur n'accepte pas encore l'envoi de fichiers pour ton compte (" + (file.name || "fichier") + "). Seuls les images, les PDF et les fichiers texte peuvent être joints.";
    }
    throw error;
  }
  return file.remoteId;
}

let imageToolSessionKey = null;

async function syncImageTool() {
  const forced = store.imageMode === true;
  // Outil image actif par défaut (Paramètres > Général) ; l'icône image force en plus la génération.
  const wanted = forced || store.imageTool !== false;
  const key = wanted ? "on:" + store.imageModel : "off";
  // Icône image (forcé) : vérification serveur à chaque envoi. Mode automatique : une vérification par session, puis cache.
  if (!forced && store.imageToolSynced === key && imageToolSessionKey === key) return;
  imageToolSessionKey = key;
  const warn = message => {
    if (forced && typeof showToast === "function") showToast(message, true);
  };
  try {
    if (wanted) {
      const current = await apiFetch("/user/instructions");
      if (current.ok) {
        const data = await current.json().catch(() => null);
        if (data && data.imageGenerationToolEnabled === true && (!store.imageModel || data.imageGenerationModel === store.imageModel)) {
          if (store.imageToolSynced !== key) {
            store.imageToolSynced = key;
            saveStore();
          }
          return;
        }
      }
    }
    const body = { imageGenerationToolEnabled: wanted };
    if (wanted && store.imageModel) body.imageGenerationModel = store.imageModel;
    const response = await apiFetch("/user/instructions", {
      method: "PATCH",
      body: JSON.stringify(body)
    });
    if (response.ok) {
      store.imageToolSynced = key;
      saveStore();
    } else {
      store.imageToolSynced = null;
      warn("Impossible d'activer la génération d'image (HTTP " + response.status + ").");
    }
  } catch {
    store.imageToolSynced = null;
    warn("Impossible d'activer la génération d'image (réseau).");
  }
}

// Consigne ajoutée au message envoyé (pas au texte affiché) quand le mode Image est actif.
function imagePromptPrefix(text) {
  if (typeof isPowerPointPrompt === "function" && isPowerPointPrompt(text)) return "";
  if (store.imageMode !== true) return "";
  const model = store.imageModel ? " (modèle " + store.imageModel + ")" : "";
  return "[Génération d'image] Utilise obligatoirement l'outil de génération d'image" + model + " pour créer l'image décrite ci-dessous. Ne réponds pas seulement par du texte ou des emojis.\n\n";
}

const FILE_INSTR_TAG = "[FranceStudent-fichiers]";
const FILE_INSTR = FILE_INSTR_TAG + " Quand on te demande de créer un fichier (Python, PDF, texte, HTML, CSV...), donne son contenu complet dans un bloc de code avec le langage, et mets le nom du fichier (ex. script.py) en commentaire sur la première ligne du bloc. Pour un PDF, utilise un bloc de langage pdf contenant le texte du document ; l'application le convertit en PDF téléchargeable.";

async function syncFileInstructions() {
  if (store.fileInstrSynced || store.customInstructionsManaged) return;
  try {
    const res = await apiFetch("/user/instructions");
    if (!res.ok) return;
    const data = await res.json();
    const current = String((data && data.customInstructions) || "");
    if (current.indexOf(FILE_INSTR_TAG) < 0) {
      const patch = await apiFetch("/user/instructions", {
 method: "PATCH",
 body: JSON.stringify({ customInstructions: (current ? current + "\n\n" : "") + FILE_INSTR })
      });
      if (!patch.ok) return;
    }
    store.fileInstrSynced = true;
    saveStore();
  } catch {
  }
}

// Parcourt un événement du flux et ajoute les URL de sites trouvées (sources de recherche, citations).
function collectSourceUrls(data, sources, keys) {
  let added = false;
  const addUrl = (raw, title) => {
    let url = String(raw || "").trim();
    if (!url || url.length > 2048 || url.indexOf(" ") >= 0) return;
    const lower = url.toLowerCase();
    if (!lower.startsWith("http://") && !lower.startsWith("https://")) {
      // Domaine nu (ex. webSearchDomains du ChatMessage) : lemonde.fr
      if (!/^[a-z0-9.-]+[.][a-z]{2,}$/i.test(url)) return;
      url = "https://" + url;
    }
    let host = "";
    try { host = new URL(url).hostname.replace(/^www[.]/i, ""); } catch { return; }
    if (!host || host.indexOf(".") < 0) return;
    const key = url.split("#")[0].split("?")[0].replace(/[/]$/, "").toLowerCase();
    if (keys.has(key)) return;
    keys.add(key);
    sources.push({ url, title: typeof title === "string" ? title.trim() : "", host });
    added = true;
  };
  const visit = (node, depth) => {
    if (!node || typeof node !== "object" || depth > 10 || sources.length >= 40) return;
    if (Array.isArray(node)) {
      for (const child of node) visit(child, depth + 1);
      return;
    }
    if (typeof node.url === "string") addUrl(node.url, node.title);
    else if (typeof node.uri === "string") addUrl(node.uri, node.title);
    for (const name of Object.keys(node)) {
      const value = node[name];
      // webSearchDomains, sources, links, citations : listes de chaines (URL ou domaines).
      if (Array.isArray(value) && /domain|source|url|link|citation/i.test(name)) {
        for (const item of value) if (typeof item === "string") addUrl(item, "");
      }
      if (value && typeof value === "object") visit(value, depth + 1);
    }
  };
  visit(data, 0);
  return added;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Cherche les images générées dans un événement du flux ou un message (parts).
// Clé unique d'une image générée (base64, identifiant ou URL).
function generatedImageKey(image) {
  if (!image) return "";
  if (image.data) return "d:" + image.data.length + ":" + image.data.slice(-40);
  if (image.id) return "i:" + image.id;
  return image.url ? "u:" + image.url : "";
}

const IMAGE_TYPE_RE = /image_generation|imagegeneration|generated[_-]?image|output_image|^image$|^image_file$/i;
const IMAGE_ID_KEYS = ["imageId", "image_id", "generatedImageId", "generated_image_id", "fileId", "file_id"];

// Base64 brut d'une image (PNG, JPEG, WebP, GIF) ou data URL.
const RAW_IMAGE_RE = /^(data:image\/[\w.+-]+;base64,|iVBORw0KGgo|\/9j\/|UklGR|R0lGOD)/;

function rawImageDataUrl(value) {
  if (value.startsWith("data:")) return value;
  const mime = value.startsWith("/9j/") ? "image/jpeg" : value.startsWith("UklGR") ? "image/webp" : value.startsWith("R0lGOD") ? "image/gif" : "image/png";
  return "data:" + mime + ";base64," + value;
}

// Détection complète : format typé, puis base64 brut sous n'importe quelle clé (hors images partielles ou envoyées).
function collectGeneratedImages(root) {
  const out = collectGeneratedImagesCore(root);
  if (out.some(image => image.data)) return out;
  const seen = new Set(out.map(generatedImageKey));
  const walk = (node, depth) => {
    if (typeof node === "string" && depth <= 10 && /^[\s]*[\[{]/.test(node)) {
      try { walk(JSON.parse(node), depth + 1); } catch {}
      return;
    }
    if (!node || typeof node !== "object" || depth > 10) return;
    if (Array.isArray(node)) { for (const item of node) walk(item, depth + 1); return; }
    if (typeof node.type === "string" && /partial|input/i.test(node.type)) return;
    if (typeof node.role === "string" && /user|system/i.test(node.role)) return;
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (/partial|input/i.test(key)) continue;
      if (typeof value === "string") {
        if (value.length > 200 && RAW_IMAGE_RE.test(value)) {
          const image = { data: rawImageDataUrl(value) };
          const k = generatedImageKey(image);
          if (!seen.has(k)) { seen.add(k); out.push(image); }
        }
      } else if (value && typeof value === "object") {
        walk(value, depth + 1);
      }
    }
  };
  walk(root, 0);
  return out;
}

// Détection élargie : base64, identifiant (UUID) ou URL, quel que soit le format renvoyé.
function collectGeneratedImagesCore(root) {
  const out = [];
  const seen = new Set();
  const push = image => {
    const key = generatedImageKey(image);
    if (key && !seen.has(key)) { seen.add(key); out.push(image); }
  };
  const walk = (node, depth) => {
    if (typeof node === "string" && depth <= 10 && /^[\s]*[\[{]/.test(node)) {
      try { walk(JSON.parse(node), depth + 1); } catch {}
      return;
    }
    if (!node || typeof node !== "object" || depth > 10) return;
    if (Array.isArray(node)) { for (const item of node) walk(item, depth + 1); return; }
    const type = typeof node.type === "string" ? node.type : "";
    if (/partial|input/i.test(type) || /^(user|system)$/i.test(node.role || "")) return;
    if (IMAGE_TYPE_RE.test(type) || /image.?generation/i.test(node.toolName || node.tool_name || "") || /^image\//i.test(node.mimeType || node.mime_type || "") || IMAGE_ID_KEYS.some(key => typeof node[key] === "string")) {
      const raw = [node.result, node.b64_json, node.image_base64, node.base64, node.imageData, node.data]
        .find(v => typeof v === "string" && v.length > 200 && !UUID_RE.test(v)) || "";
      const imageUrl = node.image_url && typeof node.image_url === "object" ? node.image_url.url : node.image_url;
      const url = [node.url, imageUrl, node.imageUrl, node.src].find(v => typeof v === "string" && /^(https?:|data:image\/|\/)/i.test(v));
      const id = IMAGE_ID_KEYS.map(k => node[k])
 .concat([typeof node.result === "string" ? node.result : null, type !== "image_generation_call" ? node.id : null])
        .find(v => typeof v === "string" && UUID_RE.test(v));
      if (raw) push({ data: raw.startsWith("data:") ? raw : "data:image/png;base64," + raw });
      else if (id) push({ id });
      else if (url) push({ url });
    } else {
      for (const k of ["imageId", "image_id", "generatedImageId", "generated_image_id"]) {
 if (typeof node[k] === "string" && UUID_RE.test(node[k])) push({ id: node[k] });
      }
    }
    for (const key of Object.keys(node)) {
      if (key === "result" || key === "b64_json" || key === "partial_image_b64") continue;
      if (key === "images" && Array.isArray(node[key])) {
        for (const image of node[key]) {
          if (typeof image === "string" && UUID_RE.test(image)) push({ id: image });
          else if (typeof image === "string" && /^(https?:|data:image\/|\/)/i.test(image)) push({ url: image });
          else if (image && typeof image === "object") walk({ ...image, type: image.type || "generated_image" }, depth + 1);
        }
        continue;
      }
      walk(node[key], depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

// Ancienne détection, conservée pour référence (plus utilisée).
function collectGeneratedImagesLegacy(root) {
  const out = [];
  const walk = (node, depth) => {
    if (!node || typeof node !== "object" || depth > 8) return;
    if (Array.isArray(node)) { for (const item of node) walk(item, depth + 1); return; }
    const type = typeof node.type === "string" ? node.type : "";
    if (/image_generation_call|generated_image|output_image|^image$/i.test(type) && !/partial/i.test(type)) {
      const raw = [node.result, node.b64_json, node.image_base64, node.data].find(v => typeof v === "string" && v.length > 0) || "";
      const id = [node.imageId, node.image_id, node.fileId, typeof node.result === "string" && UUID_RE.test(node.result) ? node.result : null, type !== "image_generation_call" ? node.id : null]
        .find(v => typeof v === "string" && UUID_RE.test(v));
      if (raw && !UUID_RE.test(raw) && raw.length > 200) out.push({ data: raw.startsWith("data:") ? raw : "data:image/png;base64," + raw });
      else if (id) out.push({ id });
    }
    for (const key of Object.keys(node)) {
      if (key === "result" || key === "b64_json" || key === "partial_image_b64") continue;
      walk(node[key], depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

const generatedImageCache = new Map();

// Résumé court de la forme d'un objet (clés et types, sans le contenu), pour le diagnostic.
function describeShape(node, depth) {
  depth = depth || 0;
  if (node === null || node === undefined) return String(node);
  if (typeof node === "string") return UUID_RE.test(node) ? "uuid" : node.length > 60 ? "str(" + node.length + ")" : JSON.stringify(node);
  if (typeof node !== "object") return String(node);
  if (depth > 3) return Array.isArray(node) ? "[…]" : "{…}";
  if (Array.isArray(node)) return "[" + node.slice(0, 4).map(v => describeShape(v, depth + 1)).join(",") + (node.length > 4 ? ",…" : "") + "]";
  return "{" + Object.keys(node).slice(0, 12).map(k => k + ":" + describeShape(node[k], depth + 1)).join(",") + "}";
}

// Tous les UUID présents dans un objet, hors identifiants connus (message, chat…).
function collectUuidCandidates(root, exclude) {
  const skip = new Set((exclude || []).filter(Boolean).map(v => String(v).toLowerCase()));
  const out = [];
  const walk = (node, depth) => {
    if (!node || depth > 10 || out.length >= 6) return;
    if (typeof node === "string") {
      const v = node.toLowerCase();
      if (UUID_RE.test(node) && !skip.has(v) && !out.includes(v)) out.push(v);
      return;
    }
    if (typeof node !== "object") return;
    if (Array.isArray(node)) { for (const item of node) walk(item, depth + 1); return; }
    for (const key of Object.keys(node)) {
      if (/^(chatId|userId|agentId|messageId|parentId)$/i.test(key)) continue;
      walk(node[key], depth + 1);
    }
  };
  walk(root, 0);
  return out;
}

// Renvoie une URL data: de l'image générée (base64 direct ou téléchargée depuis l'API).
async function fetchGeneratedImage(path, retried = false) {
  const cap = window.Capacitor;
  const http = cap?.isNativePlatform?.() && cap.Plugins?.CapacitorHttp;
  if (http) {
    // Native HTTP returns binary as base64. Avoid passing it through fetch().blob()
    // on WKWebView, where the patched fetch can interpret it as text.
    const response = await http.request({
      url: API_URL + path, method: "GET", responseType: "arraybuffer",
      headers: { ...clientHeaders(), Accept: "image/*", Authorization: "Bearer " + await getAccessToken(retried) },
      connectTimeout: 30000, readTimeout: 60000
    });
    if (response.status === 401 && !retried) return fetchGeneratedImage(path, true);
    if (response.status < 200 || response.status >= 300) throw new Error("HTTP " + response.status);
    const headers = response.headers || {};
    const type = Object.entries(headers).find(([key]) => key.toLowerCase() === "content-type")?.[1] || "image/png";
    if (!/^image\//i.test(type) || typeof response.data !== "string" || !response.data) throw new Error("Réponse image invalide");
    return "data:" + type.split(";")[0] + ";base64," + response.data;
  }
  const response = await apiFetch(path, { accept: "image/*" });
  if (!response.ok) throw new Error("HTTP " + response.status);
  const blob = await response.blob();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function resolveGeneratedImage(image) {
  if (image.data) return image.data;
  if (image.url && /^(https?:|data:image\/)/i.test(image.url)) return image.url;
  if (image.url && image.url.startsWith("/")) {
    return fetchGeneratedImage(image.url);
  }
  if (!image.id || !image.messageId || !image.chatId) return null;
  const key = image.chatId + "/" + image.messageId + "/" + image.id;
  if (generatedImageCache.has(key)) return generatedImageCache.get(key);
  const promise = (async () => {
    return fetchGeneratedImage("/chats/" + encodeURIComponent(image.chatId) + "/messages/" + encodeURIComponent(image.messageId) + "/images/" + encodeURIComponent(image.id));
  })();
  generatedImageCache.set(key, promise);
  promise.catch(() => generatedImageCache.delete(key));
  return promise;
}

async function downloadGeneratedImage(src) {
  try {
    const match = /^data:(image\/[\w+.-]+);base64,(.*)$/.exec(String(src || ""));
    if (!match) throw new Error("format d'image inconnu");
    const ext = ({ "image/jpeg": "jpg", "image/webp": "webp" })[match[1]] || "png";
    FILE_MIME.png = "image/png";
    FILE_MIME.jpg = "image/jpeg";
    FILE_MIME.webp = "image/webp";
    const bin = atob(match[2]);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const name = "image-" + new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-") + "." + ext;
    await saveFile(name, bytes);
    const onIOS = window.Capacitor && typeof window.Capacitor.getPlatform === "function" && window.Capacitor.getPlatform() === "ios";
    showToast("Image « " + name + " » enregistrée dans " + (onIOS ? "Fichiers > Sur mon iPhone > FranceStudent Chat" : "Téléchargements"));
  } catch (error) {
    showToast("Téléchargement impossible : " + (error && error.message ? error.message : error), true);
  }
}

const DOWNLOAD_ICON = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11"/><path d="M7 10l5 5 5-5"/><path d="M5 20h14"/></svg>';

// Affiche les images générées juste sous la bulle de réponse.
function renderGeneratedImages(bubble, images) {
  if (!bubble || !bubble.parentElement || !Array.isArray(images) || !images.length) return;
  let box = bubble.parentElement.querySelector(".generated-images");
  if (!box) {
    box = document.createElement("div");
    box.className = "generated-images";
    box._keys = new Set();
    bubble.after(box);
  }
  for (const image of images) {
    const key = generatedImageKey(image);
    if (!key || box._keys.has(key)) continue;
    box._keys.add(key);
    const figure = document.createElement("figure");
    figure.className = "generated-image loading";
    const img = document.createElement("img");
    img.alt = "Image générée";
    img.decoding = "async";
    const button = document.createElement("button");
    button.type = "button";
    button.className = "generated-image-download";
    button.title = "Télécharger l'image";
    button.setAttribute("aria-label", "Télécharger l'image");
    button.innerHTML = DOWNLOAD_ICON;
    button.addEventListener("click", event => {
      event.stopPropagation();
      if (img.src) downloadGeneratedImage(img.src);
    });
    img.addEventListener("load", () => scrollToBottom());
    img.addEventListener("click", () => {
      if (img.src) previewAttachment({ name: /^data:image\/jpeg/i.test(img.src) ? "image.jpg" : /^data:image\/webp/i.test(img.src) ? "image.webp" : "image.png", kind: "image", data: img.src });
    });
    figure.append(img, button);
    box.appendChild(figure);
    resolveGeneratedImage(image).then(src => {
      if (!src) throw new Error("introuvable");
      img.src = src;
      figure.classList.remove("loading");
    }).catch(() => {
      figure.classList.remove("loading");
      figure.classList.add("failed");
      figure.textContent = "Image indisponible";
    });
  }
  scrollToBottom();
}

// Une suspension de la WebView ne signifie pas que la génération serveur a échoué.
async function streamChat(conversation, text, attachments, onDelta, onEvent, resume = false) {
  const startedAt = Date.now();
  const initialChatId = conversation.chatId;
  let recentChatIds = Array.isArray(conversation.pendingResponse?.recentChatIds) ? new Set(conversation.pendingResponse.recentChatIds) : null;
  let latestOutput = resume ? conversation.pendingResponse?.output || '' : '';
  let backgrounded = document.hidden === true;
  const visibility = () => { if (document.hidden) backgrounded = true; };
  document.addEventListener("visibilitychange", visibility);
  let baseline = null;
  try {
    if (resume) {
      if (Array.isArray(conversation.pendingResponse?.baselineIds)) baseline = new Set(conversation.pendingResponse.baselineIds);
    } else if (conversation.chatId) {
      try {
        const res = await apiFetch("/chats/" + encodeURIComponent(conversation.chatId));
        if (res.ok) {
          const detail = await res.json();
          if (Array.isArray(detail.chatMessages)) baseline = new Set(detail.chatMessages.map(m => m.id));
        }
      } catch {}
    } else {
      baseline = new Set();
      if (window.Capacitor?.getPlatform?.() === 'ios') {
        try {
          const res = await apiFetch('/chats?limit=100&sortedBy=lastMessageAt');
          const data = res.ok ? await res.json() : null;
          if (Array.isArray(data?.chats)) {
            recentChatIds = new Set(data.chats.map(chat=>chat.id));
            if(conversation.pendingResponse) conversation.pendingResponse.recentChatIds = [...recentChatIds];
          }
        } catch {}
      }
    }
    if (!resume && baseline && conversation.pendingResponse) { conversation.pendingResponse.baselineIds = [...baseline]; saveStore(); }
    try {
      return await streamChatRequest(conversation, text, attachments, value => { latestOutput = value; onDelta(value); }, onEvent, resume);
    } catch (error) {
      if (stopRequested) return latestOutput;
      // L'erreur native porte le vrai état iOS, même si visibilitychange a été différé.
      backgrounded = backgrounded || error.backgrounded === true;
      if (error.localPlugin || error.auth || (error.status && !(resume && [404,409,410].includes(error.status))) || error.fromStream || error.upload) throw error;
      if (!backgrounded && window.Capacitor?.getPlatform?.() !== 'ios') throw error;
      // Attendre le retour au premier plan avant les lectures de récupération.
      while (document.hidden && !stopRequested) await new Promise(resolve => setTimeout(resolve, 500));
      if (stopRequested) return latestOutput;
      // Si le premier événement n'a pas atteint l'interface, retrouver uniquement
      // un nouveau chat qui contient exactement cette demande, sans renvoyer le POST.
      if (!conversation.chatId && recentChatIds) {
        try {
          const res = await apiFetch('/chats?limit=20&sortedBy=lastMessageAt');
          const data = res.ok ? await res.json() : null;
          const candidates = (data?.chats || []).filter(chat => !recentChatIds.has(chat.id) && Date.parse(chat.createdAt) >= startedAt - 5000 &&
            (!chat.agent || Number(chat.agent.id) === conversation.agentId) && (chat.projectId || null) === (conversation.projectId || null)).slice(0,5);
          const matches = [];
          for (const chat of candidates) {
            const detailResponse = await apiFetch('/chats/' + encodeURIComponent(chat.id));
            const detail = detailResponse.ok ? await detailResponse.json() : null;
            if (detail?.chatMessages?.some(m=>m.role==='user' && m.content?.endsWith(text))) matches.push(chat.id);
          }
          if (matches.length === 1) conversation.chatId = matches[0];
        } catch {}
      }
      if ((!resume || !initialChatId) && conversation.chatId && conversation.pendingResponse) {
        try { return await streamChatRequest(conversation, text, [], value => { latestOutput=value; onDelta(value); }, onEvent, true); }
        catch (retryError) { if(retryError.auth || retryError.fromStream || retryError.localPlugin || (retryError.status && ![404,409,410].includes(retryError.status))) throw retryError; }
      }
      if (conversation.chatId && baseline) {
        for (let attempt = 0; attempt < 30 && !stopRequested; attempt++) {
          try {
            const res = await apiFetch("/chats/" + encodeURIComponent(conversation.chatId));
            if (res.ok) {
              const detail = await res.json();
              const list = (detail.chatMessages || []).slice().sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
              // Exiger le nouveau message utilisateur : ne jamais récupérer une ancienne réponse.
              const user = list.findLastIndex(m => m.role === "user" && !baseline.has(m.id) && typeof m.content === "string" && m.content.endsWith(text));
              const following = list.slice(user + 1);
              const nextUser = following.findIndex(m=>m.role==='user');
              const answer = user < 0 ? null : following.slice(0,nextUser<0?undefined:nextUser).find(m => m.role === "assistant" && !baseline.has(m.id));
              const recoveredImages = answer ? collectGeneratedImages(answer) : [];
              const recoveredText = typeof answer?.content === 'string' ? answer.content : []
                .concat(Array.isArray(answer?.content) ? answer.content : [], Array.isArray(answer?.parts) ? answer.parts : [])
                .map(part => typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : '').filter(Boolean).join('\n\n');
              if (answer && (recoveredText || recoveredImages.length)) {
                if (recoveredText) onDelta(recoveredText);
                if (typeof onEvent === "function") {
                  const sources = [];
                  collectSourceUrls(answer, sources, new Set());
                  if (sources.length) onEvent("sources", sources);
                  for (const image of recoveredImages) onEvent("image", { ...image, messageId: answer.id, chatId: conversation.chatId });
                }
                return recoveredText;
              }
            }
          } catch {}
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
      if (stopRequested) return latestOutput;
      const interrupted = new Error((backgrounded ? "L’app a été suspendue pendant la réponse. " : "La connexion a été interrompue. ") + "La réponse n’a pas pu être récupérée automatiquement. Rouvre la conversation pour vérifier si elle a été enregistrée avant de réessayer.");
      interrupted.partialOutput = latestOutput;
      throw interrupted;
    }
  } finally {
    document.removeEventListener("visibilitychange", visibility);
  }
}

async function streamChatRequest(conversation, text, attachments, onDelta, onEvent, resume = false) {
  let response;
  if (resume) {
    if (!conversation.chatId) throw new Error('Identifiant de réponse encore indisponible. Rouvre la discussion après sa synchronisation.');
    const cursor = conversation.pendingResponse?.lastEventId;
    response = await apiFetch('/chats/' + encodeURIComponent(conversation.chatId) + '/stream' + (cursor ? '?last_event_id=' + encodeURIComponent(cursor) : ''), {method:'GET',accept:'text/event-stream',stream:true});
  } else {
  const list = Array.isArray(attachments) ? attachments : [];
  const images = [];
  const files = [];
  for (const file of list) {
    if (file.kind !== "image" && file.kind !== "file") continue;
    const id = await uploadAttachment(file);
    if (file.remoteKind === "image" || (!file.remoteKind && file.kind === "image")) images.push(id);
    else files.push(id);
  }
  // Modification d'une image : si l'utilisateur n'a rien joint, on renvoie la dernière image générée comme image source.
  let sourceNote = "";
  if (!images.length && !(typeof isPowerPointPrompt === "function" && isPowerPointPrompt(text))) {
    try {
      const history = Array.isArray(conversation.messages) ? conversation.messages : [];
      let previous = null;
      for (let i = history.length - 1; i >= 0; i--) {
        if (history[i] && history[i].role === "assistant") { previous = history[i]; break; }
      }
      const lastImage = previous && Array.isArray(previous.images) && previous.images.length ? previous.images[previous.images.length - 1] : null;
      if (lastImage) {
        const uploads = streamChat.sourceUploads || (streamChat.sourceUploads = new Map());
        const cacheKey = generatedImageKey(lastImage);
        let remoteId = cacheKey ? uploads.get(cacheKey) : null;
        if (!remoteId) {
          const src = await resolveGeneratedImage(lastImage);
          const info = /^data:(image\/(png|jpe?g|webp));base64,/i.exec(String(src || ""));
          if (info) {
            const ext = info[2].toLowerCase() === "png" ? "png" : info[2].toLowerCase() === "webp" ? "webp" : "jpg";
            remoteId = await postAttachment("/files/upload", { data: src, mime: info[1], name: "image-precedente." + ext });
            if (cacheKey) uploads.set(cacheKey, remoteId);
          }
        }
        if (remoteId) {
          images.push(remoteId);
          sourceNote = "[Image source] L'image jointe est la dernière image générée. Si la demande ci-dessous est une modification (ajouter, retirer ou changer un élément), modifie cette image : garde le même sujet, le même véhicule, la même composition, le même cadrage et le même style, et ne change que ce qui est demandé.\n\n";
        }
      }
    } catch {
      // Sans image source, la génération continue normalement.
    }
  }
  await syncImageTool(); await syncFileInstructions();
  const payload = {
    agentId: conversation.agentId,
    chatId: conversation.chatId || null,
    enableCanvas: false,
    enableWebSearch: store.webSearch === true && store.webSearchMode !== "disabled",
    images,
        initialContent: imagePromptPrefix(text) + sourceNote + text,
    isIncognito: false,
    isPrivate: false
  };
  if (files.length) payload.files = files;
  if (conversation.projectId) payload.projectId = conversation.projectId;
  response = await apiFetch("/chats/stream", {
    method: "POST",
    accept: "text/event-stream",
    stream: true,
    body: JSON.stringify(payload)
  });
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const error = new Error("HTTP " + response.status + (detail ? " : " + detail.slice(0, 500) : ""));
    error.status = response.status;
    throw error;
  }

  let output = resume && conversation.pendingResponse?.lastEventId ? conversation.pendingResponse.output || "" : "";
  if(output) onDelta(output);
  let checkpointAt = 0;
  let completed = false;
  let streamError = null;
  const append = chunk => {
    if (typeof chunk !== "string" || !chunk) return;
    output += chunk;
    onDelta(output);
  };

  const sources = [];
  const sourceKeys = new Set();
  const seenImages = new Set();
  // Identifiants d'images vus sans messageId : résolus après le flux via /chats/{id}.
  const pendingImageIds = new Set();
  let emittedImages = 0;
  // Signal « génération d'image démarrée » envoyé une seule fois à l'interface.
  let imageStartSent = false;
  let sawImageHint = resume && conversation.pendingResponse?.imageStarted === true;
  // Diagnostic : événements reçus (nom, type d'item), consultable si la réponse est vide.
  const streamLog = [];
  try { window.__lastStreamLog = streamLog; } catch {}
  const logEvent = (name, data, raw) => {
    if (streamLog.length >= 60 || name === "response.output_text.delta") return;
    let entry = String(name || "message");
    if (data && typeof data === "object") {
      const item = data.item || data.output_item || data.part || data.message || null;
      const type = (item && typeof item.type === "string" && item.type) || (typeof data.type === "string" && data.type) || "";
      if (type && type !== entry) entry += "(" + type + ")";
      if (data.error || (data.response && data.response.error)) entry += "!erreur";
    } else if (raw) {
      entry += "[non-JSON:" + String(raw).slice(0, 40) + "]";
    }
    if (streamLog[streamLog.length - 1] !== entry) streamLog.push(entry);
  };
  const parser = createSseParser((name, payload, eventId) => {
    if (payload === "[DONE]") { completed = true; return; }
    let data;
    try {
      data = JSON.parse(payload);
    } catch {
      logEvent(name, null, payload);
      return;
    }
    logEvent(name, data);
    if (!data || typeof data !== "object") return;
    if (data.chat_id) {
      conversation.chatId = data.chat_id;
      if (conversation.pendingResponse) saveStore();
    }
    // Diagnostic : forme de l'item image_generation_call terminé (clés et types seulement).
    if (name === "response.output_item.done" && data.item && data.item.type === "image_generation_call") {
      try { streamLog.push("image_item=" + describeShape(data.item).slice(0, 300)); } catch {}
    }
    // Images générées (image_generation_call) : base64 direct ou identifiant à télécharger.
    if (typeof onEvent === "function" && name !== "response.output_text.delta") {
      if (/image_generation|generated_image|output_image/i.test(String(name || "") + " " + String(payload).slice(0, 4000))) {
        sawImageHint = true;
        if (!imageStartSent && emittedImages === 0) {
          imageStartSent = true;
          try { onEvent("image_start", null); } catch {}
        }
      }
      const found = collectGeneratedImages(data);
      const messageId = (data.message && typeof data.message.id === "string" && (name === "completed" || data.message.role === "assistant") ? data.message.id : null)
        || (typeof data.message_id === "string" ? data.message_id : null)
        || (typeof data.messageId === "string" ? data.messageId : null);
      for (const image of found) {
        const key = generatedImageKey(image);
        if (!key || seenImages.has(key)) continue;
        if (!image.data && !image.url && !messageId) { pendingImageIds.add(image.id); continue; }
        seenImages.add(key);
        if (image.id) pendingImageIds.delete(image.id);
        emittedImages++;
        try { onEvent("image", { data: image.data || null, url: image.url || null, id: image.id || null, messageId, chatId: conversation.chatId }); } catch {}
      }
    }
    // Sites consultés : web_search_call (action.sources), annotations url_citation, etc.
    if (name !== "response.output_text.delta" && typeof onEvent === "function" && collectSourceUrls(data, sources, sourceKeys)) {
      try { onEvent("sources", sources.slice()); } catch {}
    }
    switch (name) {
      case "response.output_text.delta":
        append(data.delta);
        break;
      case "response.output_text.done":
        if (!output) append(data.text);
        break;
      case "response.failed":
      case "error":
        streamError = data;
        break;
      case "response.completed":
        completed = true;
        if (data.response && data.response.error) streamError = data.response.error;
        break;
      case "completed":
        completed = true;
        if (!output && data.message) {
          const msg = data.message;
          if (typeof msg.content === "string") append(msg.content);
          else {
            // content ou parts sous forme de tableau : on récupère les morceaux de texte.
            const pieces = [].concat(Array.isArray(msg.content) ? msg.content : [], Array.isArray(msg.parts) ? msg.parts : [])
              .map(p => typeof p === "string" ? p : p && typeof p.text === "string" ? p.text : p && typeof p.content === "string" && /text/i.test(String(p.type || "")) ? p.content : "")
              .filter(Boolean);
            if (pieces.length) append(pieces.join("\n\n"));
          }
        }
        break;
      default:
        if (typeof onEvent === "function" && !output) {
          const itemType = data && data.item && typeof data.item.type === "string" ? data.item.type : "";
          if (/web_search|websearch|web-search/i.test(String(name || "") + " " + itemType + " " + (typeof data.type === "string" ? data.type : ""))) {
            try { onEvent("web_search", data); } catch {}
          }
        }
        break;
    }
    if (conversation.pendingResponse) {
      conversation.pendingResponse.output = output;
      if (/^\d+$/.test(eventId || '')) conversation.pendingResponse.lastEventId = eventId;
      if (Date.now()-checkpointAt > 500) { checkpointAt=Date.now(); saveStore(); }
    }
  });

  if (response.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      if (stopRequested) {
        reader.cancel().catch(() => {});
        break;
      }
      const { value, done } = await reader.read();
      if (done) break;
      parser.feed(decoder.decode(value, { stream: true }));
    }
    parser.feed(decoder.decode());
  } else {
    parser.feed(await response.text());
  }
  parser.end();
  if (!completed && !streamError && !stopRequested) throw new TypeError("Flux de réponse interrompu avant la fin.");

  // Dernier message assistant lu par le repli /chats (utilisé pour tester les UUID).
  let fallbackLast = null;
  // Secours : image annoncée dans le flux mais jamais affichée (pas de base64 ni de messageId).
  if (!stopRequested && !streamError && typeof onEvent === "function" && conversation.chatId && emittedImages === 0 && (pendingImageIds.size || sawImageHint || store.imageMode === true)) {
    try {
      const res = await apiFetch("/chats/" + encodeURIComponent(conversation.chatId));
      streamLog.push("repli /chats HTTP " + res.status);
      if (res.ok) {
        const detail = await res.json().catch(() => null);
        const list = detail && Array.isArray(detail.chatMessages) ? detail.chatMessages.slice() : [];
        const time = v => { const t = Date.parse(v); return Number.isFinite(t) ? t : 0; };
        const last = list
          .filter(m => m && String(m.role || "").toLowerCase() === "assistant")
          .sort((a, b) => time(a.createdAt) - time(b.createdAt))
          .pop();
        if (last) {
          fallbackLast = last;
          for (const image of collectGeneratedImages(last.parts || last)) {
            const key = generatedImageKey(image);
            if (!key || seenImages.has(key)) continue;
            seenImages.add(key);
            emittedImages++;
            try { onEvent("image", { data: image.data || null, url: image.url || null, id: image.id || null, messageId: last.id || null, chatId: conversation.chatId }); } catch {}
          }
        }
      }
    } catch {
    }
  }

  // Image générée introuvable dans le flux et dans /chats : diagnostic des parts, puis test des UUID
  // sur /chats/{chatId}/messages/{messageId}/images/{imageId} (endpoint décrit dans la doc).
  if (!stopRequested && !streamError && typeof onEvent === "function" && emittedImages === 0 && fallbackLast && fallbackLast.id) {
    const last = fallbackLast;
    try { streamLog.push("parts=" + describeShape(last.parts).slice(0, 300)); } catch {}
    const candidates = collectUuidCandidates(last.parts || last, [last.id, conversation.chatId, last.chatId]);
    if (!candidates.length) streamLog.push("aucun uuid d'image dans le message");
    for (const id of candidates) {
      try {
        const src = await resolveGeneratedImage({ id, messageId: last.id, chatId: conversation.chatId });
        if (src) {
          streamLog.push("image trouvée via uuid");
          emittedImages++;
          try { onEvent("image", { data: src, url: null, id, messageId: last.id, chatId: conversation.chatId }); } catch {}
        }
      } catch (err) {
        streamLog.push("uuid " + id.slice(0, 8) + " : " + (err && err.message ? err.message : "échec"));
      }
    }
  }

  if (streamError && !stopRequested) {
    // On conserve code / type / retryable pour un message clair (saturation, modération…).
    const error = new Error(describeStreamError(streamError));
    const inner = streamError && typeof streamError.error === "object" && streamError.error ? streamError.error : streamError;
    if (inner && typeof inner === "object") {
      if (inner.code) error.code = String(inner.code);
      if (inner.type) error.type = String(inner.type);
      if (typeof inner.retryable === "boolean") error.retryable = inner.retryable;
      if (inner.moderation_details) error.moderation = inner.moderation_details;
    }
    error.fromStream = true;
    throw error;
  }
  return output;
}

async function cancelStream(chatId) {
  if (!chatId) return;
  try {
    await apiFetch("/chats/" + encodeURIComponent(chatId) + "/stream/cancel", { method: "POST" });
  } catch {
  }
}

