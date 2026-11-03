/* Profil FranceStudent dans les réglages, sans exposer les jetons au renderer. */
const accountSettingsCard = document.createElement("section");
accountSettingsCard.className = "settings-card"; accountSettingsCard.dataset.settingsGroup = "account";
accountSettingsCard.setAttribute("aria-labelledby", "account-settings-title");
accountSettingsCard.innerHTML = '<h3 id="account-settings-title">Compte FranceStudent</h3><div class="account-profile"><div class="account-avatar" aria-hidden="true">●</div><div><p id="account-profile-status" role="status">Sélectionne Actualiser pour consulter ton profil.</p><div class="account-profile-actions"><button type="button" id="account-avatar-change">Changer la photo</button><button type="button" id="account-avatar-remove">Retirer</button><button type="button" id="account-profile-refresh">Actualiser le profil</button></div><input id="account-avatar-input" type="file" accept="image/png,image/jpeg,image/webp,image/gif" hidden><p class="settings-help">Photo enregistrée uniquement sur cet ordinateur.</p></div></div>';
$("settings-help-title").closest(".settings-card").before(accountSettingsCard);
$("account-profile-refresh").onclick = async event => {
    const epoch = accountSettingsEpoch;
    event.currentTarget.disabled = true; $("account-profile-status").textContent = "Chargement du profil…";
    try { const profile = await api.accountProfile(); if (epoch !== accountSettingsEpoch) return; $("account-profile-status").textContent = [profile.name, profile.email].filter(Boolean).join(" · ") || "Connecté à FranceStudent."; accountAvatarOwner = profile.email || profile.name || ""; renderAccountAvatar(); }
    catch (error) { if (epoch === accountSettingsEpoch) $("account-profile-status").textContent = `Profil indisponible : ${error.message}`; }
    finally { event.currentTarget.disabled = false; }
};
let accountAvatarOwner = "";
function renderAccountAvatar() {
    const avatar = accountSettingsCard.querySelector(".account-avatar");
    let data = "";
    try { if (accountAvatarOwner) data = localStorage.getItem("fs.avatar." + accountAvatarOwner) || ""; } catch {}
    avatar.replaceChildren();
    if (data && /^data:image\/(png|jpeg|webp|gif);base64,/i.test(data)) {
        const image = document.createElement("img"); image.src = data; image.alt = ""; avatar.append(image);
    } else avatar.textContent = accountAvatarOwner ? accountAvatarOwner.slice(0, 1).toLocaleUpperCase("fr") : "●";
}
$("account-avatar-change").onclick = () => { if (accountAvatarOwner) $("account-avatar-input").click(); else $("account-profile-status").textContent = "Connecte-toi et actualise ton profil pour ajouter une photo."; };
$("account-avatar-input").onchange = event => {
    const file = event.target.files?.[0]; event.target.value = "";
    if (!file) return;
    if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type) || file.size > 1024 * 1024) { $("account-profile-status").textContent = "Choisis une image PNG, JPEG, WebP ou GIF de 1 Mo maximum."; return; }
    const owner = accountAvatarOwner, epoch = accountSettingsEpoch, reader = new FileReader();
    reader.onload = () => { if (epoch !== accountSettingsEpoch || owner !== accountAvatarOwner) return; try { localStorage.setItem("fs.avatar." + owner, reader.result); renderAccountAvatar(); } catch { $("account-profile-status").textContent = "Impossible d’enregistrer la photo sur cet ordinateur."; } };
    reader.readAsDataURL(file);
};
$("account-avatar-remove").onclick = () => { if (!accountAvatarOwner) return; try { localStorage.removeItem("fs.avatar." + accountAvatarOwner); } catch {} renderAccountAvatar(); };
filterSettingsCards();
