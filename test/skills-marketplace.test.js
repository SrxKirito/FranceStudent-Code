"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");

const marketplace = require("../src/skills/marketplace");

const RAW = "https://raw.githubusercontent.com/acme/skills/HEAD/";
const API = "https://api.github.com/repos/acme/skills/contents/";

async function tmpDir() {
    return fs.mkdtemp(path.join(os.tmpdir(), "frst-market-"));
}

function response(body, status = 200) {
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => JSON.parse(text),
        text: async () => text,
        arrayBuffer: async () => {
            const buf = Buffer.from(text, "utf8");
            return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
        }
    };
}

function fakeFetch(routes) {
    const calls = [];
    const fn = async (url) => {
        calls.push(url);
        return url in routes ? response(routes[url]) : response("not found", 404);
    };
    fn.calls = calls;
    return fn;
}

const INDEX = {
    name: "acme-skills",
    plugins: [
        { name: "docs", description: "Documents", source: "./", skills: ["./skills/demo", "./skills/broken", "../evil"] },
        { name: "bad", description: "x", source: "/etc", skills: ["./passwd"] }
    ]
};

const SKILL_MD = "---\nname: demo\ndescription: Un skill de démonstration\n---\n\n# Demo\n";

function baseRoutes() {
    return {
        [`${RAW}.claude-plugin/marketplace.json`]: INDEX,
        [`${RAW}skills/demo/SKILL.md`]: SKILL_MD,
        [`${API}skills/demo?ref=HEAD`]: [
            { name: "SKILL.md", type: "file", size: SKILL_MD.length },
            { name: "scripts", type: "dir" }
        ],
        [`${API}skills/demo/scripts?ref=HEAD`]: [
            { name: "run.py", type: "file", size: 12 },
            { name: "..", type: "file", size: 1 }
        ],
        [`${RAW}skills/demo/scripts/run.py`]: "print('ok')\n",
        [`${API}skills/broken?ref=HEAD`]: [{ name: "README.md", type: "file", size: 3 }]
    };
}

test("parseSource accepte owner/repo, @ref et URL GitHub, refuse le reste", () => {
    assert.deepEqual(marketplace.parseSource("acme/skills"), { owner: "acme", repo: "skills", ref: "HEAD", id: "acme/skills" });
    assert.equal(marketplace.parseSource("https://github.com/acme/skills.git").id, "acme/skills");
    assert.equal(marketplace.parseSource("acme/skills@v1").ref, "v1");
    assert.equal(marketplace.parseSource("").id, marketplace.DEFAULT_SOURCE);
    assert.throws(() => marketplace.parseSource("../x"));
    assert.throws(() => marketplace.parseSource("acme/skills@../../x"));
    assert.throws(() => marketplace.parseSource("acme"));
});

test("safeRelPath refuse .. et les chemins absolus", () => {
    assert.equal(marketplace.safeRelPath("./skills/xlsx"), "skills/xlsx");
    assert.equal(marketplace.safeRelPath("./"), "");
    assert.equal(marketplace.safeRelPath("../evil"), null);
    assert.equal(marketplace.safeRelPath("/etc"), null);
    assert.equal(marketplace.safeRelPath("C:\\Windows"), null);
});

test("fetchMarketplace liste les skills valides avec leur description", async () => {
    const fetch = fakeFetch(baseRoutes());
    const market = await marketplace.fetchMarketplace("acme/skills", { fetch });
    assert.equal(market.name, "acme-skills");
    assert.deepEqual(market.skills.map(s => s.name), ["demo", "broken"]);
    assert.equal(market.skills[0].description, "Un skill de démonstration");
    assert.equal(market.skills[1].description, "Documents");
});

