/* Réglages locaux d’un projet et de ses dossiers sources. */
async function showNewLocalProject() {
    if (isMotionOpen()) { await closeMotionDesign(); if (isMotionOpen()) return; }
    const dialog = document.createElement("dialog"); dialog.id = "new-local-project-dialog"; dialog.className = "fs-dialog project-source-dialog";
    studioSurfaceHeader(dialog, { title: "Nouveau projet", subtitle: "Crée un dossier pour ton projet ou ouvre un dossier existant.", icon: "tools" });
    const label = centerNode("label", "project-source-name", "Nom du projet"), name = document.createElement("input");
    name.value = "Mon projet"; name.maxLength = 100; label.append(name);
    let parent = null;
    const location = centerNode("button", "project-source-add", "Choisir l’emplacement…"); location.type = "button";
    const message = centerNode("p", "settings-help", "Un nouveau dossier sera créé à cet emplacement."); message.setAttribute("role", "status");
    const footer = centerNode("div", "fs-dialog-footer"), cancel = centerNode("button", "", "Annuler"), create = centerNode("button", "primary", "Créer le projet");
    cancel.type = create.type = "button"; create.disabled = true; cancel.onclick = () => dialog.close();
    location.onclick = async () => { location.disabled = true; try { const chosen = await api.localProjects("chooseParent"); if (chosen) { parent = chosen; location.textContent = chosen; location.title = chosen; create.disabled = !name.value.trim(); } } catch (error) { message.textContent = error.message; } finally { location.disabled = false; } };
    name.oninput = () => { create.disabled = !parent || !name.value.trim(); };
    name.onkeydown = event => { if (event.key === "Enter" && !create.disabled) { event.preventDefault(); create.click(); } };
    const existing = centerNode("button", "project-source-add", "Ouvrir un dossier existant…"); existing.type = "button";
    existing.onclick = async () => { dialog.close(); await openProject(); await renderCodexRail(); };
    create.onclick = async () => {
        if (ui.tabs.some(tab => tab.dirty) && !await confirmStudioAction("Des fichiers ne sont pas enregistrés. Changer de projet quand même ?")) return;
        create.disabled = true;
        try { const result = await api.localProjects("create", { parent, name: name.value }); if (result.workspace !== ui.workspace) { ui.workspace = result.workspace; onWorkspaceChanged(); } dialog.close(); await renderCodexRail(); if (browserHomeCurrent === "projects") browserHomeShow("projects", { page: true }); studioFeedback("Projet créé."); }
        catch (error) { message.textContent = error.message; create.disabled = false; }
    };
    footer.append(cancel, create); dialog.append(label, location, existing, message, footer); document.body.append(dialog);
    dialog.addEventListener("close", () => dialog.remove(), { once: true }); dialog.showModal(); name.focus(); name.select();
}

async function removeLocalProject(root, name) {
    if (ui.status.busy) return studioFeedback("Attends la fin de la demande.");
    const key = value => String(value || "").replace(/\\/g, "/").replace(/\/+$/, "").toLocaleLowerCase();
    if (key(root) === key(ui.workspace) && ui.tabs.some(tab => tab.dirty) && !await confirmStudioAction("Des fichiers ne sont pas enregistrés. Fermer ce projet quand même ?")) return;
    if (!await confirmStudioAction(`Retirer « ${name} » de la liste des projets ? Les fichiers, les sauvegardes et les conversations sont conservés. Tu pourras le retrouver en ouvrant son dossier.`, { title: "Supprimer le projet de la liste", confirmLabel: "Retirer le projet", danger: true })) return;
    try {
        await api.localProjects("remove", { root });
        window.dispatchEvent(new Event("frst-conversations-changed"));
        if (browserHomeCurrent === "projects") browserHomeShow("projects", { page: true });
        studioFeedback("Projet retiré de la liste. Ses fichiers sont conservés.");
    } catch (error) { studioFeedback(error.message); }
}

