"use strict";

let currentProject = null;
let accountProjects = [];
let projectsLoading = false;
let projectSaving = false;
let editingProjectId = null;

function projectRoute(id) { return "/projects/" + encodeURIComponent(id); }

function projectRelativeDate(value, now = Date.now()) {
  const date = Date.parse(value);
  if (!Number.isFinite(date)) return "";
  const seconds = Math.max(0, Math.floor((now - date) / 1000));
  if (seconds < 60) return "À l’instant";
  const format = new Intl.RelativeTimeFormat("fr-FR", { numeric: "always" });
  if (seconds < 3600) return format.format(-Math.floor(seconds / 60), "minute");
  if (seconds < 86400) return format.format(-Math.floor(seconds / 3600), "hour");
  if (seconds < 86400 * 30) return format.format(-Math.floor(seconds / 86400), "day");
  return settingsDate(value);
}

function projectAvatarMarkup(id) {
  let seed = 2166136261;
  for (const char of String(id)) seed = Math.imul(seed ^ char.charCodeAt(0), 16777619) >>> 0;
  const hue = seed % 360;
  let blocks = "";
  for (let row = 0; row < 5; row++) {
    for (let column = 0; column < 3; column++) {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      if (!(seed & 0x10000)) continue;
      for (const x of column === 2 ? [2] : [column, 4 - column]) blocks += '<rect x="' + (3 + x * 6) + '" y="' + (3 + row * 6) + '" width="6" height="6" rx="1"/>';
    }
  }
  return '<svg viewBox="0 0 36 36" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><rect width="36" height="36" rx="6" fill="#f4f4f5"/><g fill="hsl(' + hue + ' 52% 59%)">' + blocks + '</g></svg>';
}

