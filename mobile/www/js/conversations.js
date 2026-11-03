"use strict";

function currentConversation() {
  return store.conversations.find(c => c.id === currentId) || null;
}

function scrollToBottom() {
  const box = $("messages");
  box.scrollTop = box.scrollHeight;
}

function appendMessage(role, content, index, animate = true) {
  $("empty-state").classList.add("hidden");
  const row = document.createElement("div");
  row.className = "message " + role;
  if (animate) row.classList.add("message-enter");
  if (Number.isInteger(index)) row.dataset.index = String(index);
  const bubble = document.createElement("div");
  bubble.className = "bubble";
  if (role === "assistant") bubble.innerHTML = renderMarkdown(content);
  else bubble.textContent = content;
  row.appendChild(bubble);
  $("messages").appendChild(row);
  scrollToBottom();
  return bubble;
}

function copyText(text, button) {
  const done = ok => {
    if (!button) return;
    if (!button.dataset.label) button.dataset.label = button.innerHTML;
    const iconOnly = button.classList.contains("icon-only");
    button.innerHTML = ok ? '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7"/></svg>' + (iconOnly ? "" : "<span>Copié</span>") : iconOnly ? '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M12 7v6m0 3v1"/></svg>' : "<span>Échec</span>";
    clearTimeout(button.copyTimer);
    button.copyTimer = setTimeout(() => {
      button.innerHTML = button.dataset.label;
    }, 1500);
  };
  const fallback = () => {
    const area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand("copy");
    } catch {
      ok = false;
    }
    area.remove();
    done(ok);
  };
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(() => done(true), fallback);
  } else {
    fallback();
  }
}

function updateFeedbackButtons(row, message) {
  for (const button of row.querySelectorAll("[data-action=like], [data-action=dislike]")) {
    const active = message.feedback === (button.dataset.action === "like" ? "up" : "down");
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  }
}

function addMessageActions(row, message, index) {
  row.dataset.index = String(index);
  const old = row.querySelector(".message-actions");
  if (old) old.remove();
  const bar = document.createElement("div");
  bar.className = "message-actions";
  const make = (action, label, title) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "msg-action";
    button.dataset.action = action;
    button.innerHTML = label;
    button.title = title;
    button.setAttribute("aria-label", title);
    bar.appendChild(button);
    return button;
  };
  make("copy", icon("copy") + "<span>Copier</span>", "Copier la réponse");
  make("regenerate", icon("refresh") + "<span>Régénérer</span>", "Régénérer la réponse");
  make("like", icon("like"), "Bonne réponse");
  make("dislike", icon("dislike"), "Mauvaise réponse");
  row.appendChild(bar);
  updateFeedbackButtons(row, message);
}

function addErrorActions(row, index) {
  row.dataset.index = String(index);
  const old = row.querySelector(".message-actions");
  if (old) old.remove();
  const bar = document.createElement("div");
  bar.className = "message-actions error-actions";
  const retry = document.createElement("button");
  retry.type = "button";
  retry.className = "msg-action retry-action";
  retry.dataset.action = "retry";
  retry.innerHTML = icon("refresh") + "<span>Réessayer</span>";
  retry.title = "Renvoyer le dernier message";
  retry.setAttribute("aria-label", "Réessayer");
  bar.appendChild(retry);
  const edit = document.createElement("button");
  edit.type = "button";
  edit.className = "msg-action";
  edit.dataset.action = "edit-failed";
  edit.innerHTML = icon("edit") + "<span>Modifier le message</span>";
  edit.title = "Remettre le message dans la zone de saisie";
  edit.setAttribute("aria-label", "Modifier le message");
  bar.appendChild(edit);
  row.appendChild(bar);
}

