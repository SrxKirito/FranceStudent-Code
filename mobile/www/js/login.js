"use strict";

function showLogin(message) {
  $("app").classList.add("hidden");
  $("login-screen").classList.remove("hidden");
  const error = $("login-error");
  error.textContent = message || "";
  error.classList.toggle("hidden", !message);
}

async function showApp() {
  $("login-screen").classList.add("hidden");
  $("app").classList.remove("hidden");
  renderHistory();
  renderMessages();
  updateSendButton();
  renderProfile();
  const profileReady = await loadProfile();
  syncConversationsFromServer();
  await loadAgents();
  if (profileReady && typeof resumeSavedResponse === 'function') resumeSavedResponse();
}

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible" && !busy && !$("app").classList.contains("hidden")) {
    syncConversationsFromServer();
  }
});

const LOGIN_TIMEOUT_MS = 30000;
const MAX_REDIRECTS = 15;
const MAX_PAGE_STEPS = 6;
const REDIRECT_STATUSES = [301, 302, 303, 307, 308];
const VISIBLE_TEXT_TYPES = ["text", "email", "tel", ""];
const SKIPPED_TYPES = ["password", "submit", "button", "image", "file", "reset"];

function nativeHttp() {
  const cap = window.Capacitor;
  const native = cap && typeof cap.isNativePlatform === "function" && cap.isNativePlatform();
  const http = native && ((cap.Plugins && cap.Plugins.CapacitorHttp) || (cap.registerPlugin && cap.registerPlugin("CapacitorHttp")));
  if (!http) throw new Error("La connexion par e-mail nécessite l’application Android ou iPhone. Dans un navigateur, utilise le cookie de session.");
  return http;
}

function headerValue(headers, name) {
  const key = Object.keys(headers || {}).find(k => k.toLowerCase() === name);
  return key === undefined ? "" : headers[key];
}

function storeCookies(headers, jar) {
  const raw = headerValue(headers, "set-cookie");
  const lines = (Array.isArray(raw) ? raw : [raw]).flatMap(v => String(v || "").split(/,(?=\s*[^;,=\s]+=)/));
  for (const line of lines) {
    const pair = line.split(";")[0];
    const index = pair.indexOf("=");
    if (index <= 0) continue;
    const name = pair.slice(0, index).trim();
    const value = pair.slice(index + 1).trim();
    if (!value || /max-age=(0|-\d+)\s*(;|$)/i.test(line)) jar.delete(name);
    else jar.set(name, value);
  }
}

function createLoginSession() {
  const http = nativeHttp();
  const jars = new Map();
  const jarFor = host => {
    if (!jars.has(host)) jars.set(host, new Map());
    return jars.get(host);
  };

  async function request(url, { method = "GET", data, headers = {}, referer } = {}) {
    const target = new URL(url);
    const jar = jarFor(target.host);
    const cookie = [...jar].map(([name, value]) => name + "=" + value).join("; ");
    let response;
    try {
      response = await http.request({
        url: target.toString(),
        method,
        data,
        headers: {
          "User-Agent": USER_AGENT,
          Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8",
          "Accept-Language": "fr-FR,fr;q=0.9,en;q=0.8",
          Referer: referer || ORIGIN + "/",
          ...(cookie ? { Cookie: cookie } : {}),
          ...headers
        },
        responseType: "text",
        disableRedirects: true,
        connectTimeout: LOGIN_TIMEOUT_MS,
        readTimeout: LOGIN_TIMEOUT_MS
      });
    } catch (error) {
      throw new Error("Réseau indisponible : " + (error && error.message ? error.message : error));
    }
    storeCookies(response.headers, jar);
    const body = typeof response.data === "string" ? response.data : JSON.stringify(response.data ?? "");
    return { status: Number(response.status) || 0, headers: response.headers || {}, body, url: target.toString() };
  }

  return { request, jarFor };
}

function parseJson(response) {
  try {
    return JSON.parse(response.body);
  } catch {
    return null;
  }
}

async function followRedirects(session, response, stop) {
  let current = response;
  let hops = 0;
  while (!stop() && REDIRECT_STATUSES.includes(current.status)) {
    const location = headerValue(current.headers, "location");
    if (!location) break;
    if (++hops > MAX_REDIRECTS) throw authError("Trop de redirections pendant la connexion.");
    current = await session.request(new URL(location, current.url).toString(), { referer: current.url });
  }
  return current;
}

