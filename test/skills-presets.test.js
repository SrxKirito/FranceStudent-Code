"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const assert = require("node:assert/strict");

// Le dossier de données doit être fixé AVANT de charger la configuration (settings.json temporaire).
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "fs-data-presets-"));
const previousDataDir = process.env.FS_DATA_DIR;
process.env.FS_DATA_DIR = dataDir;

const settings = require("../src/settings");
const presets = require("../src/skills/presets");
const skillsLib = require("../src/skills");

const SKILLS = [
    { name: "react-dev", scope: "utilisateur", description: "Build React components in TypeScript" },
    { name: "email-sequence", scope: "utilisateur", description: "Write marketing email campaigns" },
    { name: "pdf", scope: "utilisateur", description: "Read and create PDF documents", disabled: true }
];

test.after(() => {
    if (previousDataDir === undefined) delete process.env.FS_DATA_DIR;
    else process.env.FS_DATA_DIR = previousDataDir;
    fs.rmSync(dataDir, { recursive: true, force: true });
});

test("settings.json est isolé dans le dossier temporaire", () => {
    assert.ok(settings.file().startsWith(dataDir), settings.file());
});

test("sans preset actif, tous les skills activés sont proposés", () => {
    assert.equal(presets.activePreset(), null);
    assert.equal(presets.skillFilter("x", SKILLS).only, null);
    assert.equal(skillsLib.catalogText(SKILLS).split("\n").length, 2);
});

test("enregistrement, activation et filtre d'un preset", () => {
    presets.savePreset("Code", ["react-dev", "react-dev"]);
    assert.deepEqual(presets.listPresets(), { code: ["react-dev"] });
    presets.setActivePreset("code");
    assert.deepEqual(presets.skillFilter("fix bug", SKILLS).only, ["react-dev"]);
    // Un skill cité par son nom est toujours ajouté.
    assert.deepEqual(presets.skillFilter("use email-sequence", SKILLS).only.sort(), ["email-sequence", "react-dev"]);
    assert.equal(skillsLib.catalogText(SKILLS, { only: ["react-dev"] }).split("\n").length, 1);
});

test("sélection automatique par mots-clés (skills désactivés ignorés)", () => {
    presets.setActivePreset("auto");
    assert.equal(presets.activePreset(), "auto");
    assert.deepEqual(presets.autoSelect("write a marketing email", SKILLS), ["email-sequence"]);
    assert.deepEqual(presets.autoSelect("create a pdf document", SKILLS), []);
});

test("analyse de la suggestion de l'IA", () => {
    const raw = "voici " + JSON.stringify({ presets: { code: ["React-Dev", "inconnu"], web: [] } });
    assert.deepEqual(presets.parseSuggestion(raw, SKILLS), { code: ["react-dev"] });
    assert.throws(() => presets.parseSuggestion("pas de json", SKILLS));
});

test("suggestPresets utilise requestModel en conversation neuve", async () => {
    let options = null;
    const api = {
        requestModel: async (_prompt, opts) => {
            options = opts;
            return JSON.stringify({ presets: { marketing: ["email-sequence"] } });
        }
    };
    assert.deepEqual(await presets.suggestPresets(SKILLS, { api }), { marketing: ["email-sequence"] });
    assert.deepEqual(options, { conversationMode: "chat", fresh: true });
});

test("noms réservés, suppression et retour à tous", () => {
    assert.throws(() => presets.savePreset("auto", []));
    presets.setActivePreset("code");
    presets.deletePreset("code");
    assert.equal(presets.activePreset(), null);
    assert.throws(() => presets.setActivePreset("code"));
    presets.setActivePreset(null);
    assert.equal(presets.activePreset(), null);
});
