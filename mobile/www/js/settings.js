"use strict";

// Fenêtre Paramètres : onglets Général, Compte et MCP.

let settingsReturnFocus = null;
let settingsCloseTimer = null;
let settingsActiveTab = "account";
const settingsLoaded = { mcp: false, general: false };
let mcpLoading = false;

function settingsOpen() {
  const modal = $("settings-modal");
  return !!modal && !modal.classList.contains("hidden");
}

function openSettings(tab) {
  if(typeof renderLibrarySettings === "function")renderLibrarySettings();
  const modal = $("settings-modal");
  if (!modal) return;
  const reopening = modal.classList.contains("is-closing");
  if (settingsCloseTimer !== null) clearTimeout(settingsCloseTimer);
  settingsCloseTimer = null;
  modal.classList.remove("is-closing");
  closeMenus();
  if (!reopening) settingsReturnFocus = document.activeElement;
  // Les listes distantes sont rechargées à chaque ouverture (compte éventuellement changé).
  settingsLoaded.mcp = false;
  settingsLoaded.general = false;
  modal.classList.remove("hidden");
  document.body.classList.add("settings-open");
  $("user-button").setAttribute("aria-expanded", "true");
  if (typeof renderDefaultModelSelect === "function") renderDefaultModelSelect();
  renderImageSettings();
  selectSettingsTab(tab || "account", false);
  $("settings-close").focus();
}

function closeSettings() {
  if (settingsCloseTimer !== null) return;
  closeReasoningMenu();
  closeSettingsImageModelMenu();
  if (!settingsOpen()) return;
  if (typeof closeDefaultModelMenu === "function") closeDefaultModelMenu();
  const modal = $("settings-modal");
  const finish = () => {
    settingsCloseTimer = null;
    modal.classList.add("hidden");
    modal.classList.remove("is-closing");
    document.body.classList.remove("settings-open");
    $("user-button").setAttribute("aria-expanded", "false");
    const target = settingsReturnFocus;
    settingsReturnFocus = null;
    if (target && typeof target.focus === "function" && document.body.contains(target) && target.getClientRects().length) target.focus();
  };
  if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    finish();
    return;
  }
  modal.classList.add("is-closing");
  settingsCloseTimer = setTimeout(finish, 180);
}

function selectSettingsTab(name, focus) {
  closeReasoningMenu();
  closeSettingsImageModelMenu();
  const tabs = Array.from(document.querySelectorAll("#settings-tablist .settings-tab"));
  if (!tabs.some(tab => tab.dataset.tab === name)) name = "account";
  settingsActiveTab = name;
  tabs.forEach(tab => {
    const on = tab.dataset.tab === name;
    tab.setAttribute("aria-selected", on ? "true" : "false");
    tab.tabIndex = on ? 0 : -1;
    tab.classList.toggle("active", on);
    if (on && focus) tab.focus();
  });
  document.querySelectorAll("#settings-menu .settings-panel").forEach(panel => {
    panel.hidden = panel.dataset.panel !== name;
  });
  const panels = document.querySelector("#settings-menu .settings-panels");
  if (panels) panels.scrollTop = 0;
  if (name !== "general" && typeof closeDefaultModelMenu === "function") closeDefaultModelMenu();
  if (name === "account" && typeof loadQuota === "function") loadQuota();
  if (name === "account" && typeof loadAccountActivity === "function") loadAccountActivity();
  if (name === "mcp" && !settingsLoaded.mcp) loadMcpServers();
  if (name === "general" && !settingsLoaded.general) loadGeneralSettings();
}

// ---------- Génération d'images (onglet Général) ----------

function settingsImageModelList() {
  // Le catalogue reste disponible même sans sélecteur d'image dans le chat.
  const catalog = typeof IMAGE_MODELS === "object" && IMAGE_MODELS ? IMAGE_MODELS : {};
  return Object.entries(catalog).map(([id, info]) => ({ id, label: info.name || id }));
}

function applyImageSettingsChange() {
  store.imageToolSynced = null;
  saveStore();
  if (typeof renderImageModel === "function") renderImageModel();
  if (typeof renderToggles === "function") renderToggles();
  renderImageSettings();
}