async function startOAuth(session) {
  const csrf = await session.request(ORIGIN + "/api/auth/csrf", { headers: { Accept: "application/json" } });
  const csrfToken = csrf.status === 200 && (parseJson(csrf) || {}).csrfToken;
  if (!csrfToken) throw authError("Jeton CSRF non reçu (HTTP " + csrf.status + ").");

  const response = await session.request(ORIGIN + "/api/auth/signin/whmcs", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: ORIGIN,
      "X-Auth-Return-Redirect": "1"
    },
    data: new URLSearchParams({ csrfToken, callbackUrl: "/" }).toString()
  });
  const target = headerValue(response.headers, "location") || (parseJson(response) || {}).url;
  if (!target) throw authError("Adresse de connexion non reçue (HTTP " + response.status + ").");
  return new URL(target, ORIGIN).toString();
}

function parseForms(doc, baseUrl) {
  return [...doc.querySelectorAll("form")].map(form => {
    let action;
    try {
      action = new URL(form.getAttribute("action") || "", baseUrl).toString();
    } catch {
      action = baseUrl;
    }
    return {
      action,
      method: (form.getAttribute("method") || "get").toUpperCase(),
      fields: [...form.querySelectorAll("input")].map(input => ({
        name: input.getAttribute("name") || "",
        id: input.id || "",
        type: (input.getAttribute("type") || "text").toLowerCase(),
        value: input.getAttribute("value") || "",
        checked: input.hasAttribute("checked"),
        disabled: input.hasAttribute("disabled")
      })),
      buttons: [...form.querySelectorAll("button")].map(button => ({
        name: button.getAttribute("name") || "",
        value: button.getAttribute("value") || "",
        type: (button.getAttribute("type") || "submit").toLowerCase(),
        label: button.textContent.replace(/\s+/g, " ").trim()
      }))
    };
  });
}

function findLoginForm(forms) {
  for (const form of forms) {
    const password = form.fields.find(f => f.type === "password" && f.name);
    const candidates = form.fields.filter(f => VISIBLE_TEXT_TYPES.includes(f.type) && f.name && !f.disabled);
    if (!password || !candidates.length) continue;
    const username = candidates.find(f => /user|mail|login|ident/i.test(f.name + " " + f.id)) || candidates[0];
    return { form, username, password };
  }
  return null;
}

function formBody(form, skip) {
  const body = new URLSearchParams();
  for (const field of form.fields) {
    if (!field.name || field.disabled || skip.includes(field)) continue;
    if (SKIPPED_TYPES.includes(field.type)) continue;
    if ((field.type === "checkbox" || field.type === "radio") && !field.checked) continue;
    body.append(field.name, field.type === "checkbox" && field.value === "" ? "on" : field.value);
  }
  return body;
}

function buildLoginBody({ form, username, password }, email, secret) {
  const body = formBody(form, [username, password]);
  body.set(username.name, email);
  body.set(password.name, secret);
  const submitter = form.fields.find(f => f.type === "submit" && f.name) || form.buttons.find(b => b.type === "submit" && b.name);
  if (submitter) body.set(submitter.name, submitter.value);
  return body;
}

function findConsentForm(forms) {
  for (const form of forms) {
    if (form.fields.some(f => (VISIBLE_TEXT_TYPES.includes(f.type) && f.name && !f.disabled) || f.type === "password")) continue;
    const submitters = [
      ...form.fields.filter(f => f.type === "submit").map(f => ({ name: f.name, value: f.value, label: f.value })),
      ...form.buttons.filter(b => b.type === "submit").map(b => ({ name: b.name, value: b.value, label: b.label }))
    ];
    const accept = submitters.find(s => /autoris|authori[sz]e|approve|allow|accepter|accept/i.test(s.name + " " + s.value + " " + s.label));
    if (accept) {
      const body = formBody(form, []);
      if (accept.name) body.set(accept.name, accept.value);
      return { form, body };
    }
  }
  return null;
}

function pageText(doc) {
  doc.querySelectorAll("script, style, template, noscript").forEach(node => node.remove());
  return (doc.body ? doc.body.textContent : "").replace(/\s+/g, " ").trim();
}

function checkPage(response) {
  const blocked = headerValue(response.headers, "cf-mitigated") === "challenge" ||
    ([403, 429, 503].includes(response.status) && /just a moment|cf-chl|attention required|cloudflare/i.test(response.body));
  if (blocked) throw authError("Cloudflare bloque la connexion automatique. Utilise le cookie de session.");
  if (response.status >= 400) throw authError("La page de connexion a répondu HTTP " + response.status + ".");
}

