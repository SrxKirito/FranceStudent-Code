"use strict";
const test = require("node:test"), assert = require("node:assert/strict");
const selection = require("../src/tools/selection");
test("la sélection garde les lectures et refuse les autres groupes", async () => {
    assert.equal(selection.allowed("mcp_call"), true);
    await selection.run(["files"], async () => {
        assert.equal(selection.allowed("read_file"), true);
        assert.equal(selection.allowed("edit_file"), true);
        assert.throws(() => selection.assertAllowed("run_command"), /pas sélectionné/);
        assert.equal(selection.allowed("mcp_call"), false);
        assert.equal(selection.allowed("ask_user"), true);
        assert.equal(selection.allowed("job_stop"), true);
        await selection.run(["files", "terminal"], async () => assert.equal(selection.allowed("run_command"), false));
    });
    assert.equal(selection.allowed("run_command"), true);
});
test("deux tâches asynchrones ne partagent pas leur sélection", async () => {
    await Promise.all([selection.run(["web"], async () => { await Promise.resolve(); assert.equal(selection.allowed("web_fetch"), true); assert.equal(selection.allowed("edit_file"), false); }), selection.run(["files"], async () => { await Promise.resolve(); assert.equal(selection.allowed("web_fetch"), false); assert.equal(selection.allowed("edit_file"), true); })]);
});
test("le catalogue omet les outils exclus et valide les groupes", () => {
    selection.run([], () => {
        const catalog = selection.catalog('1. read_file — lecture\n   paramètres\n\n2. run_command — terminal\n   paramètres\n\n3. final — réponse');
        assert.match(catalog, /read_file/); assert.match(catalog, /final/); assert.doesNotMatch(catalog, /run_command/);
    });
    for (const value of [["unknown"], ["files", "files"], "all", [null]]) assert.throws(() => selection.normalize(value), /invalide/);
    assert.equal(selection.normalize(undefined), null);
});
