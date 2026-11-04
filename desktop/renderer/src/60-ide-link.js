/* ---------- IDE Link bêta ---------- */
const chatIdeLinkButton = document.createElement("button");
chatIdeLinkButton.type = "button";
chatIdeLinkButton.id = "chat-ide-link-button";
chatIdeLinkButton.setAttribute("aria-haspopup", "dialog");
chatIdeLinkButton.setAttribute("aria-expanded", "false");
chatIdeLinkButton.setAttribute("aria-controls", "chat-ide-link-menu");
chatControlContent(chatIdeLinkButton, '<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>', "IDE Link");
chatIdeLinkButton.title = "IDE Link"; chatIdeLinkButton.setAttribute("aria-label", "IDE Link");
chatNavigationActions.prepend(chatIdeLinkButton);
const chatIdeLinkMenu = document.createElement("div");
chatIdeLinkMenu.id = "chat-ide-link-menu";
chatIdeLinkMenu.className = "chat-access-menu chat-ide-link-menu";
chatIdeLinkMenu.setAttribute("popover", "auto");
chatIdeLinkMenu.setAttribute("role", "dialog");
chatIdeLinkMenu.setAttribute("aria-labelledby", "chat-ide-link-title");
chatIdeLinkMenu.innerHTML = `<div class="ide-link-heading"><div><div class="chat-access-heading" id="chat-ide-link-title">IDE Link <span class="ide-link-badge">Bêta</span></div><p class="ide-link-subtitle">Retrouve ton agent sur mobile</p></div><button type="button" id="ide-link-close" aria-label="Fermer">×</button></div>
<details class="ide-link-intro" id="ide-link-instructions" open><summary>Comment connecter mon iPhone</summary><ol class="ide-link-steps"><li>Active la connexion sur cet ordinateur.</li><li>Dans l’app FranceStudent, ouvre <strong>France IDE → Scanner le QR code</strong>.</li><li>Envoie tes consignes et suis ton agent depuis ton téléphone.</li></ol><p class="settings-help">Garde l’ordinateur allumé et connecté à Internet. Le QR code donne accès à la conversation et aux actions de l’agent.</p></details>
<section class="ide-link-remember-section"><label class="ide-link-persistent-choice"><input type="checkbox" id="ide-link-remember"><span>Mémoriser cet iPhone pour ce projet</span></label><p class="settings-help">Retrouve ce projet après redémarrage, sans domaine ni serveur à gérer.</p><details class="ide-link-privacy"><summary>Confidentialité et reconnexion</summary><p class="settings-help">La découverte utilise des annonces chiffrées sur le service public ntfy.sh ; les conversations et clés d’accès ne lui sont pas envoyées. Ce service externe peut être indisponible. La mémorisation autorise aussi l’accès aux prochaines conversations de ce projet.</p></details><p id="ide-link-discovery" class="settings-help" role="status"></p></section>
<div id="ide-link-details" hidden><div id="ide-link-pairing"><img id="ide-link-qr" width="256" height="256" alt="QR code privé pour associer un téléphone"><p id="ide-link-expiry" class="settings-help"></p><details><summary>Connexion manuelle avec un PIN</summary><label for="ide-link-address">Adresse de connexion</label><input id="ide-link-address" type="text" readonly><button type="button" id="ide-link-copy">Copier l’adresse</button><label>Code PIN à usage unique</label><div id="ide-link-pin" class="ide-link-pin" aria-live="polite"></div></details></div><p id="ide-link-device" class="settings-help" hidden></p><button type="button" id="ide-link-renew">Nouveau QR code</button></div>
<details class="ide-link-configuration"><summary>Options avancées · adresse fixe</summary><fieldset id="ide-link-config-fields"><label class="ide-link-persistent-choice"><input type="checkbox" id="ide-link-persistent"><span>Utiliser mon propre domaine pour une adresse fixe</span></label><p id="ide-link-saved-address" class="settings-help" hidden></p><div id="ide-link-fixed-settings" hidden><p class="settings-help">Une adresse fixe demande un domaine et un tunnel Cloudflare. L’adresse est conservée après redémarrage. Sans iPhone mémorisé pour ce projet, active IDE Link et scanne à nouveau.</p><details><summary>Créer mon adresse fixe, étape par étape</summary><ol class="ide-link-steps"><li>Crée un compte Cloudflare et ajoute ton domaine.</li><li>Dans <strong>Networking → Tunnels</strong>, crée un tunnel pour cet ordinateur.</li><li>Ajoute une application publiée, par exemple <strong>ide.ton-domaine.fr</strong>, vers le service HTTP <strong id="ide-link-local-target">127.0.0.1:43821</strong>.</li><li>Copie uniquement le jeton de connexion du tunnel dans le champ ci-dessous. L’IDE lance lui-même cloudflared.</li></ol><button type="button" id="ide-link-setup-guide">Ouvrir le guide officiel Cloudflare</button></details><label for="ide-link-fixed-address">Adresse HTTPS fixe</label><input id="ide-link-fixed-address" type="url" placeholder="https://ide.ton-domaine.fr" autocomplete="off" spellcheck="false"><label for="ide-link-tunnel-token">Jeton du tunnel Cloudflare</label><input id="ide-link-tunnel-token" type="password" autocomplete="new-password" spellcheck="false" placeholder="Colle le jeton ici, jamais dans le chat"><p class="settings-help">Le jeton est protégé par le coffre système. Il n’est jamais inclus dans le QR code.</p><details><summary>Port local du service</summary><label for="ide-link-fixed-port">Même port que dans Cloudflare</label><input id="ide-link-fixed-port" type="number" min="1024" max="65535" value="43821"></details></div><div class="ide-link-config-actions"><button type="button" id="ide-link-save-config">Enregistrer le choix</button><button type="button" id="ide-link-forget-config" hidden>Effacer la configuration</button></div></fieldset></details>
<p id="ide-link-status" class="settings-help" role="status">Désactivé.</p>
<div class="ide-link-actions"><button type="button" id="ide-link-start">Activer IDE Link</button><button type="button" id="ide-link-stop" disabled>Arrêter IDE Link</button></div>`;
document.body.append(chatIdeLinkMenu);
chatIdeLinkMenu.querySelector(".ide-link-configuration").addEventListener("toggle", () => { if (chatIdeLinkMenu.matches(":popover-open")) positionChatIdeLink(); });
let ideLinkConfigurationLoaded = false, ideLinkConfigurationDirty = false;
let ideLinkLastError = "", ideLinkIntroState = "";
function positionChatIdeLink() {
    const rect = chatIdeLinkButton.getBoundingClientRect();
    const width = Math.min(370, window.innerWidth - 24);
    chatIdeLinkMenu.style.width = `${width}px`;
    chatIdeLinkMenu.style.left = `${Math.max(12, Math.min(rect.left, window.innerWidth - width - 12))}px`;
    const below = Math.max(80, window.innerHeight - rect.bottom - 20);
    chatIdeLinkMenu.style.maxHeight = `${below}px`;
    chatIdeLinkMenu.style.overflowY = "auto";
    chatIdeLinkMenu.style.top = `${Math.min(window.innerHeight - 80, rect.bottom + 8)}px`;
}
chatIdeLinkButton.onclick = () => {
    if (chatIdeLinkMenu.matches(":popover-open")) { chatIdeLinkMenu.hidePopover(); return; }
    chatIdeLinkMenu.showPopover(); positionChatIdeLink(); refreshIdeLink();
};
chatIdeLinkMenu.addEventListener("toggle", () => chatIdeLinkButton.setAttribute("aria-expanded", String(chatIdeLinkMenu.matches(":popover-open"))));
window.addEventListener("resize", () => { if (chatIdeLinkMenu.matches(":popover-open")) positionChatIdeLink(); });
async function refreshIdeLink() {
    try {
        const info = await api.ideLink("status");
        if (ideLinkIntroState !== info.state) { $("ide-link-instructions").open = info.state === "stopped"; ideLinkIntroState = info.state; }
        $("ide-link-remember").checked = info.remembering?.enabled === true;
        $("ide-link-remember").disabled = !info.remembering?.available || info.state === "starting";
        $("ide-link-discovery").textContent = info.remembered ? ["error", "limited"].includes(info.discoveryState) ? "Téléphone mémorisé. La découverte est momentanément indisponible ; la connexion actuelle reste utilisable." : "Téléphone mémorisé. Suspendre coupe la connexion ; décocher cette option ou réassocier un appareil révoque l’association." : info.remembering?.paired ? "Téléphone mémorisé, connexion suspendue. Active IDE Link pour reprendre sans scanner. Décocher cette option retire l’association." : info.remembering?.enabled ? "Le prochain scan dans l’app iPhone à jour sera mémorisé." : !info.remembering?.available ? "La mémorisation nécessite un projet Code et le coffre système." : "Option désactivée : l’association reste temporaire.";
        const config = info.configuration;
        $("ide-link-config-fields").disabled = info.state !== "stopped";
        if (config && !ideLinkConfigurationLoaded && !ideLinkConfigurationDirty) {
            $("ide-link-persistent").checked = config.mode === "fixed";
            $("ide-link-fixed-address").value = config.origin || "";
            $("ide-link-fixed-port").value = config.port || 43821;
            $("ide-link-tunnel-token").value = "";
            $("ide-link-tunnel-token").placeholder = config.hasToken ? "Jeton déjà protégé · laisser vide pour le conserver" : "Colle uniquement le jeton du tunnel";
            $("ide-link-fixed-settings").hidden = config.mode !== "fixed";
            $("ide-link-saved-address").hidden = config.mode !== "fixed";
            $("ide-link-saved-address").textContent = config.mode === "fixed" ? `Adresse conservée : ${config.origin}` : "";
            $("ide-link-forget-config").hidden = !config.hasToken;
            $("ide-link-local-target").textContent = `127.0.0.1:${config.port || 43821}`;
            ideLinkConfigurationLoaded = true;
        }
        $("ide-link-fixed-settings").hidden = info.state !== "stopped" || !$("ide-link-persistent").checked;
        chatIdeLinkMenu.querySelector(".ide-link-config-actions").hidden = info.state !== "stopped";
        $("ide-link-start").disabled = info.state !== "stopped";
        $("ide-link-stop").disabled = info.state === "stopped";
        $("ide-link-stop").textContent = info.remembered ? "Suspendre IDE Link" : "Arrêter IDE Link";
        $("ide-link-details").hidden = info.state !== "running";
        $("ide-link-status").textContent = info.state === "running" ? info.device ? info.remembered ? "Appareil mémorisé pour ce projet." : "Appareil associé. Arrêter IDE Link révoque son accès." : info.pin ? "Prêt à associer ton téléphone." : "Association expirée ou bloquée. Génère un nouveau QR code." : info.state === "starting" ? "Préparation de la connexion…" : ideLinkLastError || "Désactivé.";
        $("ide-link-pairing").hidden = Boolean(info.device);
        $("ide-link-device").hidden = !info.device;
        $("ide-link-device").textContent = info.device ? `${info.device.name} · associé à ${new Date(info.device.connectedAt).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}` : "";
        $("ide-link-renew").textContent = info.device ? "Révoquer et associer un autre appareil" : "Nouveau QR code";
        $("ide-link-expiry").textContent = info.pin ? `Association unique · expire à ${new Date(info.pinExpires || Date.now() + 600000).toLocaleTimeString("fr-FR", { hour: "2-digit", minute: "2-digit" })}` : "QR code expiré ou déjà utilisé.";
        $("ide-link-qr").hidden = !info.qr;
        $("ide-link-qr").src = info.qr || "";
        $("ide-link-address").value = info.address || "";
        const pinBox = $("ide-link-pin"); pinBox.replaceChildren();
        if (info.pin) {
            pinBox.setAttribute("aria-label", `Code PIN ${info.pin.split("").join(" ")}`);
            for (const digit of info.pin) { const cell = document.createElement("span"); cell.textContent = digit; cell.setAttribute("aria-hidden", "true"); pinBox.append(cell); }
        } else { pinBox.removeAttribute("aria-label"); pinBox.textContent = "Code utilisé, expiré ou bloqué."; }
        if (chatIdeLinkMenu.matches(":popover-open")) positionChatIdeLink();
    } catch (error) { $("ide-link-status").textContent = error.message; }
}
$("ide-link-close").onclick = () => chatIdeLinkMenu.hidePopover();
setInterval(() => { if (chatIdeLinkMenu.matches(":popover-open")) refreshIdeLink(); }, 30000);
$("ide-link-start").onclick = async () => {
    const rememberNotice = $("ide-link-remember").checked ? " En mémorisant cet iPhone, tu autorises la reprise automatique sur ce projet et ses prochaines conversations lors des ouvertures suivantes de l’IDE. La découverte utilise des annonces chiffrées sur ntfy.sh." : "";
    if (!await confirmStudioAction("Ton téléphone pourra voir la conversation actuelle, y compris les messages précédents, lancer des tâches et répondre aux questions et confirmations avec les autorisations actuelles de l’agent. Toute personne possédant le lien d’association du QR code, ou l’adresse et le PIN, peut associer son appareil. Le code expire après dix minutes et une seule association. Activer IDE Link ?" + rememberNotice, { title: "Connecter mon téléphone", confirmLabel: "Activer", danger: true })) return;
    if (!chatIdeLinkMenu.matches(":popover-open")) { chatIdeLinkMenu.showPopover(); positionChatIdeLink(); }
    $("ide-link-start").disabled = true;
    ideLinkLastError = "";
    try { if (ideLinkConfigurationDirty) await saveIdeLinkConfiguration(); await api.ideLink("start"); } catch (error) { ideLinkLastError = error.message; $("ide-link-status").textContent = error.message; $("ide-link-start").disabled = false; return; }
    await refreshIdeLink();
};
$("ide-link-stop").onclick = async () => { try { await api.ideLink("stop"); await refreshIdeLink(); } catch (error) { $("ide-link-status").textContent = error.message; } };
$("ide-link-renew").onclick = async () => { try { await api.ideLink("renew"); await refreshIdeLink(); } catch (error) { $("ide-link-status").textContent = error.message; } };
$("ide-link-copy").onclick = async () => { try { await navigator.clipboard.writeText($("ide-link-address").value); $("ide-link-status").textContent = "Adresse de connexion copiée. Ne la partage qu’avec une personne de confiance."; } catch { $("ide-link-address").select(); $("ide-link-status").textContent = "Sélectionne et copie l’adresse manuellement."; } };
api.onEvent(channel => { if (channel === "ideLink") refreshIdeLink(); });
refreshIdeLink();
function dirtyIdeLinkConfiguration() { ideLinkConfigurationDirty = true; ideLinkLastError = ""; }
$("ide-link-persistent").onchange = () => { $("ide-link-fixed-settings").hidden = !$("ide-link-persistent").checked; dirtyIdeLinkConfiguration(); positionChatIdeLink(); };
for (const id of ["ide-link-fixed-address", "ide-link-tunnel-token", "ide-link-fixed-port"]) $(id).addEventListener("input", dirtyIdeLinkConfiguration);
$("ide-link-fixed-port").addEventListener("input", () => { $("ide-link-local-target").textContent = `127.0.0.1:${$("ide-link-fixed-port").value}`; });
async function saveIdeLinkConfiguration() {
    await api.ideLink("configure", { mode: $("ide-link-persistent").checked ? "fixed" : "temporary", origin: $("ide-link-fixed-address").value, port: Number($("ide-link-fixed-port").value), token: $("ide-link-tunnel-token").value });
    $("ide-link-tunnel-token").value = ""; ideLinkConfigurationDirty = false; ideLinkConfigurationLoaded = false;
    ideLinkLastError = "";
}
$("ide-link-save-config").onclick = async () => { try { await saveIdeLinkConfiguration(); await refreshIdeLink(); $("ide-link-status").textContent = "Choix enregistré. Active IDE Link pour ouvrir la connexion."; } catch (error) { $("ide-link-status").textContent = error.message; } };
$("ide-link-forget-config").onclick = async () => { try { await api.ideLink("forget"); ideLinkConfigurationDirty = false; ideLinkConfigurationLoaded = false; await refreshIdeLink(); } catch (error) { $("ide-link-status").textContent = error.message; } };
$("ide-link-setup-guide").onclick = () => api.openExternal("https://developers.cloudflare.com/tunnel/get-started/", true).catch(error => { $("ide-link-status").textContent = error.message; });
$("ide-link-remember").onchange = async () => {
    const field = $("ide-link-remember"); field.disabled = true;
    try { await api.ideLink("remember", { enabled: field.checked }); await refreshIdeLink(); }
    catch (error) { await refreshIdeLink(); $("ide-link-status").textContent = error.message; }
};