function renderImageSettings() {
  const toggle = $("image-tool-toggle");
  if (toggle) {
    toggle.checked = store.imageTool !== false;
    toggle.setAttribute("aria-checked", toggle.checked ? "true" : "false");
    toggle.onchange = () => {
      store.imageTool = toggle.checked;
      applyImageSettingsChange();
    };
  }
  const box = $("settings-image-models");
  if (!box) return;
  const models = settingsImageModelList();
  const current = models.find(model => model.id === store.imageModel);
  $("settings-image-model-name").textContent = current ? current.label : "Choisir le modèle";
  $("settings-image-model-logo").innerHTML = providerMark({ provider: "OpenAI" });
  box.innerHTML = "";
  if (!models.length) {
    const note = document.createElement("div");
    note.className = "model-menu-note";
    note.textContent = "Les modèles d’image sont indisponibles. Relance l’application.";
    box.appendChild(note);
  }
  for (const model of models) {
    const btn = modelOption({ id: model.id, name: model.label, provider: "OpenAI", available: true }, store.imageModel);
    btn.onclick = event => {
      event.stopPropagation();
      store.imageModel = model.id;
      applyImageSettingsChange();
      closeSettingsImageModelMenu();
      $("settings-image-model-button").focus();
    };
    box.appendChild(btn);
  }
  $("settings-image-model-button").onclick = event => {
    event.stopPropagation();
    const opening = box.classList.contains("hidden");
    closeMenus();
    if (!opening) return;
    box.classList.remove("hidden");
    $("settings-image-model-button").setAttribute("aria-expanded", "true");
    const selected = box.querySelector('[aria-selected="true"]');
    if (selected) selected.focus();
  };
  box.onkeydown = event => {
    if (event.key === "Escape") {
      event.stopPropagation();
      closeSettingsImageModelMenu();
      $("settings-image-model-button").focus();
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const options = [...box.querySelectorAll(".model-option")];
    const index = options.indexOf(document.activeElement);
    options[(index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length]?.focus();
  };
}

function closeSettingsImageModelMenu() {
  $("settings-image-models")?.classList.add("hidden");
  $("settings-image-model-button")?.setAttribute("aria-expanded", "false");
}

// ---------- Utilitaires ----------

async function settingsApi(path, opts = {}) {
  const res = await apiFetch(path, opts);
  if (!res || typeof res.text !== "function") return res;
  const text = await res.text();
  let data = null;
  if (text) {
    try { data = JSON.parse(text); } catch { data = text; }
  }
  if (!res.ok) {
    let msg = "";
    if (data && typeof data === "object") {
      const e = data.error;
      msg = (e && typeof e === "object" ? e.message : typeof e === "string" ? e : "") || data.message || data.detail || "";
    } else if (typeof data === "string") {
      msg = data.slice(0, 200);
    }
    const error = new Error(msg || `Erreur ${res.status}`);
    error.status = res.status;
    throw error;
  }
  return data;
}

function settingsItems(data, key) {
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.data)) return data.data;
  if (data && key && Array.isArray(data[key])) return data[key];
  return [];
}

function settingsEl(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined && text !== null) node.textContent = String(text);
  return node;
}

function settingsNotice(list, text, isError) {
  list.replaceChildren(settingsEl("div", isError ? "settings-empty settings-error" : "settings-empty", text));
}

function settingsShowError(node, message) {
  if (!node) return;
  node.textContent = message || "";
  node.hidden = !message;
}

function settingsButton(label, className, onClick) {
  const button = settingsEl("button", "settings-btn" + (className ? " " + className : ""), label);
  button.type = "button";
  button.addEventListener("click", onClick);
  return button;
}

function settingsSwitch(checked, label, onChange) {
  const wrap = settingsEl("label", "settings-switch");
  wrap.title = label;
  const input = document.createElement("input");
  input.type = "checkbox";
  input.checked = checked;
  input.setAttribute("aria-label", label);
  input.addEventListener("change", () => onChange(input.checked, input));
  wrap.append(input, settingsEl("span", "settings-switch-track"));
  return wrap;
}

function settingsDate(value) {
  if (value === undefined || value === null || value === "") return "";
  let date;
  if (typeof value === "number") date = new Date(value < 1e12 ? value * 1000 : value);
  else date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString("fr-FR", { day: "numeric", month: "short", year: "numeric" });
}

