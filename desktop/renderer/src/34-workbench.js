/* Classe les réglages par catégorie. */
const settingsNavigation = centerNode("nav", "settings-navigation");
settingsNavigation.setAttribute("aria-label", "Catégories des paramètres");
let settingsCategory = "account";
const settingsGroups = [
    ["account", "Compte"], ["general", "Général"],
    ["agent", "IA et contexte"], ["access", "Autorisations"], ["advanced", "Connexions et outils"]
];
const settingsGroupByTitle = {
    "settings-model-title": "general", "studio-editor-settings-title": "general",
    "settings-context-title": "agent", "settings-web-title": "agent",
    "settings-access-title": "access", "settings-tools-title": "advanced",
    "settings-marketplace-title": "advanced", "settings-help-title": "account"
};
captureSettings.dataset.settingsGroup = "access";
updateSettings.dataset.settingsGroup = "general";
function filterSettingsCards() {
    for (const card of $("settings-view").querySelectorAll(".settings-card")) {
        const group = card.dataset.settingsGroup || settingsGroupByTitle[card.getAttribute("aria-labelledby")] || "general";
        card.classList.toggle("hidden", settingsCategory !== group);
    }
    for (const button of settingsNavigation.children) {
        button.setAttribute("aria-pressed", String(button.dataset.category === settingsCategory));
    }
    const title = $("settings-view").querySelector(".settings-layout-main > h1");
    if (title) title.textContent = settingsGroups.find(group => group[0] === settingsCategory)?.[1] || "Paramètres";
}
for (const [id, label] of settingsGroups) {
    const button = centerNode("button");
    const iconPaths = {
        account: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
        general: '<path d="M5 3v7m0 4v7M12 3v3m0 4v11M19 3v11m0 4v3M2 10h6M9 6h6m1 8h6"/>'
    };
    if (iconPaths[id]) {
        const icon = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        icon.setAttribute("viewBox", "0 0 24 24"); icon.setAttribute("aria-hidden", "true"); icon.innerHTML = iconPaths[id]; button.append(icon);
    }
    button.append(document.createTextNode(label));
    button.type = "button"; button.dataset.category = id;
    button.onclick = () => { settingsCategory = id; filterSettingsCards(); };
    settingsNavigation.append(button);
}
$("settings-view").querySelector(".sidebar-header").after(settingsNavigation);
filterSettingsCards();
// Expose icon-only navigation names to keyboard and assistive technology.
for (const button of document.querySelectorAll("#activity-bar button, .agent-actions button, .sidebar-actions button")) {
    if (!button.hasAttribute("aria-label") && button.title) button.setAttribute("aria-label", button.title);
}
