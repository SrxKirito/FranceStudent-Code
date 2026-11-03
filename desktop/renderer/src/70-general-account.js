/* Préférences générales du compte utilisées également par l’application mobile. */
const generalAccountCard = document.createElement("section"); generalAccountCard.className = "settings-card"; generalAccountCard.dataset.settingsGroup = "general";
generalAccountCard.setAttribute("aria-labelledby", "account-general-title");
generalAccountCard.innerHTML = '<h3 id="account-general-title">Personnalisation FranceStudent</h3><p class="settings-help">Ces préférences sont enregistrées sur ton compte et partagées avec l’application mobile.</p><button type="button" data-general-load>Charger les préférences</button><fieldset disabled data-general-fields><label class="center-code-label">Niveau de réflexion GPT<select data-general-reasoning><option value="none">Aucun</option><option value="minimal">Minimal</option><option value="low">Faible</option><option value="medium">Moyen</option><option value="high">Élevé</option><option value="xhigh">Très élevé</option></select></label><label class="center-code-label">Instructions personnalisées<textarea data-general-instructions rows="5" maxlength="2000000"></textarea></label><button type="button" data-general-save>Enregistrer sur le compte</button></fieldset><p class="settings-help" data-general-status role="status"></p>';
$("settings-model-title").closest(".settings-card").after(generalAccountCard);
let accountSettingsEpoch = 0;
const generalAccountFields = generalAccountCard.querySelector("[data-general-fields]");
const generalAccountStatus = generalAccountCard.querySelector("[data-general-status]");
generalAccountCard.querySelector("[data-general-load]").onclick = async event => {
    const epoch = accountSettingsEpoch;
    event.currentTarget.disabled = true; generalAccountStatus.textContent = "Chargement…";
    try { const value = await api.accountPersonalization("get"); if (epoch !== accountSettingsEpoch) return; const select = generalAccountFields.querySelector("select"); select.value = [...select.options].some(option => option.value === value.reasoning) ? value.reasoning : "none"; generalAccountFields.querySelector("textarea").value = value.instructions; generalAccountFields.disabled = false; generalAccountStatus.textContent = ""; }
    catch (error) { if (epoch === accountSettingsEpoch) generalAccountStatus.textContent = error.message; } finally { event.currentTarget.disabled = false; }
};
generalAccountCard.querySelector("[data-general-save]").onclick = async () => {
    const epoch = accountSettingsEpoch;
    generalAccountFields.disabled = true; generalAccountStatus.textContent = "Enregistrement…";
    try { await api.accountPersonalization("save", { reasoning: generalAccountFields.querySelector("select").value, instructions: generalAccountFields.querySelector("textarea").value }); if (epoch === accountSettingsEpoch) generalAccountStatus.textContent = "Préférences enregistrées sur ton compte."; }
    catch (error) { if (epoch === accountSettingsEpoch) generalAccountStatus.textContent = error.message; } finally { if (epoch === accountSettingsEpoch) generalAccountFields.disabled = false; }
};
filterSettingsCards();

function clearAccountSettings() {
    accountSettingsEpoch++;
    if (browserHomeCurrent === "library" && $("app").classList.contains("browser-home-page")) browserHomeClosePage();
    generalAccountFields.disabled = true;
    generalAccountFields.querySelector("textarea").value = "";
    generalAccountFields.querySelector("select").value = "none";
    generalAccountStatus.textContent = "";
    $("account-profile-status").textContent = "Non connecté.";
}