async function settingsBusy(button, busyLabel, task) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = busyLabel;
  try {
    return await task();
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

// ---------- MCP ----------

async function loadMcpServers() {
  if (mcpLoading) return;
  mcpLoading = true;
  const list = $("mcp-list");
  const refresh = $("mcp-refresh");
  if (!settingsLoaded.mcp) settingsNotice(list, "Chargement des serveurs…");
  refresh.classList.add("spinning");
  try {
    const data = await settingsApi("/mcp/servers");
    settingsLoaded.mcp = true;
    renderMcpServers(settingsItems(data, "servers"));
  } catch (err) {
    settingsNotice(list, "Impossible de charger les serveurs MCP : " + err.message, true);
  } finally {
    mcpLoading = false;
    refresh.classList.remove("spinning");
  }
}

function renderMcpServers(items) {
  const list = $("mcp-list");
  list.replaceChildren();
  if (!items.length) {
    settingsNotice(list, "Aucun serveur MCP pour l'instant. Clique sur + Ajouter MCP.");
    return;
  }
  items.forEach(server => list.appendChild(mcpItem(server)));
}

function mcpItem(server) {
  const label = server.server_label || server.id || "Serveur";
  const id = encodeURIComponent(server.id);
  const item = settingsEl("div", "settings-item");
  item.dataset.mcpId = String(server.id);
  item.classList.toggle("disabled", server.enabled === false);
  const error = settingsEl("p", "settings-error");
  error.hidden = true;

  const head = settingsEl("div", "settings-item-head");
  const info = settingsEl("div", "settings-item-info");
  info.append(settingsEl("div", "settings-item-title", label));
  if (server.server_url) info.append(settingsEl("div", "settings-item-sub", server.server_url));
  head.append(info);
  head.append(settingsSwitch(server.enabled !== false, `Activer ${label}`, async (checked, input) => {
    input.disabled = true;
    settingsShowError(error, "");
    try {
      await settingsApi(`/mcp/servers/${id}`, { method: "POST", body: JSON.stringify({ enabled: checked }) });
      server.enabled = checked;
      item.classList.toggle("disabled", !checked);
    } catch (err) {
      input.checked = !checked;
      settingsShowError(error, err.message);
    } finally {
      input.disabled = false;
    }
  }));
  item.append(head);

  if (server.server_description) item.append(settingsEl("p", "settings-item-desc", server.server_description));

  const tools = Array.isArray(server.available_tools) ? server.available_tools : [];
  const badges = settingsEl("div", "settings-badges");
  badges.append(settingsEl("span", "settings-badge", `${tools.length} outil${tools.length > 1 ? "s" : ""}`));
  if (server.has_authorization) badges.append(settingsEl("span", "settings-badge ok", "Authentifié"));
  if (typeof server.oauth_status === "string" && server.oauth_status && server.oauth_status !== "none") {
    badges.append(settingsEl("span", "settings-badge", "OAuth : " + server.oauth_status));
  }
  if (server.require_approval === "always") badges.append(settingsEl("span", "settings-badge", "Approbation requise"));
  item.append(badges);

  if (tools.length) {
    const details = settingsEl("details", "settings-tools");
    details.append(settingsEl("summary", "", "Voir les outils"));
    const ul = settingsEl("ul", "settings-tool-list");
    tools.forEach(tool => {
      const li = settingsEl("li");
      li.append(settingsEl("strong", "", tool.title || tool.name || "outil"));
      if (tool.description) li.append(settingsEl("span", "", tool.description));
      ul.append(li);
    });
    details.append(ul);
    item.append(details);
  }

  const actions = settingsEl("div", "settings-item-actions");
  const discover = settingsButton("Actualiser les outils", "", () => {
    settingsShowError(error, "");
    settingsBusy(discover, "Actualisation…", async () => {
      await settingsApi(`/mcp/servers/${id}/discover`, { method: "POST", body: JSON.stringify({}) });
      await loadMcpServers();
    }).catch(err => settingsShowError(error, err.message));
  });
  const remove = settingsButton("Supprimer", "danger", () => {
    if (!window.confirm(`Supprimer le serveur MCP « ${label} » ?`)) return;
    settingsShowError(error, "");
    settingsBusy(remove, "Suppression…", async () => {
      await settingsApi(`/mcp/servers/${id}`, { method: "DELETE" });
      await loadMcpServers();
    }).catch(err => settingsShowError(error, err.message));
  });
  actions.append(discover, remove);
  if (server.auth_type === "oauth") {
    const connect = settingsButton("Connecter mon compte", "", () => {
      settingsShowError(error, "");
      settingsBusy(connect, "Connexion…", () => startMcpOAuth(server.id)).catch(err => settingsShowError(error, err.message));
    });
    actions.prepend(connect);
  }
  item.append(actions, error);
  return item;
}

let mcpStep = 1;
let mcpSubmitting = false;

function mcpAuthType() {
  return document.querySelector('input[name="mcp-auth"]:checked').value;
}

function showMcpStep(step) {
  mcpStep = step;
  settingsShowError($("mcp-form-error"), "");
  document.querySelectorAll("[data-mcp-panel]").forEach(panel => { panel.hidden = Number(panel.dataset.mcpPanel) !== step; });
  document.querySelectorAll("[data-mcp-step]").forEach(button => {
    const index = Number(button.dataset.mcpStep);
    button.disabled = index > step || mcpSubmitting;
    button.setAttribute("aria-current", index === step ? "step" : "false");
    button.querySelector("span").textContent = index < step ? "✓" : String(index);
  });
  $("mcp-summary").hidden = step === 1;
  $("mcp-summary-name").textContent = $("mcp-label").value.trim();
  $("mcp-summary-url").textContent = $("mcp-url").value.trim();
  $("mcp-credentials").hidden = mcpAuthType() !== "bearer";
  $("mcp-oauth-hint").hidden = mcpAuthType() !== "oauth";
  $("mcp-back").textContent = step === 1 ? "Annuler" : "← Retour";
  $("mcp-submit").textContent = step === 3 ? "Ajouter le serveur" : "Continuer →";
  const panel = document.querySelector('[data-mcp-panel="' + step + '"]');
  panel.querySelector("input, textarea")?.focus();
}

function closeMcpWizard() {
  if (mcpSubmitting) return;
  $("mcp-wizard").close();
  $("mcp-form").reset();
  $("mcp-add").focus();
}

async function submitMcpForm(event) {
  event.preventDefault();
  if (mcpSubmitting) return;
  const errorBox = $("mcp-form-error");
  const label = $("mcp-label").value.trim();
  const url = $("mcp-url").value.trim();
  const description = $("mcp-description").value.trim();
  const token = $("mcp-token").value.trim().replace(/^Bearer\s+/i, "");
  settingsShowError(errorBox, "");
  if (!/^[a-zA-Z0-9_-]+$/.test(label)) return settingsShowError(errorBox, "Utilise uniquement des lettres, chiffres, underscores et tirets pour le nom.");
  let parsed = null;
  try { parsed = new URL(url); } catch { parsed = null; }
  if (!parsed || !/^https?:$/.test(parsed.protocol)) {
    return settingsShowError(errorBox, "Indique une URL valide commençant par https://.");
  }
  if (mcpStep < 3) return showMcpStep(mcpStep + 1);
  const authType = mcpAuthType();
  let headers = {};
  if (authType === "bearer") {
    try {
      headers = JSON.parse($("mcp-headers").value.trim() || "{}");
      if (!headers || Array.isArray(headers) || typeof headers !== "object" || Object.values(headers).some(value => typeof value !== "string")) throw new Error();
    } catch {
      return settingsShowError(errorBox, 'Les headers doivent être un objet JSON contenant des valeurs texte, par exemple {"X-API-Key":"secret"}.');
    }
    if (!token && !Object.keys(headers).length) return settingsShowError(errorBox, "Indique un token ou un header sécurisé, ou choisis Sans authentification.");
  }
  const body = {
    server_label: label,
    server_url: url,
    require_approval: $("mcp-approval").checked ? "always" : "never",
    enabled: true,
    auth_type: authType
  };
  if (description) body.server_description = description;
  if (authType === "bearer" && token) body.authorization = token;
  if (authType === "bearer" && Object.keys(headers).length) body.headers = headers;
  const submit = $("mcp-submit");
  try {
    mcpSubmitting = true;
    $("mcp-back").disabled = true;
    const server = await settingsBusy(submit, "Ajout…", () => settingsApi("/mcp/servers", { method: "POST", body: JSON.stringify(body) }));
    mcpSubmitting = false;
    $("mcp-form").reset();
    closeMcpWizard();
    settingsLoaded.mcp = false;
    await loadMcpServers();
    if (authType === "oauth" && server && server.id) {
      try { await startMcpOAuth(server.id); }
      catch (err) { $("mcp-list").prepend(settingsEl("p", "settings-error", "Serveur ajouté. Connexion impossible : " + err.message)); }
    }
  } catch (err) {
    settingsShowError(errorBox, err.message);
  } finally {
    mcpSubmitting = false;
    $("mcp-back").disabled = false;
  }
}

async function startMcpOAuth(id) {
  const data = await settingsApi('/mcp/servers/' + encodeURIComponent(id) + '/oauth/start', { method: "POST", body: "{}" });
  const url = new URL(data.authorization_url);
  if (!/^https?:$/.test(url.protocol)) throw new Error("URL de connexion invalide.");
  window.open(url.href, "_blank", "noopener,noreferrer");
  const item = [...$("mcp-list").querySelectorAll("[data-mcp-id]")].find(node => node.dataset.mcpId === String(id));
  if (!item) return;
  item.querySelector(".mcp-oauth-complete")?.remove();
  const form = settingsEl("form", "settings-form mcp-oauth-complete");
  const link = settingsEl("a", "settings-btn", "Ouvrir la connexion");
  link.href = url.href;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  const label = settingsEl("label", "settings-label", "Code d’autorisation ou URL de retour");
  const input = settingsEl("input", "settings-input");
  input.required = true;
  input.autocomplete = "off";
  label.append(input);
  const error = settingsEl("p", "settings-error");
  error.hidden = true;
  const finish = settingsButton("Terminer la connexion", "primary", () => {});
  finish.type = "submit";
  form.append(link, settingsEl("p", "settings-hint", "Après la connexion, colle le code fourni ou l’URL de retour pour terminer l’autorisation."), label, error, finish);
  form.onsubmit = async event => {
    event.preventDefault();
    let code = input.value.trim();
    let state = data.state;
    try {
      const callback = new URL(code);
      if (callback.searchParams.get("state") !== state) throw new Error("La connexion ne correspond pas à cette demande.");
      code = callback.searchParams.get("code") || "";
    } catch (err) {
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(code)) return settingsShowError(error, err.message);
    }
    if (!code) return settingsShowError(error, "Indique le code d’autorisation.");
    try {
      await settingsBusy(finish, "Connexion…", () => settingsApi("/mcp/servers/oauth/complete", { method: "POST", body: JSON.stringify({ code, state }) }));
      await loadMcpServers();
    } catch (err) { settingsShowError(error, err.message); }
  };
  item.append(form);
}

