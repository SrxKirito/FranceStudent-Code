"use strict";
// Indexe les discussions du compte par petites pages ; aucun contenu local d’un autre compte.
const account = require("../src/api/account");
const { collectGeneratedImages, collectImageReferences } = require("../src/api/generated-images");
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
async function page(cursor = "", transcriptStore = null, refresh = false) {
    if (cursor && !UUID.test(cursor)) throw new Error("Curseur de bibliothèque invalide.");
    const cache=require('./account-library-cache'),scope=await cache.owner();
    if(refresh && !cursor)await cache.clearPages(scope);
    const cached=!refresh&&await cache.read(scope,'page',cursor);if(cached)return {...cached,cached:true};
    const query = new URLSearchParams({ limit: "10", sortedBy: "lastMessageAt" });
    if (cursor) query.set("cursor_chat_id", cursor);
    const data = await account.getJson(`/chats?${query}`);
    const all = Array.isArray(data?.chats) ? data.chats : [];
    const chats = all.filter(chat => chat?.id && UUID.test(String(chat.id)));
    const items = []; let failed = 0, limited = 0;
    async function scan(chat) {
        const detail = await account.getJson(`/chats/${encodeURIComponent(chat.id)}`);
        const found = []; let incomplete = false; const messages = Array.isArray(detail?.chatMessages) ? detail.chatMessages : [];
        for (const message of messages) {
            if (String(message.role || "").toLowerCase() !== "assistant") continue;
            const common = { conversationId: String(chat.id), conversationTitle: String(detail?.title || chat.title || "Discussion"), updatedAt: message.createdAt || chat.lastMessageAt || null };
            const text = typeof message.content === "string" ? message.content : "";
            for (const match of text.matchAll(/```([^\n`]*)\n([\s\S]*?)```/g)) {
                if (match[2] && match[2].length <= 2000000) found.push({ ...common, kind: "code", language: String(match[1] || "texte").trim().slice(0, 50), code: match[2] });
                else if (match[2]) incomplete = true;
            }
            const images = collectGeneratedImages(message);
            for (const image of images) found.push({ ...common, kind: "image", data: image });
            for (const ref of collectImageReferences(message)) found.push({ ...common, kind: "image", messageId: ref.messageId, imageId: ref.id });
        }
        // Seuls les journaux dont l’identifiant vient du compte courant sont consultés.
        const saved = transcriptStore ? await transcriptStore.load(String(chat.id)).catch(() => null) : null;
        for (const entry of saved?.entries || []) {
            if (entry.type !== "user") continue;
            for (const preview of Array.isArray(entry.previews) ? entry.previews : []) {
                const id = String(preview.previewId || "");
                const data = typeof preview.data === "string" && /^data:image\/(?:png|jpeg|webp|gif);base64,[a-z0-9+/=]+$/i.test(preview.data) && preview.data.length <= 3000000 ? preview.data : "";
                if (!UUID.test(id) && !data) continue;
                found.push({ conversationId: String(chat.id), conversationTitle: String(detail?.title || chat.title || "Discussion"), kind: "attachment", name: String(preview.name || "Fichier").slice(0, 200), previewId: UUID.test(id) ? id : "", data });
            }
        }
        return { items: found, incomplete };
    }
    // Limite les accès parallèles et rapporte les discussions inaccessibles.
    for (let i = 0; i < chats.length; i += 3) {
        const batch = await Promise.allSettled(chats.slice(i, i + 3).map(scan));
        for (const result of batch) if (result.status === "fulfilled") { items.push(...result.value.items); if (result.value.incomplete) limited++; } else failed++;
    }
    const result={ items, failed, limited, cursor: String(all.at(-1)?.id || ""), hasMore: Boolean(data?.hasMore && all.length) };
    if(scope!==await cache.owner())throw Error('Le compte a changé pendant le chargement.');
    if(!failed)await cache.write(scope,'page',cursor,result).catch(()=>{});
    return result;
}
async function image(chatId, messageId, imageId) {
    if (![chatId, messageId, imageId].every(value => UUID.test(String(value || "")))) throw new Error("Référence d’image invalide.");
    const cache=require('./account-library-cache'),scope=await cache.owner(),key=[chatId,messageId,imageId].join(':');
    const cached=await cache.read(scope,'image',key);if(cached)return cached;
    const data=await account.fetchGeneratedImage(chatId, messageId, imageId);
    if(scope!==await cache.owner())throw Error('Le compte a changé pendant le chargement.');
    await cache.write(scope,'image',key,data).catch(()=>{});return data;
}
module.exports = { page, image };
