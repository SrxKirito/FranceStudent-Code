/* FranceStudent stores this preference on the account, not in each chat. */
const reasoningButton = document.createElement("button");
reasoningButton.id = "chat-reasoning"; reasoningButton.type = "button"; reasoningButton.hidden = true;
reasoningButton.setAttribute("aria-haspopup", "menu"); reasoningButton.setAttribute("aria-expanded", "false");
reasoningButton.setAttribute("aria-controls", "chat-reasoning-menu");
$("btn-model").after(reasoningButton);
reasoningButton.innerHTML = '<span class="combined-model-name"></span><span class="combined-reasoning-level"></span><svg class="combined-model-chevron" viewBox="0 0 24 24" aria-hidden="true"><path d="m7 10 5 5 5-5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
$("btn-model").hidden = true;
const reasoningMenu = document.createElement("div");
reasoningMenu.id = "chat-reasoning-menu"; reasoningMenu.className = "chat-access-menu"; reasoningMenu.setAttribute("popover", "auto");
reasoningMenu.innerHTML = `<div class="reasoning-compact"><div class="reasoning-header"><span class="reasoning-symbol" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="m13 2-8 11h6l-1 9 9-12h-6l1-8Z"/></svg></span><div class="reasoning-caption"><strong class="reasoning-level"></strong><button type="button" class="reasoning-model" title="Changer de modèle"></button></div><button type="button" class="reasoning-reset" aria-label="Rétablir le niveau à l’ouverture" title="Rétablir le niveau à l’ouverture"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7v5h5M5 11a7 7 0 1 1 2 6"/></svg></button></div><div class="reasoning-range"><div class="reasoning-ticks" aria-hidden="true"></div><input class="reasoning-slider" type="range" min="0" step="1" aria-label="Niveau de réflexion"></div><p class="chat-access-error" role="status"></p></div>`;
document.body.append(reasoningMenu);
const reasoningLabels = { none: ["Désactivée", "Privilégie une réponse rapide, sans raisonnement supplémentaire."], minimal: ["Minimale", "Réflexion très courte."], low: ["Faible", "Privilégie la rapidité et une consommation réduite."], medium: ["Moyenne", "Équilibre entre rapidité et réflexion."], high: ["Élevée", "Davantage de réflexion pour les tâches difficiles."], xhigh: ["Très élevée", "Réflexion approfondie, potentiellement plus lente et coûteuse."] };
let reasoningSnapshot = null, reasoningModelKey = null, reasoningSerial = 0, reasoningLoading = false, reasoningSavingUi = false, reasoningDraftLevel = null, reasoningOpeningLevel = null;
function positionReasoningMenu() {
    const rect = reasoningButton.getBoundingClientRect(), width = Math.min(240, window.innerWidth - 24);
    reasoningMenu.style.width = `${width}px`; reasoningMenu.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`;
    reasoningMenu.style.maxHeight = `${Math.max(80, rect.top - 20)}px`;
    reasoningMenu.style.top = `${Math.max(12, rect.top - reasoningMenu.getBoundingClientRect().height - 8)}px`;
}
function paintReasoning() {
    const snapshot = reasoningSnapshot;
    const hasLevels = Boolean(snapshot?.levels?.length);
    reasoningButton.hidden = false;
    reasoningButton.disabled = !ui.status.booted || reasoningSavingUi || Boolean(ui.status.busy);
    const modelName = ui.status.model || $("model-label").textContent || "Modèle";
    const visibleLevel = reasoningDraftLevel ?? snapshot?.level;
    const supported = hasLevels && snapshot.levels.includes(visibleLevel);
    reasoningButton.querySelector(".combined-model-name").textContent = modelName;
    reasoningButton.querySelector(".combined-reasoning-level").textContent = supported ? (reasoningLabels[visibleLevel]?.[0] || visibleLevel) : "";
    reasoningButton.title = hasLevels ? `Modèle ${modelName} · réglage de réflexion` : `Choisir le modèle · ${modelName}`;
    if (!hasLevels) { if (reasoningMenu.matches(":popover-open")) reasoningMenu.hidePopover(); return; }
    const slider = reasoningMenu.querySelector(".reasoning-slider");
    const index = snapshot.levels.indexOf(visibleLevel);
    slider.max = String(snapshot.levels.length - 1); slider.value = String(Math.max(0, index));
    slider.disabled = reasoningSavingUi || Boolean(ui.status.busy);
    const ticks = reasoningMenu.querySelector(".reasoning-ticks");
    if (ticks.childElementCount !== snapshot.levels.length) ticks.replaceChildren(...snapshot.levels.map(() => document.createElement("span")));
    reasoningMenu.querySelector(".reasoning-reset").disabled = reasoningSavingUi || Boolean(ui.status.busy) || !reasoningOpeningLevel || reasoningOpeningLevel === snapshot.level;
    slider.setAttribute("aria-valuetext", supported ? (reasoningLabels[visibleLevel]?.[0] || visibleLevel) : "À choisir");
    slider.style.setProperty("--reasoning-progress", `${snapshot.levels.length > 1 ? Math.max(0, index) * 100 / (snapshot.levels.length - 1) : 0}%`);
    reasoningMenu.querySelector(".reasoning-level").textContent = supported ? (reasoningLabels[visibleLevel]?.[0] || visibleLevel) : "À choisir";
    reasoningMenu.querySelector(".reasoning-model").textContent = (ui.models?.agents || []).find(model => String(model.id) === String(snapshot.modelId))?.name || ui.status.model || $("model-label").textContent || "Modèle actuel";
    reasoningMenu.querySelector(".chat-access-error").textContent = supported ? "" : "Choisis un niveau de réflexion.";
}
async function loadChatReasoning() {
    if (!ui.status.booted || reasoningSavingUi) return;
    const serial = ++reasoningSerial; reasoningLoading = true; paintReasoning();
    try {
        const value = await api.reasoning();
        if (serial !== reasoningSerial || value.modelId !== ui.status.modelId) return;
        reasoningSnapshot = value;
    } catch (error) {
        if (serial === reasoningSerial) {
            reasoningSnapshot = null;
            if (reasoningMenu.matches(":popover-open")) studioFeedback(`Réflexion : ${error.message}`);
        }
    } finally {
        if (serial === reasoningSerial) { reasoningLoading = false; paintReasoning(); if (reasoningMenu.matches(":popover-open")) positionReasoningMenu(); }
    }
}
function updateChatReasoning(status) {
    const key = status.booted ? status.modelId : null;
    if (key !== reasoningModelKey) {
        reasoningModelKey = key; reasoningSerial++; reasoningSnapshot = null; reasoningDraftLevel = null; reasoningLoading = false;
        if (reasoningMenu.matches(":popover-open")) reasoningMenu.hidePopover();
        if (key !== null) loadChatReasoning();
    }
    paintReasoning();
}
async function saveChatReasoning(level) {
    if (reasoningSavingUi || ui.status.busy || !reasoningSnapshot) return;
    reasoningDraftLevel = level; reasoningSavingUi = true; reasoningSerial++; reasoningLoading = false; paintReasoning();
    try {
        const value = await api.reasoning("save", { modelId: reasoningSnapshot.modelId, level });
        if (value.modelId !== ui.status.modelId) return;
        reasoningSnapshot = value; reasoningDraftLevel = null;
        studioFeedback(`Réflexion ${reasoningLabels[level]?.[0].toLowerCase() || level} enregistrée sur ton compte FranceStudent.`);
    } catch (error) { reasoningDraftLevel = null; reasoningMenu.querySelector(".chat-access-error").textContent = error.message; studioFeedback(error.message); }
    finally { reasoningSavingUi = false; const message = reasoningMenu.querySelector(".chat-access-error").textContent; paintReasoning(); reasoningMenu.querySelector(".chat-access-error").textContent = message; }
}
reasoningButton.onclick = () => {
    if (!reasoningSnapshot?.levels?.length) { toggleModelMenu(); return; }
    if (reasoningMenu.matches(":popover-open")) { reasoningMenu.hidePopover(); return; }
    hideModelMenu(); if (chatAccessMenu.matches(":popover-open")) chatAccessMenu.hidePopover();
    reasoningOpeningLevel = reasoningSnapshot?.level || null;
    paintReasoning(); reasoningMenu.showPopover(); positionReasoningMenu();
    reasoningMenu.querySelector(".reasoning-slider")?.focus();
};
reasoningMenu.querySelector(".reasoning-model").onclick = () => { reasoningMenu.hidePopover(); void openModelMenu(); };
reasoningMenu.querySelector(".reasoning-reset").onclick = () => {
    if (reasoningOpeningLevel && reasoningSnapshot?.levels.includes(reasoningOpeningLevel)) void saveChatReasoning(reasoningOpeningLevel);
};
reasoningMenu.querySelector(".reasoning-slider").addEventListener("input", event => {
    const level = reasoningSnapshot?.levels[Number(event.target.value)];
    if (!level) return;
    reasoningDraftLevel = level;
    reasoningMenu.querySelector(".reasoning-level").textContent = reasoningLabels[level]?.[0] || level;
    event.target.setAttribute("aria-valuetext", reasoningLabels[level]?.[0] || level);
    event.target.style.setProperty("--reasoning-progress", `${Number(event.target.value) * 100 / Math.max(1, Number(event.target.max))}%`);
});
reasoningMenu.querySelector(".reasoning-slider").addEventListener("change", event => {
    const level = reasoningSnapshot?.levels[Number(event.target.value)]; if (level && level !== reasoningSnapshot.level) saveChatReasoning(level); else { reasoningDraftLevel = null; paintReasoning(); }
});
reasoningMenu.addEventListener("toggle", () => reasoningButton.setAttribute("aria-expanded", String(reasoningMenu.matches(":popover-open"))));
reasoningMenu.addEventListener("keydown", event => {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const rows = [...reasoningMenu.querySelectorAll("[data-level]")];
    if (!rows.length || !rows.includes(document.activeElement)) return;
    event.preventDefault(); const index = rows.indexOf(document.activeElement);
    rows[event.key === "Home" ? 0 : event.key === "End" ? rows.length - 1 : (index + (event.key === "ArrowUp" ? rows.length - 1 : 1)) % rows.length].focus();
});
window.addEventListener("resize", () => { if (reasoningMenu.matches(":popover-open")) positionReasoningMenu(); });
updateChatReasoning(ui.status);
