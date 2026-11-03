"use strict";

const GPT_REASONING_LEVELS = ["none", "minimal", "low", "medium", "high", "xhigh"];
const GPT_REASONING_LABELS = { none: "Aucun", minimal: "Minimal", low: "Faible", medium: "Moyen", high: "Élevé", xhigh: "Très élevé" };
const WEB_MODE_LABELS = { open: "Sans restriction", filtered: "Sites filtrés", disabled: "Désactivé" };
let generalSettingsLoading = false;
let generalPersonalization = null;
let webDomainSettings = null;
let webSettingsSaving = false;

function generalStatus(id, message, error = false) {
  $(id).textContent = message;
  $(id).classList.toggle("general-status-error", error);
}

async function loadGeneralSettings() {
  if (generalSettingsLoading) return;
  generalSettingsLoading = true;
  const session = store.session;
  $("personalization-fields").disabled = true;
  $("web-settings-open").disabled = true;
  $("personalization-retry").hidden = true;
  generalStatus("personalization-status", "Chargement des préférences…");
  try {
    const data = await settingsApi("/user/instructions");
    if (session !== store.session) return;
    if (!data || typeof data !== "object") throw new Error("Réponse du serveur illisible.");
    generalPersonalization = data;
    applyWebSearchPreference(data.webSearchMode);
    $("gpt-reasoning").value = GPT_REASONING_LEVELS.includes(data.gptReasoning) ? data.gptReasoning : "none";
    renderReasoningMenu();
    $("custom-instructions").value = typeof data.customInstructions === "string" ? data.customInstructions : "";
    $("web-settings-summary").textContent = WEB_MODE_LABELS[data.webSearchMode] || WEB_MODE_LABELS.open;
    $("personalization-fields").disabled = false;
    $("web-settings-open").disabled = false;
    settingsLoaded.general = true;
    generalStatus("personalization-status", "");
  } catch (err) {
    generalStatus("personalization-status", "Impossible de charger les préférences : " + err.message, true);
    $("personalization-retry").hidden = false;
  } finally { generalSettingsLoading = false; }
}

async function saveGeneralSettings(event) {
  event.preventDefault();
  if ($("personalization-fields").disabled) return;
  const reasoning = $("gpt-reasoning").value;
  if (!GPT_REASONING_LEVELS.includes(reasoning)) return;
  const customInstructions = $("custom-instructions").value;
  if (customInstructions.length > 2000000) return generalStatus("personalization-status", "Les instructions sont trop longues.", true);
  const session = store.session;
  $("personalization-fields").disabled = true;
  generalStatus("personalization-status", "Enregistrement…");
  try {
    await settingsApi("/user/instructions", { method: "PATCH", body: JSON.stringify({ gptReasoning: reasoning, customInstructions }) });
    if (session !== store.session) return;
    generalPersonalization = { ...generalPersonalization, gptReasoning: reasoning, customInstructions };
    // Une modification explicite remplace aussi la consigne automatique des fichiers.
    store.customInstructionsManaged = true;
    store.fileInstrSynced = true;
    saveStore();
    generalStatus("personalization-status", "Préférences enregistrées sur ton compte.");
  } catch (err) {
    generalStatus("personalization-status", "Enregistrement impossible : " + err.message, true);
  } finally { $("personalization-fields").disabled = false; }
}

function updateWebDomainFields() {
  $("web-domain-options").hidden = $("web-search-mode").value !== "filtered";
  const allowed = $("web-filter-type").value === "allowlist";
  $("web-allowed-field").hidden = !allowed;
  $("web-blocked-field").hidden = allowed;
}

function applyWebSearchPreference(mode) {
  store.webSearchMode = Object.hasOwn(WEB_MODE_LABELS, mode) ? mode : "open";
  if (store.webSearchMode === "disabled") store.webSearch = false;
  saveStore();
  if (typeof renderToggles === "function") renderToggles();
}

function parseWebDomains(value) {
  const domains = String(value).split(/[\s,;]+/).map(part => part.trim()).filter(Boolean).map(part => {
    let url;
    try { url = new URL(/^https?:\/\//i.test(part) ? part : "https://" + part); }
    catch { throw new Error("Domaine invalide : " + part); }
    const hostname = url.hostname.toLowerCase().replace(/\.$/, "");
    if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.port || url.pathname !== "/" || url.search || url.hash || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,63}$/i.test(hostname)) {
      throw new Error("Indique uniquement un domaine, par exemple wikipedia.org : " + part);
    }
    return hostname;
  });
  return [...new Set(domains)];
}

async function loadWebDomainSettings() {
  const session = store.session;
  webDomainSettings = null;
  $("web-settings-fields").disabled = true;
  $("web-settings-retry").hidden = true;
  generalStatus("web-settings-status", "Chargement des filtres…");
  try {
    const raw = await settingsApi("/user/web-search-domains");
    if (session !== store.session) return;
    const data = normalizeWebDomainSettings(raw);
    webDomainSettings = data;
    $("web-filter-type").value = data.filterType === "blocklist" ? "blocklist" : "allowlist";
    $("web-allowed-domains").value = data.allowedDomains.join("\n");
    $("web-blocked-domains").value = data.blockedDomains.join("\n");
    updateWebDomainFields();
    $("web-settings-fields").disabled = false;
    generalStatus("web-settings-status", "");
  } catch (err) {
    generalStatus("web-settings-status", "Impossible de charger les filtres : " + err.message, true);
    $("web-settings-retry").hidden = false;
    // Les modes sans filtre restent utilisables même si les listes ne chargent pas.
    $("web-settings-fields").disabled = false;
  }
}