function restoreFailedPrompt(conversation, index) {
  let userIndex = index - 1;
  while (userIndex >= 0 && conversation.messages[userIndex].role !== "user") userIndex--;
  if (userIndex < 0) return;
  const userMessage = conversation.messages[userIndex];
  const prompt = $("prompt");
  const files = userMessage.attachments || [];
  prompt.value = userMessage.prompt && !files.length ? userMessage.prompt : String(userMessage.content || "").replace(/\n*\u{1F4CE} [^\n]*$/u, "");
  pendingFiles = files.map(file => ({ ...file }));
  conversation.messages = conversation.messages.slice(0, userIndex);
  saveStore();
  renderMessages();
  renderHistory();
  renderAttachments();
  resizePrompt();
  updateSendButton();
  prompt.focus();
}

function addUserActions(row, index) {
  if (!row) return;
  row.dataset.index = String(index);
  const old = row.querySelector(".message-actions");
  if (old) old.remove();
  const bar = document.createElement("div");
  bar.className = "message-actions user-actions";
  const edit = document.createElement("button");
  edit.type = "button";
  edit.className = "msg-action icon-only";
  edit.dataset.action = "edit-sent";
  edit.innerHTML = icon("edit");
  edit.title = "Modifier ce message et relancer la réponse";
  edit.setAttribute("aria-label", "Modifier ce message");
  bar.appendChild(edit);
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "msg-action icon-only";
  copy.dataset.action = "copy";
  copy.innerHTML = icon("copy");
  copy.title = "Copier le texte";
  copy.setAttribute("aria-label", "Copier le texte du message");
  bar.appendChild(copy);
  row.appendChild(bar);
}

function buildContextRecap(messages) {
  const parts = [];
  for (const m of messages) {
    if (!m || (m.role !== "user" && m.role !== "assistant")) continue;
    let t = String(m.content || "").trim();
    if (!t) continue;
    if (t.length > 1500) t = t.slice(0, 1500) + "\u2026";
    parts.push((m.role === "user" ? "Utilisateur : " : "Assistant : ") + t);
  }
  const kept = [];
  let total = 0;
  for (let i = parts.length - 1; i >= 0; i--) {
    if (total + parts[i].length > 8000) break;
    total += parts[i].length;
    kept.unshift(parts[i]);
  }
  if (!kept.length) return "";
  return "[Contexte de la conversation avant la modification du message]\n" + kept.join("\n\n") + "\n\n[Nouveau message de l'utilisateur]\n";
}

function editSentMessage(conversation, index) {
  if (busy || !conversation) return;
  const userMessage = conversation.messages[index];
  if (!userMessage || userMessage.role !== "user") return;
  const prompt = $("prompt");
  const files = userMessage.attachments || [];
  const recap = buildContextRecap(conversation.messages.slice(0, index));
  prompt.value = String(userMessage.content || "");
  pendingFiles = files.map(file => ({ ...file }));
  conversation.messages = conversation.messages.slice(0, index);
  conversation.contextRecap = recap;
  conversation.chatId = null;
  conversation.updatedAt = Date.now();
  saveStore();
  renderMessages();
  renderHistory();
  renderAttachments();
  resizePrompt();
  updateSendButton();
  prompt.focus();
  showToast("Modifiez votre message puis renvoyez-le.");
}

