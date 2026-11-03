// Panneau « Nouvel onglet » à droite du chat plein écran : onglet, barre d'adresse, Outils, Suggestions.
// Les adresses HTTP(S) s'ouvrent dans le navigateur intégré du panneau.
const BROWSER_HOME_KEY = "fs.browserHome.open";
const browserHomeSuggestions = [
    { title: "FranceStudent Code", detail: "github.com", url: "https://github.com/SrxKirito/FranceStudent-Code", icon: "github" },
    { title: "francestudents-ide", detail: "github.com", url: "https://github.com/extraopaa/francestudents-ide", icon: "github" },
    { title: "SideStore Docs", detail: "docs.sidestore.io", url: "https://docs.sidestore.io", icon: "globe" },
];
const browserHomeIcons = {
    github: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 19c-4 1.5-4-2-6-2.5"/><path d="M15 21v-3.5a3 3 0 0 0-.9-2.3c3-.3 6-1.5 6-6.5a5 5 0 0 0-1.4-3.5 4.7 4.7 0 0 0-.1-3.5s-1.1-.3-3.6 1.4a12.4 12.4 0 0 0-6.5 0C6 1.4 4.9 1.7 4.9 1.7a4.7 4.7 0 0 0-.1 3.5A5 5 0 0 0 3.4 8.7c0 5 3 6.2 6 6.5a3 3 0 0 0-.9 2.3V21"/></svg>',
    globe: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3a14 14 0 0 1 0 18"/><path d="M12 3a14 14 0 0 0 0 18"/></svg>',
    changes: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><circle cx="6" cy="6" r="2"/><circle cx="6" cy="18" r="2"/><circle cx="18" cy="9" r="2"/><path d="M6 8v8"/><path d="M18 11a6 6 0 0 1-6 6H8"/></svg>',
    terminal: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3"/><path d="M12 15h5"/></svg>',
    files: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M4 5a2 2 0 0 1 2-2h5l2 3h5a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2z"/></svg>',
    back: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M15 6l-6 6 6 6"/></svg>',
    forward: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>',
    reload: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 5.7"/><path d="M20 4v7h-7"/></svg>',
    external: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6"/><path d="M20 4l-9 9"/><path d="M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/></svg>',
    close: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12"/><path d="M18 6L6 18"/></svg>',
    plus: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14"/><path d="M5 12h14"/></svg>',
    panel: '<svg class="i" viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/></svg>',
};

function browserHomeButton(icon, label, onClick, className = "browser-home-icon-btn") {
    const button = document.createElement("button");
    button.type = "button";
    button.className = className;
    button.title = label;
    button.setAttribute("aria-label", label);
    button.innerHTML = browserHomeIcons[icon];
    if (onClick) button.onclick = onClick; else button.disabled = true;
    return button;
}

function browserHomeResolve(raw) {
    const text = String(raw || "").trim();
    if (!text) return null;
    let url;
    if (/^[a-z][\w+.-]*:\/\//i.test(text)) url = text;
    else if (/^(localhost|127\.0\.0\.1)(:\d+)?(\/|$)/i.test(text)) url = `http://${text}`;
    else if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/.test(text)) url = `https://${text}`;
    else url = `https://www.google.com/search?q=${encodeURIComponent(text)}`;
    try {
        const parsed = new URL(url);
 return /^https?:$/.test(parsed.protocol) ? parsed : null;
    } catch { return null; }
}

function browserHomeOpenExternal(url) {
    Promise.resolve(api.openExternal(url, true)).catch((error) => studioFeedback(`Impossible d'ouvrir ${url} : ${error?.message || error}`));
}

function browserHomeNavigate(raw) {
    const parsed = browserHomeResolve(raw);
    if (!parsed) { studioFeedback("Adresse invalide : seules les adresses http(s) sont acceptées."); return; }
    browserHomeShow("browser");
    Promise.resolve(openLocalBrowser(parsed.href)).catch((error) => studioFeedback(error?.message || String(error)));
}

function setBrowserHomeOpen(open) {
    $("app").classList.toggle("browser-home-open", open);
    localStorage.setItem(BROWSER_HOME_KEY, open ? "1" : "0");
    const toggle = $("browser-home-toggle");
    if (toggle) toggle.setAttribute("aria-pressed", String(open));
}

const browserHome = document.createElement("aside");
browserHome.id = "browser-home";
browserHome.setAttribute("aria-label", "Nouvel onglet");