function normalizeWebDomainSettings(raw) {
  const data = raw == null || raw === "" ? {} : raw;
  if (typeof data !== "object" || Array.isArray(data)) throw new Error("Filtres du serveur illisibles.");
  const list = key => {
    if (data[key] == null) return [];
    if (!Array.isArray(data[key]) || data[key].some(item => typeof item !== "string")) throw new Error("Liste de domaines invalide.");
    return data[key];
  };
  return { filterType: data.filterType === "blocklist" ? "blocklist" : "allowlist", allowedDomains: list("allowedDomains"), blockedDomains: list("blockedDomains") };
}

async function saveWebSettings(event) {
  event.preventDefault();
  if (webSettingsSaving || $("web-settings-fields").disabled) return;
  const webSearchMode = $("web-search-mode").value;
  if (!Object.hasOwn(WEB_MODE_LABELS, webSearchMode)) return;
  let domains = null;
  if (webSearchMode === "filtered") {
    if (!webDomainSettings) return generalStatus("web-settings-status", "Charge les listes avec Réessayer avant de modifier les filtres.", true);
    try {
      domains = {
        filterType: $("web-filter-type").value,
        allowedDomains: parseWebDomains($("web-allowed-domains").value),
        blockedDomains: parseWebDomains($("web-blocked-domains").value)
      };
      if (domains.filterType === "allowlist" && !domains.allowedDomains.length) throw new Error("Ajoute au moins un site autorisé.");
    } catch (err) { return generalStatus("web-settings-status", err.message, true); }
  }
  webSettingsSaving = true;
  $("web-settings-fields").disabled = true;
  let domainsSaved = false;
  generalStatus("web-settings-status", "Enregistrement…");
  try {
    if (domains) {
      await settingsApi("/user/web-search-domains", { method: "PUT", body: JSON.stringify(domains) });
      webDomainSettings = domains;
      domainsSaved = true;
    }
    await settingsApi("/user/instructions", { method: "PATCH", body: JSON.stringify({ webSearchMode }) });
    generalPersonalization = { ...generalPersonalization, webSearchMode };
    applyWebSearchPreference(webSearchMode);
    $("web-settings-summary").textContent = WEB_MODE_LABELS[webSearchMode];
    generalStatus("personalization-status", "Préférences de recherche web enregistrées.");
    $("web-settings-dialog").close();
    $("web-settings-open").focus();
  } catch (err) {
    generalStatus("web-settings-status", (domainsSaved ? "Listes enregistrées, mais le mode de recherche n’a pas pu être enregistré : " : "Enregistrement impossible : ") + err.message, true);
  } finally {
    webSettingsSaving = false;
    $("web-settings-fields").disabled = false;
  }
}

function setupGeneralSettings() {
  setupReasoningMenu();
  const dialog = $("web-settings-dialog");
  document.body.appendChild(dialog);
  $("personalization-form").addEventListener("submit", saveGeneralSettings);
  $("personalization-retry").addEventListener("click", loadGeneralSettings);
  $("web-settings-open").addEventListener("click", () => {
    $("web-search-mode").value = Object.hasOwn(WEB_MODE_LABELS, generalPersonalization?.webSearchMode) ? generalPersonalization.webSearchMode : "open";
    updateWebDomainFields();
    dialog.showModal();
    loadWebDomainSettings();
  });
  const close = () => { if (!webSettingsSaving) { dialog.close(); $("web-settings-open").focus(); } };
  $("web-settings-close").addEventListener("click", close);
  $("web-settings-cancel").addEventListener("click", close);
  dialog.addEventListener("cancel", event => { event.preventDefault(); close(); });
  $("web-search-mode").addEventListener("change", updateWebDomainFields);
  $("web-filter-type").addEventListener("change", updateWebDomainFields);
  $("web-settings-form").addEventListener("submit", saveWebSettings);
  $("web-settings-retry").addEventListener("click", loadWebDomainSettings);
}

function renderReasoningMenu() {
  const value = $("gpt-reasoning").value;
  $("gpt-reasoning-label").textContent = GPT_REASONING_LABELS[value] || "Aucun";
  for (const option of $("gpt-reasoning-menu").querySelectorAll("[data-reasoning]")) {
    option.setAttribute("aria-selected", String(option.dataset.reasoning === value));
  }
}

function closeReasoningMenu() {
  $("gpt-reasoning-menu")?.classList.add("hidden");
  $("gpt-reasoning-button")?.setAttribute("aria-expanded", "false");
}

function setupReasoningMenu() {
  const button = $("gpt-reasoning-button");
  const menu = $("gpt-reasoning-menu");
  button.addEventListener("click", event => {
    event.stopPropagation();
    const opening = menu.classList.contains("hidden");
    closeMenus();
    if (!opening) return;
    renderReasoningMenu();
    menu.classList.remove("hidden");
    button.setAttribute("aria-expanded", "true");
    menu.querySelector('[aria-selected="true"]')?.focus();
  });
  menu.addEventListener("click", event => {
    event.stopPropagation();
    const option = event.target.closest("[data-reasoning]");
    if (!option || !GPT_REASONING_LEVELS.includes(option.dataset.reasoning)) return;
    $("gpt-reasoning").value = option.dataset.reasoning;
    renderReasoningMenu(); closeReasoningMenu(); button.focus();
  });
  menu.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      event.preventDefault(); event.stopPropagation(); closeReasoningMenu(); button.focus(); return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const options = [...menu.querySelectorAll("[data-reasoning]")];
    const index = options.indexOf(document.activeElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
    options[next]?.focus();
  });
}