test("installSkill télécharge le skill, refuse le doublon sans force", async () => {
    const dir = await tmpDir();
    const previous = process.env.FS_SKILLS_DIR;
    process.env.FS_SKILLS_DIR = dir;
    try {
        const fetch = fakeFetch(baseRoutes());
        const result = await marketplace.installSkill("demo", { source: "acme/skills", fetch });
        assert.equal(result.files, 2);
        assert.equal(result.replaced, false);
        assert.equal(await fs.readFile(path.join(dir, "demo", "SKILL.md"), "utf8"), SKILL_MD);
        assert.equal(await fs.readFile(path.join(dir, "demo", "scripts", "run.py"), "utf8"), "print('ok')\n");

        await assert.rejects(marketplace.installSkill("demo", { source: "acme/skills", fetch }), /existe déjà/);
        const again = await marketplace.installSkill("demo", { source: "acme/skills", fetch, force: true });
        assert.equal(again.replaced, true);

        const leftovers = (await fs.readdir(dir)).filter(n => n.startsWith("."));
        assert.deepEqual(leftovers, []);
    } finally {
        if (previous === undefined) delete process.env.FS_SKILLS_DIR;
        else process.env.FS_SKILLS_DIR = previous;
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test("installSkill refuse un skill sans SKILL.md, inconnu ou au nom invalide", async () => {
    const dir = await tmpDir();
    const previous = process.env.FS_SKILLS_DIR;
    process.env.FS_SKILLS_DIR = dir;
    try {
        const fetch = fakeFetch(baseRoutes());
        await assert.rejects(marketplace.installSkill("broken", { source: "acme/skills", fetch }), /SKILL\.md absent/);
        await assert.rejects(marketplace.installSkill("nope", { source: "acme/skills", fetch }), /absent du marketplace/);
        await assert.rejects(marketplace.installSkill("../x", { source: "acme/skills", fetch }), /invalide/);
        assert.deepEqual(await fs.readdir(dir), []);
    } finally {
        if (previous === undefined) delete process.env.FS_SKILLS_DIR;
        else process.env.FS_SKILLS_DIR = previous;
        await fs.rm(dir, { recursive: true, force: true });
    }
});

test("parseGithubUrl lit owner, repo, branche et chemin, refuse les chemins dangereux", () => {
    assert.deepEqual(marketplace.parseGithubUrl("https://github.com/openclaw/openclaw/tree/main/skills/nano-pdf"), {
        src: { owner: "openclaw", repo: "openclaw", ref: "main", id: "openclaw/openclaw" },
        path: "skills/nano-pdf"
    });
    const repoOnly = marketplace.parseGithubUrl("https://github.com/acme/skills");
    assert.equal(repoOnly.src.ref, "HEAD");
    assert.equal(repoOnly.path, "");
    assert.throws(() => marketplace.parseGithubUrl("https://github.com/acme/skills/tree/main/../x"));
    assert.throws(() => marketplace.parseGithubUrl("https://github.com/acme/skills/tree/main/%2e%2e/x"));
    assert.throws(() => marketplace.parseGithubUrl("https://evil.example/acme/skills"));
    assert.throws(() => marketplace.parseGithubUrl(""));
});

const SMP = "https://skillsmp.com/api/v1/skills/search";

test("searchSkillsmp interroge l'API, normalise les résultats et gère le quota", async () => {
    const fetch = fakeFetch({
        [`${SMP}?q=pdf&page=2&limit=20`]: {
            success: true,
            data: {
                skills: [
                    { id: "1", name: "Nano PDF", author: "openclaw", description: "Édite\n des PDF", githubUrl: "https://github.com/openclaw/openclaw/tree/main/skills/nano-pdf", stars: 12 },
                    { id: "2", name: "sans-url" }
                ],
                pagination: { page: 2, total: 1, hasNext: false }
            }
        }
    });
    const result = await marketplace.searchSkillsmp("pdf", { page: 2, fetch });
    assert.equal(result.skills.length, 1);
    assert.equal(result.skills[0].installName, "nano-pdf");
    assert.equal(result.skills[0].description, "Édite des PDF");
    assert.equal(result.skills[0].stars, 12);
    assert.equal(result.pagination.total, 1);

    let seen = null;
    const limited = async (_url, init) => {
        seen = init.headers.Authorization;
        return response({ success: false, error: { code: "RATE_LIMITED" } }, 429);
    };
    await assert.rejects(marketplace.searchSkillsmp("pdf", { fetch: limited, apiKey: "k" }), /Quota SkillsMP/);
    assert.equal(seen, "Bearer k");
    await assert.rejects(marketplace.searchSkillsmp("  ", { fetch }), /mot-clé/);
});

test("searchSkillsmp sans mot-clé avec sortBy stars charge le top (q générique « skill »)", async () => {
    const fetch = fakeFetch({
        [`${SMP}?q=skill&page=1&limit=20&sortBy=stars`]: {
            success: true,
            data: {
                skills: [
                    { id: "1", name: "Top Skill", author: "a", description: "populaire", githubUrl: "https://github.com/a/b/tree/main/skills/top-skill", stars: 999 }
                ],
                pagination: { page: 1, total: 1, hasNext: false }
            }
        }
    });
    const result = await marketplace.searchSkillsmp("", { sortBy: "stars", fetch });
    assert.equal(result.skills.length, 1);
    assert.equal(result.skills[0].stars, 999);
    assert.equal(result.skills[0].installName, "top-skill");
});

test("installFromGithub télécharge le dossier GitHub dans le dossier des skills", async () => {
    const dir = await tmpDir();
    const previous = process.env.FS_SKILLS_DIR;
    process.env.FS_SKILLS_DIR = dir;
    try {
        const fetch = fakeFetch({
            "https://api.github.com/repos/acme/skills/contents/skills/demo?ref=main": [
                { name: "SKILL.md", type: "file", size: SKILL_MD.length }
            ],
            "https://raw.githubusercontent.com/acme/skills/main/skills/demo/SKILL.md": SKILL_MD
        });
        const url = "https://github.com/acme/skills/tree/main/skills/demo";
        const result = await marketplace.installFromGithub(url, { fetch });
        assert.equal(result.name, "demo");
        assert.equal(result.source, "acme/skills");
        assert.equal(await fs.readFile(path.join(dir, "demo", "SKILL.md"), "utf8"), SKILL_MD);

        const renamed = await marketplace.installFromGithub(url, { fetch, name: "Demo Skill" });
        assert.equal(renamed.name, "demo-skill");
        await assert.rejects(marketplace.installFromGithub(url, { fetch }), /existe déjà/);

        const before = fetch.calls.length;
        await assert.rejects(marketplace.installFromGithub("https://github.com/acme/skills/tree/main/../x", { fetch }));
        assert.equal(fetch.calls.length, before);
    } finally {
        if (previous === undefined) delete process.env.FS_SKILLS_DIR;
        else process.env.FS_SKILLS_DIR = previous;
        await fs.rm(dir, { recursive: true, force: true });
    }
});
