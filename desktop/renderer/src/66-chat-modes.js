/* Sélection du chat normal et de l’agent, avec historiques distincts. */
const chatModeToggle = $("codex-mode-toggle");
const chatModeMenu = document.createElement("div");
chatModeMenu.className = "codex-mode-menu";
chatModeMenu.setAttribute("popover", "auto");
chatModeMenu.setAttribute("role", "menu");
chatModeMenu.setAttribute("aria-label", "Choisir le mode de conversation");
for (const [mode, label, description] of [["chat", "FranceStudent", "Discuter, créer et explorer"], ["agent", "FranceStudent Code", "Développer avec les outils de l’agent"]]) {
    const button = document.createElement("button"); button.type = "button"; button.dataset.chatMode = mode; button.setAttribute("role", "menuitemradio");
    button.append(centerNode("strong", "", label), centerNode("small", "", description));
    button.onclick = async () => {
        chatModeMenu.hidePopover();
        if (isMotionOpen()) { await closeMotionDesign(); if (isMotionOpen()) return; }
        try { afterConversationOpened(await api.switchChatMode(mode)); setAgentTab("conversation"); renderCodexRail(); }
        catch (error) { studioFeedback(error.message); }
    };
    chatModeMenu.append(button);
}
document.body.append(chatModeMenu);
chatModeToggle.onclick = () => {
    if (chatModeMenu.matches(":popover-open")) { chatModeMenu.hidePopover(); return; }
    const rect = chatModeToggle.getBoundingClientRect();
    chatModeMenu.style.left = `${Math.max(8, rect.left)}px`; chatModeMenu.style.top = `${rect.bottom + 6}px`;
    chatModeMenu.showPopover();
};
chatModeMenu.addEventListener("toggle", () => chatModeToggle.setAttribute("aria-expanded", String(chatModeMenu.matches(":popover-open"))));
let lastChatMode = null;
function updateChatModeMenu(status) {
    if (!status?.mode) return;
    const mode = status.mode === "chat" ? "chat" : "agent";
    document.getElementById("app").classList.toggle("classic-chat-mode", mode === "chat" && !status.motionDesign);
    input.placeholder = mode === "chat" ? "Pose ta question…" : "Demande à l’agent… (/ pour les commandes)";
    chatModeToggle.firstChild.textContent = mode === "chat" ? "FranceStudent " : "FranceStudent Code ";
    for (const button of chatModeMenu.children) button.setAttribute("aria-checked", String(button.dataset.chatMode === mode));
    if (lastChatMode !== mode) {
        lastChatMode = mode;
        const selected = franceStudentProjects.find(item => String(item.id) === $("agent-fr-project").value) || null;
        renderFranceStudentProjects(selected);
        renderCodexRail();
    }
}
$("mode-select").onchange = async event => {
    const mode = event.target.value === "chat" ? "chat" : "agent";
    try { afterConversationOpened(await api.switchChatMode(mode)); }
    catch (error) { studioFeedback(error.message); event.target.value = ui.status.mode; }
};
updateChatModeMenu(ui.status);
