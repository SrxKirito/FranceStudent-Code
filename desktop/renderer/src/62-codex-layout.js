/* Disposition « Codex » : en plein écran du chat, une barre latérale
   Nouveau chat / Rechercher / Récents réutilise l'historique existant
   (api.conversationsRecent + renderHistoryRow). Aucun ID existant n'est modifié. */
const codexRail = document.createElement("nav");
codexRail.id = "codex-rail";
codexRail.className = "codex-rail";
codexRail.setAttribute("aria-label", "Conversations");
codexRail.innerHTML = `
    <div class="codex-rail-brand"><button type="button" id="codex-mode-toggle" aria-haspopup="menu" aria-expanded="false">FranceStudent Code <svg class="codex-mode-chevron" viewBox="0 0 16 16" aria-hidden="true"><path d="m4 6 4 4 4-4"/></svg></button><button type="button" id="codex-rail-brand-search" title="Rechercher une conversation" aria-label="Rechercher une conversation">⌕</button></div>
    <button type="button" id="codex-rail-new" class="codex-rail-item"><svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg><span>Nouveau chat</span></button>
    <button type="button" id="codex-rail-search" class="codex-rail-item"><svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="m21 21-4.3-4.3M11 18a7 7 0 1 1 0-14 7 7 0 0 1 0 14Z"/></svg><span>Rechercher</span></button>
    <button type="button" id="codex-rail-changes" class="codex-rail-item"><svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 3v12M18 9v12M6 15a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM18 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z"/></svg><span>Fichiers et modifications</span></button>
    <details class="codex-rail-tools-menu"><summary>Outils</summary>
    <div class="codex-rail-tools" role="group" aria-label="Outils de l'IDE">
        <button type="button" class="codex-rail-item" data-rail-tool="explorer"><span>Explorateur</span></button>
 <button type="button" class="codex-rail-item" data-rail-tool="search"><span>Recherche dans le projet</span></button>
 <button type="button" class="codex-rail-item" data-rail-tool="worktrees"><span>Tâches parallèles</span></button>
        <button type="button" class="codex-rail-item" data-rail-tool="project"><span>Cockpit du projet</span></button>
        <button type="button" class="codex-rail-item" data-rail-tool="extensions"><span>Extensions</span></button>
        <button type="button" class="codex-rail-item" data-rail-tool="motion"><span>Motion design</span></button>
 <button type="button" class="codex-rail-item" data-rail-tool="terminal"><span>Terminal</span></button>
        <button type="button" class="codex-rail-item" data-rail-tool="palette"><span>Palette de commandes</span></button>
        <button type="button" class="codex-rail-item" data-rail-tool="settings"><span>Paramètres</span></button>
        <button type="button" class="codex-rail-item" data-rail-tool="help"><span>Connexion et aide</span></button>
    </div></details>
    <div class="codex-rail-section codex-projects-heading"><button type="button" id="codex-rail-add-project" title="Créer un nouveau projet" aria-label="Créer un nouveau projet">+</button><span>Projets</span></div>
    <div id="codex-rail-projects" class="codex-rail-projects"></div>
    <div class="codex-rail-section"><span>Récents</span><button type="button" id="codex-rail-refresh" title="Actualiser les conversations" aria-label="Actualiser les conversations">↻</button></div>
    <div id="codex-rail-list" class="codex-rail-list" role="list"></div>`;