function matchingProjects(projects, query, sort) {
  const normalize = value => String(value || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("fr-FR");
  const search = normalize(query).trim();
  return projects.filter(project => normalize(project.name).includes(search)).slice().sort(sort === "name"
    ? (a, b) => String(a.name).localeCompare(String(b.name), "fr-FR")
    : (a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0));
}

function renderProjects() {
  const list = $("projects-list");
  list.replaceChildren();
  const projects = matchingProjects(accountProjects, $("project-search").value, $("project-sort").value);
  if (!projects.length) {
    const empty = settingsEl("div", "projects-empty");
    empty.append(settingsEl("div", "project-empty-icon", "⊞"), settingsEl("h3", "", accountProjects.length ? "Aucun projet trouvé" : "Vous souhaitez démarrer un projet ?"), settingsEl("p", "settings-hint", "Définissez des instructions personnalisées et organisez vos conversations dans un seul espace."));
    empty.append(settingsButton("+ Nouveau projet", "", () => openProjectEditor(null)));
    list.append(empty);
    return;
  }
  for (const project of projects) {
    const card = settingsEl("article", "project-card");
    const open = settingsButton(project.name || "Projet", "project-card-open", () => {
      settingsBusy(open, "Ouverture…", () => openProject(project.id)).catch(err => { $("projects-status").textContent = "Ouverture impossible : " + err.message; });
    });
    const mark = settingsEl("span", "project-avatar");
    mark.innerHTML = projectAvatarMarkup(project.id);
    mark.setAttribute("aria-hidden", "true");
    const info = settingsEl("div", "project-card-info");
    const date = settingsEl("small", "settings-hint", projectRelativeDate(project.updatedAt || project.createdAt));
    date.title = settingsDate(project.updatedAt || project.createdAt);
    info.append(open, date);
    card.append(mark, info);
    list.append(card);
  }
}

async function loadProjects() {
  if (projectsLoading) return;
  projectsLoading = true;
  const session = store.session;
  $("projects-status").textContent = "Chargement des projets…";
  $("projects-retry").hidden = true;
  $("projects-list").replaceChildren();
  try {
    const data = await settingsApi("/projects");
    if (store.session !== session) return;
    accountProjects = settingsItems(data, "projects").filter(project => project && project.id);
    $("projects-status").textContent = "";
    renderProjects();
  } catch (err) {
    $("projects-status").textContent = "Impossible de charger les projets : " + err.message;
    $("projects-retry").hidden = false;
  } finally { projectsLoading = false; }
}

function mergeProjectChats(projectId, chats) {
  for (const chat of chats) {
    if (!chat || !chat.id) continue;
    let conversation = store.conversations.find(item => item.chatId === chat.id);
    if (!conversation) {
      conversation = { id: makeId(), chatId: chat.id, messages: [], needsLoad: true };
      store.conversations.push(conversation);
    }
    const updated = serverTime(chat.lastMessageAt) || serverTime(chat.createdAt);
    if (updated > (conversation.updatedAt || 0)) conversation.needsLoad = true;
    Object.assign(conversation, { projectId, title: chat.title || "Sans titre", pinned: chat.isPinned === true, updatedAt: updated || conversation.updatedAt || Date.now(), agentId: chat.agent && Number.isInteger(Number(chat.agent.id)) ? Number(chat.agent.id) : conversation.agentId || store.agentId });
    if (chat.agent) {
      conversation.agentName = chat.agent.name;
      conversation.agentProvider = providerLabel(chat.agent.modelProvider, chat.agent.name);
    }
  }
}

async function openProject(id) {
  if (busy) throw new Error("Attends la fin de la réponse en cours.");
  const session = store.session;
  const project = await settingsApi(projectRoute(id));
  if (!project || !project.id) throw new Error("Projet introuvable.");
  let cursor = "";
  const seen = new Set();
  const chats = [];
  do {
    const page = await settingsApi(projectRoute(id) + "/chats?limit=100" + (cursor ? "&cursor_chat_id=" + encodeURIComponent(cursor) : ""));
    const items = settingsItems(page, "chats");
    chats.push(...items);
    const next = page?.hasMore && items.length ? items[items.length - 1].id : "";
    if (!next || seen.has(next)) break;
    seen.add(next);
    cursor = next;
  } while (cursor);
  if (session !== store.session) return;
  mergeProjectChats(id, chats);
  currentProject = project;
  saveStore();
  $("projects-window").close();
  $("project-editor").close();
  newConversation();
  renderProjectContext();
}

function renderProjectContext() {
  const context = $("project-context");
  if (!context) return;
  context.hidden = !currentProject;
  $("app").classList.toggle("project-active", Boolean(currentProject));
  $("project-context-name").textContent = currentProject?.name || "";
  const empty = $("empty-state");
  empty.querySelector("h2").textContent = currentProject?.name || "Comment puis-je t'aider ?";
  empty.querySelector(".empty-help").textContent = currentProject?.customInstructions || (currentProject ? "Commence une nouvelle discussion dans ce projet." : "Pose une question, demande une explication ou fais relire un texte.");
}

function openProjectEditor(project) {
  editingProjectId = project?.id || null;
  $("project-editor").classList.toggle("is-editing", Boolean(project));
  $("project-settings-nav").hidden = !project;
  $("project-editor-title").textContent = project ? "Général" : "Créer un projet";
  $("project-name-label").textContent = project ? "Nom du projet" : "Sur quoi travaillez-vous ?";
  $("project-instructions-label").textContent = project ? "Instructions personnalisées" : "Qu’essayez-vous de faire ?";
  $("project-name").value = project?.name || "";
  $("project-instructions").value = project?.customInstructions || "";
  $("project-submit").textContent = project ? "Enregistrer" : "Créer le projet";
  $("project-delete").hidden = !project;
  $("project-submit").disabled = !$("project-name").value.trim();
  $("project-editor-status").textContent = "";
  $("project-editor").showModal();
  $("project-name").focus();
}

function projectFormBody(name, customInstructions) {
  name = String(name).trim();
  if (!name || name.length > 50) throw new Error("Indique un nom de 1 à 50 caractères.");
  if (customInstructions.length > 10000) throw new Error("Les instructions sont limitées à 10 000 caractères.");
  return { name, customInstructions };
}

async function saveProject(event) {
  event.preventDefault();
  if (projectSaving) return;
  let body;
  try { body = projectFormBody($("project-name").value, $("project-instructions").value); }
  catch (err) { $("project-editor-status").textContent = err.message; return; }
  const id = editingProjectId;
  projectSaving = true;
  $("project-fields").disabled = true;
  $("project-editor-status").textContent = "Enregistrement…";
  try {
    const saved = await settingsApi(id ? projectRoute(id) : "/projects", { method: id ? "PATCH" : "POST", body: JSON.stringify(body) });
    if (!saved?.id && !id) throw new Error("Le serveur n’a pas renvoyé le projet créé.");
    const project = { ...body, ...saved, id: saved?.id || id };
    accountProjects = accountProjects.filter(item => item.id !== project.id).concat(project);
    if (id) {
      if (currentProject?.id === id) currentProject = { ...currentProject, ...project };
      $("project-editor").close();
      renderProjectContext();
      renderProjects();
    } else {
      // La création est déjà confirmée : ouvrir le projet ne crée pas une seconde fois en cas d'erreur réseau.
      $("project-editor").close();
      currentProject = project;
      $("projects-window").close();
      newConversation();
      renderProjectContext();
    }
  } catch (err) { $("project-editor-status").textContent = "Enregistrement impossible : " + err.message; }
  finally { projectSaving = false; $("project-fields").disabled = false; }
}

async function deleteProject() {
  const id = editingProjectId;
  if (!id || projectSaving || !window.confirm("Supprimer définitivement ce projet ?")) return;
  projectSaving = true;
  $("project-fields").disabled = true;
  try {
    await settingsApi(projectRoute(id), { method: "DELETE" });
    accountProjects = accountProjects.filter(project => project.id !== id);
    store.conversations = store.conversations.filter(conversation => conversation.projectId !== id);
    saveStore();
    $("project-editor").close();
    if (currentProject?.id === id) leaveProject();
    renderProjects();
  } catch (err) { $("project-editor-status").textContent = "Suppression impossible : " + err.message; }
  finally { projectSaving = false; $("project-fields").disabled = false; }
}

function leaveProject() {
  if (busy) return;
  currentProject = null;
  newConversation();
  renderProjectContext();
}

function closeProjectSort() {
  $("project-sort-menu").classList.add("hidden");
  $("project-sort").setAttribute("aria-expanded", "false");
}

function toggleProjectSort(event) {
  event.stopPropagation();
  const menu = $("project-sort-menu");
  const opening = menu.classList.contains("hidden");
  closeProjectSort();
  if (!opening) return;
  menu.classList.remove("hidden");
  $("project-sort").setAttribute("aria-expanded", "true");
  menu.querySelector('[aria-selected="true"]')?.focus();
}

function setupProjects() {
  $("project-sort").title = "Trier les projets : Les plus récents";
  $("project-sort").setAttribute("aria-label", "Trier les projets : Les plus récents");
  $("project-settings-nav").appendChild($("project-delete"));
  $("projects-open").addEventListener("click", () => {
    if (busy) return showToast("Attends la fin de la réponse en cours.");
    closeMenus(); closeSidebar();
    $("projects-window").showModal();
    loadProjects();
  });
  $("projects-close").addEventListener("click", () => $("projects-window").close());
  $("projects-retry").addEventListener("click", loadProjects);
  $("project-search").addEventListener("input", renderProjects);
  $("project-search-toggle").addEventListener("click", () => {
    const search = $("project-search");
    search.hidden = !search.hidden;
    $("project-search-toggle").setAttribute("aria-expanded", String(!search.hidden));
    if (!search.hidden) search.focus();
    else { search.value = ""; renderProjects(); }
  });
  $("project-search").addEventListener("keydown", event => {
    if (event.key !== "Escape") return;
    event.preventDefault(); event.stopPropagation();
    $("project-search").value = "";
    $("project-search").hidden = true;
    $("project-search-toggle").setAttribute("aria-expanded", "false");
    $("project-search-toggle").focus(); renderProjects();
  });
  $("project-sort").addEventListener("click", toggleProjectSort);
  $("project-sort-menu").addEventListener("click", event => {
    event.stopPropagation();
    const option = event.target.closest("[data-sort]");
    if (!option) return;
    $("project-sort").value = option.dataset.sort;
    $("project-sort-label").textContent = option.textContent;
    $("project-sort").setAttribute("aria-label", "Trier les projets : " + option.textContent);
    $("project-sort").title = "Trier les projets : " + option.textContent;
    for (const item of $("project-sort-menu").querySelectorAll("[data-sort]")) item.setAttribute("aria-selected", String(item === option));
    closeProjectSort();
    renderProjects();
    $("project-sort").focus();
  });
  $("project-sort-menu").addEventListener("keydown", event => {
    if (event.key === "Escape") {
      event.preventDefault(); event.stopPropagation();
      closeProjectSort(); $("project-sort").focus(); return;
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const options = [...$("project-sort-menu").querySelectorAll("[data-sort]")];
    const index = options.indexOf(document.activeElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length;
    options[next]?.focus();
  });
  document.addEventListener("click", event => { if (!event.target.closest(".project-sort-field")) closeProjectSort(); });
  $("projects-window").addEventListener("close", closeProjectSort);
  $("projects-window").addEventListener("cancel", event => {
    if (!$("project-sort-menu").classList.contains("hidden")) { event.preventDefault(); closeProjectSort(); $("project-sort").focus(); }
  });
  $("project-new").addEventListener("click", () => openProjectEditor(null));
  $("project-settings-open").addEventListener("click", () => { if (!busy && currentProject) openProjectEditor(currentProject); });
  $("project-leave").addEventListener("click", leaveProject);
  $("project-name").addEventListener("input", () => { $("project-submit").disabled = !$("project-name").value.trim(); });
  $("project-form").addEventListener("submit", saveProject);
  $("project-delete").addEventListener("click", deleteProject);
  const close = () => { if (!projectSaving) $("project-editor").close(); };
  $("project-editor-close").addEventListener("click", close);
  $("project-cancel").addEventListener("click", close);
  $("project-editor").addEventListener("cancel", event => { event.preventDefault(); close(); });
  $("logout").addEventListener("click", () => { currentProject = null; currentId = null; accountProjects = []; renderProjectContext(); });
}