function handleMessageClick(event) {
  if (typeof handleQuizClick === "function" && handleQuizClick(event)) return;
  const codeButton = event.target.closest(".code-copy");
  if (codeButton) {
    const block = codeButton.closest(".code-block");
    const code = block && block.querySelector("pre code");
    if (code) copyText(code.textContent, codeButton);
    return;
  }
  const fileCard = event.target.closest(".file-card");
  if (fileCard) {
    const index = fileCard.dataset.fileIndex;
    const wrap = /^\d+$/.test(index || "") ? fileCard.closest(".bubble")?.querySelector('.file-wrap[data-file-index="' + index + '"]') : fileCard.closest(".file-wrap");
    const cBlock = wrap && wrap.querySelector(".code-block");
    const cCode = cBlock && cBlock.querySelector("pre code");
    const cLang = cBlock && cBlock.querySelector(".code-lang");
    if (cCode) {
      if (!event.target.closest('.file-card-dl') && typeof previewGeneratedFile === 'function') previewGeneratedFile(cCode.textContent, cLang ? cLang.textContent : "", fileCard.dataset.name);
      else downloadCode(cCode.textContent, cLang ? cLang.textContent : "", cBlock, fileCard, fileCard.dataset.name);
    }
    return;
  }
  const dlButton = event.target.closest(".code-download");
  if (dlButton) {
    const dlBlock = dlButton.closest(".code-block");
    const dlCode = dlBlock && dlBlock.querySelector("pre code");
    const dlLang = dlBlock && dlBlock.querySelector(".code-lang");
    if (dlCode) downloadCode(dlCode.textContent, dlLang ? dlLang.textContent : "", dlBlock, dlButton);
    return;
  }
  const button = event.target.closest(".msg-action");
  if (!button) return;
  const row = button.closest(".message");
  const conversation = currentConversation();
  const index = Number(row && row.dataset.index);
  const message = conversation && conversation.messages[index];
  if (!message) return;
  const action = button.dataset.action;
  if (action === "copy") {
    copyText(message.content, button);
  } else if (action === "regenerate" || action === "retry") {
    regenerate(index);
  } else if (action === "edit-failed") {
    if (!busy) restoreFailedPrompt(conversation, index);
  } else if (action === "edit-sent") {
    if (!busy) editSentMessage(conversation, index);
  } else if (action === "like" || action === "dislike") {
    const value = action === "like" ? "up" : "down";
    message.feedback = message.feedback === value ? null : value;
    saveStore();
    updateFeedbackButtons(row, message);
  }
}

function renderMessageAttachments(bubble, attachments) {
  if (!bubble || !Array.isArray(attachments) || !attachments.length) return;
  const box = document.createElement("div");
  box.className = "message-attachments";
  for (const file of attachments) {
    const chip = document.createElement("div");
    chip.className = "attachment-chip";
    chip.title = file.name || "";
    chip.tabIndex = 0;
    chip.setAttribute('role', 'button');
    chip.setAttribute('aria-label', 'Aperçu de ' + (file.name || 'la pièce jointe'));
    chip.addEventListener('click', () => previewAttachment(file));
    chip.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); previewAttachment(file); } });
    chip.classList.add("file-pill");
    {
      const icon = document.createElement("span");
      icon.className = "attachment-icon";
      icon.innerHTML = fileIconSvg(file.name, file.kind);
      chip.appendChild(icon);
      const info = document.createElement("span");
      info.className = "attachment-info";
      const name = document.createElement("span");
      name.className = "attachment-name";
      name.textContent = file.name || "Fichier";
      info.appendChild(name);
      chip.appendChild(info);
    }
    box.appendChild(chip);
  }
  bubble.prepend(box);
  if (!bubble.textContent.trim() || bubble.childNodes.length === 1) bubble.classList.add("only-attachments");
  scrollToBottom();
}

function renderMessages() {
  if (typeof renderProjectContext === "function") renderProjectContext();
  const box = $("messages");
  for (const node of [...box.querySelectorAll(".message")]) node.remove();
  const conversation = currentConversation();
  const messages = conversation ? conversation.messages : [];
  $("empty-state").classList.toggle("hidden", messages.length > 0);
  messages.forEach((message, index) => {
    const bubble = appendMessage(message.role, message.content, index, false);
    if (message.role === "assistant" && Array.isArray(message.sources) && message.sources.length) {
      const box = document.createElement("div");
      box.className = "sources-container";
      box.innerHTML = sourcesHtml(message.sources, false);
      const block = box.querySelector(".sources-block");
      block.classList.remove("open");
      block.querySelector(".sources-pill").setAttribute("aria-expanded", "false");
      bubble.parentElement.insertBefore(box, bubble);
    }
    if (message.role === "assistant" && Array.isArray(message.images) && message.images.length) {
      renderGeneratedImages(bubble, message.images);
      if (!String(message.content || "").trim()) bubble.classList.add("image-only");
    }
    if (message.role === "assistant") addMessageActions(bubble.parentElement, message, index);
    if (message.role === "error") addErrorActions(bubble.parentElement, index);
    if (message.role === "user" && message.attachments) renderMessageAttachments(bubble, message.attachments);
    if (message.role === "user") addUserActions(bubble.parentElement, index);
  });
  renderConversationModel();
}

