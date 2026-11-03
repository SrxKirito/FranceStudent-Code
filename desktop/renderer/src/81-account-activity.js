/* Budget et historique du compte, issus des mêmes données que le mobile. */
const desktopAppearanceCard = document.createElement("section");
desktopAppearanceCard.className = "settings-card";
desktopAppearanceCard.dataset.settingsGroup = "general";
desktopAppearanceCard.innerHTML = '<h3>Apparence</h3><p class="settings-help">Thèmes disponibles sur cet ordinateur.</p><div class="appearance-choices" role="group" aria-label="Thème de l’application"><button type="button" data-theme-choice="original"><span class="appearance-preview appearance-original" aria-hidden="true"></span>Sombre original</button><button type="button" data-theme-choice="midnight"><span class="appearance-preview appearance-midnight" aria-hidden="true"></span>Minuit</button></div><p class="settings-help" data-appearance-status role="status"></p>';
mobileLibrarySettings.before(desktopAppearanceCard);
function renderDesktopAppearance() {
    desktopAppearanceCard.querySelectorAll("[data-theme-choice]").forEach(button => button.setAttribute("aria-pressed", String(button.dataset.themeChoice === studioEditorPreferences.theme)));
}
desktopAppearanceCard.querySelectorAll("[data-theme-choice]").forEach(button => button.onclick = async () => {
    const status = desktopAppearanceCard.querySelector("[data-appearance-status]");
    desktopAppearanceCard.querySelectorAll("button").forEach(item => item.disabled = true);
    try { applyStudioEditorPreferences(await api.editorPreferences("save", { ...studioEditorPreferences, theme: button.dataset.themeChoice })); status.textContent = "Apparence enregistrée."; }
    catch (error) { status.textContent = error.message; }
    finally { desktopAppearanceCard.querySelectorAll("button").forEach(item => item.disabled = false); }
});
renderDesktopAppearance();
const desktopAccountDetails = document.createElement("section");
desktopAccountDetails.className = "settings-card account-activity-card";
desktopAccountDetails.dataset.settingsGroup = "account";
desktopAccountDetails.innerHTML = '<div class="account-section-heading"><h3>Budget du jour</h3><button type="button" data-budget-refresh aria-label="Actualiser le budget">↻</button></div><div class="account-budget-line"><span>Utilisé</span><strong data-budget-value>—</strong></div><progress data-budget-progress max="100" value="0" aria-label="Budget utilisé"></progress><p class="settings-help" data-budget-status>Chargement du budget…</p><div class="account-section-heading account-activity-heading"><h3>Activité tokens</h3><button type="button" data-activity-refresh aria-label="Actualiser l’activité">↻</button></div><p class="settings-help" data-activity-status role="status">Historique journalier sur les 343 derniers jours.</p><div data-activity-content></div>';
accountSettingsCard.after(desktopAccountDetails);
const previousAccountQuotaRender = renderQuota;
renderQuota = function() {
    previousAccountQuotaRender();
    const quota = ui.quota, percent = quota?.percent == null ? null : Math.max(0, Math.min(100, Number(quota.percent)));
    desktopAccountDetails.querySelector("[data-budget-value]").textContent = percent == null || !Number.isFinite(percent) ? "—" : `${quota.uncertain ? "≈ " : ""}${percent} %`;
    desktopAccountDetails.querySelector("[data-budget-progress]").value = Number.isFinite(percent) ? percent : 0;
    const reset = quota?.resetAt ? new Date(quota.resetAt) : null;
    desktopAccountDetails.querySelector("[data-budget-status]").textContent = ui.quotaError || (percent == null ? (ui.quotaLoading ? "Chargement du budget…" : "Budget indisponible.") : `${100 - percent} % restant${reset && !Number.isNaN(reset.getTime()) ? " · Réinitialisation le " + reset.toLocaleString("fr-FR", { dateStyle: "medium", timeStyle: "short" }) : ""}`);
};
desktopAccountDetails.querySelector("[data-budget-refresh]").onclick = () => void refreshQuota();
desktopAccountDetails.querySelector("[data-activity-refresh]").onclick = () => void loadDesktopAccountActivity();
const desktopActivityNumber = value => new Intl.NumberFormat("fr-FR", { notation: "compact", maximumFractionDigits: 1 }).format(value);
async function loadDesktopAccountActivity() {
    const epoch = accountSettingsEpoch, button = desktopAccountDetails.querySelector("[data-activity-refresh]");
    const status = desktopAccountDetails.querySelector("[data-activity-status]"), content = desktopAccountDetails.querySelector("[data-activity-content]");
    if (button.disabled) return;
    button.disabled = true; status.textContent = "Chargement de l’activité…";
    try {
        const data = await api.accountTokenActivity();
        if (epoch !== accountSettingsEpoch) return;
        const days = new Map(data.rows.map(row => [row.date, row])), rows = [...days.values()];
        const sum = key => rows.reduce((total, row) => total + row[key], 0);
        const peak = rows.reduce((best, row) => row.totalTokens > best.totalTokens ? row : best, { date: "", totalTokens: 0 });
        const metrics = centerNode("div", "account-activity-metrics");
        for (const [label, value] of [["Tokens totaux", data.totalTokenCount], ["Pic journalier", rows.length ? peak.totalTokens : null], ["Jours actifs", rows.length ? rows.filter(row => row.totalTokens > 0).length : null], ["Moyenne / jour renseigné", rows.length ? sum("totalTokens") / rows.length : null]]) {
            const metric = centerNode("div"); metric.append(centerNode("strong", "", value == null ? "—" : desktopActivityNumber(value)), centerNode("span", "", label)); metrics.append(metric);
        }
        content.replaceChildren(metrics);
        if (rows.length) {
            const calendar = centerNode("div", "account-calendar-box");
            calendar.append(centerNode("strong", "", `${new Intl.NumberFormat("fr-FR").format(sum("totalTokens"))} tokens · ${rows.length} jours renseignés`));
            const scroll = centerNode("div", "account-calendar-scroll"), grid = centerNode("div", "account-calendar-grid");
            const today = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Paris", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
            const end = new Date(today + "T00:00:00Z").getTime();
            for (let index = 0; index < 343; index++) {
                const date = new Date(end - (342 - index) * 86400000).toISOString().slice(0, 10), row = days.get(date);
                const cell = centerNode("button", "account-calendar-cell"); cell.type = "button";
                cell.dataset.level = row && row.totalTokens > 0 ? String(Math.max(1, Math.ceil(row.totalTokens / Math.max(peak.totalTokens, 1) * 4))) : "0";
                cell.classList.toggle("unreported", !row);
                cell.title = `${date} : ${row ? new Intl.NumberFormat("fr-FR").format(row.totalTokens) + " tokens" : "aucune donnée reçue"}`;
                cell.setAttribute("aria-label", cell.title); cell.tabIndex = index === 0 ? 0 : -1;
                cell.onclick = () => { status.textContent = cell.title; };
                cell.onkeydown = event => {
                    const delta = { ArrowLeft: -7, ArrowRight: 7, ArrowUp: -1, ArrowDown: 1 }[event.key];
                    if (!delta) return;
                    event.preventDefault(); const next = grid.children[Math.max(0, Math.min(grid.children.length - 1, index + delta))];
                    if (next) { cell.tabIndex = -1; next.tabIndex = 0; next.focus(); }
                };
                grid.append(cell);
            }
            scroll.append(grid); calendar.append(scroll, centerNode("p", "settings-help", "Clair = activité élevée · pointillés = aucune donnée reçue.")); content.append(calendar);
            const breakdown = centerNode("p", "settings-help", `Entrée : ${desktopActivityNumber(sum("inputTokens"))} · Sortie : ${desktopActivityNumber(sum("outputTokens"))} · Réflexion : ${desktopActivityNumber(sum("reasoningTokens"))}`);
            content.append(breakdown);
        }
        status.textContent = rows.length ? "Historique journalier disponible sur les 343 derniers jours." : "Aucun historique journalier disponible.";
    } catch (error) { if (epoch === accountSettingsEpoch) status.textContent = `Activité indisponible : ${error.message}`; }
    finally { button.disabled = false; }
}
const clearActivityAccountSettings = clearAccountSettings;
clearAccountSettings = function() {
    clearActivityAccountSettings(); accountAvatarOwner = ""; renderAccountAvatar();
    desktopAccountDetails.querySelector("[data-activity-content]").replaceChildren();
    desktopAccountDetails.querySelector("[data-activity-status]").textContent = "Connecte-toi pour consulter ton activité.";
};
renderQuota();
filterSettingsCards();
