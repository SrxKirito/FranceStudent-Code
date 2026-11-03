"use strict";

const API_URL = "https://api.francestudent.ai";
const ORIGIN = "https://ia.francestudent.org";
const CLIENT_PLATFORM = "web_fs_ai";
const CLIENT_VERSION = "4005601";
const DEFAULT_AGENT_ID = -1002;
const SESSION_COOKIE = "next-auth.session-token";
const STORE_KEY = "fs-chat-state";
const TOKEN_MARGIN_MS = 60000;

const $ = id => document.getElementById(id);

const auth = { accessToken: "", expiresAt: 0 };
const store = loadStore();
let agents = [];
let currentId = null;
let busy = false;
let stopRequested = false;
let activeConversation = null;

function makeId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function loadStore() {
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(STORE_KEY) || "{}") || {};
  } catch {
    saved = {};
  }
  return {
    session: typeof saved.session === "string" ? saved.session : "",
    deviceId: saved.deviceId || makeId(),
    agentId: Number.isInteger(saved.agentId) ? saved.agentId : Number.isInteger(saved.defaultAgentId) ? saved.defaultAgentId : DEFAULT_AGENT_ID,
    defaultAgentId: Number.isInteger(saved.defaultAgentId) ? saved.defaultAgentId : null,
    webSearch: saved.webSearch === true,
    webSearchMode: ["open", "filtered", "disabled"].includes(saved.webSearchMode) ? saved.webSearchMode : "open",
    customInstructionsManaged: saved.customInstructionsManaged === true,
    libraryColumns: [1,2,3,4].includes(saved.libraryColumns) ? saved.libraryColumns : 3,
    completionNotifications: saved.completionNotifications === true,
    imageMode: saved.imageMode === true,
    powerpointMode: false,
    imageTool: saved.imageTool !== false,
    studyMode: ["fiches", "quiz", "cartes"].includes(saved.studyMode) ? saved.studyMode : "",
    imageModel: ["gpt-image-2.5-sunburst", "gpt-image-2.5-flare", "gpt-image-2"].includes(saved.imageModel) ? saved.imageModel : "gpt-image-2.5-flare",
    theme: ["light", "dark"].includes(saved.theme) ? saved.theme : "system",
    profile: saved.profile && typeof saved.profile === "object" ? saved.profile : null,
    avatar: typeof saved.avatar === "string" && /^data:image\//i.test(saved.avatar) ? saved.avatar : "",
    conversations: Array.isArray(saved.conversations) ? saved.conversations : []
  };
}

function saveStore() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(store));
  } catch (error) {
    alert("Stockage plein : supprime d'anciennes discussions pour enregistrer les pièces jointes.");
  }
}

function cleanSession(raw) {
  return String(raw || "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/^[\w.-]*session-token=/i, "")
    .trim();
}

function authError(message) {
  const error = new Error(message);
  error.auth = true;
  return error;
}

const USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:157.0) Gecko/20100101 Firefox/157.0";

function clientHeaders() {
  return {
    "User-Agent": USER_AGENT,
    "francestudent-client-platform": CLIENT_PLATFORM,
    "francestudent-client-version": CLIENT_VERSION,
    "francestudent-device-id": store.deviceId,
    Referer: ORIGIN + "/"
  };
}