// ---------- Clavier et branchement ----------

function settingsFocusable() {
  const dialog = $("settings-menu");
  const selector = 'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), summary, [tabindex]';
  return Array.from(dialog.querySelectorAll(selector)).filter(node =>
    node.tabIndex >= 0 && !node.hidden && node.getClientRects().length > 0);
}

function settingsKeydown(event) {
  if ($("mcp-wizard").open || $("web-settings-dialog")?.open) return;
  if (!settingsOpen()) return;
  if (event.key === "Escape") {
    const modelMenu = $("default-model-menu");
    if (modelMenu && !modelMenu.classList.contains("hidden")) return;
    const reasoningMenu = $("gpt-reasoning-menu");
    if (reasoningMenu && !reasoningMenu.classList.contains("hidden")) return;
    event.preventDefault();
    event.stopPropagation();
    closeSettings();
    return;
  }
  if (event.key !== "Tab") return;
  const dialog = $("settings-menu");
  const nodes = settingsFocusable();
  if (!nodes.length) return;
  const first = nodes[0];
  const last = nodes[nodes.length - 1];
  const active = document.activeElement;
  if (event.shiftKey && (active === first || !dialog.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && (active === last || !dialog.contains(active))) {
    event.preventDefault();
    first.focus();
  }
}

// Photo de profil : le serveur ne la conserve pas, elle est donc enregistrée sur l'appareil (store.avatar).
function avatarToast(message, isError) {
  if (typeof showToast === "function") showToast(message, isError);
}

function readAvatarFile(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const size = 256;
        const side = Math.min(img.naturalWidth, img.naturalHeight);
        if (!side) throw new Error("Image vide");
        const sx = (img.naturalWidth - side) / 2;
        const sy = (img.naturalHeight - side) / 2;
        const canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        const ctx = canvas.getContext("2d");
        ctx.fillStyle = "#ffffff";
        ctx.fillRect(0, 0, size, size);
        ctx.drawImage(img, sx, sy, side, side, 0, 0, size, size);
        resolve(canvas.toDataURL("image/jpeg", 0.85));
      } catch (error) {
        reject(error);
      } finally {
        URL.revokeObjectURL(url);
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Image illisible"));
    };
    img.src = url;
  });
}

