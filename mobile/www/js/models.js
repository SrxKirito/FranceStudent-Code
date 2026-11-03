"use strict";

let agentsLoaded = false;
let agentsError = "";

const PROVIDER_NAMES = [
  [/openai|gpt|chatgpt/, "OpenAI"],
  [/anthropic|claude/, "Anthropic"],
  [/google|gemini|gemma|vertex/, "Google"],
  [/mistral|mixtral|codestral/, "Mistral"],
  [/llama|meta/, "Meta"],
  [/xai|grok/, "xAI"],
  [/deepseek/, "DeepSeek"],
  [/qwen|alibaba/, "Alibaba"]
];

function providerLabel(provider, name) {
  const raw = String(provider || "").trim();
  const lowerRaw = raw.toLowerCase();
  for (const [pattern, label] of PROVIDER_NAMES) if (lowerRaw && pattern.test(lowerRaw)) return label;
  const lowerName = String(name || "").toLowerCase();
  for (const [pattern, label] of PROVIDER_NAMES) if (pattern.test(lowerName)) return label;
  if (raw) return raw.charAt(0).toUpperCase() + raw.slice(1);
  return "";
}

function normalizeAgent(a) {
  const name = String(a.name || a.model || a.id);
  return {
    id: Number(a.id),
    name,
    model: String(a.model || ""),
    provider: providerLabel(a.modelProvider, name + " " + (a.model || "")),
    description: String(a.description || ""),
    available: a.isActive !== false,
    isDefault: a.isDefault === true
  };
}

function agentById(id) {
  return agents.find(a => a.id === id) || null;
}

function agentLabel(agent) {
  if (!agent) return "";
  const clean = String(agent.name).replace(/\s*\([^)]*\)\s*$/, "").trim();
  return clean || String(agent.name);
}

