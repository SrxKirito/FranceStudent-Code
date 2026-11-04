"use strict";

const { state, record, activateConversation } = require("../state");
const api = require("../api/api");
const conversations = require("../project/conversations");

// Détecte une demande explicite et une précision demandée au tour précédent.
function imageRequested(input, history) {
    const value = String(input || "");
    if (/^Création (?:de document PDF|PowerPoint)\b/i.test(value)) return false;
    const intent = text => /(?:g[ée]n[èe]re|cr[ée]+|dessine|r[ée]alise|fais|faire|imagine|generate|create|draw)/i.test(text) && /\b(?:images?|photos?|illustrations?|dessins?|portraits?|logos?|affiches?|avatars?|pictures?|wallpapers?)\b/i.test(text);
    if (intent(value)) return true;
    const recent = Array.isArray(history) ? history.slice(-2) : [];
    return recent.length === 2 && recent[0].role === "user" && intent(recent[0].content) && recent[1].role === "assistant" && /(?:pr[ée]cis|souhait|veux|quel|quelle|d[ée]cri|sujet)/i.test(recent[1].content || "") && value.trim().length > 0;
}

async function ensureImageTool() {
    const account = require("../api/account");
    let settings = await account.getJson("/user/instructions");
    const model = String(settings?.imageGenerationModel || "gpt-image-2.5-flare");
    if (settings?.imageGenerationToolEnabled !== true) {
        await account.setImageGeneration(model, true);
        settings = await account.getJson("/user/instructions");
        if (settings?.imageGenerationToolEnabled !== true) throw new Error("Le service n’a pas confirmé l’activation de la génération d’image. Vérifie les paramètres du compte.");
        require("../ui-bridge").ui.info("Génération d’image activée sur ton compte FranceStudent.");
    }
}

/**
 * Logique métier d'un message en mode chat, sans aucun affichage.
 * onDelta reçoit chaque morceau de texte pendant le streaming.
 * Renvoie { response, newChatId } : newChatId est l'identifiant de la
 * conversation si elle vient d'être créée par ce message, sinon null.
 */
async function send(input, { onDelta, onCheckpoint } = {}) {
    activateConversation("chat");
    const hadChat = Boolean(state.chatIds.chat);

    // Premier message d'une conversation : pré-prompt utilisateur/projet et faits appris.
    let preprompt = "";
    if (!state.chatId && !state.desktopAgentProjectIsolation) {
        try {
            preprompt = require("../project/profile").buildPreprompt();
        } catch {
            preprompt = "";
        }
    }

    const documentRequest = /^Création (?:de document PDF|PowerPoint)\b/i.test(input);
    const imageRequest = state.desktopAgentProjectIsolation && state.mode === "chat" && !state.motionDesign && !documentRequest && (state.desktopImageMode || imageRequested(input, state.history));
    if (imageRequest) {
        const preparation = require("../ui-bridge").ui.spinner("Préparation de l’image");
        try { await ensureImageTool(); } finally { preparation.stop(); }
    }
    const imageInstruction = imageRequest ? "[Génération d’image] Utilise l’outil de génération d’image pour créer l’image demandée. Ne te limite pas à un dessin textuel ou à du code SVG.\n\n" : "";
    const body = imageInstruction + input;
    const message = preprompt ? `${preprompt}\n\n${body}` : body;

    const response = await api.requestModel(message, {
        onCheckpoint, imageRequest,
        onDelta(text) {
            if (onDelta) onDelta(text);
        }
    });

    record("user", input);
    record("assistant", response);

    let newChatId = null;

    if (state.chatId) {
        const settings = {
            model: state.model,
            webSearch: state.webSearch,
            private: state.private,
            incognito: state.incognito,
            autoApprove: state.autoApprove
        };
        state.conversationSettings.chat = settings;
        await conversations.touch({
            id: state.chatId,
            firstMessage: input,
            model: state.model,
            workspace: state.workspace,
            mode: "chat",
            settings
        });

        if (!hadChat) {
            newChatId = state.chatId;
            if(state.desktopAgentProjectIsolation && !state.incognito){
                const title=require('../project/conversation-title').conversationTitle(input);
                try { await require('../api/fr-projects').requestJson('PATCH',`/chats/${encodeURIComponent(state.chatId)}`,{title}); }
                catch { require('../ui-bridge').ui.info('Le titre local est prêt ; sa synchronisation avec le compte n’a pas été confirmée.'); }
            }
        }
    }

    return { response, newChatId };
}

module.exports = { send };
