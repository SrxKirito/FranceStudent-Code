/* Réglages généraux et compte organisés comme dans l’application mobile. */
const mobileLibrarySettings = document.createElement("section"); mobileLibrarySettings.className = "settings-card mobile-settings-card"; mobileLibrarySettings.dataset.settingsGroup = "general";
mobileLibrarySettings.innerHTML = '<h3>Affichage de la bibliothèque</h3><p class="settings-help">Nombre de colonnes sur cet ordinateur.</p><div class="mobile-setting-choices" role="group" aria-label="Colonnes de la bibliothèque"></div>';
const libraryChoices = mobileLibrarySettings.querySelector(".mobile-setting-choices");
function libraryColumnCount() { const value = Number(localStorage.getItem("fs.library.columns")); return value >= 1 && value <= 4 ? value : 3; }
function refreshLibraryChoices() {
    for (const button of libraryChoices.children) button.setAttribute("aria-pressed", String(Number(button.dataset.columns) === libraryColumnCount()));
    document.querySelectorAll(".library-grid-desktop").forEach(grid => grid.style.setProperty("--library-columns", libraryColumnCount()));
}
for (let count = 1; count <= 4; count++) {
    const button = centerNode("button", "library-choice"); button.type = "button"; button.dataset.columns = String(count);
    const preview = centerNode("span", "library-choice-preview"); preview.setAttribute("aria-hidden", "true"); preview.style.setProperty("--choice-columns", count);
    for (let i = 0; i < count * 3; i++) preview.append(document.createElement("i"));
    button.append(preview, centerNode("span", "", `${count} colonne${count > 1 ? "s" : ""}`));
    button.onclick = () => { localStorage.setItem("fs.library.columns", String(count)); refreshLibraryChoices(); }; libraryChoices.append(button);
}
$("settings-model-title").closest(".settings-card").before(mobileLibrarySettings); refreshLibraryChoices();
const mobileImageSettings = document.createElement("section"); mobileImageSettings.className = "settings-card mobile-settings-card"; mobileImageSettings.dataset.settingsGroup = "general";
mobileImageSettings.innerHTML = '<h3>Génération d’images</h3><fieldset data-image-fields disabled><label class="setting-toggle"><span><b>Générer des images dans le chat</b><small>Autorise le modèle à utiliser l’outil de génération d’image.</small></span><input type="checkbox" data-image-enabled role="switch"></label><div class="center-code-label"><span id="settings-image-model-label">Modèle d’image</span><select data-image-model aria-labelledby="settings-image-model-label"><option value="gpt-image-2.5-flare">GPT Image 2.5 Flare</option><option value="gpt-image-2.5-sunburst">GPT Image 2.5 Sunburst</option><option value="gpt-image-2">GPT Image 2</option></select></div><button type="button" data-image-save>Enregistrer sur le compte</button></fieldset><p class="settings-help" data-image-feedback role="status"></p><button type="button" data-image-retry hidden>Réessayer</button>';
$("settings-model-title").closest(".settings-card").after(mobileImageSettings);
const mobileImageFields = mobileImageSettings.querySelector("[data-image-fields]"), mobileImageFeedback = mobileImageSettings.querySelector("[data-image-feedback]");
let mobileImageLoadingEpoch = -1;
async function loadMobileImageSettings() {
    const epoch = accountSettingsEpoch;
    if (mobileImageLoadingEpoch === epoch) return;
    mobileImageLoadingEpoch = epoch; mobileImageSettings.querySelector("[data-image-retry]").hidden = true; mobileImageFeedback.textContent = "Chargement…";
    try {
        const value = await api.accountPersonalization("get"); if (epoch !== accountSettingsEpoch) return;
        const select = mobileImageFields.querySelector("select");
        if (![...select.options].some(option => option.value === value.imageModel)) throw new Error("Le modèle enregistré n’est pas reconnu ; aucun réglage n’a été modifié.");
        select.value = value.imageModel; mobileImageFields.querySelector("input").checked = value.imageEnabled;
        mobileImageFields.disabled = false; mobileImageFeedback.textContent = "";
        if (typeof syncSettingsModelMenu === "function") syncSettingsModelMenu(select);
    } catch (error) { if (epoch === accountSettingsEpoch) { mobileImageFeedback.textContent = `Chargement impossible : ${error.message}`; mobileImageSettings.querySelector("[data-image-retry]").hidden = false; } }
    finally { if (mobileImageLoadingEpoch === epoch) mobileImageLoadingEpoch = -1; }
}
mobileImageSettings.querySelector("[data-image-retry]").onclick = () => void loadMobileImageSettings();
mobileImageSettings.querySelector("[data-image-save]").onclick = async () => {
    const epoch = accountSettingsEpoch;
    mobileImageFields.disabled = true; mobileImageFeedback.textContent = "Enregistrement…";
    try {
        await api.accountPersonalization("image", { enabled: mobileImageFields.querySelector("input").checked, model: mobileImageFields.querySelector("select").value });
        const mode = await api.imageMode("status"); if (epoch !== accountSettingsEpoch) return; chatImageEnabled = mode.enabled; updateImageModeUi();
        mobileImageFeedback.textContent = "Réglages enregistrés sur ton compte.";
    } catch (error) { if (epoch === accountSettingsEpoch) mobileImageFeedback.textContent = error.message; }
    finally { if (epoch === accountSettingsEpoch) mobileImageFields.disabled = false; }
};
const accountUsageButton = centerNode("button", "", "Voir mon utilisation"); accountUsageButton.type = "button";
accountUsageButton.onclick = () => { browserHomeClosePage(); setAgentTab("usage"); };
accountSettingsCard.append(accountUsageButton);
let mobileGeneralRequested = false, mobileAccountRequested = false;
function loadMobileSettingsSection() {
    if (!ui.status.booted) { mobileImageFeedback.textContent = "Connecte-toi pour modifier les réglages d’image."; return; }
    if (settingsCategory === "general" && !mobileGeneralRequested) {
        mobileGeneralRequested = true; generalAccountCard.querySelector("[data-general-load]").click(); void loadMobileImageSettings();
    }
    if (settingsCategory === "account" && !mobileAccountRequested) {
        mobileAccountRequested = true; $("account-profile-refresh").click();
        if (typeof loadDesktopAccountActivity === "function") void loadDesktopAccountActivity();
    }
}
for (const button of settingsNavigation.children) button.addEventListener("click", loadMobileSettingsSection);
const oldSettingsBrowserView = browserHomeViews.settings;
browserHomeViews.settings = () => { oldSettingsBrowserView(); loadMobileSettingsSection(); };
const oldClearAccountSettings = clearAccountSettings;
clearAccountSettings = function() { oldClearAccountSettings(); mobileImageFields.disabled = true; mobileImageFields.querySelector("select").selectedIndex = 0; mobileImageFields.querySelector("input").checked = false; if (typeof syncSettingsModelMenu === "function") syncSettingsModelMenu(mobileImageFields.querySelector("select")); mobileImageFeedback.textContent = "Connecte-toi pour modifier les réglages d’image."; mobileImageSettings.querySelector("[data-image-retry]").hidden = true; mobileGeneralRequested = false; mobileAccountRequested = false; };
filterSettingsCards();
