/* ---------- Transcript ---------- */

function scrollDown() {
    transcript.scrollTop = transcript.scrollHeight;
}

const QUIET_TOOLS = new Set(["read_file", "search_files", "list_directory"]);
let toolGroup = null;

function toolRowHtml(e) {
    return `<span class="tdot"></span><span class="name">${escapeHtml(toolLabel(e.name))}</span><span class="arg" title="${escapeHtml(e.arg || "")}">${escapeHtml(e.arg || "")}</span>`;
}

function plural(n, word) {
    return `${n} ${word}${n > 1 ? "s" : ""}`;
}

/** Lectures, recherches et listes successives : une seule ligne repliable. */
function addQuietTool(e) {
    if (!toolGroup) {
        const el = addEntry("tool-group", "<details><summary></summary><div class=\"tool-group-body\"></div></details>");
        toolGroup = { el, summary: el.querySelector("summary"), body: el.querySelector(".tool-group-body"), reads: 0, searches: 0, lists: 0, awaitingResult: false };
    }
    const g = toolGroup;
    if (e.name === "read_file") g.reads++;
    else if (e.name === "search_files") g.searches++;
    else g.lists++;
    const parts = [];
    if (g.reads) parts.push(plural(g.reads, "lecture"));
    if (g.searches) parts.push(plural(g.searches, "recherche"));
    if (g.lists) parts.push(`${plural(g.lists, "dossier")} listé${g.lists > 1 ? "s" : ""}`);
    g.summary.textContent = parts.join(" · ");
    const row = document.createElement("div");
    row.className = "entry tool";
    row.innerHTML = toolRowHtml(e);
    g.body.appendChild(row);
    g.awaitingResult = true;
    scrollDown();
    return row;
}

function addEntry(cls, html) {
    toolGroup = null;
    const div = document.createElement("div");
    div.className = `entry ${cls}`;
    div.innerHTML = html;
    transcript.appendChild(div);
    scrollDown();
    return div;
}

function appendOutput(text) {
    output.textContent += `${text}\n`;
    if (output.textContent.length > 200000) output.textContent = output.textContent.slice(-150000);
    output.scrollTop = output.scrollHeight;
}

/** Libellé court du type d'une pièce jointe : extension en majuscules (PDF, TXT, JS…) ou catégorie MIME. */
function attachmentTypeLabel(item) {
    const match = /\.([a-z0-9]{1,6})$/i.exec(String((item && item.name) || ""));
    if (match) return match[1].toUpperCase();
    const mime = String((item && item.mime) || "").toLowerCase();
    if ((item && item.kind === "image") || mime.startsWith("image/")) return "IMAGE";
    if ((item && item.kind === "text") || mime.startsWith("text/")) return "TEXTE";
    if (mime.startsWith("audio/")) return "AUDIO";
    if (mime.startsWith("video/")) return "VIDÉO";
    return "FICHIER";
}

/** Aperçu des pièces jointes d'un message envoyé : miniature pour les images, badge de type sinon. */
function buildUserAttachments(files) {
    const box = document.createElement("div");
    box.className = "user-attachments";
    files.forEach((item) => {
        const isImage = item.kind === "image" && typeof item.preview === "string" && /^data:image\//i.test(item.preview);
        const card = document.createElement("div");
        card.className = `user-attachment ${isImage ? "is-image" : "is-file"}`;
        const size = Number.isFinite(item.size) && typeof formatBytes === "function" ? formatBytes(item.size) : "";
        card.title = [item.name, item.mime, size].filter(Boolean).join(" · ");
        if (isImage) {
            const img = document.createElement("img");
            img.src = item.preview;
            img.alt = item.name;
            img.loading = "lazy";
            img.title = "Cliquer pour agrandir ou réduire";
            img.onclick = () => card.classList.toggle("expanded");
            card.appendChild(img);
        } else {
            const badge = document.createElement("span");
            badge.className = `user-attachment-type kind-${item.kind === "text" ? "text" : "file"}`;
            badge.textContent = attachmentTypeLabel(item);
            card.appendChild(badge);
        }
        const info = document.createElement("span");
        info.className = "user-attachment-info";
        const name = document.createElement("span");
        name.className = "user-attachment-name";
        name.textContent = item.name;
        info.appendChild(name);
        const meta = document.createElement("span");
        meta.className = "user-attachment-meta";
        meta.textContent = [isImage ? "Image" : item.kind === "text" ? "Texte" : "Fichier", size].filter(Boolean).join(" · ");
        info.appendChild(meta);
        card.appendChild(info);
        box.appendChild(card);
    });
    return box;
}