function providerMark(agent) {
  const provider = agent ? agent.provider : "";
  const logos = window.PROVIDER_LOGOS || {};
  if (provider && logos[provider]) return logos[provider];
  const source = agent ? provider || agent.name : "";
  const letter = source ? source.charAt(0).toUpperCase().replace(/[<>&"']/g, "") : "";
  return '<span class="model-logo-letter">' + (letter || "?") + "</span>";
}

async function loadAgents() {
  agentsError = "";
  try {
    let response = await apiFetch("/chats/agents?include-disabled=true");
    if (!response.ok) response = await apiFetch("/chats/agents");
    if (!response.ok) throw new Error("HTTP " + response.status);
    const data = await response.json();
    const list = Array.isArray(data) ? data : data && Array.isArray(data.agents) ? data.agents : [];
    agents = list
      .filter(a => a && Number.isInteger(Number(a.id)))
      .map(normalizeAgent);
  } catch (error) {
    agents = [];
    agentsError = error && error.message ? error.message : String(error);
  }
  if (!agents.length) {
    agents = [{ id: DEFAULT_AGENT_ID, name: "Modèle par défaut", model: "", provider: "", description: "", available: true, isDefault: true }];
  }
  agentsLoaded = true;
  const usable = agents.filter(a => a.available);
  if (!currentConversation() && defaultAgentValid()) {
    store.agentId = store.defaultAgentId;
    saveStore();
  }
  if (!usable.some(a => a.id === store.agentId)) {
    store.agentId = (usable.find(a => a.isDefault) || usable[0] || agents[0]).id;
    saveStore();
  }
  renderModels();
  renderHistory();
}

function modelOption(agent, selectedId = store.agentId) {
  const selected = agent.id === selectedId;
  const button = document.createElement("button");
  button.type = "button";
  button.className = "model-option" + (agent.available ? "" : " unavailable");
  button.setAttribute("role", "option");
  button.setAttribute("aria-selected", selected ? "true" : "false");
  button.dataset.id = String(agent.id);
  if (!agent.available) {
    button.setAttribute("aria-disabled", "true");
    button.title = "Ce modèle est indisponible pour le moment.";
  }

  const logo = document.createElement("span");
  logo.className = "model-logo";
  logo.setAttribute("aria-hidden", "true");
  logo.innerHTML = providerMark(agent);

  const text = document.createElement("span");
  text.className = "model-option-text";
  const name = document.createElement("span");
  name.className = "model-option-name";
  name.textContent = agentLabel(agent);
  text.appendChild(name);

  button.appendChild(logo);
  button.appendChild(text);
  if (!agent.available) {
    const badge = document.createElement("span");
    badge.className = "model-badge";
    badge.textContent = "Indisponible";
    button.appendChild(badge);
  } else if (selected) {
    const check = document.createElement("span");
    check.className = "model-check";
    check.setAttribute("aria-hidden", "true");
    check.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7"/></svg>';
    button.appendChild(check);
  }
  return button;
}

function renderModels() {
  const select = $("model-select");
  select.innerHTML = "";
  for (const agent of agents) {
    const option = document.createElement("option");
    option.value = String(agent.id);
    option.textContent = agentLabel(agent);
    option.disabled = !agent.available;
    select.appendChild(option);
  }
  select.value = String(store.agentId);
  renderDefaultModelSelect();

  const current = agentById(store.agentId);
  const name = $("model-name");
  name.innerHTML = "";
  const title = document.createElement("span");
  title.className = "model-title";
  title.textContent = current ? agentLabel(current) : "Modèle";
  name.appendChild(title);
  $("model-logo").innerHTML = providerMark(current);
  $("model-button").title = current ? "Modèle : " + agentLabel(current) : "Choisir le modèle";

  const menu = $("model-menu");
  menu.innerHTML = "";
  if (agentsError) {
    const note = document.createElement("div");
    note.className = "model-menu-note";
    note.textContent = "Liste des modèles indisponible (" + agentsError + "). Modèle par défaut utilisé.";
    menu.appendChild(note);
  }
  const groups = new Map();
  for (const agent of agents) {
    const key = agent.provider || "Autres modèles";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(agent);
  }
  for (const [provider, list] of groups) {
    const label = document.createElement("div");
    label.className = "menu-label";
    label.textContent = provider;
    menu.appendChild(label);
    for (const agent of list) menu.appendChild(modelOption(agent));
  }
  renderConversationModel();
}

function rememberAgent(conversation) {
  const agent = agentById(conversation.agentId);
  if (!agent) return;
  conversation.agentName = agent.name;
  conversation.agentProvider = agent.provider;
}

function renderConversationModel() {
  const box = $("conversation-model");
  if (!box) return;
  box.innerHTML = "";
  const conversation = currentConversation();
  if (!conversation || !(conversation.messages || []).length) {
    box.classList.add("hidden");
    return;
  }
  const agent = agentById(conversation.agentId);
  let label;
  if (agent) label = agentLabel(agent);
  else if (conversation.agentName) label = conversation.agentProvider ? conversation.agentProvider + " \u00B7 " + conversation.agentName : conversation.agentName;
  else label = agentsLoaded ? "Modèle inconnu" : "Chargement\u2026";

  const text = document.createElement("span");
  text.textContent = "Modèle de cette discussion : ";
  const strong = document.createElement("strong");
  strong.textContent = label;
  text.appendChild(strong);
  box.appendChild(text);

  const unavailable = agent ? !agent.available : agentsLoaded && !agentsError;
  if (unavailable) {
    const badge = document.createElement("span");
    badge.className = "model-badge";
    badge.textContent = "Indisponible";
    box.appendChild(badge);
  }
  if (conversation.agentId !== store.agentId) {
    const next = agentById(store.agentId);
    const note = document.createElement("div");
    note.className = "conversation-model-note";
    note.textContent = "Le prochain message utilisera " + (next ? agentLabel(next) : "le modèle choisi") + " et démarrera une nouvelle discussion côté serveur.";
    box.appendChild(note);
  }
  box.classList.remove("hidden");
}

function selectModel(id) {
  const agent = agentById(id);
  if (!agent || !agent.available) return;
  store.agentId = id;
  saveStore();
  closeMenus();
  renderModels();
}

function defaultAgentValid() {
  return store.defaultAgentId !== null && agents.some(a => a.id === store.defaultAgentId && a.available);
}

const AUTO_MODEL_MARK = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z"/><path d="M19 15l.8 2.2L22 18l-2.2.8L19 21l-.8-2.2L16 18l2.2-.8z"/></svg>';

function renderDefaultModelSelect() {
  const button = $("default-model-button");
  const menu = $("default-model-menu");
  if (!button || !menu) return;
  const valid = defaultAgentValid();
  const current = valid ? agentById(store.defaultAgentId) : null;

  const name = $("default-model-name");
  name.innerHTML = "";
  const title = document.createElement("span");
  title.className = "model-title";
  title.textContent = current ? agentLabel(current) : "Automatique";
  name.appendChild(title);
  $("default-model-logo").innerHTML = current ? providerMark(current) : AUTO_MODEL_MARK;
  button.title = current ? "Modèle par défaut : " + agentLabel(current) : "Modèle par défaut : automatique (dernier utilisé)";

  menu.innerHTML = "";
  const auto = document.createElement("button");
  auto.type = "button";
  auto.className = "model-option";
  auto.setAttribute("role", "option");
  auto.setAttribute("aria-selected", valid ? "false" : "true");
  auto.dataset.id = "";
  const autoLogo = document.createElement("span");
  autoLogo.className = "model-logo";
  autoLogo.setAttribute("aria-hidden", "true");
  autoLogo.innerHTML = AUTO_MODEL_MARK;
  const autoText = document.createElement("span");
  autoText.className = "model-option-text";
  const autoName = document.createElement("span");
  autoName.className = "model-option-name";
  autoName.textContent = "Automatique (dernier utilisé)";
  autoText.appendChild(autoName);
  auto.append(autoLogo, autoText);
  if (!valid) {
    const check = document.createElement("span");
    check.className = "model-check";
    check.setAttribute("aria-hidden", "true");
    check.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7"/></svg>';
    auto.appendChild(check);
  }
  menu.appendChild(auto);

  const groups = new Map();
  for (const agent of agents) {
    const key = agent.provider || "Autres modèles";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(agent);
  }
  for (const [provider, list] of groups) {
    const label = document.createElement("div");
    label.className = "menu-label";
    label.textContent = provider;
    menu.appendChild(label);
    for (const agent of list) menu.appendChild(modelOption(agent, valid ? store.defaultAgentId : null));
  }
}

function closeDefaultModelMenu() {
  const menu = $("default-model-menu");
  if (menu) menu.classList.add("hidden");
  const button = $("default-model-button");
  if (button) button.setAttribute("aria-expanded", "false");
}

function toggleDefaultModelMenu(event) {
  event.stopPropagation();
  closeReasoningMenu();
  closeSettingsImageModelMenu();
  const menu = $("default-model-menu");
  const opening = menu.classList.contains("hidden");
  closeDefaultModelMenu();
  if (!opening) return;
  renderDefaultModelSelect();
  menu.classList.remove("hidden");
  $("default-model-button").setAttribute("aria-expanded", "true");
  const selected = menu.querySelector(".model-option[aria-selected=\"true\"]");
  if (selected) selected.focus();
}

function setDefaultModel(value) {
  const id = value === "" ? null : Number(value);
  store.defaultAgentId = Number.isInteger(id) ? id : null;
  if (defaultAgentValid() && !currentConversation()) store.agentId = store.defaultAgentId;
  saveStore();
  renderModels();
}

function applyDefaultModel() {
  if (defaultAgentValid()) store.agentId = store.defaultAgentId;
}

const QUOTA_LABELS = {
  daily: "Messages du jour",
  day: "Messages du jour",
  hourly: "Messages de l'heure",
  hour: "Messages de l'heure",
  weekly: "Messages de la semaine",
  week: "Messages de la semaine"
};

function quotaLabel(limit) {
  const parts = [limit.type, limit.bucket].map(v => String(v || "")).filter(Boolean);
  for (const part of parts) {
    const key = part.toLowerCase();
    for (const [word, label] of Object.entries(QUOTA_LABELS)) if (key.includes(word)) return label + (parts.length > 1 && part !== parts[0] ? "" : "");
  }
  return parts.join(" \u00B7 ") || "Limite";
}

function formatReset(value) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const sameDay = date.toDateString() === new Date().toDateString();
  const time = date.toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" });
  return "Réinitialisation " + (sameDay ? "à " + time : "le " + date.toLocaleDateString("fr-FR", { day: "numeric", month: "short" }) + " à " + time);
}

function quotaRow(title, usedPercent, detail, reset) {
  const row = document.createElement("div");
  row.className = "quota-row";
  const head = document.createElement("div");
  head.className = "quota-row-head";
  const name = document.createElement("span");
  name.textContent = title;
  const value = document.createElement("strong");
  const pct = Math.max(0, Math.min(100, Number(usedPercent) || 0));
  value.textContent = Math.round(pct) + " %";
  head.append(name, value);
  const bar = document.createElement("div");
  bar.className = "quota-bar";
  const fill = document.createElement("span");
  fill.style.width = pct + "%";
  if (pct >= 90) fill.className = "danger";
  else if (pct >= 70) fill.className = "warn";
  bar.appendChild(fill);
  row.append(head, bar);
  const info = [detail, reset].filter(Boolean).join(" \u00B7 ");
  if (info) {
    const note = document.createElement("div");
    note.className = "quota-note";
    note.textContent = info;
    row.appendChild(note);
  }
  return row;
}

let quotaLoading = false;

async function loadQuota() {
  const box = $("quota-box");
  if (!box || quotaLoading) return;
  quotaLoading = true;
  box.innerHTML = '<div class="quota-note">Chargement\u2026</div>';
  try {
    const response = await apiFetch("/user/usage");
    if (!response.ok) throw new Error("HTTP " + response.status);
    const data = (await response.json()) || {};
    box.innerHTML = "";
    const budget = data.chatBudget;
    if (budget && typeof budget === "object") {
      box.appendChild(quotaRow("Utilisé", budget.usedPercent, Math.round(Number(budget.remainingPercent) || 0) + " % restant", formatReset(budget.resetAt)));
    }
    if (!box.children.length) box.innerHTML = '<div class="quota-note">Budget du jour non communiqué par le serveur.</div>';
  } catch (error) {
    box.innerHTML = "";
    const note = document.createElement("div");
    note.className = "quota-note";
    note.textContent = "Quota indisponible (" + (error && error.message ? error.message : String(error)) + ").";
    box.appendChild(note);
  } finally {
    quotaLoading = false;
  }
}

function toggleModelMenu(event) {
  event.stopPropagation();
  const menu = $("model-menu");
  const opening = menu.classList.contains("hidden");
  closeMenus();
  if (!opening) return;
  menu.classList.remove("hidden");
  $("model-button").setAttribute("aria-expanded", "true");
  const selected = menu.querySelector(".model-option[aria-selected=\"true\"]");
  if (selected) selected.focus();
}

