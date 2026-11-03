/* Connexions Code : aucune modification de préférences dans Studio ou Blender. */
async function showCreativePlugin(kind) {
    const blender = kind === "blender", title = blender ? "Blender · FranceStudent Connect" : "Roblox Studio · MCP officiel";
    const dialog = document.createElement("dialog"); dialog.id = `creative-plugin-${kind}`; dialog.className = "fs-dialog creative-plugin-dialog";
    studioSurfaceHeader(dialog, { title, subtitle: "Connecte l’agent Code à une application ouverte sur cet ordinateur.", icon: "tools" });
    const status = centerNode("p", "creative-plugin-status", "Vérification de l’installation…"); status.setAttribute("role", "status");
    const instructions = centerNode("p", "settings-help", blender
        ? "Ouvre une nouvelle fenêtre Blender connectée, ou ajoute FranceStudent Connect à une fenêtre existante. Les scripts Python restent désactivés tant que tu ne les autorises pas dans Blender."
        : "Dans Roblox Studio à jour : Assistant → … → Manage MCP Servers → Enable Studio as MCP server. Le plugin utilise le serveur fourni par Roblox.");
    const actions = centerNode("div", "creative-plugin-actions"), message = centerNode("p", "settings-feedback", ""); message.setAttribute("role", "status");
    let data;
    const refresh = async () => {
        data = await api.creativePlugins("status"); const item = data[kind];
        placeInstalledPlugin(kind, Boolean(item.installed)); filterPlugins();
        status.textContent = `${item.available ? "Application détectée" : blender ? "Exécutable Blender à choisir" : "Lanceur MCP Studio non détecté"} · ${item.configured ? "MCP configuré" : "MCP à configurer"}`;
    };
    const action = (label, callback, primary = false) => {
        const button = centerNode("button", primary ? "primary" : "", label); button.type = "button";
        button.onclick = async () => {
            for (const control of actions.querySelectorAll("button")) control.disabled = true;
            message.textContent = "En cours…";
            try { await callback(); await refresh(); }
            catch (error) { message.textContent = error.message; }
            finally { for (const control of actions.querySelectorAll("button")) control.disabled = false; }
        };
        actions.append(button); return button;
    };
    action("Configurer le plugin", async () => { await api.creativePlugins("configure", kind); message.textContent = "MCP configuré. Vérifie maintenant la connexion avec l’application ouverte."; }, true);
    if (blender) {
        action("Choisir Blender…", async () => { const selected = await api.creativePlugins("chooseBlender"); message.textContent = selected ? "Exécutable Blender enregistré." : "Sélection annulée."; });
        action("Ouvrir Blender connecté", async () => { const result = await api.creativePlugins("launchBlender"); message.textContent = result.message; });
        action("Enregistrer l’extension Blender…", async () => { const result = await api.creativePlugins("exportAddon"); message.textContent = result ? "Extension enregistrée. Dans Blender : Préférences → Extensions/Add-ons → Installer depuis un fichier. Active-la, puis indique le fichier IDE ci-dessous dans le panneau FranceStudent de la vue 3D." : "Enregistrement annulé."; });
    } else action("Guide officiel Roblox", async () => { await api.openExternal("https://create.roblox.com/docs/studio/mcp", true); message.textContent = "Guide officiel ouvert."; });
    action("Vérifier la connexion", async () => {
        const result = await api.creativePlugins("verify", kind);
        const text = JSON.stringify(result.result, null, 2);
        message.textContent = result.message + "\n" + text.slice(0, 12000);
    });
    const details = centerNode("details", "creative-plugin-details"), summary = centerNode("summary", "", "Détails de connexion"), pathLabel = centerNode("code", "");
    details.append(summary, pathLabel);
    const close = centerNode("button", "", "Fermer"); close.type = "button"; close.onclick = () => dialog.close();
    const footer = centerNode("div", "fs-dialog-footer"); footer.append(close);
    dialog.append(status, instructions, actions, details, message, footer); document.body.append(dialog);
    dialog.addEventListener("close", () => dialog.remove(), { once: true }); dialog.showModal();
    try { await refresh(); pathLabel.textContent = blender ? `Fichier IDE : ${data.blender.sessionFile}\nLes connexions sont locales ; aucune scène n’est publiée automatiquement.` : "Serveur : Roblox_Studio\nCommence par lister les sessions Studio, puis choisis leur studio_id. Les outils de génération Roblox peuvent utiliser les crédits de Roblox."; }
    catch (error) { status.textContent = error.message; }
}
// Logos Simple Icons (CC0) ; voir assets/plugin-logos-NOTICE.md.
const creativePluginLogos = {"roblox":"<svg aria-hidden=\"true\" fill=\"#00a2ff\" viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M 13.936 15.356 L 1.826 12.112 L 0 18.93 L 18.928 24 L 21.608 14.01 L 14.79 12.18 L 13.936 15.356 Z M 5.072 0 L 2.394 9.992 L 9.21 11.822 L 10.064 8.644 L 22.174 11.89 L 24 5.072 L 5.072 0 Z\"/></svg>","blender":"<svg aria-hidden=\"true\" fill=\"#e87d0d\" viewBox=\"0 0 24 24\" xmlns=\"http://www.w3.org/2000/svg\"><path d=\"M12.51 13.214c.046-.8.438-1.506 1.03-2.006a3.424 3.424 0 0 1 2.212-.79c.85 0 1.631.3 2.211.79.592.5.983 1.206 1.028 2.005.045.823-.285 1.586-.865 2.153a3.389 3.389 0 0 1-2.374.938 3.393 3.393 0 0 1-2.376-.938c-.58-.567-.91-1.33-.865-2.152M7.35 14.831c.006.314.106.922.256 1.398a7.372 7.372 0 0 0 1.593 2.757 8.227 8.227 0 0 0 2.787 2.001 8.947 8.947 0 0 0 3.66.76 8.964 8.964 0 0 0 3.657-.772 8.285 8.285 0 0 0 2.785-2.01 7.428 7.428 0 0 0 1.592-2.762 6.964 6.964 0 0 0 .25-3.074 7.123 7.123 0 0 0-1.016-2.779 7.764 7.764 0 0 0-1.852-2.043h.002L13.566 2.55l-.02-.015c-.492-.378-1.319-.376-1.86.002-.547.382-.609 1.015-.123 1.415l-.001.001 3.126 2.543-9.53.01h-.013c-.788.001-1.545.518-1.695 1.172-.154.665.38 1.217 1.2 1.22V8.9l4.83-.01-8.62 6.617-.034.025c-.813.622-1.075 1.658-.563 2.313.52.667 1.625.668 2.447.004L7.414 14s-.069.52-.063.831zm12.09 1.741c-.97.988-2.326 1.548-3.795 1.55-1.47.004-2.827-.552-3.797-1.538a4.51 4.51 0 0 1-1.036-1.622 4.282 4.282 0 0 1 .282-3.519 4.702 4.702 0 0 1 1.153-1.371c.942-.768 2.141-1.183 3.396-1.185 1.256-.002 2.455.41 3.398 1.175.48.391.87.854 1.152 1.367a4.28 4.28 0 0 1 .522 1.706 4.236 4.236 0 0 1-.239 1.811 4.54 4.54 0 0 1-1.035 1.626\"/></svg>"};
for (const entry of document.querySelectorAll("[data-creative-plugin]")) {
    entry.querySelector(".plugin-entry-icon").innerHTML = creativePluginLogos[entry.dataset.creativePlugin];
    entry.onclick = () => showCreativePlugin(entry.dataset.creativePlugin);
}