async function changeAvatar(file) {
  if (!file) return;
  if (!String(file.type || "").startsWith("image/")) {
    avatarToast("Choisis un fichier image.", true);
    return;
  }
  try {
    const dataUrl = await readAvatarFile(file);
    const previous = store.avatar;
    store.avatar = dataUrl;
    try {
      saveStore();
    } catch {
      store.avatar = previous;
      avatarToast("Stockage plein : impossible d'enregistrer la photo.", true);
      return;
    }
    renderProfile();
    avatarToast("Photo de profil mise à jour.", false);
  } catch {
    avatarToast("Impossible de lire cette image.", true);
  }
}

function removeAvatar() {
  delete store.avatar;
  saveStore();
  renderProfile();
  avatarToast("Photo de profil retirée.", false);
}

function setupAvatarControls() {
  const input = $("avatar-input");
  if (!input) return;
  const pick = () => input.click();
  const edit = $("avatar-edit");
  const change = $("avatar-change");
  const remove = $("avatar-remove");
  if (edit) edit.addEventListener("click", pick);
  if (change) change.addEventListener("click", pick);
  if (remove) remove.addEventListener("click", removeAvatar);
  input.addEventListener("change", () => {
    const file = input.files && input.files[0];
    input.value = "";
    changeAvatar(file);
  });
  if (typeof renderProfile === "function") renderProfile();
}

