"use strict";
// Reprend uniquement une réponse textuelle du chat classique ; aucun appel d’outil n’est exécuté.
const { CONFIG } = require("../src/config");
const { auth, getAccessToken } = require("../src/api/auth");
async function resumeChatStream(chatId, pending, { signal, onText, onCheckpoint, onImage } = {}) {
    if (!/^[0-9a-f-]{36}$/i.test(String(chatId || ""))) throw new Error("Identifiant de discussion invalide.");
    let output = String(pending?.output || ""), cursor = String(pending?.cursor || "");
    if (output && !cursor) throw new Error("Le curseur de reprise manque. Rouvre la discussion et vérifie la réponse sur le service.");
    if (output.length > 8 * 1024 * 1024 || cursor.length > 1024) throw new Error("État de reprise trop volumineux.");
    const token = await getAccessToken();
    const query = cursor ? `?last_event_id=${encodeURIComponent(cursor)}` : "";
    const response = await fetch(`${CONFIG.apiUrl}/chats/${encodeURIComponent(chatId)}/stream${query}`, {
        method:"GET", signal, headers:{ Accept:"text/event-stream", Authorization:`Bearer ${token}`, "User-Agent":CONFIG.userAgent,
            "francestudent-client-platform":CONFIG.clientPlatform, "francestudent-client-version":CONFIG.clientVersion,
            "francestudent-device-id":auth.deviceId, Origin:CONFIG.origin, Referer:`${CONFIG.origin}/` }
    });
    if (!response.ok || !response.body) throw new Error(`Flux indisponible (HTTP ${response.status}). Vérifie la discussion avant de renvoyer la demande.`);
    if (output) onText?.(output);
    const reader = response.body.getReader(), decoder = new TextDecoder();
    let buffer="", name="", parts=[], eventId="", complete=false, eventChars=0;
    const images = new Set();
    function dispatch() {
        const raw=parts.join("\n"), event=name; parts=[]; name=""; eventChars=0;
        if (eventId) cursor=eventId; eventId="";
        if (!raw) return;
        if (raw === "[DONE]") { complete=true; return; }
        let data; try { data=JSON.parse(raw); } catch { throw new Error("Événement de reprise invalide."); }
        if (!data || typeof data !== "object") throw new Error("Événement de reprise invalide.");
        if (data.chat_id && String(data.chat_id) !== chatId) throw new Error("Le flux appartient à une autre discussion.");
        if (event === "error" || event === "response.failed" || data.response?.error) throw new Error("Le service a signalé une erreur pendant la reprise.");
        let delta="";
        if (event === "response.output_text.delta" && typeof data.delta === "string") delta=data.delta;
        else if (event === "response.output_text.done" && !output && typeof data.text === "string") delta=data.text;
        else if (event === "completed") {
            const full = data.message?.content;
            if (typeof full === "string" && (!output || full.startsWith(output))) delta=full.slice(output.length);
            complete=true;
        }
        if (delta) { if (output.length + delta.length > 8*1024*1024) throw new Error("Réponse trop volumineuse."); output+=delta; onText?.(delta); }
        for (const image of require("../src/api/generated-images").collectGeneratedImages(data)) {
            const key=`${image.length}:${image.slice(-64)}`; if (!images.has(key)) { images.add(key); onImage?.(image); }
        }
        if (cursor || !output) onCheckpoint?.({ cursor, output, updatedAt:Date.now() });
    }
    function line(value) {
        if (!value) return dispatch();
        if (value.startsWith(":")) return;
        const at=value.indexOf(":"), field=at<0?value:value.slice(0,at); let part=at<0?"":value.slice(at+1); if(part.startsWith(" "))part=part.slice(1);
        if(field === "id" && !part.includes("\0") && part.length<=1024) eventId=part;
        else if(field === "event") name=part;
        else if(field === "data") { eventChars+=part.length; if(eventChars>8*1024*1024)throw new Error("Événement de reprise trop volumineux."); parts.push(part); }
    }
    try {
        while (!complete) {
            const chunk=await reader.read(); if(chunk.done)break;
            buffer+=decoder.decode(chunk.value,{stream:true}); if(buffer.length>8*1024*1024)throw new Error("Événement de reprise trop volumineux.");
            let index; while ((index=buffer.indexOf("\n"))>=0) { const value=buffer.slice(0,index).replace(/\r$/,""); buffer=buffer.slice(index+1); line(value); if(complete)break; }
        }
        if (!complete) throw new Error("La réponse reste interrompue. Rouvre la discussion pour réessayer la lecture.");
        return output;
    } finally { await reader.cancel().catch(()=>{}); try { reader.releaseLock(); } catch {} }
}
module.exports = { resumeChatStream };