let historyQuery = "";
let menuConversationId = null;

function conversationMatches(conversation, query) {
  if (!query) return true;
  const parts = [conversation.title || ""];
  for (const message of conversation.messages || []) parts.push(String(message.content || ""));
  return parts.join("\n").toLowerCase().includes(query);
}

function historyGroup(conversation, now) {
  if (conversation.pinned) return "\u00C9pingl\u00E9es";
  const updated = conversation.updatedAt || 0;
  const day = 86400000;
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  if (updated >= today.getTime()) return "Aujourd'hui";
  if (updated >= today.getTime() - day) return "Hier";
  if (now - updated < 7 * day) return "7 derniers jours";
  if (now - updated < 30 * day) return "30 derniers jours";
  return "Plus ancien";
}

function renderHistory() {
  const nav = $("history");
  nav.innerHTML = "";
  const query = historyQuery.trim().toLowerCase();
  const sorted = store.conversations
    .filter(c => (c.projectId || null) === (typeof currentProject !== "undefined" && currentProject ? currentProject.id : null))
    .filter(c => conversationMatches(c, query))
    .sort((a, b) => (b.pinned === true) - (a.pinned === true) || (b.updatedAt || 0) - (a.updatedAt || 0));
  if (!sorted.length) {
    if (query) {
      const empty = document.createElement("div");
      empty.className = "history-empty";
      empty.textContent = "Aucune conversation trouv\u00E9e.";
      nav.appendChild(empty);
    }
    return;
  }

  const now = Date.now();
  let lastGroup = "";
  for (const conversation of sorted) {
    const group = historyGroup(conversation, now);
    if (group !== lastGroup) {
      const label = document.createElement("div");
      label.className = "history-label";
      label.textContent = group;
      nav.appendChild(label);
      lastGroup = group;
    }

    const item = document.createElement("div");
    item.className = "history-item" + (conversation.id === currentId ? " active" : "") + (conversation.id === menuConversationId ? " menu-open" : "");
    item.setAttribute("role", "button");
    item.tabIndex = 0;

    const title = document.createElement("span");
    title.className = "history-title";
    title.textContent = conversation.title || "Sans titre";
    if (conversation.pinned) {
      const pin = document.createElement("span");
      pin.className = "history-pin";
      pin.innerHTML = icon("pin", 14);
      title.prepend(pin);
    }
    title.title = conversation.title || "Sans titre";

    const more = document.createElement("button");
    more.type = "button";
    more.className = "history-more";
    more.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden="true"><circle cx="5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="19" cy="12" r="1.8"/></svg>';
    more.title = "Actions";
    more.setAttribute("aria-label", "Actions sur la conversation");
    more.setAttribute("aria-haspopup", "menu");
    more.addEventListener("click", event => {
      event.stopPropagation();
      openConversationMenu(conversation.id, more);
    });

    const convAgent = agentById(conversation.agentId) || (conversation.agentName || conversation.agentProvider ? {
      name: conversation.agentName || "Modèle",
      provider: providerLabel(conversation.agentProvider, conversation.agentName)
    } : null);
    {
      const mark = document.createElement("span");
      mark.className = "model-logo history-model";
      mark.setAttribute("aria-hidden", "true");
      mark.innerHTML = providerMark(convAgent);
      item.title = agentLabel(convAgent);
      item.append(mark);
    }
    item.append(title, more);
    item.addEventListener("click", () => openConversation(conversation.id));
    item.addEventListener("keydown", event => {
      if (event.target === item && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault();
        openConversation(conversation.id);
      }
    });
    nav.appendChild(item);
  }
}

