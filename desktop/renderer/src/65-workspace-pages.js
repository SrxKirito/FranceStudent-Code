/* Pages de navigation et présentation des réglages. */
if (api.platform === "win32") document.documentElement.classList.add("windows-material");
const settingsLayout = document.createElement("div");
settingsLayout.className = "settings-layout";
const settingsLayoutNav = document.createElement("aside");
settingsLayoutNav.className = "settings-layout-nav";
const settingsLayoutMain = document.createElement("div");
settingsLayoutMain.className = "settings-layout-main";
settingsLayoutNav.append(centerNode("h2", "", "Paramètres"), settingsNavigation);
settingsLayoutMain.append(centerNode("h1", "", settingsGroups.find(group=>group[0]===settingsCategory)?.[1] || "Paramètres"));
for (const child of [...$("settings-view").children]) {
    if (!child.classList.contains("sidebar-header")) settingsLayoutMain.append(child);
}
settingsLayout.append(settingsLayoutNav, settingsLayoutMain);
$("settings-view").append(settingsLayout);

browserHomeViewTitles.projects = "Projets";
browserHomeViews.projects = () => {
    const page = centerNode("div", "projects-page");
    const header = centerNode("div", "projects-heading");
    const search = document.createElement("input");
    search.type = "search"; search.placeholder = "Rechercher des projets"; search.setAttribute("aria-label", "Rechercher des projets");
    const open = centerButton("+ Nouveau projet", () => showNewLocalProject());
    header.append(centerNode("h1", "", "Projets"), search, open);
    const list = centerNode("div", "projects-list", "Chargement…");
    page.append(header, list); browserHomeViewBody.append(page);
    let projectListSequence = 0;
    const render = async () => {
        const sequence = ++projectListSequence;
        try {
            const [local, accountResult] = await Promise.all([api.localProjects("list"), api.frProjects("list").catch(error => ({ error: error.message, projects: [] }))]);
            if (!page.isConnected || sequence !== projectListSequence) return;
            const paths = new Map();
            for (const project of local.projects || []) paths.set(project.path, 0);
            list.replaceChildren();
            const query = search.value.toLocaleLowerCase("fr");
            for (const project of accountResult.projects || []) {
                if (!String(project.name || "").toLocaleLowerCase("fr").includes(query)) continue;
                const row = centerNode("div", "projects-row");
                const button = centerButton(`☁  ${project.name || "Projet sans nom"}`, async () => {
                    try {
                        if (isMotionOpen()) await closeMotionDesign();
                        if (isMotionOpen()) return;
                        if (ui.status.mode !== "chat") afterConversationOpened(await api.switchChatMode("chat"));
                        const selected = await api.frProjects("select", { id: project.id });
                        franceStudentProjects = selected.projects || franceStudentProjects;
                        renderFranceStudentProjects(selected.selected);
                        browserHomeClosePage(); setAgentFocus(true); setAgentTab("conversation");
                        await openFranceStudentProjectChats(true);
                    } catch (error) { studioFeedback(error.message); }
                });
                button.classList.add("projects-open");
                row.append(button, centerNode("span", "projects-path", "Projet FranceStudent")); list.append(row);
            }
            if (accountResult.error) list.append(centerNode("p", "settings-help", `Projets FranceStudent indisponibles : ${accountResult.error}`));
            for (const path of paths.keys()) {
                let info; try { info = await api.projectSources("get", { root: path }); } catch { info = { name: path.replace(/[\\/]+$/, "").split(/[\\/]/).pop(), sources: [] }; }
                if (!page.isConnected || sequence !== projectListSequence) return;
                if (!`${path} ${info.name}`.toLocaleLowerCase("fr").includes(query)) continue;
                const row = centerNode("div", "projects-row");
                const name = info.name;
                const button = centerButton(`📁  ${name}`, async () => {
                    if (path !== ui.workspace) {
                        if (ui.tabs.some(t => t.dirty) && !await confirmStudioAction("Des fichiers ne sont pas enregistrés. Changer de projet quand même ?")) return;
                        try { const ws = await api.openProject(path); if (!ws) return; if (ws !== ui.workspace) { ui.workspace = ws; onWorkspaceChanged(); } }
                        catch (error) { studioFeedback(error.message); return; }
                    }
                    browserHomeShowSideView("project");
                });
                button.classList.add("projects-open"); button.title = path;
                const pathLabel = centerNode("span", "projects-path", path); pathLabel.title = path;
                const edit = centerButton("Modifier", () => showProjectEditor(path)); edit.title = `Modifier ${name}`;
                const remove = centerButton("Supprimer", () => removeLocalProject(path, name)); remove.classList.add("project-remove-action"); remove.title = `Retirer ${name} de la liste`;
                row.append(button, pathLabel, edit, remove); list.append(row);
            }
            if (!list.children.length) list.append(centerNode("p", "settings-help", query ? "Aucun projet trouvé." : "Aucun projet récent. Ouvre un dossier pour commencer."));
        } catch (error) { list.textContent = `Impossible de charger les projets : ${error.message}`; }
    };
    search.addEventListener("input", render); render();
};

