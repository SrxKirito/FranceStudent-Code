"use strict";
const net = require("node:net");

function fixedOrigin(value) {
    let url;
    try { url = new URL(String(value || "").trim()); } catch { throw new Error("Renseigne l’adresse HTTPS de ton tunnel, par exemple https://ide.ton-domaine.fr."); }
    const host = url.hostname;
    if (url.protocol !== "https:" || url.username || url.password || url.port || url.search || url.hash || url.pathname !== "/" || host === "trycloudflare.com" || net.isIP(host.replace(/^\[|\]$/g, "")) || !/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/i.test(host) || /\.(?:localhost|local|localdomain|internal|lan|home|invalid|test|trycloudflare\.com)$/i.test(host)) throw new Error("Utilise un nom de domaine public en HTTPS, sans chemin, port ou code de connexion. Les adresses temporaires trycloudflare.com ne peuvent pas être conservées.");
    return url.origin;
}
function createIdeLinkSettings({ settings = require("../src/settings"), secrets = require("../src/secret-storage") } = {}) {
    const read = () => { const saved = settings.load().ideLink; return saved && typeof saved === "object" && !Array.isArray(saved) ? saved : {}; };
    function status() {
        const saved = read();
        return { mode: saved.mode === "fixed" ? "fixed" : "temporary", origin: typeof saved.origin === "string" ? saved.origin : "", port: Number.isInteger(saved.port) ? saved.port : 43821, hasToken: Boolean(saved.protectedToken), vaultAvailable: secrets.available() };
    }
    function save(input) {
        if (!input || !["temporary", "fixed"].includes(input.mode)) throw new Error("Type de connexion invalide.");
        const saved = read();
        if (input.mode === "temporary") { settings.save({ ideLink: { ...saved, mode: "temporary" } }); return status(); }
        const origin = fixedOrigin(input.origin), port = Number(input.port);
        if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Le port local doit être compris entre 1024 et 65535.");
        if (!secrets.available()) throw new Error("Le coffre système est indisponible. L’adresse fixe nécessite un jeton protégé ; utilise le lien temporaire en attendant.");
        let protectedToken = saved.protectedToken;
        const token = typeof input.token === "string" ? input.token.trim() : "";
        if (token) {
            if (token.length < 40 || token.length > 16000 || !/^[A-Za-z0-9_+\/=.-]+$/.test(token)) throw new Error("Colle uniquement le jeton du tunnel Cloudflare, sans la commande d’installation.");
            protectedToken = secrets.protect(token);
            if (!protectedToken) throw new Error("Le coffre système n’a pas pu protéger le jeton. Rien n’a été enregistré.");
        }
        if (!protectedToken) throw new Error("Renseigne le jeton du tunnel pour conserver cette adresse.");
        settings.save({ ideLink: { mode: "fixed", origin, port, protectedToken } });
        return status();
    }
    function connection() {
        const saved = read();
        if (saved.mode !== "fixed") return { mode: "temporary" };
        const origin = fixedOrigin(saved.origin), port = Number(saved.port);
        if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("Le port de l’adresse fixe est invalide. Enregistre de nouveau la configuration.");
        const token = secrets.unprotect(saved.protectedToken);
        if (!token) throw new Error("Le jeton du tunnel ne peut pas être lu dans le coffre système. Renseigne-le de nouveau.");
        return { mode: "fixed", origin, port, token };
    }
    function forget() { settings.save({ ideLink: { mode: "temporary" } }); return status(); }
    return { status, save, connection, forget };
}
module.exports = { createIdeLinkSettings, fixedOrigin };
