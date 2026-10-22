"use strict";
// formatter.js — formatage Prettier (portage adapté de extraopaa/francestudents-ide).
// Prettier est optionnel : il est cherché d'abord dans l'application, puis dans
// node_modules du projet ouvert. S'il est absent, une erreur explicite est renvoyée.

const path = require("node:path");
const { createRequire } = require("node:module");

const parsers = {
    js: "babel", jsx: "babel", mjs: "babel", cjs: "babel",
    ts: "typescript", tsx: "typescript", mts: "typescript", cts: "typescript",
    json: "json", jsonc: "json",
    css: "css", scss: "scss", less: "less",
    html: "html", htm: "html", vue: "vue",
    md: "markdown", markdown: "markdown",
    yaml: "yaml", yml: "yaml"
};

function loadPrettier(workspace) {
    const bases = [path.join(__dirname, "package.json")];
    if (workspace) bases.push(path.join(workspace, "package.json"));
    for (const base of bases) {
        try {
            const prettier = createRequire(base)("prettier");
            if (prettier && typeof prettier.format === "function") return prettier;
        } catch { /* essai suivant */ }
    }
    return null;
}

async function formatDocument({ file, text, tabSize = 4, workspace = null } = {}) {
    if (typeof text !== "string" || text.length > 2000000) {
        throw new Error("Le formatage est limité aux documents de 2 millions de caractères.");
    }
    const extension = String(file || "").split(".").pop().toLowerCase();
    const parser = parsers[extension];
    if (!parser) throw new Error("Formatage disponible pour JS, TS, JSON, CSS, HTML, Vue, Markdown et YAML.");
    const prettier = loadPrettier(workspace);
    if (!prettier) {
        throw new Error("Prettier introuvable : installe-le dans le projet (npm i -D prettier) ou dans l'application.");
    }
    const result = await prettier.format(text, {
        parser,
        tabWidth: Math.max(2, Math.min(8, Number(tabSize) || 4)),
        useTabs: false,
        endOfLine: "lf"
    });
    return { text: result, changed: result !== text };
}

module.exports = { formatDocument, parsers, loadPrettier };
