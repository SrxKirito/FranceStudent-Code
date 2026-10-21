"use strict";

/**
 * Réglages persistants de l'utilisateur (globaux, hors projet).
 *
 * Stockés dans CONFIG.dataDir/settings.json, écriture atomique (tmp + rename)
 * en mode 0o600. Sert notamment à mémoriser l'auto-approbation permanente
 * (écritures : autoApproveAlways; commandes : autoApproveCommandsAlways).
 */

const fs = require("fs");
const path = require("path");
const { CONFIG } = require("./config");

const FILE_NAME = "settings.json";
const DEFAULTS = { version: 1, autoApproveAlways: false, autoApproveCommandsAlways: false };

function file() {
    return path.join(CONFIG.dataDir, FILE_NAME);
}

function load() {
    try {
        const raw = JSON.parse(fs.readFileSync(file(), "utf8"));
        if (!raw || typeof raw !== "object") return { ...DEFAULTS };
        return {
            ...DEFAULTS,
            ...raw,
            autoApproveAlways: raw.autoApproveAlways === true,
            autoApproveCommandsAlways: raw.autoApproveCommandsAlways === true
        };
    } catch {
        return { ...DEFAULTS };
    }
}

function save(patch) {
    const next = { ...load(), ...(patch || {}), version: 1 };
    const target = file();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
    fs.renameSync(tmp, target);
    return next;
}

function autoApproveAlways() {
    return load().autoApproveAlways === true;
}

function setAutoApproveAlways(value) {
    return save({ autoApproveAlways: value === true });
}

// Commandes run_command lancées sans question (les commandes interdites restent bloquées).
function autoApproveCommandsAlways() {
    return load().autoApproveCommandsAlways === true;
}

function setAutoApproveCommandsAlways(value) {
    return save({ autoApproveCommandsAlways: value === true });
}

// Skills et MCP : "auto" = l'agent décide seul s'il en a besoin ;
// "manual" = seuls les skills / serveurs MCP nommés par l'utilisateur dans sa demande sont proposés.
const EXTENSIONS_MODES = ["auto", "manual"];

function extensionsMode() {
    const mode = load().extensionsMode;
    return EXTENSIONS_MODES.includes(mode) ? mode : "auto";
}

function setExtensionsMode(value) {
    if (!EXTENSIONS_MODES.includes(value)) {
        throw new Error(`Mode invalide : ${value} (auto ou manual).`);
    }
    return save({ extensionsMode: value });
}

// Modèle (agent FranceStudent) utilisé au démarrage : null = CONFIG.defaultAgentId.
function defaultModel() {
    const id = load().defaultModel;
    return Number.isInteger(id) && id !== 0 ? id : null;
}

function setDefaultModel(value) {
    if (value === null || value === "" || value === undefined) return save({ defaultModel: null });
    const id = Number(value);
    if (!Number.isInteger(id) || id === 0) throw new Error(`Identifiant de modèle invalide : ${value}`);
    return save({ defaultModel: id });
}

// Clé API SkillsMP (recherche du marketplace) : null = variable d'environnement SKILLSMP_API_KEY si définie.
function skillsmpApiKey() {
    const key = load().skillsmpApiKey;
    return typeof key === "string" && key.trim() ? key.trim() : null;
}

function setSkillsmpApiKey(value) {
    const key = value === null || value === undefined ? "" : String(value).trim();
    if (key && !/^[\x21-\x7e]{8,512}$/.test(key)) {
        throw new Error("Clé SkillsMP invalide (8 à 512 caractères imprimables, sans espace).");
    }
    return save({ skillsmpApiKey: key || null });
}

// Indexation du projet (/index, RESUME.md) : null = valeur par défaut de CONFIG (ou de la variable d'environnement).
const INDEXING_LIMITS = {
    maxFiles: { min: 1, max: 100_000 },
    maxListedFiles: { min: 1, max: 1_000_000 },
    budgetChars: { min: 10_000, max: 100_000_000 },
    summaryFileChars: { min: 500, max: 100_000 }
};

function indexing() {
    const raw = load().indexing;
    const src = raw && typeof raw === "object" ? raw : {};
    const out = { readAll: src.readAll === true };
    for (const [key, { min, max }] of Object.entries(INDEXING_LIMITS)) {
        const n = src[key];
        out[key] = Number.isInteger(n) && n >= min && n <= max ? n : null;
    }
    return out;
}

function setIndexing(patch) {
    const next = indexing();
    for (const [key, value] of Object.entries(patch || {})) {
        if (key === "readAll") {
            next.readAll = value === true;
            continue;
        }
        const range = INDEXING_LIMITS[key];
        if (!range) throw new Error(`Réglage d'indexation inconnu : ${key}`);
        if (value === null || value === "") {
            next[key] = null;
            continue;
        }
        const n = Number(value);
        if (!Number.isInteger(n) || n < range.min || n > range.max) {
            throw new Error(`${key} : entier entre ${range.min} et ${range.max} attendu.`);
        }
        next[key] = n;
    }
    save({ indexing: next });
    return next;
}

// Limites effectives : réglages de l'utilisateur, sinon CONFIG. readAll lit tous les fichiers listés, sans budget global.
function indexingLimits() {
    const s = indexing();
    const maxListedFiles = s.maxListedFiles ?? CONFIG.contextMaxListedFiles ?? CONFIG.contextMaxFiles;
    return {
        readAll: s.readAll,
        maxListedFiles,
        maxFiles: s.readAll ? maxListedFiles : Math.min(s.maxFiles ?? CONFIG.contextMaxFiles, maxListedFiles),
        budgetChars: s.readAll ? Infinity : s.budgetChars ?? CONFIG.contextBudgetChars,
        summaryFileChars: s.summaryFileChars ?? CONFIG.summaryFileChars
    };
}

module.exports = {
    FILE_NAME,
    DEFAULTS,
    file,
    load,
    save,
    autoApproveAlways,
    setAutoApproveAlways,
    autoApproveCommandsAlways,
    setAutoApproveCommandsAlways,
    EXTENSIONS_MODES,
    extensionsMode,
    setExtensionsMode,
    defaultModel,
    setDefaultModel,
    skillsmpApiKey,
    setSkillsmpApiKey,
    INDEXING_LIMITS,
    indexing,
    setIndexing,
    indexingLimits
};