const browserHomeTabs = document.createElement("div");
browserHomeTabs.className = "browser-home-tabs";
browserHomeTabs.setAttribute("role", "tablist");
const browserHomeTabItems = [];
let browserHomeActiveTab = null;
const browserHomeNewTabButton = browserHomeButton("plus", "Nouvel onglet", () => browserHomeAddTab());
browserHomeTabs.append(browserHomeNewTabButton);

function browserHomeActivateTab(tab) {
    if (browserHomeActiveTab === tab) return;
    if (browserHomeActiveTab) {
        browserHomeActiveTab.view = browserHomeCurrent;
        browserHomeActiveTab.address = browserHomeCurrent === "browser" ? (localBrowserState?.url || browserHomeAddress.value) : browserHomeAddress.value;
    }
    browserHomeActiveTab = tab;
    for (const item of browserHomeTabItems) {
        const active = item === tab;
        item.element.classList.toggle("active", active);
        item.select.setAttribute("aria-selected", String(active));
        item.select.tabIndex = active ? 0 : -1;
    }
    browserHomeAddress.value = tab.address;
    browserHomeShow(tab.view);
    if (tab.view === "browser" && tab.address) openLocalBrowser(tab.address);
}

function browserHomeAddTab() {
    const tab = { view: "home", address: "" };
    const element = document.createElement("div");
    element.className = "browser-home-tab";
    const select = document.createElement("button");
    select.type = "button";
    select.className = "browser-home-tab-title";
    select.setAttribute("role", "tab");
    select.textContent = "Nouvel onglet";
    select.onclick = () => browserHomeActivateTab(tab);
    const close = browserHomeButton("close", "Fermer l’onglet", () => {
        const index = browserHomeTabItems.indexOf(tab);
        const wasActive = tab === browserHomeActiveTab;
        browserHomeTabItems.splice(index, 1);
        element.remove();
        if (!browserHomeTabItems.length) {
            browserHomeActiveTab = null;
            browserHomeShow("home");
            setBrowserHomeOpen(false);
            browserHomeAddTab();
        } else if (wasActive) {
            browserHomeActiveTab = null;
            browserHomeActivateTab(browserHomeTabItems[Math.min(index, browserHomeTabItems.length - 1)]);
        }
    }, "browser-home-tab-close");
    tab.element = element;
    tab.select = select;
    element.append(select, close);
    browserHomeTabItems.push(tab);
    browserHomeTabs.insertBefore(element, browserHomeNewTabButton);
    browserHomeActivateTab(tab);
    browserHomeAddress.focus();
}

const browserHomeToolbar = document.createElement("form");
browserHomeToolbar.className = "browser-home-toolbar";
const browserHomeAddress = document.createElement("input");
browserHomeAddress.id = "browser-home-address";
browserHomeAddress.type = "text";
browserHomeAddress.autocomplete = "off";
browserHomeAddress.spellcheck = false;
browserHomeAddress.placeholder = "Rechercher ou saisir une URL";
browserHomeAddress.setAttribute("aria-label", "Rechercher ou saisir une URL");
const browserHomeBack = browserHomeButton("back", "Page précédente", () => $("local-browser-back").click());
const browserHomeForward = browserHomeButton("forward", "Page suivante", () => $("local-browser-forward").click());
const browserHomeReload = browserHomeButton("reload", "Actualiser", () => $("local-browser-reload").click());
browserHomeBack.disabled = true;
browserHomeForward.disabled = true;
browserHomeToolbar.append(
    browserHomeBack,
    browserHomeForward,
    browserHomeReload,
    browserHomeAddress,
    browserHomeButton("external", "Ouvrir dans le navigateur système", () => { const url = browserHomeResolve(browserHomeAddress.value || "https://www.google.com"); if (url) browserHomeOpenExternal(url.href); }),
);
browserHomeToolbar.onsubmit = (event) => { event.preventDefault(); const value = browserHomeAddress.value; browserHomeAddress.blur(); browserHomeNavigate(value); };
window.addEventListener("frst-local-browser-state", (event) => {
    if (browserHomeCurrent !== "browser") return;
    const state = event.detail;
    if (document.activeElement !== browserHomeAddress) browserHomeAddress.value = state.url || "";
    if (browserHomeActiveTab) browserHomeActiveTab.address = state.url || "";
    browserHomeBack.disabled = !state.canGoBack;
    browserHomeForward.disabled = !state.canGoForward;
});

