/* ---------- Connexion guidée et guide de démarrage (porté de 21-onboarding) ----------
 * Les identifiants sont saisis dans une fenêtre dédiée, jamais dans le chat.
 * main.js réutilise loginWithPassword : seul le cookie de session est enregistré.
 */
const GUIDE_ORIGIN = "https://ia.francestudent.org";
const GUIDE_SEEN_KEY = "frst.guide-seen";
const guideState = { step: 1, busy: false, returnFocus: null };

function buildConnectionGuide() {
    if ($("connection-guide")) return;
    const wrap = document.createElement("div");
    wrap.id = "connection-guide";
    wrap.className = "guide-overlay hidden";
    wrap.setAttribute("role", "dialog");
    wrap.setAttribute("aria-modal", "true");
    wrap.setAttribute("aria-labelledby", "guide-title");
    wrap.innerHTML = `
<div class="guide-card">
  <button type="button" id="guide-close" class="guide-close" aria-label="Fermer le guide">✕</button>
  <ol class="guide-steps">
    <li data-guide-step="1">Connexion</li>
    <li data-guide-step="2">Projet</li>
    <li data-guide-step="3">Première demande</li>
  </ol>
  <h2 id="guide-title"></h2>
  <p id="guide-description" class="guide-description"></p>
  <section data-guide-page="1">
    <form id="guide-login-form" autocomplete="on">
      <label class="guide-field">Adresse e-mail
        <input type="email" id="guide-email" required autocomplete="username" spellcheck="false">
      </label>
      <label class="guide-field">Mot de passe
        <span class="guide-password-row">
          <input type="password" id="guide-password" required autocomplete="current-password">
          <button type="button" id="guide-show-password" aria-pressed="false" aria-label="Afficher le mot de passe">Afficher</button>
        </span>
      </label>
      <div class="guide-actions">
        <button type="submit" id="guide-login-submit" class="guide-primary">Se connecter</button>
        <button type="button" id="guide-open-site">Ouvrir le site FranceStudent</button>
      </div>
      <p class="guide-note">Ton mot de passe n'est jamais enregistré : seul le cookie de session est conservé sur cet ordinateur.</p>
    </form>
    <div id="guide-already-connected" class="hidden">
      <p>Tu es déjà connecté à FranceStudent.</p>
      <div class="guide-actions">
        <button type="button" id="guide-to-project" class="guide-primary">Continuer</button>
        <button type="button" id="guide-open-account">Gérer mon compte</button>
      </div>
    </div>
  </section>
  <section data-guide-page="2" class="hidden">
    <p id="guide-project-name"></p>
    <div class="guide-actions">
      <button type="button" id="guide-pick-project" class="guide-primary">Ouvrir un dossier</button>
      <button type="button" id="guide-project-next">Continuer</button>
      <button type="button" id="guide-skip-project">Plus tard</button>
    </div>
  </section>
  <section data-guide-page="3" class="hidden">
    <ul class="guide-tips">
      <li>Écris ta demande en français dans la zone du bas ; tape / pour voir les commandes.</li>
      <li>Les modifications de fichiers te sont présentées avant d'être appliquées.</li>
      <li>Tu peux envoyer d'autres messages pendant que l'agent travaille : ils sont mis en file.</li>
    </ul>
    <div class="guide-actions">
      <button type="button" id="guide-first-prompt" class="guide-primary">Préparer une première demande</button>
      <button type="button" id="guide-show-help">Voir l'aide (/help)</button>
      <button type="button" id="guide-finish">Terminer</button>
    </div>
  </section>
  <p id="guide-message" class="guide-message" role="status" aria-live="polite"></p>
</div>`;
    document.body.appendChild(wrap);
}

function buildGuideSettingsButtons() {
    const anchor = $("settings-message");
    if (!anchor || $("settings-guide")) return;
    const row = document.createElement("div");
    row.className = "ext-section guide-settings";
    row.innerHTML = `<div class="ext-section-head"><span>Compte FranceStudent</span></div>
<div class="guide-actions">
  <button type="button" id="settings-guide">Connexion et guide</button>
  <button type="button" id="settings-logout">Se déconnecter</button>
</div>`;
    anchor.parentNode.insertBefore(row, anchor);
}

function guideBooted() {
    return Boolean(ui.status && ui.status.booted);
}

function guideMessage(text, isError = false) {
    $("guide-message").textContent = text;
    $("guide-message").classList.toggle("is-error", Boolean(isError));
}