function setupSettings() {
  const modal = $("settings-modal");
  if (!modal) return;
  // La barre latérale peut être transformée : on place la fenêtre directement dans <body>.
  if (modal.parentElement !== document.body) document.body.appendChild(modal);

  modal.querySelectorAll("[data-settings-close]").forEach(node => {
    node.addEventListener("click", event => {
      event.stopPropagation();
      closeSettings();
    });
  });

  const tablist = $("settings-tablist");
  const tabs = Array.from(tablist.querySelectorAll(".settings-tab"));
  tabs.forEach(tab => tab.addEventListener("click", () => selectSettingsTab(tab.dataset.tab, true)));
  tablist.addEventListener("keydown", event => {
    const index = tabs.findIndex(tab => tab.dataset.tab === settingsActiveTab);
    let next = -1;
    if (event.key === "ArrowDown" || event.key === "ArrowRight") next = (index + 1) % tabs.length;
    else if (event.key === "ArrowUp" || event.key === "ArrowLeft") next = (index - 1 + tabs.length) % tabs.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = tabs.length - 1;
    if (next < 0) return;
    event.preventDefault();
    selectSettingsTab(tabs[next].dataset.tab, true);
  });

  setupAvatarControls();
  setupGeneralSettings();
  setupAccountActivity();
  setupProjects();
  document.body.appendChild($("mcp-wizard"));
  $("mcp-refresh").addEventListener("click", loadMcpServers);
  $("mcp-form").addEventListener("submit", submitMcpForm);
  $("mcp-add").addEventListener("click", () => {
    $("mcp-form").reset();
    $("mcp-wizard").showModal();
    showMcpStep(1);
  });
  $("mcp-close").addEventListener("click", closeMcpWizard);
  $("mcp-wizard").addEventListener("cancel", event => { event.preventDefault(); closeMcpWizard(); });
  $("mcp-back").addEventListener("click", () => mcpStep === 1 ? closeMcpWizard() : showMcpStep(mcpStep - 1));
  $("mcp-edit").addEventListener("click", () => { if (!mcpSubmitting) showMcpStep(1); });
  document.querySelectorAll("[data-mcp-step]").forEach(button => button.addEventListener("click", () => { if (!mcpSubmitting) showMcpStep(Number(button.dataset.mcpStep)); }));

  $("logout").addEventListener("click", closeSettings);
  document.addEventListener("keydown", settingsKeydown, true);
}