async function showProjectEditor(root) {
    let config;
    try { config = await api.projectSources("get", { root }); }
    catch (error) { studioFeedback(error.message); return; }
    const dialog = document.createElement("dialog"); dialog.className = "fs-dialog project-source-dialog";
    studioSurfaceHeader(dialog, { title: "Modifier le projet", subtitle: "Organise les dossiers à étudier ensemble.", icon: "tools" });
    const nameLabel = document.createElement("label"); nameLabel.className = "project-source-name"; nameLabel.append(centerNode("span", "", "Nom du projet"));
    const nameInput = document.createElement("input"); nameInput.value = config.name; nameInput.maxLength = 100; nameInput.required = true; nameLabel.append(nameInput);
    const section = centerNode("section", "project-source-section"); section.append(centerNode("h3", "", "Dossiers sources"));
    const folders = centerNode("div", "project-source-folders"); let paths = config.sources.map(source => source.path);
    function drawFolders() {
        folders.replaceChildren();
        const primary = centerNode("div", "project-source-row"); primary.append(centerNode("span", "project-source-path", config.root), centerNode("span", "project-source-badge", "Principal")); folders.append(primary);
        paths.forEach((source, index) => {
            const row = centerNode("div", "project-source-row");
            const label = centerNode("span", "project-source-path", source); label.title = source;
            const remove = centerNode("button", "project-source-remove", "×"); remove.type = "button"; remove.setAttribute("aria-label", `Retirer ${source}`);
            remove.onclick = () => { paths.splice(index, 1); drawFolders(); };
            row.append(label, remove); folders.append(row);
        });
        const add = centerNode("button", "project-source-add", "+ Ajouter un dossier"); add.type = "button";
        add.onclick = async () => { add.disabled = true; try { const chosen = await api.projectSources("choose"); if (chosen) { paths.push(chosen); drawFolders(); } } catch (error) { message.textContent = error.message; } finally { add.disabled = false; } };
        folders.append(add);
    }
    const message = centerNode("p", "settings-help", "L’outil de sources les consulte en lecture seule. Les sauvegardes avant demande couvrent uniquement le dossier principal."); message.setAttribute("role", "status");
    section.append(folders, message); drawFolders();
    const footer = centerNode("div", "fs-dialog-footer"), cancel = centerNode("button", "", "Annuler"), save = centerNode("button", "primary", "Enregistrer");
    cancel.type = save.type = "button"; cancel.onclick = () => dialog.close();
    save.onclick = async () => {
        save.disabled = true;
        try { await api.projectSources("save", { root: config.root, name: nameInput.value, paths }); dialog.close(); renderCodexRail(); if (browserHomeCurrent === "projects") browserHomeShow("projects", { page: true }); studioFeedback("Projet enregistré."); }
        catch (error) { message.textContent = error.message; save.disabled = false; }
    };
    footer.append(cancel, save); dialog.append(nameLabel, section, footer); document.body.append(dialog);
    dialog.addEventListener("close", () => dialog.remove(), { once: true }); dialog.showModal(); nameInput.focus(); nameInput.select();
}
async function showProjectInfo(root, count, anchor) {
    const old = document.querySelector(".project-info-popover"); if (old) old.remove();
    const popover = centerNode("div", "project-info-popover"); popover.setAttribute("popover", "auto"); popover.setAttribute("aria-label", "Informations sur le projet");
    popover.append(centerNode("strong", "", "Chargement…")); document.body.append(popover);
    popover.addEventListener("toggle", () => { if (!popover.matches(":popover-open")) popover.remove(); });
    const rect = anchor.getBoundingClientRect(); popover.style.left = `${Math.max(8, Math.min(innerWidth - 330, rect.right + 8))}px`; popover.style.top = `${Math.max(8, Math.min(innerHeight - 240, rect.top))}px`; popover.showPopover();
    try {
        const info = await api.projectSources("get", { root }); if (!popover.isConnected) return;
        popover.replaceChildren(centerNode("strong", "", info.name), centerNode("p", "", `${count} discussion(s)`));
        for (const item of [info.root, ...info.sources.map(source => source.path)]) { const line = centerNode("div", "project-info-path", item); line.title = item; popover.append(line); }
        const edit = centerNode("button", "", "Modifier le projet"); edit.type = "button"; edit.onclick = () => { popover.hidePopover(); showProjectEditor(info.root); }; popover.append(edit);
        const remove = centerNode("button", "project-remove-action", "Supprimer le projet de la liste"); remove.type = "button";
        remove.onclick = () => { popover.hidePopover(); removeLocalProject(info.root, info.name); }; popover.append(remove);
    } catch (error) {
        popover.replaceChildren(centerNode("p", "", error.message));
        const remove = centerNode("button", "project-remove-action", "Supprimer le projet de la liste"); remove.type = "button";
        remove.onclick = () => { popover.hidePopover(); removeLocalProject(root, root.replace(/[\\/]+$/, "").split(/[\\/]/).pop()); }; popover.append(remove);
    }
}
