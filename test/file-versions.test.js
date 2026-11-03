"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const dataDir = require("node:fs").mkdtempSync(path.join(os.tmpdir(), "frst-versions-data-"));
process.env.FS_DATA_DIR = dataDir;
test.after(async () => { await fs.rm(dataDir, { recursive: true, force: true }); });
const memory = require("../src/project/memory");
const versions = require("../src/project/file-versions");

async function project(t) {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "frst-versions-"));
    await memory.open(workspace);
    t.after(async () => { memory.close(); await fs.rm(workspace, { recursive: true, force: true }); });
    return workspace;
}

test("un point avant demande restaure les fichiers et conserve une version de sécurité", { concurrency: false }, async t => {
    const dir = await project(t);
    await fs.writeFile(path.join(dir, "a.txt"), "avant");
    const point = await versions.save(dir, "Modifier a.txt");
    await fs.writeFile(path.join(dir, "a.txt"), "après");
    await fs.writeFile(path.join(dir, "nouveau.txt"), "nouveau");
    const preview = await versions.preview(dir, point.id);
    assert.deepEqual(preview.changes.map(item => [item.path, item.action]), [["a.txt", "restaurer"], ["nouveau.txt", "retirer"]]);
    const result = await versions.restore(dir, point.id, preview.expected);
    assert.equal(result.restored, 2);
    assert.equal(await fs.readFile(path.join(dir, "a.txt"), "utf8"), "avant");
    await assert.rejects(fs.stat(path.join(dir, "nouveau.txt")), { code: "ENOENT" });
    const safetyPreview = await versions.preview(dir, result.safetyId);
    await versions.restore(dir, result.safetyId, safetyPreview.expected);
    assert.equal(await fs.readFile(path.join(dir, "a.txt"), "utf8"), "après");
    assert.equal(await fs.readFile(path.join(dir, "nouveau.txt"), "utf8"), "nouveau");
});

test("un aperçu périmé ne doit pas écraser un changement ultérieur", { concurrency: false }, async t => {
    const dir = await project(t);
    await fs.writeFile(path.join(dir, "a.txt"), "avant");
    const point = await versions.save(dir, "Modifier");
    await fs.writeFile(path.join(dir, "a.txt"), "après");
    const preview = await versions.preview(dir, point.id);
    await fs.writeFile(path.join(dir, "a.txt"), "modification manuelle");
    await assert.rejects(versions.restore(dir, point.id, preview.expected), /changé depuis l'aperçu/);
    assert.equal(await fs.readFile(path.join(dir, "a.txt"), "utf8"), "modification manuelle");
});

test("les chemins sensibles exclus restent inchangés et apparaissent dans l’aperçu", { concurrency: false }, async t => {
    const dir = await project(t);
    await fs.writeFile(path.join(dir, ".env"), "avant");
    await fs.writeFile(path.join(dir, "a.txt"), "avant");
    const point = await versions.save(dir, "Modifier");
    await fs.writeFile(path.join(dir, ".env"), "après");
    await fs.writeFile(path.join(dir, "a.txt"), "après");
    const preview = await versions.preview(dir, point.id);
    assert.ok(preview.excludedPaths.includes(".env"));
    await versions.restore(dir, point.id, preview.expected);
    assert.equal(await fs.readFile(path.join(dir, ".env"), "utf8"), "après");
});

test("un conflit fichier-dossier est refusé avant toute modification", { concurrency: false }, async t => {
    const dir = await project(t);
    await fs.writeFile(path.join(dir, "element"), "ancien fichier");
    await fs.writeFile(path.join(dir, "autre.txt"), "avant");
    const point = await versions.save(dir, "Modifier la structure");
    await fs.unlink(path.join(dir, "element"));
    await fs.mkdir(path.join(dir, "element"));
    await fs.writeFile(path.join(dir, "element", "enfant.txt"), "nouveau fichier");
    await fs.writeFile(path.join(dir, "autre.txt"), "après");
    await assert.rejects(versions.preview(dir, point.id), /fichier et dossier/);
    assert.equal(await fs.readFile(path.join(dir, "autre.txt"), "utf8"), "après");
    assert.equal(await fs.readFile(path.join(dir, "element", "enfant.txt"), "utf8"), "nouveau fichier");
});

test("un projet parent du profil exclut les données privées et reste restaurable", { concurrency: false }, async t => {
    const dir = await project(t);
    const profile = path.join(dir, "profil-local");
    const oldProfile = process.env.FS_CODEX_COPY_DATA;
    const oldPath = memory.projectPath;
    process.env.FS_CODEX_COPY_DATA = profile;
    memory.projectPath = name => path.join(profile, "core", name);
    t.after(() => { memory.projectPath = oldPath; if (oldProfile === undefined) delete process.env.FS_CODEX_COPY_DATA; else process.env.FS_CODEX_COPY_DATA = oldProfile; });
    await fs.mkdir(profile, { recursive: true });
    await fs.writeFile(path.join(profile, "private.txt"), "secret");
    await fs.writeFile(path.join(dir, "a.txt"), "avant");
    const point = await versions.save(dir, "Modifier");
    assert.ok(point.excludedPaths.includes("profil-local"));
    assert.deepEqual(Object.keys(point.files), ["a.txt"]);
    await fs.writeFile(path.join(dir, "a.txt"), "après");
    const preview = await versions.preview(dir, point.id);
    await versions.restore(dir, point.id, preview.expected);
    assert.equal(await fs.readFile(path.join(dir, "a.txt"), "utf8"), "avant");
    assert.equal(await fs.readFile(path.join(profile, "private.txt"), "utf8"), "secret");
});
