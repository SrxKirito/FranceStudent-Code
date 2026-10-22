// 22-extension-center.js — centre d'extensions : édition, import et suppression de skills,
// activation et retrait des serveurs MCP.
// Portage adapté de extraopaa/francestudents-ide : la vue Extensions locale (12-sidebar.js)
// est conservée ; ce module l'enrichit au lieu de la remplacer. API : api.extensionAction.

function centerNode(tag, className = "", text = "") {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text) node.textContent = text;
    return node;
}

function centerButton(label, handler, primary = false) {
    const button = centerNode("button", primary ? "primary" : "", label);
    button.type = "button";
    button.onclick = async (event) => {
        event.stopPropagation();
        button.disabled = true;
        try {
            await handler(event);
        } catch (error) {
            if (typeof lspStatus === "function") lspStatus(error.message || String(error));
        } finally {
            button.disabled = false;
        }
    };
    return button;
}

/* ---------- Boîte d'édition / import d'un skill ---------- */

document.body.insertAdjacentHTML("beforeend", `<dialog id="skill-editor" class="center-dialog" aria-labelledby="skill-editor-title"><form id="skill-editor-form"><div class="center-dialog-head"><h2 id="skill-editor-title">Skill</h2><button type="button" id="skill-editor-close" aria-label="Fermer">×</button></div><div class="center-filters"><input id="skill-editor-name" maxlength="64" placeholder="nom-du-skill" spellcheck="false" aria-label="Nom du skill"><select id="skill-editor-scope" aria-label="Portée"><option value="utilisateur">Utilisateur</option><option value="projet">Projet</option></select></div><label class="center-code-label">SKILL.md<textarea id="skill-editor-content" rows="18" spellcheck="false" maxlength="200000"></textarea></label><p id="skill-editor-message" class="studio-message" role="status"></p><div class="center-dialog-actions"><button type="button" id="skill-editor-cancel">Annuler</button><button type="submit" id="skill-editor-save" class="primary">Enregistrer</button></div></form></dialog>`);

let skillEditorMode = null;

function skillTemplate(name) {
    return `---\nname: ${name || "mon-skill"}\ndescription: Quand utiliser ce skill.\n---\n\n# ${name || "Mon skill"}\n\nInstructions pour l'agent.\n`;
}

async function openSkillEditor(mode, name = "") {
    skillEditorMode = { mode, name };
    $("skill-editor-message").textContent = "";
    $("skill-editor-name").disabled = mode === "edit";
    $("skill-editor-scope").disabled = mode === "edit";
    $("skill-editor-title").textContent = mode === "edit" ? `Modifier le skill ${name}` : "Importer un skill";
    if (mode === "edit") {
        const data = await api.extensionAction("read", { name });
        $("skill-editor-name").value = data.name;
        $("skill-editor-scope").value = data.scope;
        $("skill-editor-content").value = data.content;
    } else {
        $("skill-editor-name").value = "";
        $("skill-editor-scope").value = "utilisateur";
        $("skill-editor-content").value = skillTemplate("");
    }
    $("skill-editor").showModal();
    (mode === "edit" ? $("skill-editor-content") : $("skill-editor-name")).focus();
}

$("skill-editor-close").onclick = () => $("skill-editor").close();
$("skill-editor-cancel").onclick = () => $("skill-editor").close();
$("skill-editor-form").onsubmit = async (event) => {
    event.preventDefault();
    const state = skillEditorMode;
    if (!state) return;
    const content = $("skill-editor-content").value;
    $("skill-editor-save").disabled = true;
    try {
        if (state.mode === "edit") {
            await api.extensionAction("save", { name: state.name, content });
        } else {
            const name = $("skill-editor-name").value.trim();
            if (!name) throw new Error("Donne un nom au skill.");
            await api.extensionAction("import", { name, content, scope: $("skill-editor-scope").value });
        }
        $("skill-editor").close();
        await refreshSkills();
    } catch (error) {
        $("skill-editor-message").textContent = error.message;
    } finally {
        $("skill-editor-save").disabled = false;
    }
};

/* ---------- Actions ajoutées aux listes de la vue Extensions ---------- */

function centerItemActions(item, buttons) {
    if (item.dataset.centerDecorated) return;
    item.dataset.centerDecorated = "1";
    const bar = centerNode("div", "center-item-actions");
    bar.append(...buttons);
    item.appendChild(bar);
}

function decorateSkills() {
    for (const item of $("skills-list").querySelectorAll(".ext-item")) {
        const name = item.querySelector(".ext-item-name")?.textContent;
        if (!name) continue;
        centerItemActions(item, [
            centerButton("Modifier", () => openSkillEditor("edit", name)),
            centerButton("Supprimer", async () => {
                if (!window.confirm(`Supprimer définitivement le skill « ${name} » et son dossier ?`)) return;
                await api.extensionAction("remove", { name });
                await refreshSkills();
            })
        ]);
    }
}

function decorateMcp() {
    for (const item of $("mcp-list").querySelectorAll(".ext-item")) {
        const name = item.querySelector(".ext-item-name")?.textContent;
        if (!name) continue;
        const disabled = item.querySelector(".ext-tag")?.textContent === "disabled";
        const mcpAction = async (action, payload) => {
            await api.extensionAction(action, payload);
            await refreshMcp();
        };
        centerItemActions(item, [
            centerButton(disabled ? "Activer" : "Désactiver", () => mcpAction("mcp-toggle", { name, disabled: !disabled })),
            centerButton("Retirer", async () => {
                if (!window.confirm(`Retirer le serveur MCP « ${name} » de mcp.json ?`)) return;
                await mcpAction("mcp-remove", { name });
            })
        ]);
    }
}

new MutationObserver(decorateSkills).observe($("skills-list"), { childList: true });
new MutationObserver(decorateMcp).observe($("mcp-list"), { childList: true });

const skillImportButton = centerNode("button", "", "Importer");
skillImportButton.type = "button";
skillImportButton.id = "btn-skill-import";
skillImportButton.title = "Créer un skill à partir d'un contenu SKILL.md";
skillImportButton.onclick = () => openSkillEditor("import").catch((error) => lspStatus(error.message));
$("btn-skill-dir")?.parentElement?.prepend(skillImportButton);
