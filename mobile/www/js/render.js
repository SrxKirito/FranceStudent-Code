"use strict";

function escapeHtml(text) {
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const CODE_KEYWORDS = new Set(("abstract and as async await break case catch char class const continue def default del delete do double elif else enum except export extends false False final finally float fn for from func function global go if impl import in instanceof int interface is lambda let long match mod mut namespace new nil none None not null or package pass private protected pub public raise return self static struct super switch this throw throws true True try type typeof undefined use using var void while with yield").split(" "));
const HASH_COMMENT_LANGS = /^(py|python|sh|bash|shell|zsh|rb|ruby|r|yaml|yml|toml|perl|ps1|powershell|dockerfile|makefile|conf|ini)$/;
const PLAIN_LANGS = /^(text|txt|plain|plaintext|md|markdown)$/;
const STRING_TOKEN = /"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`/;
const WORD_TOKEN = /\b\d+(?:\.\d+)?\b|[A-Za-z_$][\w$]*/;
const TABLE_SEPARATOR = /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/;

function highlightCode(code, lang) {
  const language = String(lang || "").toLowerCase();
  if (PLAIN_LANGS.test(language)) return escapeHtml(code);
  const comment = HASH_COMMENT_LANGS.test(language) ? /#[^\n]*/ : /\/\/[^\n]*|\/\*[\s\S]*?\*\/|<!--[\s\S]*?-->/;
  const pattern = new RegExp(comment.source + "|" + STRING_TOKEN.source + "|" + WORD_TOKEN.source, "g");
  let html = "";
  let last = 0;
  let match;
  while ((match = pattern.exec(code))) {
    const token = match[0];
    html += escapeHtml(code.slice(last, match.index));
    last = match.index + token.length;
    let kind = "";
    if (/^(#|\/\/|\/\*|<!--)/.test(token)) kind = "comment";
    else if (/^["'`]/.test(token)) kind = "string";
    else if (/^\d/.test(token)) kind = "number";
    else if (CODE_KEYWORDS.has(token)) kind = "keyword";
    else if (/^\s*\(/.test(code.slice(last, last + 20))) kind = "function";
    html += kind ? "<span class=\"tok-" + kind + "\">" + escapeHtml(token) + "</span>" : escapeHtml(token);
  }
  return html + escapeHtml(code.slice(last));
}

const DL_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 4v11"/><path d="m7 10 5 5 5-5"/><path d="M5 20h14"/></svg>';

function fileIconSvg(name, kind) {
  const ext = String(name || '').split('.').pop().toLowerCase();
  const isImg = kind === 'image' || ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'].includes(ext);
  const body = isImg
    ? '<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="9" cy="9" r="2"/><path d="m21 15-5-5L5 21"/>'
    : '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>';
  return '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + body + '</svg>';
}

function fileCardHtml(name, index) {
  const safe = escapeHtml(name);
  return '<button type="button" class="file-card" data-file-index="' + index + '" data-name="' + safe + '" title="Aperçu de ' + safe + '"><span class="file-card-icon">' + fileIconSvg(name) + '</span><span class="file-card-name">' + safe + '</span><span class="file-card-dl" title="Télécharger">' + DL_SVG + '</span></button>';
}

function fileNameFromCode(code, lang) {
  if (/^(pptx|powerpoint)$/i.test(String(lang || '')) && typeof powerPointFileName === 'function') return powerPointFileName(code);
  const ext = CODE_EXT[String(lang || '').trim().toLowerCase()];
  if (!ext) return '';
  const first = String(code || '').split('\n')[0].trim();
  const m = /^(#|[/][/]|<!--|[/][*]|--|%)/.test(first) ? first.match(/[A-Za-z0-9_-]+[.][A-Za-z0-9]{1,5}/) : null;
  if (m) return m[0];
  return ext === 'pdf' ? 'document.pdf' : '';
}

function showToast(text, isError) {
  let t = document.getElementById('app-toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'app-toast';
    t.setAttribute('role', 'status');
    document.body.appendChild(t);
  }
  t.textContent = text;
  const modal = document.querySelector('dialog[open]');
  if (modal && t.parentElement !== modal) modal.appendChild(t);
  else if (!modal && t.parentElement !== document.body) document.body.appendChild(t);
  t.className = 'app-toast show' + (isError ? ' error' : '');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { t.className = 'app-toast' + (isError ? ' error' : ''); }, 3200);
}

function renderCodeBlock(code, lang, open, downloads = []) {
  const study = typeof renderStudyBlock === 'function' ? renderStudyBlock(code, lang, open) : '';
  if (study) return study;
  const fname = fileNameFromCode(code, lang) || guessFileName(code, lang);
  const index = downloads.length;
  downloads.push({ name: fname, index });
  const fileOnly = /\.(pdf|pptx)$/i.test(fname);
  return '<div class="file-wrap' + (fileOnly ? ' file-only' : '') + '" data-file-index="' + index + '">' + renderCodeBlockInner(code, lang) + '</div>';
}

function renderCodeBlockInner(code, lang) {
  const label = lang ? escapeHtml(lang) : "code";
  return "<div class=\"code-block\"><div class=\"code-header\"><span class=\"code-lang\">" + label +
    "</span><button type=\"button\" class=\"code-copy\">Copier</button></div><pre><code>" +
    highlightCode(code, lang) + "</code></pre></div>";
}

const CODE_EXT = { python: 'py', py: 'py', javascript: 'js', js: 'js', typescript: 'ts', ts: 'ts', html: 'html', css: 'css', json: 'json', csv: 'csv', markdown: 'md', md: 'md', java: 'java', c: 'c', cpp: 'cpp', 'c++': 'cpp', csharp: 'cs', cs: 'cs', bash: 'sh', sh: 'sh', shell: 'sh', powershell: 'ps1', sql: 'sql', xml: 'xml', yaml: 'yml', yml: 'yml', php: 'php', ruby: 'rb', go: 'go', rust: 'rs', kotlin: 'kt', swift: 'swift', latex: 'tex', tex: 'tex', txt: 'txt', text: 'txt', pdf: 'pdf', svg: 'svg', pptx: 'pptx', powerpoint: 'pptx' };
const FILE_MIME = { py: 'text/x-python', js: 'text/javascript', html: 'text/html', css: 'text/css', json: 'application/json', csv: 'text/csv', md: 'text/markdown', pdf: 'application/pdf', pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', svg: 'image/svg+xml', xml: 'application/xml', txt: 'text/plain' };

function guessFileName(code, lang, block) {
  const ext = CODE_EXT[String(lang || '').trim().toLowerCase()] || 'txt';
  const re = /[A-Za-z0-9_-]+[.]([A-Za-z0-9]{1,5})/g;
  const pick = (text) => {
    let found = '';
    for (const m of String(text || '').matchAll(re)) if (m[1].toLowerCase() === ext) found = m[0];
    return found;
  };
  const first = code.split('\n')[0].trim();
  let name = /^(#|[/][/]|<!--|[/][*]|--|%)/.test(first) ? pick(first) : '';
  if (!name && block) {
    const prev = block.previousElementSibling;
    if (prev) name = pick(prev.textContent.slice(-300));
  }
  return name || 'fichier.' + ext;
}

function bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i += 8192) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
  return btoa(bin);
}

function makePdf(text) {
  const BS = String.fromCharCode(92);
  const lines = [];
  String(text).split('\r').join('').split('\t').join('    ').split('\n').forEach((raw) => {
    let line = raw;
    while (line.length > 95) { lines.push(line.slice(0, 95)); line = line.slice(95); }
    lines.push(line);
  });
  const esc = (s) => Array.from(s).map((ch) => {
    const c = ch.charCodeAt(0);
    if (ch === BS || ch === '(' || ch === ')') return BS + ch;
    return c < 256 ? ch : '?';
  }).join('');
  const pages = [];
  for (let i = 0; i < lines.length; i += 68) pages.push(lines.slice(i, i + 68));
  if (!pages.length) pages.push(['']);
  const objs = [];
  objs[1] = '<< /Type /Catalog /Pages 2 0 R >>';
  objs[3] = '<< /Type /Font /Subtype /Type1 /BaseFont /Courier /Encoding /WinAnsiEncoding >>';
  const kids = [];
  pages.forEach((pageLines, i) => {
    const pid = 4 + 2 * i;
    const cid = pid + 1;
    kids.push(pid + ' 0 R');
    const s = 'BT /F1 9 Tf 11 TL 40 813 Td ' + pageLines.map((l) => '(' + esc(l) + ") '").join(' ') + ' ET';
    objs[pid] = '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 3 0 R >> >> /Contents ' + cid + ' 0 R >>';
    objs[cid] = '<< /Length ' + s.length + ' >>\nstream\n' + s + '\nendstream';
  });
  objs[2] = '<< /Type /Pages /Kids [' + kids.join(' ') + '] /Count ' + pages.length + ' >>';
  let out = '%PDF-1.4\n';
  const offsets = [];
  for (let id = 1; id < objs.length; id++) {
    offsets[id] = out.length;
    out += id + ' 0 obj\n' + objs[id] + '\nendobj\n';
  }
  const xref = out.length;
  out += 'xref\n0 ' + objs.length + '\n0000000000 65535 f \n';
  for (let id = 1; id < objs.length; id++) out += String(offsets[id]).padStart(10, '0') + ' 00000 n \n';
  out += 'trailer\n<< /Size ' + objs.length + ' /Root 1 0 R >>\nstartxref\n' + xref + '\n%%EOF';
  const bytes = new Uint8Array(out.length);
  for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i) & 255;
  return bytes;
}

function fileSaverPlugin() {
  const cap = window.Capacitor;
  if (!cap || !(cap.isNativePlatform && cap.isNativePlatform())) return null;
  if (cap.Plugins && cap.Plugins.FileSaver) return cap.Plugins.FileSaver;
  return cap.registerPlugin ? cap.registerPlugin('FileSaver') : null;
}

async function saveFile(name, bytes) {
  const ext = name.split('.').pop().toLowerCase();
  const mime = FILE_MIME[ext] || 'text/plain';
  const plugin = fileSaverPlugin();
  if (plugin) {
    const res = await plugin.save({ name, mime, data: bytesToBase64(bytes) });
    return (res && res.path) || name;
  }
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return name;
}

async function generatedFileBytes(code, name) {
  return /\.pptx$/i.test(name) ? await makePowerPoint(code) : /\.pdf$/i.test(name) ? makePdf(code) : new TextEncoder().encode(code);
}

async function downloadCode(code, lang, block, button, forcedName) {
  const name = forcedName || guessFileName(code, lang, block);
  if (button?.disabled) return;
  const isCard = button && button.classList.contains('file-card');
  const old = button ? button.textContent : '';
  try {
    if (button) { button.disabled = true; button.setAttribute('aria-busy', 'true'); }
    const bytes = await generatedFileBytes(code, name);
    const path = String(await saveFile(name, bytes));
    const onIOS = window.Capacitor?.getPlatform?.() === 'ios';
    showToast(onIOS ? 'Fichier enregistré dans Fichiers → Sur mon iPhone → FranceStudent Chat.' : 'Fichier enregistré dans Téléchargements.');
    if (button && isCard) button.classList.add('saved');
    else if (button) { button.textContent = 'Enregistré'; button.title = path; }
  } catch (err) {
    showToast('Échec du téléchargement de « ' + name + ' »' + (/\.pptx$/i.test(name) ? ' : ' + err.message : ''), true);
    if (button && !isCard) button.textContent = 'Échec';
    console.error(err);
  } finally {
    if (button) { button.disabled = false; button.removeAttribute('aria-busy'); }
  }
  if (button && !isCard) setTimeout(() => { button.textContent = old; }, 2500);
}

function renderInline(text) {
  const codes = [];
  const html = escapeHtml(text)
    .replace(/`([^`]+)`/g, (_, code) => {
      codes.push("<code>" + code + "</code>");
      return "\u0000" + (codes.length - 1) + "\u0000";
    })
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, "<a href=\"$2\" target=\"_blank\" rel=\"noopener noreferrer\">$1</a>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/~~([^~]+)~~/g, "<del>$1</del>")
    .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>");
  return html.replace(/\u0000(\d+)\u0000/g, (_, index) => codes[Number(index)]);
}

function splitRow(line) {
  let row = line.trim();
  if (row.startsWith("|")) row = row.slice(1);
  if (row.endsWith("|")) row = row.slice(0, -1);
  return row.split("|").map(cell => cell.trim());
}

function renderTable(header, separator, rows) {
  const aligns = splitRow(separator).map(cell =>
    cell.startsWith(":") && cell.endsWith(":") ? "center" : cell.endsWith(":") ? "right" : "");
  const cell = (tag, text, index) =>
    "<" + tag + (aligns[index] ? " style=\"text-align:" + aligns[index] + "\"" : "") + ">" + renderInline(text) + "</" + tag + ">";
  const head = splitRow(header);
  let html = "<div class=\"table-wrap\"><table><thead><tr>" + head.map((text, index) => cell("th", text, index)).join("") + "</tr></thead><tbody>";
  for (const row of rows) {
    const cells = splitRow(row);
    html += "<tr>" + head.map((_, index) => cell("td", cells[index] || "", index)).join("") + "</tr>";
  }
  return html + "</tbody></table></div>";
}

function renderBlocks(text) {
  const lines = text.split("\n");
  let html = "";
  let paragraph = [];
  let list = null;
  let quote = [];

  const flushParagraph = () => {
    if (paragraph.length) html += "<p>" + paragraph.map(renderInline).join("<br>") + "</p>";
    paragraph = [];
  };
  const flushList = () => {
    if (list) {
      const start = list.type === "ol" && list.start > 1 ? " start=\"" + list.start + "\"" : "";
      html += "<" + list.type + start + ">" + list.items.map(item => "<li>" + item.map(renderInline).join("<br>") + "</li>").join("") + "</" + list.type + ">";
    }
    list = null;
  };
  const flushQuote = () => {
    if (quote.length) html += "<blockquote>" + renderBlocks(quote.join("\n")) + "</blockquote>";
    quote = [];
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
    flushQuote();
  };
  const addItem = (type, item, start) => {
    flushParagraph();
    flushQuote();
    if (!list || list.type !== type) {
      flushList();
      list = { type, items: [], start };
    }
    list.items.push([item]);
  };

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.trimEnd();
    let match;
    if (!line.trim()) {
      flushAll();
    } else if (line.includes("|") && i + 1 < lines.length && lines[i + 1].includes("-") && TABLE_SEPARATOR.test(lines[i + 1])) {
      flushAll();
      const rows = [];
      let next = i + 2;
      while (next < lines.length && lines[next].trim() && lines[next].includes("|")) rows.push(lines[next++]);
      html += renderTable(line, lines[i + 1], rows);
      i = next - 1;
    } else if ((match = /^(#{1,6})\s+(.*?)\s*#*$/.exec(line))) {
      flushAll();
      const level = match[1].length;
      html += "<h" + level + ">" + renderInline(match[2]) + "</h" + level + ">";
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      flushAll();
      html += "<hr>";
    } else if ((match = /^\s*>\s?(.*)$/.exec(line))) {
      flushParagraph();
      flushList();
      quote.push(match[1]);
    } else if ((match = /^\s*[-*+]\s+(.*)$/.exec(line))) {
      addItem("ul", match[1]);
    } else if ((match = /^\s*(\d+)[.)]\s+(.*)$/.exec(line))) {
      addItem("ol", match[2], Number(match[1]));
    } else if (list && /^\s+\S/.test(raw)) {
      list.items[list.items.length - 1].push(line.trim());
    } else {
      flushList();
      flushQuote();
      paragraph.push(line);
    }
  }
  flushAll();
  return html;
}

function renderMarkdown(source, streaming = false) {
  const downloads = [];
  const lines = String(source).replace(/\r\n?/g, "\n").split("\n");
  let html = "";
  let text = [];
  let code = null;
  for (const line of lines) {
    const trimmed = line.trim();
    if (code) {
      if (trimmed.length >= code.fence.length && trimmed === code.fence[0].repeat(trimmed.length)) {
        html += renderCodeBlock(code.lines.join("\n"), code.lang, false, downloads);
        code = null;
      } else {
        code.lines.push(line);
      }
      continue;
    }
    const fence = /^\s*(`{3,}|~{3,})\s*([\w#+.-]*)/.exec(line);
    if (fence) {
      html += renderTextWithMath(text.join("\n"));
      text = [];
      code = { fence: fence[1], lang: fence[2], lines: [] };
    } else {
      text.push(line);
    }
  }
  if (code) html += renderCodeBlock(code.lines.join("\n"), code.lang, true, downloads);
  html += renderTextWithMath(text.join("\n"));
  if (!streaming && downloads.length) html += '<div class="message-downloads" role="group" aria-label="Fichiers à télécharger">' + downloads.map(file => fileCardHtml(file.name, file.index)).join("") + '</div>';
  return html;
}

const MATH_PATTERN = /`[^`\n]+`|\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]|\\\(([\s\S]+?)\\\)|(^|[^\\$])\$([^\s$](?:[^$\n]*?[^\s$\\])?)\$(?![\w$])/g;

function renderMath(tex, display, raw) {
  const lib = typeof window !== "undefined" ? window.katex : undefined;
  if (!lib || typeof lib.renderToString !== "function") return escapeHtml(raw);
  try {
    return lib.renderToString(tex, { displayMode: display, throwOnError: false, output: "htmlAndMathml" });
  } catch {
    return escapeHtml(raw);
  }
}

function renderTextWithMath(text) {
  const maths = [];
  const stashed = text.replace(MATH_PATTERN, (match, dollarBlock, bracketBlock, parenInline, prefix, dollarInline) => {
    if (match[0] === "`") return match;
    let lead = "";
    let tex;
    let display = false;
    if (dollarBlock !== undefined) {
      tex = dollarBlock;
      display = true;
    } else if (bracketBlock !== undefined) {
      tex = bracketBlock;
      display = true;
    } else if (parenInline !== undefined) {
      tex = parenInline;
    } else {
      lead = prefix || "";
      tex = dollarInline;
    }
    if (!tex || !tex.trim()) return match;
    maths.push(renderMath(tex.trim(), display, match.slice(lead.length)));
    return lead + "\u0001" + (maths.length - 1) + "\u0001";
  });
  const html = renderBlocks(stashed);
  if (!maths.length) return html;
  return html.replace(/\u0001(\d+)\u0001/g, (_, index) => maths[Number(index)] || "");
}