function openConnectionGuide(step) {
    guideState.returnFocus = document.activeElement;
    $("connection-guide").classList.remove("hidden");
    setGuideStep(step || (guideBooted() ? (ui.workspace ? 3 : 2) : 1));
    try { localStorage.setItem(GUIDE_SEEN_KEY, "1"); } catch { /* stockage indisponible */ }
    setTimeout(() => {
        if (guideState.step === 1 && !guideBooted()) { $("guide-email").focus(); return; }
        const first = $("connection-guide").querySelector("section:not(.hidden) button:not(:disabled), section:not(.hidden) input:not(:disabled)");
        if (first) first.focus();
    }, 0);
}

function closeConnectionGuide() {
    if (guideState.busy) return;
    $("guide-password").value = "";
    $("connection-guide").classList.add("hidden");
    if (guideState.returnFocus && guideState.returnFocus.isConnected) guideState.returnFocus.focus();
    else input.focus();
}

function setGuideStep(step) {
    guideState.step = [1, 2, 3].includes(step) ? step : 1;
    for (const page of document.querySelectorAll("[data-guide-page]")) {
        page.classList.toggle("hidden", Number(page.dataset.guidePage) !== guideState.step);
    }
    for (const marker of document.querySelectorAll("[data-guide-step]")) {
        const n = Number(marker.dataset.guideStep);
        marker.classList.toggle("current", n === guideState.step);
        marker.classList.toggle("done", n < guideState.step);
        if (n === guideState.step) marker.setAttribute("aria-current", "step");
        else marker.removeAttribute("aria-current");
    }
    $("guide-title").textContent = ["", "Bienvenue. On commence ?", "Ouvre le bon dossier", "Ta première demande"][guideState.step];
    $("guide-description").textContent = [
        "",
        "Connecte-toi avec les mêmes identifiants que sur le site FranceStudent.",
        "Pas besoin de configuration technique : choisis simplement le dossier de ton projet.",
        "L'agent comprend tes demandes en français. Tu peux préciser ou corriger ce que tu veux au fil du travail."
    ][guideState.step];
    $("guide-login-form").classList.toggle("hidden", guideBooted());
    $("guide-already-connected").classList.toggle("hidden", !guideBooted());
    $("guide-project-name").textContent = ui.workspace
        ? `Dossier choisi : ${ui.workspace.replace(/[\\/]+$/, "").split(/[\\/]/).pop()}`
        : "Tu pourras aussi ouvrir un dossier plus tard depuis l'explorateur.";
    $("guide-project-next").disabled = !ui.workspace;
    guideMessage("");
}

function guideError(error) {
    const message = String((error && error.message) || error || "Connexion impossible.");
    const special = /captcha|double authentification|two.factor|2fa|cloudflare/i.test(message);
    guideMessage(special
        ? "Ton compte demande une vérification supplémentaire que cette connexion ne prend pas encore en charge. Ouvre le site FranceStudent pour vérifier ton accès."
        : /password|mot de passe|identifiant|invalid|incorrect|401|403/i.test(message)
            ? "Connexion refusée. Vérifie l'adresse e-mail et le mot de passe de ton compte FranceStudent."
            : `La connexion n'a pas abouti (${message}). Vérifie tes identifiants et ta connexion Internet, puis réessaie.`, true);
}

function setGuideControlsDisabled(disabled) {
    for (const control of $("connection-guide").querySelectorAll("input, button")) control.disabled = disabled;
}

buildConnectionGuide();
buildGuideSettingsButtons();

$("guide-login-form").onsubmit = async (event) => {
    event.preventDefault();
    if (guideState.busy || !$("guide-login-form").reportValidity()) return;
    guideState.busy = true;
    guideMessage("Connexion à FranceStudent…");
    $("guide-login-submit").textContent = "Connexion…";
    $("guide-login-form").setAttribute("aria-busy", "true");
    setGuideControlsDisabled(true);
    try {
        const result = await api.loginAccount({ email: $("guide-email").value.trim(), password: $("guide-password").value });
        if (!result || !result.ok) throw new Error((result && result.reason) || "Connexion impossible.");
        applyStatus(await api.status());
        if (typeof refreshQuota === "function") refreshQuota();
        setGuideStep(2);
        guideMessage("Connecté. Ton mot de passe n'a pas été enregistré.");
    } catch (error) {
        guideError(error);
    } finally {
        $("guide-password").value = "";
        guideState.busy = false;
        setGuideControlsDisabled(false);
        $("guide-project-next").disabled = !ui.workspace;
        $("guide-login-submit").textContent = "Se connecter";
        $("guide-login-form").removeAttribute("aria-busy");
    }
};