const browserHomeBody = document.createElement("div");
browserHomeBody.className = "browser-home-body";

const browserHomeTools = [
    // Les trois outils s'affichent dans ce panneau (voir 64-browser-panels.js) sans quitter le plein écran du chat.
    { icon: "changes", label: "Modifications", keys: "Ctrl+Shift+G", run: () => browserHomeShow("changes") },
    { icon: "terminal", label: "Terminal", keys: "Ctrl+`", run: () => browserHomeShow("terminal") },
    { icon: "files", label: "Fichiers", keys: "Ctrl+P", run: () => browserHomeShow("files") },
];
const browserHomeToolsSection = document.createElement("section");
browserHomeToolsSection.className = "browser-home-section";
browserHomeToolsSection.append(centerNode("h2", "browser-home-heading", "Outils"));
const browserHomeToolsList = document.createElement("div");
browserHomeToolsList.className = "browser-home-tools";
for (const tool of browserHomeTools) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "browser-home-tool";
    button.innerHTML = browserHomeIcons[tool.icon];
    button.append(centerNode("span", "browser-home-tool-label", tool.label), centerNode("kbd", "browser-home-kbd", tool.keys));
    button.onclick = tool.run;
    browserHomeToolsList.append(button);
}
browserHomeToolsSection.append(browserHomeToolsList);

const browserHomeSuggestSection = document.createElement("section");
browserHomeSuggestSection.className = "browser-home-section";
browserHomeSuggestSection.append(centerNode("h2", "browser-home-heading", "Suggestions"));
const browserHomeSuggestList = document.createElement("div");
browserHomeSuggestList.className = "browser-home-suggestions";
for (const item of browserHomeSuggestions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "browser-home-suggestion";
    button.title = item.url;
    const icon = document.createElement("span");
    icon.className = "browser-home-suggestion-icon";
    icon.innerHTML = browserHomeIcons[item.icon];
    button.append(icon, centerNode("span", "browser-home-suggestion-title", item.title), centerNode("span", "browser-home-suggestion-detail", item.detail));
    button.onclick = () => browserHomeNavigate(item.url);
    browserHomeSuggestList.append(button);
}
browserHomeSuggestSection.append(browserHomeSuggestList);

browserHomeBody.append(browserHomeToolsSection, browserHomeSuggestSection);
browserHome.append(browserHomeTabs, browserHomeToolbar, browserHomeBody);
$("agent").append(browserHome);

const browserHomeResize = document.createElement("div");
browserHomeResize.className = "browser-home-resize";
browserHomeResize.setAttribute("role", "separator");
browserHomeResize.setAttribute("aria-label", "Redimensionner le panneau droit");
browserHomeResize.setAttribute("aria-orientation", "vertical");
browserHomeResize.tabIndex = 0;
function browserHomeSetWidth(width) {
    const max = Math.max(180, Math.min(900, $("agent").clientWidth - 52));
    const value = Math.max(180, Math.min(max, width));
    $("app").style.setProperty("--browser-home-width", `${value}px`);
    browserHomeResize.setAttribute("aria-valuenow", String(Math.round(value)));
    browserHomeResize.setAttribute("aria-valuemin", "180");
    browserHomeResize.setAttribute("aria-valuemax", String(Math.round(max)));
}
browserHomeResize.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    event.preventDefault();
    browserHomeResize.setPointerCapture(event.pointerId);
});
browserHomeResize.addEventListener("pointermove", (event) => {
    if (browserHomeResize.hasPointerCapture(event.pointerId)) browserHomeSetWidth(browserHome.getBoundingClientRect().right - event.clientX);
});
browserHomeResize.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    browserHomeSetWidth(browserHome.getBoundingClientRect().width + (event.key === "ArrowLeft" ? 20 : -20));
});
browserHome.prepend(browserHomeResize);

const browserHomeActions = document.querySelector("#agent .chat-navigation-actions");
if (browserHomeActions) {
    const toggle = browserHomeButton("panel", "Afficher ou masquer le panneau Nouvel onglet", () => setBrowserHomeOpen(!$("app").classList.contains("browser-home-open")), "browser-home-toggle");
    toggle.id = "browser-home-toggle";
    browserHomeActions.append(toggle);
}
setBrowserHomeOpen(localStorage.getItem(BROWSER_HOME_KEY) !== "0");
