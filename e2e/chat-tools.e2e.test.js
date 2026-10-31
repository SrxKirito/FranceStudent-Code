"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), os = require("node:os"), { _electron } = require("playwright-core");

test("desktop tool choice reaches execution and tool results stay inspectable", { timeout: 60000 }, async () => {
    const root = path.resolve(__dirname, ".."), dir = fs.mkdtempSync(path.join(os.tmpdir(), "frst-chat-tools-")), project = path.join(dir, "project");
    fs.mkdirSync(project);
    const modulePath = name => JSON.stringify(path.join(root, name)), harness = path.join(dir, "launch.cjs");
    fs.writeFileSync(harness, `
globalThis.chatToolRequests=[];
require(${modulePath("src/core/session")}).bootstrap=async()=>({ok:true});
require(${modulePath("src/core/session")}).handleInput=async(text)=>{globalThis.chatToolRequests.push({text,groups:require(${modulePath("src/tools/selection")}).current()});return {completed:true};};
require(${modulePath("src/api/agents")}).listAgents=async()=>({agents:[{id:-1002,name:'Test model'}],source:'local'});
require(${modulePath("src/api/account")}).fetchUserUsage=async()=>({});
require(${modulePath("src/settings")}).save({releaseHighlightsSeen:${JSON.stringify(require("../package.json").version)},automaticUpdates:false});
require(${modulePath("desktop/main.js")});`);
    const env = { ...process.env, FS_DATA_DIR: dir, FS_STATE_DIR: dir, FS_SKILLS_DIR: path.join(dir, "skills") }; delete env.ELECTRON_RUN_AS_NODE;
    const app = await _electron.launch({ executablePath: require("electron"), args: [harness, "--user-data-dir=" + path.join(dir, "electron")], env, cwd: root });
    try {
        const page = await app.firstWindow();
        if (process.platform === "darwin") await page.locator("#mac-beta-notice").getByRole("button", { name: "Continuer", exact: true }).click();
        await page.locator("#startup-loading").waitFor({ state: "hidden" });
        if (await page.locator("#guide-close").isVisible()) await page.locator("#guide-close").click();
        await page.evaluate(project => window.frst.openProject(project), project);
        await page.locator("#chat-tool-selection:not(:disabled)").waitFor({ state: "visible" });
        await page.locator("#chat-tool-selection").click();
        await page.locator('[data-tool-preset="code"]').click();
        await page.keyboard.press("Escape");
        await page.evaluate(() => send("Prépare la navigation"));
        assert.deepEqual((await app.evaluate(() => globalThis.chatToolRequests)).at(-1).groups, ["files", "terminal", "skills"]);
        await page.evaluate(() => {
            transcript.replaceChildren(); resetToolActivity();
            renderEntry({ type: "tool", name: "read_file", arg: "index.js" });
            renderEntry({ type: "tool", name: "run_command", arg: "npm test" });
            renderEntry({ type: "result", text: "Texte complet du fichier" });
            renderEntry({ type: "result", text: "Échec explicite du vérificateur", tone: "error" });
        });
        assert.equal(await page.locator(".chat-tool-call").count(), 2);
        assert.equal(await page.locator(".chat-tool-call").first().locator("pre").count(), 0);
        assert.equal(await page.locator(".chat-tool-call.error[open]").count(), 1);
        assert.match(await page.locator(".tool-group > details > summary").innerText(), /erreur/);
        await page.locator(".chat-tool-call").first().locator("summary").click();
        await page.locator(".chat-tool-call").first().locator("pre").waitFor();
        assert.equal(await page.locator(".chat-tool-call").first().locator("pre").innerText(), "Texte complet du fichier");
        await page.evaluate(() => { renderEntry({ type: "tool", name: "browse", arg: "localhost" }); finishToolActivity(); });
        assert.match(await page.locator(".chat-tool-state").last().innerText(), /non reçu/);
        await page.setViewportSize({ width: 900, height: 600 });
        const sendButton = await page.locator("#btn-send").boundingBox();
        assert.ok(sendButton && sendButton.y + sendButton.height <= 600);
    } finally { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); }
});