async function getAccessToken(force = false) {
  if (!force && auth.accessToken && auth.expiresAt - Date.now() > TOKEN_MARGIN_MS) {
    return auth.accessToken;
  }
  if (!store.session) throw authError("Aucune session : colle ton cookie de session.");

  const headers = {
    Accept: "*/*",
    Cookie: SESSION_COOKIE + "=" + store.session + "; francestudent-device-id=" + store.deviceId,
    ...clientHeaders()
  };
  let status;
  let body;
  try {
    const cap = window.Capacitor;
    const http = cap && typeof cap.isNativePlatform === "function" && cap.isNativePlatform() && cap.Plugins && cap.Plugins.CapacitorHttp;
    if (http) {
      const response = await http.request({
        url: ORIGIN + "/api/auth/api-token",
        method: "GET",
        headers,
        responseType: "text",
        connectTimeout: 30000,
        readTimeout: 30000
      });
      status = Number(response.status) || 0;
      body = typeof response.data === "string" ? response.data : JSON.stringify(response.data ?? "");
    } else {
      const response = await fetch(ORIGIN + "/api/auth/api-token", { headers });
      status = response.status;
      body = await response.text();
    }
  } catch (error) {
    throw new Error("Réseau indisponible : " + (error && error.message ? error.message : error));
  }

  if (status < 200 || status >= 300) {
    if (/just a moment|cf-chl|attention required|cloudflare/i.test(body)) {
      throw authError("Cloudflare bloque l'application (HTTP " + status + ").");
    }
    const detail = String(body || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim().slice(0, 150);
    throw authError("Session refusée (HTTP " + status + ")" + (detail ? " : " + detail : "."));
  }

  let data;
  try {
    data = JSON.parse(body);
  } catch {
    throw authError("Réponse illisible : session invalide ?");
  }
  if (!data || typeof data.accessToken !== "string" || !data.accessToken) {
    throw authError("Aucun jeton reçu : session expirée ?");
  }

  auth.accessToken = data.accessToken;
  auth.expiresAt = data.expiresAt
    ? Number(data.expiresAt) * 1000
    : Date.now() + (Number(data.expiresIn) || 300) * 1000;
  return auth.accessToken;
}

// CapacitorHttp remplace window.fetch par un appel natif qui renvoie toute la réponse d'un coup.
// Pour le flux SSE, utiliser le fetch d'origine si disponible, sinon le client natif.
let webStreamUnavailable = false;

async function streamingFetch(url, options) {
  if (window.Capacitor?.getPlatform?.() === 'ios') return nativeStreamingFetch(url, options);
  const webFetch = window.CapacitorWebFetch;
  if (typeof webFetch === "function" && webFetch !== window.fetch && !webStreamUnavailable) {
    try {
      const headers = { ...options.headers };
      for (const name of ["User-Agent", "Origin", "Referer", "Cookie"]) delete headers[name];
      const response = await webFetch(url, { ...options, headers });
      if (response.status !== 0) return response;
      throw new TypeError("Flux direct interrompu.");
    } catch (error) {
      // Un POST peut déjà avoir été accepté : ne pas lancer une seconde génération.
      throw error;
    }
    webStreamUnavailable = true;
  }
  return fetch(url, options);
}

async function nativeStreamingFetch(url, options) {
  const plugin = window.Capacitor.Plugins?.ChatStream;
  if (!plugin || typeof plugin.start !== 'function' || typeof plugin.read !== 'function' || typeof plugin.cancel !== 'function') {
    throw Object.assign(new Error('Le module de réponse iPhone est indisponible. Ferme puis rouvre l’app après sa mise à jour.'), {localPlugin:true});
  }
  const failure = result => Object.assign(new TypeError(result.error || 'Connexion interrompue.'), { backgrounded: result.backgrounded === true });
  const result = await plugin.start({url, method:options.method || 'POST', headers:options.headers, body:options.body});
  if (!result.status) throw failure(result);
  const reader = {
    async read() {
      const chunk = await plugin.read({id:result.id});
      if (chunk.error) throw failure(chunk);
      if (chunk.done) return {done:true};
      return {done:false, value:Uint8Array.from(atob(chunk.data), c=>c.charCodeAt(0))};
    },
    async cancel() { await plugin.cancel({id:result.id}); }
  };
  return {status:result.status, ok:result.status>=200 && result.status<300,
    body:{getReader:()=>reader},
    async text() {
      const decoder=new TextDecoder(); let text='';
      while(true) { const chunk=await reader.read(); if(chunk.done) break; text+=decoder.decode(chunk.value,{stream:true}); }
      return text+decoder.decode();
    }
  };
}

async function apiFetch(path, { method = "GET", body, accept = "application/json", stream = false } = {}, retried = false) {
  const token = await getAccessToken(retried);
  const headers = {
    Accept: accept,
    Authorization: "Bearer " + token,
    Origin: ORIGIN,
    ...clientHeaders()
  };
  if (!(typeof FormData !== "undefined" && body instanceof FormData)) headers["Content-Type"] = "application/json";
  const options = { method, body, headers };
  const response = stream ? await streamingFetch(API_URL + path, options) : await fetch(API_URL + path, options);
  if (response.status === 401 && !retried) {
    if (stream && response.body?.getReader) await response.body.getReader().cancel().catch(()=>{});
    return apiFetch(path, { method, body, accept, stream }, true);
  }
  return response;
}