function closeMenus() {
  $("study-menu")?.classList.add("hidden");
  $("toggle-study")?.setAttribute("aria-expanded", "false");
  $("conv-menu").classList.add("hidden");
  $("model-menu").classList.add("hidden");
  $("model-button").setAttribute("aria-expanded", "false");
  closeDefaultModelMenu();
  closeSettingsImageModelMenu();
  closeReasoningMenu();
  const attachMenu = $("attach-menu");
  if (attachMenu) attachMenu.classList.add("hidden");
  const attachButton = $("attach");
  if (attachButton) attachButton.setAttribute("aria-expanded", "false");
  if (menuConversationId !== null) {
    menuConversationId = null;
    for (const node of document.querySelectorAll(".history-item.menu-open")) node.classList.remove("menu-open");
  }
}

function openConversationMenu(id, anchor) {
  const menu = $("conv-menu");
  const wasOpen = menuConversationId === id && !menu.classList.contains("hidden");
  closeMenus();
  if (wasOpen) return;
  const conversation = store.conversations.find(c => c.id === id);
  if (!conversation) return;
  menuConversationId = id;
  const row = anchor.closest(".history-item");
  if (row) row.classList.add("menu-open");
  $("conv-pin").textContent = conversation.pinned ? "D\u00E9s\u00E9pingler" : "\u00C9pingler";
  menu.classList.remove("hidden");
  const rect = anchor.getBoundingClientRect();
  const width = menu.offsetWidth;
  const height = menu.offsetHeight;
  menu.style.left = Math.max(8, Math.min(rect.left, window.innerWidth - width - 8)) + "px";
  const below = rect.bottom + 4;
  menu.style.top = (below + height > window.innerHeight - 8 ? Math.max(8, rect.top - height - 4) : below) + "px";
}

async function syncConversation(conversation, method, suffix, body) {
  if (!conversation || !conversation.chatId) return true;
  try {
    const response = await apiFetch("/chats/" + encodeURIComponent(conversation.chatId) + suffix, {
      method,
      body: body ? JSON.stringify(body) : undefined
    });
    return response.ok;
  } catch {
    return false;
  }
}

async function renameConversation(id) {
  const conversation = store.conversations.find(c => c.id === id);
  if (!conversation) return;
  const value = window.prompt("Nouveau nom de la conversation :", conversation.title || "");
  if (value === null) return;
  const title = value.trim().slice(0, 100);
  if (!title || title === conversation.title) return;
  conversation.title = title;
  saveStore();
  renderHistory();
  if (!(await syncConversation(conversation, "PATCH", "", { title }))) console.warn("Renommage non synchronis\u00E9 avec le serveur.");
}

async function togglePin(id) {
  const conversation = store.conversations.find(c => c.id === id);
  if (!conversation) return;
  conversation.pinned = !conversation.pinned;
  saveStore();
  renderHistory();
  if (!(await syncConversation(conversation, conversation.pinned ? "PUT" : "DELETE", "/pins"))) console.warn("\u00C9pinglage non synchronis\u00E9 avec le serveur.");
}

// ===== Synchronisation des conversations avec le serveur (entre appareils) =====
let serverSyncRunning = false;

function serverTime(value) {
  const time = Date.parse(value || "");
  return Number.isFinite(time) ? time : 0;
}