async function submitForm(session, form, body, referer, stop) {
  const post = form.method === "POST";
  const target = new URL(form.action);
  if (!post) body.forEach((value, name) => target.searchParams.set(name, value));
  const response = await session.request(target.toString(), {
    method: post ? "POST" : "GET",
    referer,
    data: post ? body.toString() : undefined,
    headers: post ? { "Content-Type": "application/x-www-form-urlencoded", Origin: new URL(referer).origin } : {}
  });
  return followRedirects(session, response, stop);
}

async function loginWithPassword(email, password) {
  const session = createLoginSession();
  const jar = session.jarFor(new URL(ORIGIN).host);
  const stop = () => jar.has(SESSION_COOKIE);

  const authorizeUrl = await startOAuth(session);
  let response = await followRedirects(session, await session.request(authorizeUrl), stop);
  let submitted = false;

  for (let step = 0; step < MAX_PAGE_STEPS && !stop(); step++) {
    checkPage(response);
    const doc = new DOMParser().parseFromString(response.body, "text/html");
    const forms = parseForms(doc, response.url);
    const loginForm = findLoginForm(forms);

    if (loginForm) {
      if (submitted) {
        const alert = doc.querySelector(".alert-danger, .alert-error, .login-error, .errorbox");
        const detail = alert ? alert.textContent.replace(/\s+/g, " ").trim().slice(0, 200) : "";
        throw authError("Identifiants refusés" + (detail ? " : " + detail : "."));
      }
      if (doc.querySelector(".g-recaptcha, .h-captcha, .cf-turnstile")) {
        throw authError("La page de connexion demande un captcha. Utilise le cookie de session.");
      }
      submitted = true;
      response = await submitForm(session, loginForm.form, buildLoginBody(loginForm, email, password), response.url, stop);
      continue;
    }

    const text = pageText(doc);
    if (submitted && /double authentification|authentification (?:à|a) deux|two-?factor|\b2fa\b|code de v[ée]rification|authenticator|totp/i.test(text)) {
      throw authError("Double authentification requise : non prise en charge. Utilise le cookie de session.");
    }

    const consent = findConsentForm(forms);
    if (consent) {
      response = await submitForm(session, consent.form, consent.body, response.url, stop);
      continue;
    }

    const title = (doc.title || "").trim().slice(0, 80);
    throw authError("Page inattendue pendant la connexion (" + new URL(response.url).host + ", HTTP " + response.status + (title ? ", « " + title + " »" : "") + ").");
  }

  if (!stop()) throw authError("Connexion incomplète : le cookie de session n'a pas été reçu.");
  return jar.get(SESSION_COOKIE);
}

async function activateSession(session) {
  if (store.session !== session) {
    store.webSearchMode = "open";
    store.customInstructionsManaged = false;
    store.fileInstrSynced = false;
  }
  store.session = session;
  auth.accessToken = "";
  auth.expiresAt = 0;
  try {
    await getAccessToken(true);
  } catch (error) {
    store.session = "";
    throw error;
  }
  saveStore();
  await showApp();
}

function setButtonWaiting(button, waiting, label) {
  button.disabled = waiting;
  button.textContent = waiting ? "Connexion\u2026" : label;
}

async function login(event) {
  event.preventDefault();
  const email = $("email-input").value.trim();
  const password = $("password-input").value;
  if (!email || !password) return;

  const button = $("login-button");
  setButtonWaiting(button, true);
  showLogin("");
  try {
    await activateSession(await loginWithPassword(email, password));
    $("password-input").value = "";
  } catch (error) {
    showLogin(error.message);
  } finally {
    setButtonWaiting(button, false, "Se connecter");
  }
}

async function cookieLogin(event) {
  event.preventDefault();
  const session = cleanSession($("session-input").value);
  if (!session) return;

  const button = $("cookie-button");
  setButtonWaiting(button, true);
  showLogin("");
  try {
    await activateSession(session);
    $("session-input").value = "";
  } catch (error) {
    showLogin(error.message);
  } finally {
    setButtonWaiting(button, false, "Utiliser ce cookie");
  }
}

async function logout() {
  try { if (typeof forgetRememberedLink === "function") await forgetRememberedLink(); }
  catch (error) { if (typeof showToast === "function") showToast(error.message); return; }
  document.getElementById("france-ide")?.close();
  if (typeof franceIDESession !== "undefined") franceIDESession = null;
  if (busy) stopGeneration();
  store.session = "";
  store.profile = null;
  store.customInstructionsManaged = false;
  store.fileInstrSynced = false;
  store.webSearchMode = "open";
  auth.accessToken = "";
  auth.expiresAt = 0;
  saveStore();
  closeMenus();
  closeSidebar();
  showLogin("");
}

