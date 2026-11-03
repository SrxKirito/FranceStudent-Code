/* Mode image explicite du chat normal. L’activation met à jour la préférence du compte. */
const chatImageButton = document.createElement("button");
chatImageButton.type = "button"; chatImageButton.id = "chat-image-mode"; chatImageButton.textContent = "Image";
chatImageButton.setAttribute("aria-haspopup", "dialog"); chatImageButton.setAttribute("aria-expanded", "false");
composerSettingsRow.append(chatImageButton);
const chatImageMenu = document.createElement("div"); chatImageMenu.className = "chat-access-menu chat-image-menu";
chatImageMenu.setAttribute("popover", "auto"); chatImageMenu.setAttribute("role", "dialog"); chatImageMenu.setAttribute("aria-label", "Génération d’image");
chatImageMenu.innerHTML = '<div class="chat-access-heading">Génération d’image</div><p>Activer ce mode utilise le modèle choisi sur ton compte FranceStudent.</p><label>Modèle <select aria-label="Modèle d’image"><option value="gpt-image-2.5-flare">GPT Image 2.5 Flare</option><option value="gpt-image-2.5-sunburst">GPT Image 2.5 Sunburst</option><option value="gpt-image-2">GPT Image 2</option></select></label><p data-image-status role="status"></p><button type="button" data-image-action>Activer</button>';
document.body.append(chatImageMenu);
let chatImageEnabled = false;
function updateImageModeUi() { if (!ui.status.booted) chatImageEnabled = false; chatImageButton.hidden = ui.status.mode !== "chat"; chatImageButton.textContent = chatImageEnabled ? "Image · activée" : "Image"; chatImageMenu.querySelector("[data-image-action]").textContent = chatImageEnabled ? "Désactiver" : "Activer"; }
chatImageButton.onclick = async () => {
    if (chatImageMenu.matches(":popover-open")) { chatImageMenu.hidePopover(); return; }
    try { const state = await api.imageMode("status"); chatImageEnabled = state.enabled; chatImageMenu.querySelector("select").value = state.model; updateImageModeUi(); }
    catch (error) { studioFeedback(error.message); return; }
    const rect = (ui.status.mode === "chat" && $("classic-tools-button") ? $("classic-tools-button") : chatImageButton).getBoundingClientRect(); chatImageMenu.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - 300))}px`; chatImageMenu.style.top = `${Math.max(8, rect.top - 200)}px`; chatImageMenu.style.width = "min(290px, calc(100vw - 16px))"; chatImageMenu.showPopover();
};
chatImageMenu.addEventListener("toggle", () => chatImageButton.setAttribute("aria-expanded", String(chatImageMenu.matches(":popover-open"))));
chatImageMenu.querySelector("[data-image-action]").onclick = async event => {
    event.currentTarget.disabled = true; const status = chatImageMenu.querySelector("[data-image-status]"); status.textContent = "";
    try { const state = await api.imageMode(chatImageEnabled ? "disable" : "enable", chatImageMenu.querySelector("select").value); chatImageEnabled = state.enabled; updateImageModeUi(); chatImageMenu.hidePopover(); }
    catch (error) { status.textContent = error.message; } finally { event.currentTarget.disabled = false; }
};
const oldUpdateChatModeMenu = updateChatModeMenu;
updateChatModeMenu = function(status) { oldUpdateChatModeMenu(status); updateImageModeUi(); };
updateImageModeUi();