async function syncConversationsFromServer() {
  if (serverSyncRunning || !store.session) return;
  serverSyncRunning = true;
  try {
    const response = await apiFetch("/chats?limit=100&sortedBy=lastMessageAt");
    if (!response.ok) return;
    const data = await response.json().catch(() => null);
    const chats = data && Array.isArray(data.chats) ? data.chats : [];
    let changed = false;
    for (const chat of chats) {
      if (!chat || !chat.id) continue;
      const updatedAt = serverTime(chat.lastMessageAt) || serverTime(chat.createdAt) || Date.now();
      let conversation = store.conversations.find(c => c.chatId === chat.id);
      if (!conversation) {
        conversation = {
   id: makeId(),
   chatId: chat.id,
   projectId: chat.projectId || null,
   title: String(chat.title || "Sans titre"),
   agentId: chat.agent && Number.isInteger(Number(chat.agent.id)) ? Number(chat.agent.id) : store.agentId,
   messages: [],
   updatedAt,
   pinned: chat.isPinned === true,
   needsLoad: true
        };
        store.conversations.push(conversation);
        changed = true;
 continue;
      }
      const serverAgentId = chat.agent ? Number(chat.agent.id) : NaN;
      if ((chat.projectId || null) !== (conversation.projectId || null)) { conversation.projectId = chat.projectId || null; changed = true; }
      if (Number.isInteger(serverAgentId) && serverAgentId !== conversation.agentId) { conversation.agentId = serverAgentId; changed = true; }
      if (chat.title && chat.title !== conversation.title) { conversation.title = String(chat.title); changed = true; }
      if (typeof chat.isPinned === "boolean" && chat.isPinned !== conversation.pinned) { conversation.pinned = chat.isPinned; changed = true; }
      if (updatedAt > (conversation.updatedAt || 0) + 1000 && conversation !== activeConversation && !conversation.pendingResponse) {
 conversation.updatedAt = updatedAt;
        conversation.needsLoad = true;
 changed = true;
      }
    }
    if (changed) {
      saveStore();
      renderHistory();
      const current = currentConversation();
      if (current && current.needsLoad && !busy) await loadConversationFromServer(current);
    }
  } catch (error) {
    console.warn("Synchronisation des conversations impossible :", error && error.message);
  } finally {
    serverSyncRunning = false;
  }
}

async function loadConversationFromServer(conversation) {
  if (!conversation || !conversation.chatId) return false;
  try {
    const response = await apiFetch("/chats/" + encodeURIComponent(conversation.chatId));
    if (!response.ok) return false;
    const detail = await response.json().catch(() => null);
    const list = detail && Array.isArray(detail.chatMessages) ? detail.chatMessages.slice() : [];
    list.sort((a, b) => serverTime(a.createdAt) - serverTime(b.createdAt));
    const messages = [];
    for (const item of list) {
      const role = String(item && item.role || "").toLowerCase();
      if (role !== "user" && role !== "assistant") continue;
      const entry = { role, content: typeof item.content === "string" ? item.content : "" };
      if (role === "assistant") {
        const found = [];
        collectSourceUrls({ parts: item.parts, webSearchDomains: item.webSearchDomains }, found, new Set());
        if (found.length) entry.sources = found;
        const pics = collectGeneratedImages(item)
   .map(img => img.id && item.id ? { id: img.id, messageId: item.id, chatId: conversation.chatId } : img.data ? { data: img.data } : img.url ? { url: img.url } : null)
   .filter(Boolean);
 if (pics.length) entry.images = pics;
      }
      messages.push(entry);
    }
    if (messages.length) {
      // On garde les pièces jointes locales des messages utilisateur déjà connus.
      const localUsers = conversation.messages.filter(m => m.role === "user");
      const localAssistants = conversation.messages.filter(m => m.role === "assistant");
      let userIndex = 0;
      let assistantIndex = 0;
      for (const message of messages) {
        if (message.role === "assistant") {
          // On garde aussi les sites consultés enregistrés localement.
          const localAnswer = localAssistants[assistantIndex++];
          if (localAnswer && Array.isArray(localAnswer.sources)) message.sources = localAnswer.sources;
          if (localAnswer && Array.isArray(localAnswer.images) && localAnswer.images.length && !message.images) message.images = localAnswer.images;
          continue;
        }
        const local = localUsers[userIndex++];
        if (local && local.attachments) message.attachments = local.attachments;
        if (local && local.prompt && local.prompt === message.content) message.content = local.content;
      }
      conversation.messages = messages;
    }
    if (detail && detail.title) conversation.title = String(detail.title);
    if (detail && Object.hasOwn(detail, "projectId")) conversation.projectId = detail.projectId || null;
    conversation.needsLoad = false;
    saveStore();
    if (currentId === conversation.id) renderMessages();
    renderHistory();
    return true;
  } catch (error) {
    console.warn("Chargement de la conversation impossible :", error && error.message);
    return false;
  }
}