$("guide-close").onclick = closeConnectionGuide;
$("guide-finish").onclick = closeConnectionGuide;
$("guide-to-project").onclick = () => setGuideStep(2);
$("guide-skip-project").onclick = () => setGuideStep(3);
$("guide-project-next").onclick = () => setGuideStep(3);
$("guide-open-site").onclick = () => api.openExternal(GUIDE_ORIGIN).catch(guideError);
$("guide-open-account").onclick = () => api.openExternal(GUIDE_ORIGIN).catch(guideError);
$("guide-show-help").onclick = () => {
    closeConnectionGuide();
    send("/help");
};
$("guide-show-password").onclick = () => {
    const reveal = $("guide-password").type === "password";
    $("guide-password").type = reveal ? "text" : "password";
    $("guide-show-password").textContent = reveal ? "Masquer" : "Afficher";
    $("guide-show-password").setAttribute("aria-pressed", String(reveal));
    $("guide-show-password").setAttribute("aria-label", reveal ? "Masquer le mot de passe" : "Afficher le mot de passe");
};
$("guide-pick-project").onclick = async () => {
    try {
        await api.openProject();
        applyStatus(await api.status());
        setGuideStep(2);
    } catch (error) {
        guideMessage(error.message, true);
    }
};
$("guide-first-prompt").onclick = () => {
    closeConnectionGuide();
    if (typeof setAgentTab === "function") setAgentTab("conversation");
    input.value = ui.workspace
        ? "Explore ce projet et explique-moi comment le lancer et le vérifier."
        : "Explique-moi comment tu peux m'aider et comment démarrer mon premier projet.";
    if (typeof saveStudioDraft === "function") saveStudioDraft();
    autosizeInput();
    input.focus();
};

$("settings-guide").onclick = () => openConnectionGuide();
$("settings-logout").onclick = async () => {
    $("settings-logout").disabled = true;
    $("settings-message").textContent = "Déconnexion…";
    try {
        await api.logoutAccount();
        $("settings-message").textContent = "Déconnecté : session locale effacée.";
    } catch (error) {
        $("settings-message").textContent = `Déconnexion non terminée : ${error.message}`;
        try { applyStatus(await api.status()); } catch { /* statut indisponible */ }
    } finally {
        $("settings-logout").disabled = false;
    }
};

// Le bouton d'aide ouvre le guide ; /help reste accessible depuis le guide et par la commande.
$("btn-help").onclick = () => openConnectionGuide();
$("btn-help").title = "Connexion et guide de démarrage";

api.onEvent(async (channel) => {
    if (channel !== "signedOut") return;
    try { applyStatus(await api.status()); } catch { /* statut indisponible */ }
    ui.quota = null;
    renderQuota();
    $("guide-email").value = "";
    $("guide-password").value = "";
    $("guide-password").type = "password";
    $("guide-show-password").textContent = "Afficher";
    $("guide-show-password").setAttribute("aria-pressed", "false");
    $("guide-show-password").setAttribute("aria-label", "Afficher le mot de passe");
    if (typeof showSideView === "function") showSideView("explorer");
    openConnectionGuide(1);
    guideMessage("Tu es déconnecté de cet ordinateur. Tu peux te reconnecter ou utiliser un autre compte.");
});

$("connection-guide").addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); closeConnectionGuide(); return; }
    if (event.key !== "Tab") return;
    const controls = [...$("connection-guide").querySelectorAll("button:not(:disabled), input:not(:disabled)")]
        .filter((element) => element.offsetParent !== null);
    const first = controls[0];
    const last = controls[controls.length - 1];
    if (event.shiftKey && document.activeElement === first) { event.preventDefault(); if (last) last.focus(); }
    else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); if (first) first.focus(); }
});

/** Appelé par 99-boot après le bootstrap : guide ouvert si aucune session, ou au premier lancement. */
function maybeOpenConnectionGuide() {
    let seen = false;
    try { seen = localStorage.getItem(GUIDE_SEEN_KEY) === "1"; } catch { /* stockage indisponible */ }
    if (!guideBooted() || !seen) openConnectionGuide();
}