function renderEntry(e) {
    switch (e.type) {
        case "welcome":
            return null;
        case "user": {
            const files = Array.isArray(e.attachments) ? e.attachments.filter((a) => a && a.name) : [];
            // Les pièces jointes sont affichées en aperçu : on retire la ligne « Pièces jointes : … » du texte.
            const text = files.length ? String(e.text || "").replace(/(^|\n)Pièces jointes : [^\n]*$/, "") : e.text;
            const el = addEntry("user", escapeHtml(text));
            if (files.length) {
                el.appendChild(buildUserAttachments(files));
                scrollDown();
            }
            return el;
        }
        case "assistant":
            return addEntry("assistant", renderMarkdown(e.text));
        case "reason": {
            const el = addEntry("reason collapsed", `<span class="reason-mark">✻</span><span class="reason-text">${inline(e.text)}</span>`);
            el.title = "Cliquer pour déplier ou replier la réflexion";
            el.onclick = () => {
                if (!String(window.getSelection())) el.classList.toggle("collapsed");
            };
            return el;
        }
        case "info":
        case "warn":
        case "error":
            return addEntry(e.type, escapeHtml(e.text));
        case "print":
            return addEntry("print", `<pre>${escapeHtml((e.lines || []).join("\n"))}</pre>`);
        case "plan":
            return addEntry("plan", `<b>Plan</b><ol>${(e.items || []).map((i) => `<li>${inline(i)}</li>`).join("")}</ol>`);
        case "tool":
            if (e.name === "run_command") appendOutput(`$ ${e.arg}`);
            if (QUIET_TOOLS.has(e.name)) return addQuietTool(e);
            return addEntry("tool", toolRowHtml(e));
        case "result": {
            if (toolGroup && toolGroup.awaitingResult) {
                const row = document.createElement("div");
                row.className = `entry result ${e.tone || ""}`;
                row.textContent = `└ ${e.text}`;
                toolGroup.body.appendChild(row);
                toolGroup.awaitingResult = false;
                if (e.tone === "error" || e.tone === "err") toolGroup.el.classList.add("has-error");
                scrollDown();
                return row;
            }
            return addEntry(`result ${e.tone || ""}`, `└ ${escapeHtml(e.text)}`);
        }
        case "diff": {
            const el = addEntry("diff-entry", "");
            el.appendChild(buildDiffCard(e));
            if (e.path) recordChange(e.path, e.added, e.removed);
            return el;
        }
        default:
            return addEntry("info", escapeHtml(JSON.stringify(e)));
    }
}

function liveStart() {
    ui.liveText = "";
    ui.live = addEntry("assistant", "");
}

function liveAppend(text) {
    if (!ui.live) liveStart();
    ui.liveText += text;
    ui.live.innerHTML = renderMarkdown(ui.liveText);
    scrollDown();
}

function liveEnd() {
    ui.live = null;
    ui.liveText = "";
}

function setSpinner(data) {
    if (data.stop) {
        if (ui.spinnerId === data.id) {
            $("spinner").classList.add("hidden");
            ui.spinnerId = null;
            ui.spinnerStart = 0;
            if (ui.spinnerTimer) clearInterval(ui.spinnerTimer);
            ui.spinnerTimer = null;
        }
        return;
    }
    if (ui.spinnerId !== data.id || !ui.spinnerStart) ui.spinnerStart = Date.now();
    ui.spinnerId = data.id;
    ui.spinnerLabel = data.label || "";
    const paint = () => {
        const secs = Math.floor((Date.now() - ui.spinnerStart) / 1000);
        const elapsed = secs >= 60 ? `${Math.floor(secs / 60)} min ${String(secs % 60).padStart(2, "0")} s` : `${secs} s`;
        $("spinner-label").textContent = ui.spinnerLabel ? `${ui.spinnerLabel} · ${elapsed}` : elapsed;
    };
    paint();
    if (!ui.spinnerTimer) ui.spinnerTimer = setInterval(() => { if (ui.spinnerId) paint(); }, 1000);
    $("spinner").classList.remove("hidden");
}