async function openConversation(id) {
  if (busy) return;
  currentId = id;
  const conversation = currentConversation();
  if (conversation && agents.some(a => a.id === conversation.agentId && a.available)) {
    store.agentId = conversation.agentId;
    saveStore();
  }
  renderModels();
  renderMessages();
  renderHistory();
  closeSidebar();
  if (conversation && !conversation.pendingResponse && conversation.chatId && (conversation.needsLoad || !conversation.messages.length)) {
    await loadConversationFromServer(conversation);
  }
}

function newConversation() {
  if (busy) return;
  currentId = null;
  if (defaultAgentValid() && store.agentId !== store.defaultAgentId) {
    applyDefaultModel();
    saveStore();
    renderModels();
  }
  renderMessages();
  renderHistory();
  closeSidebar();
  $("prompt").focus();
}

async function deleteConversation(id) {
  if (busy) return;
  const conversation = store.conversations.find(c => c.id === id);
  if (!conversation) return;
  if (!confirm("Supprimer la conversation \u00AB " + (conversation.title || "Sans titre") + " \u00BB ?")) return;
  store.conversations = store.conversations.filter(c => c.id !== id);
  if (currentId === id) currentId = null;
  saveStore();
  renderMessages();
  renderHistory();
  if (!(await syncConversation(conversation, "DELETE", ""))) console.warn("Suppression non synchronis\u00E9e avec le serveur.");
}

const ICON_PATHS = {
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/>',
  refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4L21 8"/><path d="M21 3v5h-5"/>',
  like: '<path d="M7 10v11H4V10z"/><path d="M7 10l4-7a2 2 0 0 1 3 2l-1 4h6a2 2 0 0 1 2 2.3l-1.4 8A2 2 0 0 1 17.6 21H7"/>',
  dislike: '<path d="M17 14V3h3v11z"/><path d="M17 14l-4 7a2 2 0 0 1-3-2l1-4H5a2 2 0 0 1-2-2.3l1.4-8A2 2 0 0 1 6.4 3H17"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  pin: '<path d="M12 17v5"/><path d="M9 3h6l-1 63 3v2H7v-2l3-3z"/>',
  file: '<path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><path d="M14 3v6h6"/>'
};

function icon(name, size = 16) {
  return '<svg viewBox="0 0 24 24" width="' + size + '" height="' + size + '" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + (ICON_PATHS[name] || "") + '</svg>';
}

function initials(text) {
  const words = String(text || "").trim().split(/[\s@._-]+/).filter(Boolean);
  if (!words.length) return "FS";
  return (words[0][0] + (words[1] ? words[1][0] : "")).toUpperCase();
}

function renderProfile() {
  const profile = store.profile || {};
  const name = profile.name || profile.email || "Mon compte";
  const userName = document.querySelector("#user-button .user-name");
  if (userName) userName.textContent = name;
  $("profile-name").textContent = name;
  $("profile-email").textContent = profile.email || "";
  const avatar = store.avatar || profile.avatar || "image.png";
  const profileAvatar = $("profile-avatar");
  if (profileAvatar) profileAvatar.src = avatar;
  const userAvatar = document.querySelector("#user-button .avatar-img");
  if (userAvatar) userAvatar.src = avatar;
  const remove = $("avatar-remove");
  if (remove) remove.hidden = !store.avatar;
}

async function loadProfile() {
  let loaded = false;
  try {
    const response = await apiFetch("/user/me");
    if (!response.ok) return;
    const data = await response.json();
    if (!data || typeof data !== "object") return;
    store.profile = { name: String(data.name || ""), email: String(data.email || "") };
    saveStore();
    loaded = true;
  } catch {
  }
  renderProfile();
  return loaded;
}

function applyTheme() {
  const choice = ["light", "dark"].includes(store.theme) ? store.theme : "system";
  if (choice === "system") document.documentElement.removeAttribute("data-theme");
  else document.documentElement.setAttribute("data-theme", choice);
  for (const button of document.querySelectorAll("[data-theme-choice]")) {
    button.setAttribute("aria-checked", button.dataset.themeChoice === choice ? "true" : "false");
  }
}

function toggleSettingsMenu(event) {
  if (event) event.stopPropagation();
  if (settingsOpen()) closeSettings();
  else openSettings();
}

