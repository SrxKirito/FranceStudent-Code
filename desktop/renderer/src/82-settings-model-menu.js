/* Sélecteurs des paramètres : le select existant reste la source de vérité. */
const settingsModelMenus = new WeakMap();
let settingsModelMenuSequence = 0;
function syncSettingsModelMenu(select) {
    const menu = settingsModelMenus.get(select);
    if (menu) menu.sync();
}
function createSettingsModelMenu(select, label, imageModels = false) {
    const root = centerNode("div", "settings-model-picker");
    const trigger = centerNode("button", "settings-model-trigger"); trigger.type = "button";
    const icon = centerNode("span", "settings-model-icon"); icon.setAttribute("aria-hidden", "true");
    const name = centerNode("span", "settings-model-name");
    const chevron = centerNode("span", "settings-model-chevron", "⌄"); chevron.setAttribute("aria-hidden", "true");
    trigger.append(icon, name, chevron);
    trigger.setAttribute("aria-label", label); trigger.setAttribute("aria-haspopup", "listbox"); trigger.setAttribute("aria-expanded", "false");
    const list = centerNode("div", "settings-model-list"); list.id = `settings-model-list-${++settingsModelMenuSequence}`;
    list.setAttribute("role", "listbox"); list.setAttribute("aria-label", label); list.hidden = true; trigger.setAttribute("aria-controls", list.id);
    select.hidden = true; select.setAttribute("aria-hidden", "true"); select.tabIndex = -1;
    select.after(root); root.append(trigger, list);
    function info(option) { return { name: option.textContent, provider: imageModels ? "OpenAI" : option.dataset.provider, model: option.dataset.model }; }
    function optionIcon(option) {
        if (!option || (!imageModels && option.value === "")) return centerNode("span", "settings-model-sparkle", "✧");
        const logo = modelLogo(info(option), "settings-model-logo");
        if (logo) { logo.alt = ""; return logo; }
        const mark = centerNode("span", "settings-model-generic", "◇"); mark.setAttribute("aria-hidden", "true"); return mark;
    }
    function close(restoreFocus = false) {
        list.hidden = true; trigger.setAttribute("aria-expanded", "false");
        if (restoreFocus && !trigger.disabled && trigger.isConnected) trigger.focus();
    }
    function sync() {
        const option = select.selectedOptions[0];
        name.textContent = option?.textContent || "Choisir un modèle";
        trigger.setAttribute("aria-label", `${label} : ${name.textContent}`);
        icon.replaceChildren(optionIcon(option));
        trigger.disabled = select.matches(":disabled");
        if (trigger.disabled) close();
        if (!list.hidden) renderList();
    }
    function renderList() {
        list.replaceChildren();
        let lastGroup = "";
        for (const option of select.options) {
            if (option.hidden) continue;
            const vendor = modelVendor(info(option));
            const group = !imageModels && !option.value ? "" : vendor === "gpt" ? "OpenAI" : vendor === "claude" ? "Anthropic" : vendor === "gemini" ? "Google" : "Autres modèles";
            if (!imageModels && group && group !== lastGroup) {
                const heading = centerNode("div", "settings-model-group", group); heading.setAttribute("aria-hidden", "true"); list.append(heading);
            }
            lastGroup = group;
            const item = centerNode("button", "settings-model-option"); item.type = "button";
            item.setAttribute("role", "option"); item.setAttribute("aria-selected", String(option.selected)); item.disabled = option.disabled; item.tabIndex = -1;
            const mark = optionIcon(option); mark.setAttribute("aria-hidden", "true");
            const text = centerNode("span", "settings-model-option-name", option.textContent);
            const check = centerNode("span", "settings-model-check", option.selected ? "✓" : ""); check.setAttribute("aria-hidden", "true");
            item.append(mark, text, check);
            item.onclick = () => {
                if (select.value !== option.value) { select.value = option.value; select.dispatchEvent(new Event("change", { bubbles: true })); }
                sync(); close(true);
            };
            list.append(item);
        }
    }
    function open() {
        if (trigger.disabled) return;
        document.querySelectorAll(".settings-model-picker").forEach(other => { if (other !== root) other.dispatchEvent(new Event("settings-model-close")); });
        renderList(); list.hidden = false; trigger.setAttribute("aria-expanded", "true");
        (list.querySelector('[aria-selected="true"]:not(:disabled)') || list.querySelector('[role="option"]:not(:disabled)'))?.focus();
    }
    trigger.onclick = () => { if (list.hidden) open(); else close(); };
    trigger.onkeydown = event => { if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); open(); } };
    list.onkeydown = event => {
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close(true); return; }
        const options = [...list.querySelectorAll('[role="option"]:not(:disabled)')], index = options.indexOf(document.activeElement);
        if (!options.length) return;
        let next;
        if (event.key === "ArrowDown") next = (index + 1) % options.length;
        else if (event.key === "ArrowUp") next = (index - 1 + options.length) % options.length;
        else if (event.key === "Home") next = 0;
        else if (event.key === "End") next = options.length - 1;
        else return;
        event.preventDefault(); options[next].focus();
    };
    root.addEventListener("settings-model-close", () => close());
    root.addEventListener("keydown", event => { if (event.key === "Tab") setTimeout(() => close(), 0); });
    document.addEventListener("click", event => { if (!root.contains(event.target)) close(); });
    select.addEventListener("change", sync);
    const observer = new MutationObserver(sync);
    observer.observe(select, { childList: true, subtree: true, attributes: true, attributeFilter: ["disabled", "label", "selected", "hidden"] });
    const fieldset = select.closest("fieldset");
    if (fieldset) observer.observe(fieldset, { attributes: true, attributeFilter: ["disabled"] });
    settingsModelMenus.set(select, { sync }); sync();
}
createSettingsModelMenu($("settings-default-model"), "Modèle par défaut");
createSettingsModelMenu(mobileImageFields.querySelector("[data-image-model]"), "Modèle d’image", true);