$("agent").prepend(codexRail);
// Poignée indépendante de l’explorateur ; la préférence reste locale à cette fenêtre.
const codexRailResize = document.createElement("div");
codexRailResize.className = "codex-rail-resize"; codexRailResize.tabIndex = 0;
codexRailResize.setAttribute("role", "separator"); codexRailResize.setAttribute("aria-orientation", "vertical");
codexRailResize.setAttribute("aria-label", "Largeur de la barre des conversations");
$("agent").append(codexRailResize);
let codexRailWidth = 260;
try { codexRailWidth = Number(localStorage.getItem("frst.codexRailWidth")) || 260; } catch { /* stockage facultatif */ }
function setCodexRailWidth(value, save = false) {
    const max = Math.max(180, Math.min(480, innerWidth - 420));
    codexRailWidth = Math.max(180, Math.min(max, Math.round(value)));
    $("app").style.setProperty("--codex-rail-width", `${codexRailWidth}px`);
    codexRailResize.setAttribute("aria-valuemin", "180"); codexRailResize.setAttribute("aria-valuemax", String(max)); codexRailResize.setAttribute("aria-valuenow", String(codexRailWidth));
    if (save) try { localStorage.setItem("frst.codexRailWidth", String(codexRailWidth)); } catch { /* stockage facultatif */ }
}
setCodexRailWidth(codexRailWidth);
codexRailResize.addEventListener("pointerdown", event => {
    if (event.button !== 0 || !codexRailResize.checkVisibility()) return;
    event.preventDefault(); const start = event.clientX, initial = codexRailWidth;
    codexRailResize.setPointerCapture(event.pointerId); document.body.classList.add("resizing-x");
    const move = e => { if (!codexRailResize.checkVisibility()) { end(); return; } setCodexRailWidth(initial + e.clientX - start); };
    const end = () => { codexRailResize.removeEventListener("pointermove", move); codexRailResize.removeEventListener("pointerup", end); codexRailResize.removeEventListener("pointercancel", end); codexRailResize.removeEventListener("lostpointercapture", end); if(codexRailResize.hasPointerCapture(event.pointerId))codexRailResize.releasePointerCapture(event.pointerId); document.body.classList.remove("resizing-x"); setCodexRailWidth(codexRailWidth, true); };
    codexRailResize.addEventListener("pointermove", move); codexRailResize.addEventListener("pointerup", end); codexRailResize.addEventListener("pointercancel", end); codexRailResize.addEventListener("lostpointercapture", end);
});
codexRailResize.addEventListener("keydown", event => {
    if (!codexRailResize.checkVisibility() || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
    event.preventDefault(); setCodexRailWidth(event.key === "Home" ? 180 : event.key === "End" ? 480 : codexRailWidth + (event.key === "ArrowRight" ? 10 : -10), true);
});
window.addEventListener("resize", () => setCodexRailWidth(codexRailWidth));

$("workspace-new-chat").onclick = () => $("codex-rail-new").click();
$("workspace-search").onclick = () => $("codex-rail-search").click();
$("workspace-changes").onclick = () => {
    setAgentFocus(true);
    setBrowserHomeOpen(true);
    browserHomeShow("changes");
};
const workspaceTitlebarProject = $("workspace-titlebar-project");
const syncWorkspaceTitlebarProject = () => {
    const source = $("agent-project-name");
    workspaceTitlebarProject.textContent = source.textContent;
    workspaceTitlebarProject.title = source.title;
};
new MutationObserver(syncWorkspaceTitlebarProject).observe($("agent-project-name"), { childList: true, characterData: true, subtree: true, attributes: true, attributeFilter: ["title"] });
syncWorkspaceTitlebarProject();

let codexRailRenderSequence = 0;
async function newProjectDiscussion(project, remote=false) {
    if(ui.status.busy || ui.replayingConversation)return studioFeedback("Attends la fin de la demande ou du chargement.");
    try {
        if(remote){const selected=await api.frProjects("select",{id:project.id});franceStudentProjects=selected.projects||franceStudentProjects;renderFranceStudentProjects(selected.selected);}
        else {
            if(ui.tabs.some(tab=>tab.dirty)&&!await confirmStudioAction("Des fichiers ne sont pas enregistrés. Changer de projet quand même ?"))return;
            const workspace=await api.openProject(project.path);if(!workspace) return;
            if(workspace!==ui.workspace){ui.workspace=workspace;onWorkspaceChanged();}
        }
        const result=await api.submit("/new",[],{});if(result?.error)throw Error(result.error);
        browserHomeClosePage();setAgentTab("conversation");
        studioFeedback(`Nouvelle discussion dans « ${project.name || project.path.split(/[\\/]/).pop()} ».`);
        await renderCodexRail();input.focus();
    } catch(error){studioFeedback(error.message);}
}
function projectDiscussionButton(project,remote=false){
    const button=centerNode("button","codex-project-new","+");button.type="button";
    button.title=`Nouvelle discussion dans ${project.name || project.path.split(/[\\/]/).pop()}`;button.setAttribute("aria-label",button.title);
    button.onclick=event=>{event.preventDefault();event.stopPropagation();void newProjectDiscussion(project,remote);};return button;
}
const codexClosedProjects = new Set();
let codexRailMode = null;
async function renderCodexRail() {
    const list = $("codex-rail-list");
    if (!list || !$("app").classList.contains("focus-agent")) return;
    const sequence = ++codexRailRenderSequence;
    if (typeof api === "undefined" || typeof api.conversationsRecent !== "function") {
        list.innerHTML = '<div class="codex-rail-empty">Historique indisponible.</div>';
        return;
    }
    const mode = ui.status.mode === "chat" ? "chat" : "agent";
    if (codexRailMode !== mode) { list.replaceChildren(); $("codex-rail-projects").replaceChildren(); codexRailMode = mode; }
    if (!list.childNodes.length) list.innerHTML = '<div class="codex-rail-empty">Chargement…</div>';
    try {
        if (ui.status.mode === "chat") {
            const projectArea = document.createElement("div");
            try {
                const data = await refreshFranceStudentProjects();
                if (sequence !== codexRailRenderSequence) return;
                for (const project of data.projects || []) {
                    const row = centerNode("button", "codex-remote-chat", `📁  ${project.name || "Projet sans nom"}`);
                    row.type = "button";
                    row.onclick = async () => {
                        try {
                            const selected = await api.frProjects("select", { id: project.id });
                            franceStudentProjects = selected.projects || franceStudentProjects;
                            renderFranceStudentProjects(selected.selected);
                            await openFranceStudentProjectChats(true);
                        } catch (error) { studioFeedback(error.message); }
                    };
                    const group=centerNode("div","codex-remote-project");group.append(row,projectDiscussionButton(project,true));projectArea.append(group);
                }
            } catch (error) { projectArea.append(centerNode("div", "codex-rail-empty", `Projets indisponibles : ${error.message}`)); }
            if (sequence !== codexRailRenderSequence) return;
            $("codex-rail-projects").replaceChildren(...projectArea.childNodes);
            if (!ui.models) { const models = await api.models().catch(() => null); if (models && !ui.models) ui.models = models; }
            if (sequence !== codexRailRenderSequence) return;
            const seen = new Set(); let cursor = "", target = document.createElement("div"), initial = true;
            const more = centerNode("button", "codex-remote-chat", "Charger davantage"); more.type = "button";
            const load = async () => {
                more.disabled = true;
                try {
                    const page = await api.remoteChats(cursor);
                    if (sequence !== codexRailRenderSequence) return;
                    more.remove();
                    for (const chat of [...page.chats].sort ( (a, b) => Number(b.pinned) - Number(a.pinned))) {
                        if (seen.has(chat.id)) continue; seen.add(chat.id);
                        const button = centerNode("button", "codex-remote-chat");
                        const logo = historyModelLogo(chat.model); if (logo) button.append(logo);
                        button.append(centerNode("span", "codex-remote-title", chat.title));
                        button.type = "button"; button.title = chat.title;
                        button.onclick = async () => {
                            if (ui.status.busy) { studioFeedback("Attends la fin de la demande."); return; }
                            try { afterConversationOpened(await api.conversationsOpen(chat.id, { mode: "chat" })); setAgentTab("conversation"); }
                            catch (error) { studioFeedback(error.message); }
                        };
                        const row = centerNode("div", "codex-remote-row");
                        const actions = document.createElement("details"); actions.className = "codex-remote-actions";
                        const summary = centerNode("summary", "", "⋯"); summary.setAttribute("aria-label", `Options de ${chat.title}`); const popup = centerNode("div", "codex-remote-popup"); actions.append(summary, popup);
                        for (const [action, label] of [["rename", "Renommer"], [chat.pinned ? "unpin" : "pin", chat.pinned ? "Désépingler" : "Épingler"], ["delete", "Supprimer"]]) {
                            const control = centerNode("button", "", label); control.type = "button";
                            control.onclick = async () => {
                                actions.open = false;
                                let title = "";
                                if (action === "rename") { title = window.prompt("Nouveau nom de la discussion :", chat.title); if (title === null || !title.trim()) return; }
                                if (action === "delete" && !await confirmStudioAction(`Supprimer la discussion « ${chat.title} » du compte FranceStudent ?`, { title: "Supprimer la discussion", confirmLabel: "Supprimer", danger: true })) return;
                                control.disabled = true;
                                try { await api.remoteChatAction(action, chat.id, title); await renderCodexRail(); }
                                catch (error) { studioFeedback(error.message); control.disabled = false; }
                            };
                            popup.append(control);
                        }
                        if (chat.pinned) button.prepend(centerNode("span", "", "📌"));
                        row.append(button, actions); target.append(row);
                    }
                    if (page.hasMore && page.cursor && page.cursor !== cursor) { cursor = page.cursor; target.append(more); }
                    else if (!seen.size) target.append(centerNode("div", "codex-rail-empty", "Aucune discussion FranceStudent."));
                    if (initial) { list.replaceChildren(...target.childNodes); target = list; initial = false; }
                } catch (error) {
                    if (sequence === codexRailRenderSequence) { more.remove(); studioFeedback(`Historique indisponible : ${error.message}`); if (initial && !list.querySelector(".codex-remote-row")) list.replaceChildren(centerNode("div", "codex-rail-empty", "Historique indisponible.")); }
                } finally { more.disabled = false; }
            };
            more.onclick = load; await load(); return;
        }
        const [items, models, local] = await Promise.all([api.conversationsRecent(200), ui.models ? Promise.resolve(ui.models) : api.models().catch(() => null), api.localProjects("list")]);
        if (models && !ui.models) ui.models = models;
        if (sequence !== codexRailRenderSequence) return;
        const projectKey = value => String(value || "").replace(/\\/g, "/").replace(/\/+$/, "").toLocaleLowerCase();
        const hidden = new Set((local.hidden || []).map(projectKey));
        const shown = (Array.isArray(items) ? items : []).filter(item => !item.motionDesign && item.mode !== "chat" && !hidden.has(projectKey(item.workspace)));
        const projects = $("codex-rail-projects");
        projects.replaceChildren();
        const grouped = new Map();
        for (const project of local.projects || []) grouped.set(project.path, []);
        for (const item of shown) {
            if (!item.workspace) continue;
            if (!grouped.has(item.workspace)) grouped.set(item.workspace, []);
            grouped.get(item.workspace).push(item);
        }
        for (const [workspace, conversations] of grouped) {
            const group = document.createElement("details");
            group.open = !codexClosedProjects.has(workspace);
            group.addEventListener("toggle", () => {
                if (group.open) codexClosedProjects.delete(workspace);
                else codexClosedProjects.add(workspace);
            });
            const heading = document.createElement("summary");
            const projectName = centerNode("span", "codex-project-name", workspace.replace(/[\\/]+$/, "").split(/[\\/]/).pop());
            const options = centerNode("button", "codex-project-options", "⋯"); options.type = "button"; options.title = "Options du projet"; options.setAttribute("aria-label", "Options du projet");
            options.onclick = event => { event.preventDefault(); event.stopPropagation(); showProjectInfo(workspace, conversations.length, options); };
            heading.append(fileIcon(workspace, "directory", true), projectName, projectDiscussionButton({path:workspace,name:projectName.textContent}), options);
            heading.title = workspace;
            api.projectSources("get", { root: workspace }).then(info => { if (projectName.isConnected) projectName.textContent = info.name; }).catch(() => {});
            group.append(heading);
            if (!conversations.length) {
                const open = centerNode("button", "codex-project-empty", "Ouvrir le projet"); open.type = "button";
                open.onclick = async () => {
                    if (ui.status.busy) return studioFeedback("Attends la fin de la demande.");
                    if (ui.tabs.some(tab => tab.dirty) && !await confirmStudioAction("Des fichiers ne sont pas enregistrés. Changer de projet quand même ?")) return;
                    try { const workspace = await api.openProject(workspacePath); if (workspace && workspace !== ui.workspace) { ui.workspace = workspace; onWorkspaceChanged(); } }
                    catch (error) { studioFeedback(error.message); }
                };
                const workspacePath = workspace;
                group.append(open);
            }
            for (const item of conversations) {
                const row = renderHistoryRow(item);
                const logo = historyModelLogo(item.model);
                const icon = logo || document.createElement("span");
                if (!logo) icon.className = "codex-conversation-icon";
                if (!logo) icon.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h4M9 12h6M9 16h6"/></svg>';
                icon.setAttribute("aria-hidden", "true");
                row.prepend(icon);
                group.append(row);
            }
            projects.append(group);
        }
        const nextRows = document.createDocumentFragment();
        if (!shown.length) { list.innerHTML = '<div class="codex-rail-empty">Aucune conversation enregistrée.</div>'; return; }
        for (const item of shown.slice(0, 30)) {
            const row = renderHistoryRow(item);
            const logo = historyModelLogo(item.model); if (logo) row.prepend(logo);
            row.setAttribute("role", "listitem");
            const open = row.querySelector(".history-open");
            if (open) open.addEventListener("click", () => setTimeout(renderCodexRail, 400));
            nextRows.appendChild(row);
        }
        list.replaceChildren(nextRows);
    } catch (err) {
        if (sequence !== codexRailRenderSequence) return;
        studioFeedback(`Historique indisponible : ${err.message}`);
    }
}

$("codex-rail-new").onclick = () => { $("btn-new").click(); setTimeout(renderCodexRail, 400); $("input").focus(); };
$("codex-rail-add-project").onclick = async () => {
    if (ui.status.busy) return studioFeedback("Attends la fin de la demande.");
    try { if (ui.status.mode === "chat") { await createFranceStudentProject(); await renderCodexRail(); } else await showNewLocalProject(); }
    catch (error) { studioFeedback(error.message); }
};
$("codex-rail-search").onclick = () => toggleHistoryMenu();
$("codex-rail-brand-search").onclick = () => toggleHistoryMenu($("codex-rail-brand-search"));
$("codex-rail-changes").onclick = () => { setBrowserHomeOpen(true); browserHomeShow("changes"); };
$("codex-rail-refresh").onclick = () => renderCodexRail();
window.addEventListener("frst-conversations-changed", () => renderCodexRail());
// Outils de l'IDE (remplacent la barre d'activité supprimée) : chaque bouton réutilise une fonction existante.
const codexRailTools = {
    explorer: () => showSideView("explorer"),
    search: () => showSideView("search"),
    worktrees: () => showSideView("worktrees"),
    project: () => showSideView("project"),
    extensions: () => showSideView("extensions"),
    settings: () => showSideView("settings"),
    motion: () => { if (typeof motionNav !== "undefined") motionNav.click(); },
    terminal: () => { setBrowserHomeOpen(true); browserHomeShow("terminal"); },
    palette: () => openPalette("files"),
    help: () => openConnectionGuide(),
};
for (const button of codexRail.querySelectorAll("[data-rail-tool]")) {
    const run = codexRailTools[button.dataset.railTool];
    if (run) button.onclick = run;
}
for (const button of document.querySelectorAll("[data-settings-agent-view]")) {
    button.onclick = () => {
        browserHomeClosePage();
        setAgentFocus(true);
        setAgentTab(button.dataset.settingsAgentView);
    };
}
// Colonne d'actions accessible depuis le chat.
const codexActivity = document.createElement("nav");
codexActivity.id = "codex-activity";
codexActivity.setAttribute("aria-label", "Navigation principale");
const codexActivityItems = [
    ["chat", "Conversations", '<path d="m3 11 9-8 9 8M5 10v10h5v-6h4v6h5V10"/>', () => { browserHomeClosePage(); setAgentFocus(true); }],
    ["motion", "Motion design · EffectCraft (Bêta)", '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="m10 9 5 3-5 3z"/>', () => motionNav.click()],
    ["plugins", "Plugins", '<circle cx="12" cy="12" r="8"/><path d="M9 9h6v6H9zM12 4v2m0 12v2M4 12h2m12 0h2"/>', () => { setCenterTab("mcp"); showSideView("extensions"); }],
    ["project", "Projet", '<rect x="4" y="4" width="7" height="7" rx="1"/><rect x="13" y="4" width="7" height="7" rx="1"/><rect x="4" y="13" width="7" height="7" rx="1"/><rect x="13" y="13" width="7" height="7" rx="1"/>', () => { setBrowserHomeOpen(true); browserHomeShow("projects", { page: true }); }],
    ["settings", "Paramètres", '<circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1l2-1.5-2-3.5-2.3 1a7 7 0 0 0-1.7-1L14.5 3h-5L9 6a7 7 0 0 0-1.7 1L5 6 3 9.5 5.1 11a7 7 0 0 0 0 2L3 14.5 5 18l2.3-1a7 7 0 0 0 1.7 1l.5 3h5l.5-3a7 7 0 0 0 1.7-1l2.3 1 2-3.5-2.1-1.5a7 7 0 0 0 .1-1Z"/>', () => showSideView("settings")],
];
for (const [key, label, icon, action] of codexActivityItems) {
    const button = document.createElement("button");
    button.type = "button";
    button.dataset.action = key;
    button.title = label;
    button.setAttribute("aria-label", label);
    button.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icon}</svg>`;
    button.onclick = action;
    codexActivity.append(button);
}
$("agent").prepend(codexActivity);

function toggleCodexRail() {
    const collapsed = $("app").classList.toggle("codex-rail-collapsed");
    $("workspace-toggle-rail").setAttribute("aria-expanded", String(!collapsed));
}
$("workspace-toggle-rail").onclick = toggleCodexRail;
$("workspace-back").onclick = () => $("local-browser-back").click();
$("workspace-forward").onclick = () => $("local-browser-forward").click();
$("workspace-back").disabled = true;
$("workspace-forward").disabled = true;
window.addEventListener("frst-local-browser-state", event => {
    $("workspace-back").disabled = !event.detail.canGoBack;
    $("workspace-forward").disabled = !event.detail.canGoForward;
});
$("workspace-menu-new").onclick = () => $("codex-rail-new").click();
$("workspace-menu-files").onclick = () => showSideView("explorer");
$("workspace-menu-search").onclick = () => showSideView("search");
$("workspace-menu-toggle").onclick = toggleCodexRail;
$("workspace-menu-terminal").onclick = () => { setBrowserHomeOpen(true); browserHomeShow("terminal"); };
$("workspace-menu-help").onclick = () => openConnectionGuide();
for (const button of document.querySelectorAll(".workspace-menu details button")) {
    button.addEventListener("click", () => { button.closest("details").open = false; });
}

// Ne recharge l'historique qu'au passage en plein écran (les classes view-* changent souvent).
let codexRailWasFocused = false;
new MutationObserver(() => {
    const focused = $("app").classList.contains("focus-agent");
    if (focused && !codexRailWasFocused) renderCodexRail();
    codexRailWasFocused = focused;
}).observe($("app"), { attributes: true, attributeFilter: ["class"] });
// Le chat est déjà actif au démarrage ; charger aussi son historique initial.
setAgentFocus(true);
renderCodexRail();

document.addEventListener("click", event => {
    if (!event.target.closest(".codex-remote-actions")) document.querySelectorAll(".codex-remote-actions[open]").forEach(menu => { menu.open = false; });
});
