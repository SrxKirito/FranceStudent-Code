/* Aperçu issu uniquement des actions réussies de l’agent Code. */
let autoPreviewFile = null, autoPreviewServer = "", autoPreviewGeneration = 0, autoPreviewChecking = false, autoPreviewShown = false;
function autoPreviewAvailable() {
    return ui.status.mode !== "chat" && !ui.status.motionDesign && !isMotionOpen() && !ui.replayingConversation &&
        !$('app').classList.contains("browser-home-page") && !ui.tabs.some(tab => tab.dirty);
}
function noteAutomaticPreview(event, result) {
    if (!autoPreviewAvailable()) return;
    if (event.name === "write_file" && event.fileKind === "add") {
        const path = String(event.path || "").replace(/\\/g, "/");
        if (!path || path.startsWith("/") || /^[a-z]:/i.test(path) || path.split("/").some(part => part === ".." || part.startsWith("."))) return;
        if (/\.(?:html?|pdf|docx|xlsx|pptx|png|jpe?g|webp|svg|md)$/i.test(path)) autoPreviewFile = path;
    }
    if (event.name === "run_command") {
        const text = String(result.text || "");
        const match = text.match(/https?:\/\/(?:localhost|127\.0\.0\.1):\d{1,5}(?:\/[a-zA-Z0-9_./~-]*)?/i);
        if (match && /(?:ready|listening|running|started|local:|serveur|server)/i.test(text)) autoPreviewServer = match[0];
    }
}
api.onEvent(async (channel, data) => {
    if (channel === "clear" || (channel === "entry" && data?.type === "user")) { autoPreviewGeneration++; autoPreviewFile = null; autoPreviewServer = ""; autoPreviewShown = false; return; }
    if (channel === "serverPreviewOutput" && ui.status.busy && autoPreviewAvailable() && !autoPreviewChecking) {
        const match = String(data || "").match(/https?:\/\/(?:localhost|127\.0\.0\.1):\d{1,5}(?:\/[a-zA-Z0-9_./~-]*)?/i);
        if (!match || match[0] === autoPreviewServer) return;
        autoPreviewServer = match[0]; const url = autoPreviewServer, generation = autoPreviewGeneration, workspace = ui.workspace;
        autoPreviewChecking = true;
        try { if (await api.localPreviewReady(url) && generation === autoPreviewGeneration && workspace === ui.workspace && autoPreviewAvailable()) { setBrowserHomeOpen(true); browserHomeNavigate(url); autoPreviewFile = null; autoPreviewShown = true; } }
        finally { autoPreviewChecking = false; }
        return;
    }
    if (channel !== "commandEnd") return;
    if (data?.success !== true || autoPreviewShown || autoPreviewChecking) { autoPreviewFile = null; autoPreviewServer = ""; return; }
    const generation = ++autoPreviewGeneration, workspace = ui.workspace, url = autoPreviewServer, file = autoPreviewFile;
    autoPreviewFile = null; autoPreviewServer = "";
    if (!autoPreviewAvailable() || (!url && !file)) return;
    autoPreviewChecking = true;
    try {
        if (url && await api.localPreviewReady(url) && generation === autoPreviewGeneration && workspace === ui.workspace && autoPreviewAvailable()) {
            setBrowserHomeOpen(true); browserHomeNavigate(url); return;
        }
        if (file && generation === autoPreviewGeneration && workspace === ui.workspace && autoPreviewAvailable()) browserHomeOpenFile(file);
    } finally { autoPreviewChecking = false; }
});
