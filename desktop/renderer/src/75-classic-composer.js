/* Compositeur du chat classique : les actions réutilisent les contrôles existants. */
const classicToolsButton = document.createElement("button");
classicToolsButton.type = "button"; classicToolsButton.id = "classic-tools-button";
classicToolsButton.textContent = "+"; classicToolsButton.title = "Outils du chat";
classicToolsButton.setAttribute("aria-label", "Outils du chat"); classicToolsButton.setAttribute("aria-haspopup", "menu"); classicToolsButton.setAttribute("aria-expanded", "false");
$("btn-attach").before(classicToolsButton);
const classicToolsMenu = document.createElement("div"); classicToolsMenu.className = "classic-tools-menu";
classicToolsMenu.setAttribute("popover", "auto"); classicToolsMenu.setAttribute("role", "menu"); classicToolsMenu.setAttribute("aria-label", "Outils du chat");
for (const [label, icon, action] of [
    ["Fichiers", "📎", () => $("btn-attach").click()],
    ["Recherche web", "◎", () => $("set-web-search").click()],
    ["Image", "▧", () => chatImageButton.click()]
]) {
    const button = document.createElement("button"); button.type = "button"; button.setAttribute("role", "menuitem");
    const symbol = document.createElement("span"); symbol.textContent = icon; symbol.setAttribute("aria-hidden", "true");
    const text = document.createElement("span"); text.textContent = label; button.append(symbol, text);
    if (label === "Recherche web") { button.id = "classic-web-search"; button.setAttribute("role", "menuitemcheckbox"); }
    button.onclick = () => { classicToolsMenu.hidePopover(); action(); };
    classicToolsMenu.append(button);
}
document.body.append(classicToolsMenu);
classicToolsButton.onclick = () => {
    if (classicToolsMenu.matches(":popover-open")) { classicToolsMenu.hidePopover(); return; }
    $("classic-web-search").setAttribute("aria-checked", String($("set-web-search").checked));
    classicToolsMenu.showPopover();
    const rect = classicToolsButton.getBoundingClientRect(), menu = classicToolsMenu.getBoundingClientRect();
    classicToolsMenu.style.left = `${Math.max(8, Math.min(rect.left, innerWidth - menu.width - 8))}px`;
    classicToolsMenu.style.top = `${Math.max(8, rect.top - menu.height - 8)}px`;
    classicToolsMenu.querySelector("button")?.focus();
};
classicToolsMenu.addEventListener("toggle", () => classicToolsButton.setAttribute("aria-expanded", String(classicToolsMenu.matches(":popover-open"))));
