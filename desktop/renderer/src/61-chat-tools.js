/* Tool choice belongs to the next Code task; permissions remain independent. */
const chatToolSelections = new Map();
let chatToolCatalog = [], chatToolContext = "", chatToolMotion = false;
const chatToolPresets = { code: ["files", "terminal", "skills"], explore: ["web", "skills"] };
const chatToolButton = document.createElement("button");
chatToolButton.type = "button"; chatToolButton.id = "chat-tool-selection";
chatToolButton.setAttribute("aria-haspopup", "dialog"); chatToolButton.setAttribute("aria-expanded", "false");
chatToolButton.setAttribute("aria-controls", "chat-tool-selection-menu");
chatControlContent(chatToolButton, '<path d="m14 5 5 5M5 19l9-9M16 3a5 5 0 0 0-6 6l-7 7a2 2 0 0 0 3 3l7-7a5 5 0 0 0 6-6l-3 3-3-3 3-3Z"/>', "Outils · Complet");
composerModelRow.insertBefore(chatToolButton, dictationButton);
const chatToolMenu = document.createElement("div");
chatToolMenu.id = "chat-tool-selection-menu"; chatToolMenu.className = "chat-access-menu chat-tool-selection-menu";
chatToolMenu.setAttribute("popover", "auto"); chatToolMenu.setAttribute("role", "dialog");
chatToolMenu.setAttribute("aria-labelledby", "chat-tool-selection-title");
chatToolMenu.innerHTML = '<header><div><h2 id="chat-tool-selection-title">Outils de l’agent</h2><p>Pour ta prochaine demande</p></div><button type="button" class="chat-tool-close" aria-label="Fermer">×</button></header><div class="chat-tool-presets" role="group" aria-label="Préréglages des outils"><button type="button" data-tool-preset="code">Coder</button><button type="button" data-tool-preset="explore">Explorer</button><button type="button" data-tool-preset="all">Complet</button></div><div class="chat-tool-options"></div><p class="chat-tool-note">Lecture locale, pièces jointes, plan et questions restent disponibles. Le choix ne change pas les autorisations : le terminal ou un service MCP peut aussi modifier des fichiers.</p><p class="chat-tool-feedback" role="status"></p>';
document.body.append(chatToolMenu);
function chatToolOptions() {
    if (isMotionOpen() || ui.status.motionDesign) return {};
    return { toolGroups: chatToolSelections.has(chatToolContext) ? [...chatToolSelections.get(chatToolContext)] : null };
}
function refreshChatToolChoice() {
    const selected = chatToolSelections.get(chatToolContext);
    const preset = selected === undefined ? "Complet" : selected.length === chatToolCatalog.length ? "Complet" : Object.entries(chatToolPresets).find(([, ids]) => ids.length === selected.length && ids.every(id => selected.includes(id)))?.[0];
    const label = preset === "code" ? "Coder" : preset === "explore" ? "Explorer" : preset || `${selected.length} groupes`;
    chatToolButton.querySelector(".chat-control-label").textContent = `Outils · ${label}`;
    chatToolButton.title = "Choisir les outils de la prochaine demande à l’agent";
    for (const input of chatToolMenu.querySelectorAll('input[type="checkbox"]')) input.checked = selected === undefined || selected.includes(input.value);
    for (const button of chatToolMenu.querySelectorAll("[data-tool-preset]")) {
        const id = button.dataset.toolPreset, ids = chatToolPresets[id];
        button.setAttribute("aria-pressed", String(id === "all" ? selected === undefined || selected.length === chatToolCatalog.length : selected !== undefined && ids.length === selected.length && ids.every(value => selected.includes(value))));
    }
}
function positionChatToolChoice() {
    const rect = chatToolButton.getBoundingClientRect(), width = Math.min(400, window.innerWidth - 24);
    chatToolMenu.style.width = `${width}px`;
    chatToolMenu.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`;
    chatToolMenu.style.maxHeight = `${Math.max(80, rect.top - 20)}px`;
    chatToolMenu.style.top = `${Math.max(12, rect.top - chatToolMenu.getBoundingClientRect().height - 8)}px`;
}
function updateChatToolSelection(status) {
    chatToolContext = status.workspace || "";
    chatToolMotion = Boolean(status.motionDesign) || isMotionOpen();
    chatToolButton.hidden = chatToolMotion;
    chatToolButton.disabled = !status.booted || !chatToolContext || !chatToolCatalog.length;
    if (chatToolMotion && chatToolMenu.matches(":popover-open")) chatToolMenu.hidePopover();
    refreshChatToolChoice();
}
chatToolButton.onclick = () => {
    if (chatToolMenu.matches(":popover-open")) { chatToolMenu.hidePopover(); return; }
    hideModelMenu(); chatToolMenu.showPopover(); positionChatToolChoice(); chatToolMenu.querySelector("input")?.focus();
};
chatToolMenu.querySelector(".chat-tool-close").onclick = () => { chatToolMenu.hidePopover(); chatToolButton.focus(); };
for (const button of chatToolMenu.querySelectorAll("[data-tool-preset]")) button.onclick = () => {
    if (button.dataset.toolPreset === "all") chatToolSelections.delete(chatToolContext);
    else chatToolSelections.set(chatToolContext, [...chatToolPresets[button.dataset.toolPreset]]);
    refreshChatToolChoice(); chatToolMenu.querySelector(".chat-tool-feedback").textContent = "Choix prêt pour la prochaine demande. La tâche en cours garde ses outils.";
};
chatToolMenu.addEventListener("toggle", () => chatToolButton.setAttribute("aria-expanded", String(chatToolMenu.matches(":popover-open"))));
window.addEventListener("resize", () => { if (chatToolMenu.matches(":popover-open")) positionChatToolChoice(); });
api.agentTools().then(({ groups }) => {
    chatToolCatalog = groups;
    for (const group of groups) {
        const row = document.createElement("label"), input = document.createElement("input"), copy = document.createElement("span");
        input.type = "checkbox"; input.value = group.id;
        const name = document.createElement("strong"), description = document.createElement("small"); name.textContent = group.label; description.textContent = group.description;
        copy.append(name, description); row.append(input, copy); chatToolMenu.querySelector(".chat-tool-options").append(row);
        input.onchange = () => { chatToolSelections.set(chatToolContext, [...chatToolMenu.querySelectorAll("input:checked")].map(field => field.value)); refreshChatToolChoice(); chatToolMenu.querySelector(".chat-tool-feedback").textContent = "Choix prêt pour la prochaine demande."; };
    }
    updateChatToolSelection(ui.status);
}).catch(error => { chatToolButton.disabled = true; chatToolButton.title = error.message; });
updateChatToolSelection(ui.status);
new MutationObserver(() => updateChatToolSelection(ui.status)).observe($("app"), { attributes: true, attributeFilter: ["class"] });
