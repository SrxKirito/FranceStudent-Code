/* ---------- Rendu du texte ---------- */

const TOOL_LABELS = {
    ask_user: "Question de l’agent",
    effectcraft: "EffectCraft",
    list_directory: "Lister", read_file: "Lire", search_files: "Chercher",web_search_result:"Résultat web",view_image:"Examiner l’image",
    create_directory: "Créer le dossier", write_file: "Écrire", edit_file: "Éditer",
    move_path: "Déplacer", copy_path: "Copier", delete_path: "Supprimer",
    remember: "Mémoriser", run_command: "Commande", web_search: "Rechercher sur le web", web_fetch: "Lire une source", update_plan: "Actualiser le plan", semantic_search: "Explorer le code", diagnostics: "Diagnostics", browse: "Vérifier la page", job_output: "Lire la commande", job_stop: "Arrêter la commande"
};

function toolLabel(name) {
    return TOOL_LABELS[name] || String(name ?? "");
}

function escapeHtml(text) {
    return String(text ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;");
}

function inline(text) {
    return String(text ?? "").split(/(`[^`]+`|\[[^\]\n]+\]\(https?:\/\/[^)\s]+\)|\*\*[^*]+\*\*|https?:\/\/[^\s<>]+)/g).map(part => {
        if (part.startsWith("`") && part.endsWith("`")) return `<code>${escapeHtml(part.slice(1, -1))}</code>`;
        if (part.startsWith("**") && part.endsWith("**")) return `<b>${escapeHtml(part.slice(2, -2))}</b>`;
        const match = /^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)$/.exec(part);
        const url = match ? match[2] : /^https?:\/\//.test(part) ? part : null;
        if (url) return `<a href="${escapeHtml(url)}" data-web-url="${escapeHtml(url)}">${escapeHtml(match ? match[1] : url)}</a>`;
        return escapeHtml(part);
    }).join("");
}

/* Remplace un bloc « # nom.ext + contenu » d’une réponse de l’agent par une puce cliquable, sice fichier a été modifié pendant la tâche. */
function agentFileChip(source) {
    if (ui.status.mode === "chat" || !ui.changes || !ui.changes.size || typeof fileIcon !== "function") return null;
    const first = String(source || "").replace(/\r/g, "").split("\n")[0].trim();
    const named = /^(?:#|\/\/|--|%)\s*([\w@.\-\/\\]+\.\w{1,8})\s*$/.exec(first) || /^(?:<!--|\/\*)\s*([\w@.\-\/\\]+\.\w{1,8})\s*(?:-->|\*\/)$/.exec(first);
    if (!named) return null;
    const wanted = named[1].replace(/\\/g, "/").replace(/^\.\//, "");
    const path = [...ui.changes.keys()].find(key => key === wanted || key.endsWith("/" + wanted));
    if (!path) return null;
    const chip = document.createElement("button");
    chip.type = "button"; chip.className = "agent-file-chip"; chip.dataset.openPath = path;
    chip.title = `Ouvrir ${path} dans l’éditeur`; chip.setAttribute("aria-label", `Ouvrir ${path} dans l’éditeur`);
    const name = path.split("/").pop(), label = document.createElement("span");
    label.textContent = name; chip.append(fileIcon(name, "file"), label);
    return chip;
}

function renderMarkdown(src) {
    if(typeof window!=="undefined"&&window.StudioVendor) {
        // Protéger les formules avant Markdown, qui interprète notamment les barres inverses.
        const formulas = [];
        let markerPrefix = "FRSTMATH"; while (String(src ?? "").includes(markerPrefix)) markerPrefix += "X";
        const mathPattern = /```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)|`[^`\n]+`|\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([^\n]+?)\\\)|(^|[^\\$])\$([^\s$](?:[^$\n]*?[^\s$\\])?)\$(?![\w$])/g;
        const markedSource = String(src ?? "").replace(mathPattern, (match, block, brackets, parens, prefix, inlineMath) => {
            if (match.startsWith("`") || match.startsWith("~~~") || !window.katex) return match;
            const tex = block || brackets || parens || inlineMath;
            if (!tex?.trim()) return match;
            const marker = `${markerPrefix}${formulas.length}END`;
            try { formulas.push(window.katex.renderToString(tex.trim(), { displayMode: Boolean(block || brackets), throwOnError: false, trust: false, maxExpand: 100, maxSize: 20 })); }
            catch { formulas.push(escapeHtml(match.slice((prefix || "").length))); }
            return (prefix || "") + marker;
        });
        const template=document.createElement("template");template.innerHTML=window.StudioVendor.markdown(markedSource);
        for(const anchor of template.content.querySelectorAll("a")) {
            const href=anchor.getAttribute("href")||"";
            if(/^https?:\/\//i.test(href))anchor.dataset.webUrl=href;
            else anchor.removeAttribute("href");
        }
        for (const code of template.content.querySelectorAll("pre code")) {
            const language = [...code.classList].find(name => name.startsWith("language-"))?.slice(9).toLowerCase() || "";
            if (ui.status.mode === "chat") {
                const source = code.textContent || "", requested = [...transcript.querySelectorAll(".entry.user .message-content")].at(-1)?.textContent || "";
                let isDocument = language === "pdf" || /^(?:#|\/\/|%|--)\s*[\w-]+\.pdf\s*$/i.test(source.split("\n")[0].trim()) && /\bpdf\b/i.test(requested);
                if (["pptx", "powerpoint"].includes(language)) { try { parsePowerPoint(source); isDocument=true; } catch { /* bloc incomplet ou non valide */ } }
                const complete = [...String(src || "").matchAll(/```[^\n`]*\n([\s\S]*?)```/g)].some(match => match[1].replace(/\r/g, "").trimEnd() === source.replace(/\r/g, "").trimEnd());
                if (isDocument && complete) {
                    const placeholder=document.createElement("div"); placeholder.className="classic-generating-file"; placeholder.textContent="Préparation du fichier…"; code.parentElement.replaceWith(placeholder); continue;
                }
            }
            { const chip = agentFileChip(code.textContent); if (chip) { code.parentElement.replaceWith(chip); continue; } }
            if (["quiz", "cards"].includes(language) && typeof renderStudyBlock === "function") { const markup = renderStudyBlock(code.textContent, language, false); if (markup) { const holder = document.createElement("div"); holder.innerHTML = markup; code.parentElement.replaceWith(...holder.childNodes); continue; } }
            const kind = ({ javascript: "js", typescript: "ts", python: "py", markdown: "md", xml: "html" })[language] || language;
            code.innerHTML = highlightCode(code.textContent, kind);
        }
        if (formulas.length) template.innerHTML = template.innerHTML.replace(new RegExp(`${markerPrefix}(\\d+)END`, "g"), (marker, index) => formulas[Number(index)] ?? marker);
        return template.innerHTML;
    }
    const lines = String(src ?? "").split("\n");
    let html = "";
    let block = null;
    let list = null;
    const closeList = () => {
        if (list) {
            html += `</${list}>`;
            list = null;
        }
    };

    for (const line of lines) {
        if (/^\s*(```|~~~)/.test(line)) {
            if (block === null) {
                closeList();
                block = [];
            } else {
                html += `<pre><code>${escapeHtml(block.join("\n"))}</code></pre>`;
                block = null;
            }
            continue;
        }
        if (block !== null) {
            block.push(line);
            continue;
        }
        const heading = /^(#{1,6})\s+(.*)$/.exec(line);
        const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
        const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
        if (heading) {
            closeList();
            html += `<h4>${inline(heading[2])}</h4>`;
        } else if (bullet || numbered) {
            const kind = bullet ? "ul" : "ol";
            if (list !== kind) {
                closeList();
                html += `<${kind}>`;
                list = kind;
            }
            html += `<li>${inline((bullet || numbered)[1])}</li>`;
        } else if (!line.trim()) {
            closeList();
            html += "<br>";
        } else {
            closeList();
            html += `<div>${inline(line)}</div>`;
        }
    }

    if (block !== null) html += `<pre><code>${escapeHtml(block.join("\n"))}</code></pre>`;
    closeList();
    return html;
}

function diffLine(line) {
    if (typeof line === "string") {
        const first = line[0];
        const cls = first === "+" ? "add" : first === "-" ? "del" : first === "@" ? "hunk" : "";
        return { text: line, cls };
    }
    const kind = String(line?.type ?? line?.kind ?? line?.op ?? "");
    const text = String(line?.text ?? line?.line ?? line?.value ?? "");
    const cls = /add|ins|\+/.test(kind) ? "add" : /del|rem|-/.test(kind) ? "del" : /hunk|sep|@/.test(kind) ? "hunk" : "";
    const sign = cls === "add" ? "+ " : cls === "del" ? "- " : "  ";
    return { text: cls === "hunk" ? text : sign + text, cls };
}

function buildDiffCard(entry) {
    const card = document.createElement("div");
    card.className = "diff-card";

    if (entry.path) {
        const head = document.createElement("div");
        head.className = "diff-head";
        head.appendChild(fileIcon(entry.path, "file"));
        const p = document.createElement("span");
        p.className = "diff-path";
        p.textContent = entry.path;
        p.title = `${entry.path} — cliquez pour ouvrir`;
        p.onclick = () => openFile(entry.path);
        head.appendChild(p);
        const stats = document.createElement("span");
        stats.className = "diff-stats";
        const add = document.createElement("b");
        add.className = "add";
        add.textContent = `+${entry.added ?? 0}`;
        const del = document.createElement("b");
        del.className = "del";
        del.textContent = `-${entry.removed ?? 0}`;
        stats.append(add, del);
        head.appendChild(stats);
        card.appendChild(head);
    } else {
        const summary = document.createElement("div");
        summary.className = "diff-summary";
        summary.textContent = `+${entry.added ?? 0} / -${entry.removed ?? 0}`;
        card.appendChild(summary);
    }

    const body = document.createElement("div");
    body.className = "diff";
    body.innerHTML = (entry.lines || [])
        .map((line) => {
            const d = diffLine(line);
            return `<div class="${d.cls}">${escapeHtml(d.text) || " "}</div>`;
        })
        .join("");
    card.appendChild(body);
    return card;
}