// Historique des pages principales, distinct de celui du navigateur web intégré.
const workspacePageHistory = ["chat"];
let workspacePageIndex = 0, workspaceHistoryNavigation = false;
function workspaceRememberPage(page) {
    if (workspaceHistoryNavigation || workspacePageHistory[workspacePageIndex] === page) return;
    workspacePageHistory.splice(workspacePageIndex + 1);
    workspacePageHistory.push(page); workspacePageIndex++;
    workspaceSyncHistory();
}
function workspaceSyncHistory() {
    $("workspace-back").disabled = workspacePageIndex === 0;
    $("workspace-forward").disabled = workspacePageIndex >= workspacePageHistory.length - 1;
}
const workspaceOriginalShow = browserHomeShow;
browserHomeShow = function(name, options = {}) {
    workspaceOriginalShow(name, options);
    if (options.page) workspaceRememberPage(name);
};
const workspaceOriginalClose = browserHomeClosePage;
browserHomeClosePage = function() {
    const wasPage = $("app").classList.contains("browser-home-page");
    workspaceOriginalClose();
    if (wasPage) workspaceRememberPage("chat");
};
function workspaceGo(delta) {
    const index = workspacePageIndex + delta;
    if (index < 0 || index >= workspacePageHistory.length) return;
    workspacePageIndex = index; workspaceHistoryNavigation = true;
    try {
        const page = workspacePageHistory[index];
        if (page === "chat") browserHomeClosePage();
        else { browserHomeShow(page, { page: true }); setBrowserHomeOpen(true); if (page === "settings") { refreshSettings(); loadPreferences(); } if (page === "project") refreshProjectStudio(); }
    } finally { workspaceHistoryNavigation = false; workspaceSyncHistory(); }
}
$("workspace-back").onclick = () => workspaceGo(-1);
$("workspace-forward").onclick = () => workspaceGo(1);
window.addEventListener("frst-local-browser-state", workspaceSyncHistory);
workspaceSyncHistory();

// Commandes disponibles dans les menus de la fenêtre.
function workspaceMenuAction(menu, label, action, shortcut) {
    const button = document.createElement("button"); button.type = "button";
    button.textContent = label; if (shortcut) button.title = shortcut;
    button.addEventListener("mousedown", event => event.preventDefault());
    button.onclick = () => { menu.open = false; action(); };
    menu.querySelector("div").append(button);
}
let workspaceLastEditable = null;
document.addEventListener("focusin", event => { if (isEditable(event.target)) workspaceLastEditable = event.target; });
const workspaceMenus = document.querySelectorAll(".workspace-menu details");
workspaceMenuAction(workspaceMenus[0], "Ouvrir le dossier…", openProject, "Ctrl+O");
for (const [label, command, shortcut] of [["Annuler", "undo", "Ctrl+Z"], ["Rétablir", "redo", "Ctrl+Y"], ["Couper", "cut", "Ctrl+X"], ["Copier", "copy", "Ctrl+C"], ["Coller", "paste", "Ctrl+V"], ["Tout sélectionner", "selectAll", "Ctrl+A"]]) {
    workspaceMenuAction(workspaceMenus[1], label, () => { if (workspaceLastEditable?.isConnected) workspaceLastEditable.focus(); document.execCommand(command); }, shortcut);
}
workspaceMenuAction(workspaceMenus[1], "Paramètres", () => showSideView("settings"));
workspaceMenuAction(workspaceMenus[2], "Projets", () => { setBrowserHomeOpen(true); browserHomeShow("projects", { page: true }); });
workspaceMenuAction(workspaceMenus[2], "Retour", () => workspaceGo(-1));
workspaceMenuAction(workspaceMenus[2], "Suivant", () => workspaceGo(1));
for (const menu of workspaceMenus) menu.addEventListener("toggle", () => { if (menu.open) for (const other of workspaceMenus) if (other !== menu) other.open = false; });
document.addEventListener("pointerdown", event => { if (!event.target.closest(".workspace-menu")) for (const menu of workspaceMenus) menu.open = false; });
