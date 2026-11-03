"use strict";

// Session bearers stay in memory; optional durable credentials use IDELinkVault.
// Closing the panel pauses polling without submitting another task to the model.
let franceIDESession = null;
const FRANCE_IDE_PRESETS = { code: ["files", "terminal", "skills"], explore: ["web", "skills"] };
function franceIDEIcon(name) {
  const paths = { close: '<path d="m6 6 12 12M6 18 18 6"/>', add: '<path d="M12 5v14M5 12h14"/>', send: '<path d="M12 19V5m-6 6 6-6 6 6"/>', computer: '<rect x="3" y="4" width="18" height="13" rx="2"/><path d="M8 21h8m-4-4v4"/>', stop: '<rect x="7" y="7" width="10" height="10" rx="1"/>' };
  return `<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] || paths.computer}</svg>`;
}
function ideLinkAddress(value) {
  const url = new URL(value.trim());
  const publicHost = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/i.test(url.hostname) && !/(?:\.(?:localhost|local|localdomain|internal|lan|home|invalid|test)$|\.trycloudflare\.com\.)/i.test(url.hostname);
  if (url.protocol !== "https:" || !publicHost || url.port || url.username || url.password || url.search || url.pathname !== "/") throw new Error("Utilise le QR code ou l’adresse HTTPS IDE Link affichée sur ton ordinateur.");
  const fragment = new URLSearchParams(url.hash.slice(1));
  const ticket = fragment.get("ide-link");
  if (url.hash && (!ticket || !/^[A-Za-z0-9_-]{43}$/.test(ticket) || [...fragment.keys()].some(key => key !== "ide-link"))) throw new Error("QR code IDE Link invalide.");
  return { origin: url.origin, ticket };
}
async function franceIDECall(session, route, data = {}) {
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${session.token || ""}` };
  const nativeHTTP = window.Capacitor?.Plugins?.CapacitorHttp;
  let status, result;
  if (nativeHTTP?.request && window.Capacitor?.isNativePlatform?.()) {
    const response = await nativeHTTP.request({ url: session.origin + route, method: "POST", headers: { ...headers, Origin: "capacitor://localhost" }, data, connectTimeout: 10000, readTimeout: 15000, disableRedirects: true });
    status = response.status;
    result = typeof response.data === "string" ? JSON.parse(response.data) : response.data;
  } else {
    const response = await fetch(session.origin + route, { method: "POST", headers, body: JSON.stringify(data), cache: "no-store", credentials: "omit", redirect: "error", signal: AbortSignal.timeout(15000) });
    status = response.status; result = await response.json();
  }
  if (status < 200 || status >= 300) { const error = new Error(result?.error || "Connexion à l’ordinateur impossible."); error.status = status; throw error; }
  return result;
}
async function scanFranceIDEAddress() {
  const scanner = window.Capacitor?.Plugins?.QRScanner;
  if (!scanner?.scan) throw new Error("Le scan QR nécessite l’app mobile. Tu peux aussi coller le lien d’association.");
  const result = await scanner.scan();
  if (result.cancelled) return null;
  ideLinkAddress(result.value || "");
  return result.value;
}
function openFranceIDE() {
  closeSidebar();
  document.getElementById("france-ide")?.close();
  const dialog = document.createElement("dialog");
  dialog.id = "france-ide"; dialog.className = "file-library france-ide ide-control";
  dialog.setAttribute("aria-labelledby", "ide-control-title");
  dialog.innerHTML = `<header><span class="ide-computer-icon">${franceIDEIcon("computer")}</span><div class="ide-heading"><h2 id="ide-control-title">France IDE</h2><small data-project>Ton espace de travail, à distance</small></div><button type="button" data-close class="ide-icon-button" aria-label="Fermer">${franceIDEIcon("close")}</button></header>
    <section data-connect><div data-remembered hidden class="ide-remembered-card"><strong>Ordinateur mémorisé</strong><p>Ouvre le même projet dans l’IDE. La reconnexion se fait automatiquement.</p><button type="button" data-reconnect>Retrouver mon ordinateur</button><button type="button" data-forget-local>Oublier cet ordinateur</button></div><div class="ide-connect-hero"><span class="ide-connect-symbol">${franceIDEIcon("computer")}</span><span class="ide-eyebrow">ORDINATEUR + IPHONE</span><h3>Continue là où tu en étais.</h3><p>Retrouve ton agent et ton projet. Envoie une idée, suis les étapes et garde la main sur chaque action.</p><button type="button" data-scan>Scanner le QR code</button><small>Sur l’ordinateur : ouvre ton projet → IDE Link → Activer.</small></div><details class="ide-manual"><summary>Utiliser un lien ou un PIN</summary><form data-pair><label>Lien d’association ou adresse<input type="url" required autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="https://…trycloudflare.com"></label><label>PIN, pour une adresse sans QR<input data-pin inputmode="numeric" pattern="[0-9]{6}" maxlength="6" autocomplete="off" placeholder="6 chiffres"></label><button type="submit">Connecter l’ordinateur</button></form></details></section>
    <section data-control hidden><div class="ide-navigation"><div role="tablist" aria-label="Vue de la tâche"><button type="button" role="tab" id="ide-tab-chat" aria-selected="true" aria-controls="ide-chat-panel" tabindex="0" data-tab="chat">Conversation</button><button type="button" role="tab" id="ide-tab-activity" aria-selected="false" aria-controls="ide-activity-panel" tabindex="-1" data-tab="activity">Activité <span data-activity-count>0</span></button></div><button type="button" data-disconnect class="ide-disconnect">Déconnecter</button></div><div data-scroll><details data-plan hidden><summary>Plan de travail</summary><ol></ol></details><div id="ide-chat-panel" role="tabpanel" aria-labelledby="ide-tab-chat" data-messages></div><div id="ide-activity-panel" role="tabpanel" aria-labelledby="ide-tab-activity" data-activity hidden></div></div><div data-pending></div><details data-queue><summary>File d’attente <span data-queue-count>0</span></summary><div></div></details><details data-tools hidden><summary>Outils <span data-tool-count></span></summary><div class="ide-presets" role="group" aria-label="Préréglages des outils"><button type="button" data-preset="code">Coder</button><button type="button" data-preset="explore">Explorer</button><button type="button" data-preset="all">Complet</button></div><div data-tool-options></div><p class="ide-tools-note">Lecture, recherche dans le projet, plan et questions restent disponibles. Le choix s’applique à la prochaine demande et conserve les autorisations de l’IDE.</p></details><form data-compose><div data-attachments></div><textarea aria-label="Consigne pour l’agent" placeholder="Que veux-tu construire ?" rows="2" maxlength="30000" required></textarea><div class="ide-composer-bar"><button type="button" data-attach class="ide-icon-button" aria-label="Joindre des fichiers">${franceIDEIcon("add")}</button><input type="file" multiple data-files hidden><select aria-label="Mode de la demande"><option value="agent">Agent</option><option value="plan">Plan · lecture seule</option></select><button type="button" data-open-tools aria-controls="ide-tools-options" aria-expanded="false">Outils</button><span class="ide-composer-spacer"></span><button type="button" data-interrupt class="ide-icon-button" aria-label="Arrêter la tâche" title="Arrêter la tâche">${franceIDEIcon("stop")}</button><button type="submit" class="ide-send ide-icon-button" aria-label="Envoyer à l’ordinateur" title="Envoyer à l’ordinateur">${franceIDEIcon("send")}</button></div></form></section><p data-status role="status" aria-live="polite"></p>`;
  document.body.append(dialog); dialog.showModal();
  setupFranceIDE(dialog);
}
function setupFranceIDE(dialog) {
  const find = selector => dialog.querySelector(selector), status = find("[data-status]");
  const connect = find("[data-connect]"), control = find("[data-control]");
  const pair = find("[data-pair]"), address = pair.querySelector('input[type="url"]');
  let closed = false, timer = null, polling = false, viewVersion = 0, revision = "", pendingSignature = "", queueSignature = "", planSignature = "", catalogSignature = "", idlePolls = 0, pollFailures = 0;
  let selectedGroups = [...FRANCE_IDE_PRESETS.code], availableGroups = [], selectedFiles = [];
  let reconnecting = false, reconnectAfter = 0, reconnectFailures = 0;
  const savedComputer = () => typeof franceIDERemembered === "undefined" ? null : franceIDERemembered;
  const display = text => { if (!closed) status.textContent = text; };
  function showSession() { connect.hidden = Boolean(franceIDESession); control.hidden = !franceIDESession; find("[data-remembered]").hidden = !savedComputer(); }
  function expire() {
    franceIDESession = null; viewVersion++; showSession();
    for (const selector of ["[data-messages]", "[data-activity]", "[data-pending]", "[data-queue] > div", "[data-plan] ol"]) { find(selector).replaceChildren(); delete find(selector)._ideEntries; }
    find("[data-project]").textContent = "Ton agent sur l’ordinateur";
    revision = pendingSignature = queueSignature = planSignature = "";
    find("[data-plan]").hidden = true;
  }
  async function action(route, payload) {
    if (closed) return false;
    const session = franceIDESession;
    if (!session) return false;
    try { await franceIDECall(session, route, payload); display("Action transmise à l’ordinateur."); revision = ""; idlePolls = 0; await refresh(); return true; }
    catch (error) { if (!closed && session === franceIDESession && [401, 429].includes(error.status)) expire(); display(error.message + (error.status ? "" : " Vérifie l’état dans l’IDE avant de renvoyer une action.")); return false; }
  }
  function node(tag, text, className) { const element = document.createElement(tag); element.textContent = text; if (className) element.className = className; return element; }
  function button(parent, text, run) { const element = node("button", text); element.type = "button"; element.onclick = async () => { element.disabled = true; try { await run(); } finally { element.disabled = false; } }; parent.append(element); return element; }
  function render(data) {
    find("[data-project]").textContent = data.session?.project || "Ordinateur connecté";
    const messages = find("[data-messages]"), scroll = find("[data-scroll]"), activity = find("[data-activity]");
    const entries = [...(data.history || []), ...(data.live ? [{ type: "assistant", text: data.live, streaming: true }] : [])];
    const follow = scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop < 70, previous = scroll.scrollTop;
    renderEntries(messages, entries.filter(entry => ["user", "assistant"].includes(entry.type)), false);
    const activityEntries = entries.filter(entry => !["user", "assistant"].includes(entry.type));
    renderEntries(activity, activityEntries, true);
    find("[data-activity-count]").textContent = activityEntries.length;
    if (!messages.children.length) messages.append(node("p", "Ton agent est prêt. Décris la prochaine étape.", "ide-empty"));
    scroll.scrollTop = follow ? scroll.scrollHeight : previous;
    renderTools(data.toolGroups);
    const planKey = JSON.stringify(data.plan);
    if (planKey !== planSignature) {
      const plan = find("[data-plan]"); plan.hidden = !data.plan?.steps?.length; plan.querySelector("ol").replaceChildren();
      for (const step of data.plan?.steps || []) plan.querySelector("ol").append(node("li", `${step.status === "completed" ? "✓" : step.status === "in_progress" ? "◉" : "○"} ${step.step}`));
      planSignature = planKey;
    }
    const pendingKey = JSON.stringify(data.pending);
    if (pendingKey !== pendingSignature) {
      const prompts = find("[data-pending]"); prompts.replaceChildren();
      for (const item of data.pending || []) {
        const form = document.createElement("form"); form.className = "ide-question";
        form.append(node("p", item.question || item.prefix || "Confirmation demandée"));
        if (item.question && item.prefix) form.append(node("pre", item.prefix));
        const answer = value => action("/api/prompt", { id: item.id, answer: value });
        if (["confirm", "command"].includes(item.kind)) {
          button(form, "Autoriser", () => answer("o")); button(form, "Refuser", () => answer("n"));
        } else {
          for (const option of item.options || []) {
            const label = document.createElement("label"), input = document.createElement("input");
            input.type = item.multiple ? "checkbox" : "radio"; input.name = "choice"; input.value = option.id;
            label.append(input, node("span", option.label + (option.description ? " — " + option.description : ""))); form.append(label);
          }
          const text = document.createElement("textarea"); text.maxLength = 4000; text.placeholder = item.placeholder || "Ta réponse"; text.setAttribute("aria-label", "Réponse à la question"); form.append(text);
          button(form, "Répondre", () => answer(item.kind === "ask" ? text.value : { selected: [...form.querySelectorAll("input:checked")].map(input => input.value), text: text.value }));
          if (item.kind === "question") button(form, "Passer", () => answer({ skipped: true }));
          form.onsubmit = event => event.preventDefault();
        }
        prompts.append(form);
      }
      pendingSignature = pendingKey;
    }
    const queueKey = JSON.stringify(data.queue);
    if (queueKey !== queueSignature) {
      const queue = find("[data-queue] > div"); queue.replaceChildren();
      button(queue, data.queue.enabled ? "Suspendre la file" : "Reprendre la file", () => action("/api/queue", { action: data.queue.enabled ? "pause" : "start" }));
      for (const task of data.queue.tasks || []) {
        const row = node("div", "", "ide-queue-task"); row.append(node("p", `${task.status} · ${task.prompt}`));
        if (task.status === "pending") {
          button(row, "Retirer", () => action("/api/queue", { action: "remove", id: task.id }));
          if (data.queue.canSteer) button(row, "Orienter", () => action("/api/queue", { action: "steer", id: task.id }));
        }
        if (task.status === "failed" || task.status === "interrupted") button(row, "Réessayer", () => action("/api/queue", { action: "retry", id: task.id }));
        queue.append(row);
      }
      queueSignature = queueKey;
      find("[data-queue-count]").textContent = (data.queue.tasks || []).filter(task => ["pending", "running", "steering"].includes(task.status)).length;
    }
    find("[data-interrupt]").disabled = !data.queue.busy && !data.queue.canSteer && !(data.queue.tasks || []).some(task => task.status === "running") && !data.live;
  }
  function renderEntries(container, entries, technical) {
    const previous = container._ideEntries || [], signatures = entries.map(entry => JSON.stringify(entry));
    if (!previous.length) container.replaceChildren();
    let start = 0;
    while (start < signatures.length && signatures[start] === previous[start]) start++;
    // Preserve every unchanged message node, selection and expanded tool detail.
    while (container.children.length > start) container.lastElementChild.remove();
    const fragment = document.createDocumentFragment();
    for (let i = start; i < entries.length; i++) {
      const entry = entries[i], text = entry.text || (entry.lines || []).join("\n") || entry.arg || "";
      const article = document.createElement(technical ? "details" : "article"); article.className = "ide-entry ide-entry-" + entry.type;
      article.append(node(technical ? "summary" : "strong", technical ? entry.name || ({ result: "Résultat", reason: "Réflexion", info: "Information", warn: "À vérifier", error: "Erreur", print: "Sortie" }[entry.type] || "Activité") : entry.type === "user" ? "Vous" : entry.streaming ? "Agent · en cours" : "Agent"));
      const content = node("div", "", "ide-message-content");
      if (!technical && entry.type === "assistant" && text.length < 64000 && typeof renderMarkdown === "function") content.innerHTML = renderMarkdown(text, entry.streaming === true);
      else content.append(node("pre", text));
      article.append(content); fragment.append(article);
    }
    container.append(fragment); container._ideEntries = signatures;
  }
  function updateToolLabels() {
    const count = selectedGroups.length;
    find("[data-tool-count]").textContent = `${count} groupes`;
    find("[data-open-tools]").textContent = `Outils · ${count}`;
    for (const input of find("[data-tool-options]").querySelectorAll("input")) input.checked = selectedGroups.includes(input.value);
    for (const preset of dialog.querySelectorAll("[data-preset]")) {
      const ids = preset.dataset.preset === "all" ? availableGroups.map(group => group.id) : FRANCE_IDE_PRESETS[preset.dataset.preset];
      preset.setAttribute("aria-pressed", String(ids.length === count && ids.every(id => selectedGroups.includes(id))));
    }
  }
  function renderTools(groups) {
    const signature = JSON.stringify(groups || []);
    if (catalogSignature === signature) return;
    catalogSignature = signature; availableGroups = Array.isArray(groups) ? groups : [];
    find("[data-open-tools]").hidden = !availableGroups.length;
    if (!availableGroups.length) { find("[data-tools]").hidden = true; return; }
    selectedGroups = selectedGroups.filter(id => availableGroups.some(group => group.id === id));
    const options = find("[data-tool-options]"); options.replaceChildren();
    for (const group of availableGroups) {
      const label = document.createElement("label"), input = document.createElement("input"), description = node("span", "");
      input.type = "checkbox"; input.value = group.id;
      description.append(node("strong", group.label), node("small", group.description));
      input.onchange = () => { selectedGroups = availableGroups.filter(item => item.id === group.id ? input.checked : selectedGroups.includes(item.id)).map(item => item.id); updateToolLabels(); };
      label.append(input, description); options.append(label);
    }
    updateToolLabels();
  }
  async function refresh() {
    if (closed || polling || document.hidden) return;
    if (!franceIDESession) { await reconnect(); if (!franceIDESession || closed) return; }
    const session = franceIDESession, version = viewVersion; polling = true;
    try {
      const data = await franceIDECall(session, "/api/state" + (revision ? "?since=" + encodeURIComponent(revision) : ""));
      if (!closed && version === viewVersion && session === franceIDESession) { pollFailures = 0; revision = data.revision || ""; if (!data.unchanged) { render(data); idlePolls = 0; } else idlePolls++; display(session.rememberWarning || "Connecté à l’ordinateur · conversation en direct"); }
    } catch (error) {
      if (!closed && version === viewVersion && session === franceIDESession) { pollFailures = Math.min(pollFailures + 1, 4); if (session.remembered || [401, 409, 429].includes(error.status)) expire(); display(error.message); }
    } finally { polling = false; }
  }
  async function tick() { timer = null; await refresh(); if (!closed && (franceIDESession || savedComputer())) timer = setTimeout(tick, !franceIDESession ? 15000 : pollFailures ? Math.min(15000, 1500 * 2 ** pollFailures) : idlePolls > 4 ? 5000 : 1500); }
  async function reconnect() {
    if (closed || reconnecting || franceIDESession || !savedComputer() || Date.now() < reconnectAfter) return;
    const version = viewVersion; reconnecting = true; display("Recherche de ton ordinateur…");
    try {
      const session = await resumeRememberedLink(savedComputer(), { canceled: () => closed || version !== viewVersion });
      if (!closed && version === viewVersion) { franceIDESession = session; revision = ""; reconnectFailures = 0; showSession(); }
    } catch (error) {
      if (!closed && version === viewVersion) {
        reconnectFailures = Math.min(reconnectFailures + 1, 5); reconnectAfter = Date.now() + Math.min(300000, 15000 * 2 ** reconnectFailures);
        if (error.revoked) await forgetRememberedLink();
        if (closed || version !== viewVersion) return;
        display(error.message); showSession();
      }
    } finally { reconnecting = false; }
  }
  async function associate(value) {
    if (closed) return;
    const version = ++viewVersion;
    const parsed = ideLinkAddress(value), session = { origin: parsed.origin, token: "" };
    const credentials = parsed.ticket ? { ticket: parsed.ticket } : { pin: find("[data-pin]").value };
    if (!parsed.ticket && !/^[0-9]{6}$/.test(credentials.pin)) throw new Error("Saisis le PIN à six chiffres affiché dans l’IDE.");
    const canRemember = typeof ideLinkVault === "function" && Boolean(ideLinkVault()?.save) && Boolean(globalThis.crypto?.subtle);
    const result = await franceIDECall(session, "/api/pair", { ...credentials, remember: canRemember, deviceName: /iPhone|iPad/.test(navigator.userAgent) ? "iPhone / iPad" : "App FranceStudent" });
    if (closed || version !== viewVersion) return;
    let remembered = false, rememberFailure = "";
    if (result.remembered && canRemember) { try { await saveRememberedLink(result.remembered, { guard: () => !closed && version === viewVersion }); remembered = true; } catch (error) { rememberFailure = error.message; } }
    else if (typeof forgetRememberedLink === "function") { try { await forgetRememberedLink(); } catch (error) { rememberFailure = error.message; } }
    if (closed || version !== viewVersion) return;
    franceIDESession = { ...session, token: result.token, remembered, rememberWarning: rememberFailure ? rememberFailure + " La connexion actuelle reste temporaire sur cet iPhone." : "" }; viewVersion++; revision = "";
    address.value = ""; find("[data-pin]").value = ""; showSession(); await refresh(); if (timer === null && !closed && franceIDESession) timer = setTimeout(tick, 1500);
    if (rememberFailure) display(rememberFailure + " La connexion actuelle reste temporaire sur cet iPhone.");
  }
  pair.onsubmit = async event => { event.preventDefault(); const submit = pair.querySelector('button[type="submit"]'); submit.disabled = true; try { await associate(address.value); } catch (error) { display(error.message); } finally { submit.disabled = false; } };
  find("[data-scan]").onclick = async event => {
    const scan = event.currentTarget; scan.disabled = true;
    try { const value = await scanFranceIDEAddress(); if (value && !closed) { const parsed = ideLinkAddress(value); if (parsed.ticket) await associate(value); else { address.value = parsed.origin; find(".ide-manual").open = true; find("[data-pin]").focus(); display("QR reconnu. Saisis le PIN affiché sur l’ordinateur."); } } }
    catch (error) { display(error.message); } finally { scan.disabled = false; }
  };
  find("[data-interrupt]").onclick = () => action("/api/queue", { action: "interrupt" });
  find("[data-disconnect]").onclick = async () => { if (await action("/api/disconnect")) { try { if (typeof forgetRememberedLink === "function") await forgetRememberedLink(); } catch (error) { display(error.message); } expire(); display("Appareil déconnecté. Son accès a été révoqué."); } };
  find("[data-reconnect]").onclick = async () => { reconnectAfter = 0; reconnectFailures = 0; await refresh(); if (timer === null && !closed && (franceIDESession || savedComputer())) timer = setTimeout(tick, 15000); };
  find("[data-forget-local]").onclick = async () => { try { await forgetRememberedLink(); expire(); display("Association retirée du coffre de cet iPhone."); } catch (error) { display(error.message); } };
  find("[data-compose]").onsubmit = async event => {
    event.preventDefault(); const form = event.currentTarget, submit = form.querySelector('button[type="submit"]'); submit.disabled = true;
    try {
      const files = [...selectedFiles], submittedPrompt = form.querySelector("textarea").value;
      if (files.length > 4 || files.reduce((sum, file) => sum + file.size, 0) > 2 * 1024 * 1024) throw new Error("Maximum 4 pièces jointes et 2 Mio au total.");
      const attachments = await Promise.all(files.map(file => new Promise((resolve, reject) => {
        const reader = new FileReader(); reader.onerror = () => reject(new Error("Lecture du fichier impossible."));
        reader.onload = () => { const mime = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/i.test(file.type) ? file.type : "application/octet-stream"; resolve({ name: file.name, kind: mime.startsWith("image/") ? "image" : "file", data: `data:${mime};base64,${String(reader.result).split(",")[1]}` }); }; reader.readAsDataURL(file);
      })));
      if (await action("/api/tasks", { prompt: submittedPrompt, mode: form.querySelector("select").value, attachments, ...(availableGroups.length ? { toolGroups: [...selectedGroups] } : {}) })) { if (form.querySelector("textarea").value === submittedPrompt) form.querySelector("textarea").value = ""; selectedFiles = selectedFiles.filter(file => !files.includes(file)); showFiles(); }
    } catch (error) { display(error.message); } finally { submit.disabled = false; }
  };
  function showFiles() {
    const container = find("[data-attachments]"); container.replaceChildren();
    for (const file of selectedFiles) { const chip = node("span", "", "ide-file-chip"); chip.append(node("span", file.name)); button(chip, "×", () => { selectedFiles = selectedFiles.filter(item => item !== file); showFiles(); }).setAttribute("aria-label", "Retirer " + file.name); container.append(chip); }
  }
  find("[data-attach]").onclick = () => find("[data-files]").click();
  find("[data-files]").onchange = event => { const additions = [...event.target.files], next = [...selectedFiles, ...additions]; if (next.length > 4 || next.reduce((sum, file) => sum + file.size, 0) > 2 * 1024 * 1024) display("Maximum 4 pièces jointes et 2 Mio au total."); else { selectedFiles = next; showFiles(); } event.target.value = ""; };
  find("[data-tools]").id = "ide-tools-options";
  find("[data-open-tools]").onclick = () => { const tools = find("[data-tools]"), expand = tools.hidden || !tools.open; tools.hidden = !expand; tools.open = expand; };
  find("[data-tools]").addEventListener("toggle", () => find("[data-open-tools]").setAttribute("aria-expanded", String(find("[data-tools]").open && !find("[data-tools]").hidden)));
  for (const preset of dialog.querySelectorAll("[data-preset]")) preset.onclick = () => { selectedGroups = preset.dataset.preset === "all" ? availableGroups.map(group => group.id) : [...FRANCE_IDE_PRESETS[preset.dataset.preset]].filter(id => availableGroups.some(group => group.id === id)); updateToolLabels(); };
  const tabs = [...dialog.querySelectorAll("[data-tab]")];
  function selectTab(tab) { for (const button of tabs) { const active = button === tab; button.setAttribute("aria-selected", String(active)); button.tabIndex = active ? 0 : -1; } find("[data-messages]").hidden = tab.dataset.tab !== "chat"; find("[data-activity]").hidden = tab.dataset.tab !== "activity"; }
  for (const tab of tabs) { tab.onclick = () => selectTab(tab); tab.onkeydown = event => { if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return; event.preventDefault(); const index = event.key === "Home" ? 0 : event.key === "End" ? tabs.length - 1 : (tabs.indexOf(tab) + (event.key === "ArrowRight" ? 1 : -1) + tabs.length) % tabs.length; selectTab(tabs[index]); tabs[index].focus(); }; }
  find("[data-close]").onclick = () => dialog.close();
  const visibility = () => { if (!document.hidden) { reconnectAfter = 0; refresh(); } };
  document.addEventListener("visibilitychange", visibility);
  dialog.addEventListener("close", () => { closed = true; viewVersion++; clearTimeout(timer); document.removeEventListener("visibilitychange", visibility); dialog.remove(); }, { once: true });
  showSession();
  (async () => { try { if (typeof loadRememberedLink === "function") await loadRememberedLink(); } catch (error) { display(error.message); } if (!closed) { showSession(); tick(); } })();
}
