"use strict";

/**
 * /export : écrit la conversation en cours (state.history) dans un fichier Markdown.
 * Par défaut : <projet>/.frst/exports/conversation-AAAAMMJJ-HHMMSS.md (ou le dossier courant sans projet).
 */

const fs = require("node:fs");
const path = require("node:path");

function stamp(date = new Date()) {
    const p = (n) => String(n).padStart(2, "0");
    return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-` +
        `${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`;
}

function toMarkdown(history, meta = {}) {
    const lines = [`# ${meta.title || "Conversation FranceStudent"}`, ""];
    const date = meta.date || new Date();
    lines.push(`- Exportée le : ${date.toISOString()}`);
    if (meta.chatId) lines.push(`- Chat ID : ${meta.chatId}`);
    if (meta.mode) lines.push(`- Mode : ${meta.mode}`);
    if (meta.workspace) lines.push(`- Projet : ${meta.workspace}`);
    lines.push(`- Messages : ${history.length}`, "");

    for (const item of history) {
        lines.push("---", "", `## ${item.role === "user" ? "Utilisateur" : "Assistant"}`, "");
        lines.push(String(item.content ?? "").trim(), "");
    }
    return `${lines.join("\n").trimEnd()}\n`;
}

/** Renvoie { file, count } ; lève une erreur si la conversation est vide. */
function exportConversation({ history, target = "", workspace = null, chatId = null, mode = null, title = null } = {}) {
    const items = Array.isArray(history) ? history : [];
    if (!items.length) throw new Error("Conversation vide : rien à exporter.");

    const base = workspace || process.cwd();
    let file = target
        ? path.resolve(base, target)
        : path.join(base, ".frst", "exports", `conversation-${stamp()}.md`);
    if (!/\.md$/i.test(file)) file += ".md";

    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, toMarkdown(items, { chatId, mode, workspace, title }), "utf8");
    return { file, count: items.length };
}

module.exports = { exportConversation, toMarkdown, stamp };
