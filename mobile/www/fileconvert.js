(function (root) {
  "use strict";

  const MAX_TEXT = Infinity; // aucune coupe : tout le texte extrait est envoye
  const MAX_ENTRY_BYTES = 200 * 1024 * 1024;
  const TEXT_ENTRY = /\.(txt|md|markdown|csv|tsv|json|xml|html?|css|js|mjs|ts|tsx|jsx|py|java|kt|c|cc|cpp|h|hpp|cs|go|rs|rb|php|swift|sql|yml|yaml|toml|ini|cfg|log|sh|bat|ps1|tex|srt|vtt)$/i;

  function u16(b, o) {
    return b[o] | (b[o + 1] << 8);
  }

  function u32(b, o) {
    return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  }

  function utf8(bytes) {
    return new TextDecoder("utf-8").decode(bytes);
  }

  let cp1252 = null;
  function windows1252(bytes) {
    if (!cp1252) cp1252 = new TextDecoder("windows-1252");
    return cp1252.decode(bytes);
  }

  function isZip(bytes) {
    return bytes.length >= 22 && bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 3 && bytes[3] === 4;
  }

  function zipEntries(bytes) {
    let end = -1;
    for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) {
      if (u32(bytes, i) === 0x06054b50) {
        end = i;
        break;
      }
    }
    if (end < 0) throw new Error("archive ZIP invalide");
    const count = u16(bytes, end + 10);
    let offset = u32(bytes, end + 16);
    const entries = [];
    for (let n = 0; n < count && offset + 46 <= bytes.length; n++) {
      if (u32(bytes, offset) !== 0x02014b50) break;
      const nameLength = u16(bytes, offset + 28);
      entries.push({
        name: utf8(bytes.subarray(offset + 46, offset + 46 + nameLength)),
        method: u16(bytes, offset + 10),
        compressedSize: u32(bytes, offset + 20),
        size: u32(bytes, offset + 24),
        localOffset: u32(bytes, offset + 42)
      });
      offset += 46 + nameLength + u16(bytes, offset + 30) + u16(bytes, offset + 32);
    }
    return entries;
  }

  async function inflateRaw(data) {
    if (typeof DecompressionStream !== "function") throw new Error("décompression indisponible");
    const stream = new Blob([data]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  async function readEntry(bytes, entry) {
    const o = entry.localOffset;
    if (u32(bytes, o) !== 0x04034b50) throw new Error("entrée ZIP invalide");
    if (entry.size > MAX_ENTRY_BYTES) throw new Error("entrée ZIP trop grande");
    const start = o + 30 + u16(bytes, o + 26) + u16(bytes, o + 28);
    const data = bytes.subarray(start, start + entry.compressedSize);
    if (entry.method === 0) return data;
    if (entry.method === 8) return inflateRaw(data);
    throw new Error("compression ZIP non prise en charge");
  }

  const NAMED_ENTITIES = {
    amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: "\u00a0", hellip: "\u2026",
    ndash: "\u2013", mdash: "\u2014", lsquo: "\u2018", rsquo: "\u2019", ldquo: "\u201c", rdquo: "\u201d",
    laquo: "\u00ab", raquo: "\u00bb", euro: "\u20ac", copy: "\u00a9", eacute: "\u00e9", egrave: "\u00e8",
    ecirc: "\u00ea", agrave: "\u00e0", acirc: "\u00e2", ccedil: "\u00e7", ugrave: "\u00f9", ocirc: "\u00f4", icirc: "\u00ee"
  };

  function decodeEntities(text) {
    return String(text).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (match, entity) => {
      if (entity[0] === "#") {
        const code = entity[1] === "x" || entity[1] === "X" ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
        try {
          return String.fromCodePoint(code);
        } catch {
          return match;
        }
      }
      return Object.prototype.hasOwnProperty.call(NAMED_ENTITIES, entity) ? NAMED_ENTITIES[entity] : match;
    });
  }

  function cleanText(text) {
    return String(text)
      .replace(/\r\n?/g, "\n")
      .replace(/[ \t\u00a0]+\n/g, "\n")
      .replace(/\n[ \t]*\n(?:[ \t]*\n)+/g, "\n\n")
      .trim();
  }

  function xmlToText(xml, rules) {
    let text = String(xml);
    for (const [pattern, replacement] of rules) text = text.replace(pattern, replacement);
    return cleanText(decodeEntities(text.replace(/<[^>]*>/g, "")));
  }

  const WORD_RULES = [
    [/<w:(instrText|delText)\b[^>]*>[\s\S]*?<\/w:\1>/g, ""],
    [/<w:tabs>[\s\S]*?<\/w:tabs>/g, ""],
    [/<w:tab\b[^>]*\/>/g, "\t"],
    [/<w:(br|cr)\b[^>]*\/>/g, "\n"],
    [/<\/w:p>\s*<\/w:tc>/g, "\t"],
    [/<\/w:tc>/g, "\t"],
    [/<\/w:tr>/g, "\n"],
    [/<\/w:p>/g, "\n"]
  ];

  const SLIDE_RULES = [
    [/<a:br\b[^>]*\/>/g, "\n"],
    [/<a:tab\b[^>]*\/>/g, "\t"],
    [/<\/a:p>\s*<\/a:tc>/g, "\t"],
    [/<\/a:tc>/g, "\t"],
    [/<\/a:tr>/g, "\n"],
    [/<\/a:p>/g, "\n"]
  ];

  const ODF_RULES = [
    [/<office:annotation\b[\s\S]*?<\/office:annotation>/g, ""],
    [/<text:s\b[^>]*\/>/g, " "],
    [/<text:tab\b[^>]*\/>/g, "\t"],
    [/<text:line-break\b[^>]*\/>/g, "\n"],
    [/<table:table\b[^>]*?table:name="([^"]*)"[^>]*>/g, "\n--- $1 ---\n"],
    [/<table:(table-cell|covered-table-cell)\b[^>]*\/>/g, "\t"],
    [/<\/text:(p|h)>\s*<\/table:table-cell>/g, "\t"],
    [/<\/table:table-cell>/g, "\t"],
    [/<\/table:table-row>/g, "\n"],
    [/<\/text:(p|h)>/g, "\n"],
    [/<\/draw:page>/g, "\n\n"]
  ];

  const HTML_RULES = [
    [/<head\b[\s\S]*?<\/head>/gi, ""],
    [/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, ""],
    [/<!--[\s\S]*?-->/g, ""],
    [/<br\b[^>]*>/gi, "\n"],
    [/<\/(td|th)>/gi, "\t"],
    [/<li\b[^>]*>/gi, "\n- "],
    [/<\/(p|div|h[1-6]|tr|li|blockquote|pre|section|article|ul|ol|table|title)>/gi, "\n"]
  ];

  function htmlToText(html) {
    return xmlToText(String(html).replace(/\s+/g, " "), HTML_RULES).replace(/\n +/g, "\n").replace(/ {2,}/g, " ");
  }

  function attr(source, name) {
    const match = new RegExp("(?:^|\\s)" + name + "=\"([^\"]*)\"").exec(source);
    return match ? decodeEntities(match[1]) : null;
  }

  function columnIndex(ref) {
    const match = /^([A-Z]+)/.exec(String(ref || ""));
    if (!match) return -1;
    let index = 0;
    for (const letter of match[1]) index = index * 26 + letter.charCodeAt(0) - 64;
    return index - 1;
  }

  function richText(xml) {
    return decodeEntities(String(xml).replace(/<rPh\b[\s\S]*?<\/rPh>/g, "").replace(/<[^>]*>/g, ""));
  }

  function sheetToText(xml, shared) {
    const lines = [];
    for (const row of String(xml).matchAll(/<row\b[^>]*>([\s\S]*?)<\/row>/g)) {
      const cells = [];
      for (const cell of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const attrs = cell[1];
        const body = cell[2] || "";
        const type = attr(attrs, "t");
        let value = "";
        if (type === "inlineStr") {
          value = richText(body);
        } else {
          const v = /<v>([\s\S]*?)<\/v>/.exec(body);
          const raw = v ? decodeEntities(v[1]) : "";
          if (type === "s") value = shared[Number(raw)] || "";
          else if (type === "b") value = raw === "1" ? "VRAI" : raw === "0" ? "FAUX" : raw;
          else value = raw;
        }
        const index = columnIndex(attr(attrs, "r"));
        if (index >= 0 && index < 1000) while (cells.length < index) cells.push("");
        cells.push(value.replace(/[\t\r\n]+/g, " "));
      }
      while (cells.length && cells[cells.length - 1] === "") cells.pop();
      if (cells.length) lines.push(cells.join("\t"));
    }
    return lines.join("\n");
  }

  function numbered(names, pattern) {
    return names
      .map(name => ({ name, match: pattern.exec(name) }))
      .filter(item => item.match)
      .sort((a, b) => Number(a.match[1]) - Number(b.match[1]))
      .map(item => item.name);
  }

  function resolvePath(base, href) {
    const parts = String(base || "").split("/").slice(0, -1);
    let target = String(href || "").split("#")[0];
    try {
      target = decodeURIComponent(target);
    } catch {
    }
    for (const part of target.split("/")) {
      if (part === "..") parts.pop();
      else if (part && part !== ".") parts.push(part);
    }
    return parts.join("/");
  }

  async function extractZip(bytes) {
    const entries = zipEntries(bytes);
    const byName = new Map(entries.map(entry => [entry.name, entry]));
    const names = entries.map(entry => entry.name);
    const read = async name => {
      const entry = byName.get(name);
      return entry ? utf8(await readEntry(bytes, entry)) : "";
    };
    const mimetype = byName.has("mimetype") ? (await read("mimetype")).trim() : "";

    if (byName.has("word/document.xml")) {
      const parts = [await read("word/document.xml")];
      for (const name of ["word/footnotes.xml", "word/endnotes.xml"]) {
        if (byName.has(name)) parts.push(await read(name));
      }
      return { format: "document Word", text: parts.map(xml => xmlToText(xml, WORD_RULES)).filter(Boolean).join("\n\n") };
    }

    const slides = numbered(names, /^ppt\/slides\/slide(\d+)\.xml$/);
    if (slides.length) {
      const parts = [];
      for (let i = 0; i < slides.length; i++) {
        const text = xmlToText(await read(slides[i]), SLIDE_RULES);
        if (text) parts.push("--- Diapositive " + (i + 1) + " ---\n" + text);
      }
      return { format: "présentation PowerPoint", text: parts.join("\n\n") };
    }

    const sheets = numbered(names, /^xl\/worksheets\/sheet(\d+)\.xml$/);
    if (sheets.length) {
      const shared = [...(await read("xl/sharedStrings.xml")).matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/g)].map(match => richText(match[1]));
      const titles = [...(await read("xl/workbook.xml")).matchAll(/<sheet\b[^>]*>/g)].map(match => attr(match[0], "name"));
      const parts = [];
      let length = 0;
      for (let i = 0; i < sheets.length && length < MAX_TEXT; i++) {
        const text = sheetToText(await read(sheets[i]), shared);
        if (!text) continue;
        parts.push("--- Feuille " + (titles[i] || i + 1) + " ---\n" + text);
        length += text.length;
      }
      return { format: "classeur Excel", text: parts.join("\n\n") };
    }

    if (byName.has("content.xml") && (mimetype.startsWith("application/vnd.oasis.opendocument") || byName.has("META-INF/manifest.xml"))) {
      return { format: "document OpenDocument", text: xmlToText(await read("content.xml"), ODF_RULES) };
    }

    if (mimetype === "application/epub+zip" || byName.has("META-INF/container.xml")) {
      let order = [];
      const rootfile = /<rootfile\b[^>]*>/.exec(await read("META-INF/container.xml"));
      const opfPath = rootfile ? attr(rootfile[0], "full-path") : null;
      if (opfPath && byName.has(opfPath)) {
        const opf = await read(opfPath);
        const hrefs = new Map();
        for (const match of opf.matchAll(/<item\b[^>]*>/g)) {
          const id = attr(match[0], "id");
          const href = attr(match[0], "href");
          if (id && href) hrefs.set(id, resolvePath(opfPath, href));
        }
        for (const match of opf.matchAll(/<itemref\b[^>]*>/g)) {
          const target = hrefs.get(attr(match[0], "idref"));
          if (target && byName.has(target)) order.push(target);
        }
      }
      if (!order.length) order = names.filter(name => /\.x?html?$/i.test(name)).sort();
      const parts = [];
      let length = 0;
      for (const name of order) {
        if (length >= MAX_TEXT) break;
        const text = htmlToText(await read(name));
        if (text) {
          parts.push(text);
          length += text.length;
        }
      }
      return { format: "livre EPUB", text: parts.join("\n\n") };
    }

    const listing = names.filter(name => !name.endsWith("/"));
    const parts = ["Contenu de l'archive (" + listing.length + " fichier(s)) :\n" + listing.join("\n")];
    let length = parts[0].length;
    for (const name of listing) {
      if (length >= MAX_TEXT) break;
      const entry = byName.get(name);
      if (!TEXT_ENTRY.test(name) || entry.size > MAX_TEXT * 2) continue;
      try {
        const text = decodeText(await readEntry(bytes, entry));
        if (text && text.trim()) {
          parts.push("--- " + name + " ---\n" + text.trim());
          length += text.length;
        }
      } catch {
      }
    }
    return { format: "archive ZIP", text: parts.join("\n\n") };
  }

  const RTF_SKIP = /^(fonttbl|colortbl|stylesheet|info|pict|themedata|colorschememapping|latentstyles|datastore|xmlnstbl|listtable|listoverridetable|rsidtbl|generator|filetbl|revtbl|object|objdata|header|footer|headerl|headerr|footerl|footerr)$/;

  function rtfToText(source) {
    const src = String(source);
    const stack = [];
    let out = "";
    let skip = false;
    let uc = 1;
    let i = 0;
    while (i < src.length) {
      const ch = src[i];
      if (ch === "{") {
        stack.push({ skip, uc });
        i++;
        continue;
      }
      if (ch === "}") {
        const state = stack.pop();
        if (state) {
          skip = state.skip;
          uc = state.uc;
        }
        i++;
        continue;
      }
      if (ch === "\\") {
        const next = src[i + 1];
        if (next === "\\" || next === "{" || next === "}") {
          if (!skip) out += next;
          i += 2;
          continue;
        }
        if (next === "*") {
          skip = true;
          i += 2;
          continue;
        }
        if (next === "'") {
          const code = parseInt(src.substr(i + 2, 2), 16);
          if (!skip && !isNaN(code)) out += windows1252(Uint8Array.of(code));
          i += 4;
          continue;
        }
        if (next === "~") {
          if (!skip) out += " ";
          i += 2;
          continue;
        }
        if (next === "\n" || next === "\r") {
          if (!skip) out += "\n";
          i += 2;
          continue;
        }
        const match = /^([a-zA-Z]+)(-?\d+)? ?/.exec(src.slice(i + 1, i + 48));
        if (!match) {
          i += 2;
          continue;
        }
        i += 1 + match[0].length;
        const word = match[1];
        const arg = match[2] === undefined ? null : parseInt(match[2], 10);
        if (RTF_SKIP.test(word)) {
          skip = true;
          continue;
        }
        if (skip) continue;
        if (word === "par" || word === "line" || word === "row" || word === "sect" || word === "page") out += "\n";
        else if (word === "tab" || word === "cell") out += "\t";
        else if (word === "uc" && arg !== null) uc = arg;
        else if (word === "u" && arg !== null) {
          out += String.fromCharCode(arg < 0 ? arg + 65536 : arg);
          for (let n = uc; n > 0 && i < src.length; n--) {
            if (src[i] === "\\" && src[i + 1] === "'") i += 4;
            else if (src[i] === "{" || src[i] === "}" || src[i] === "\\") break;
            else i++;
          }
        }
        continue;
      }
      if (ch !== "\r" && ch !== "\n" && !skip) out += ch;
      i++;
    }
    return cleanText(out);
  }

  function controlRatio(text) {
    if (!text.length) return 0;
    let bad = 0;
    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);
      if ((code < 32 && code !== 9 && code !== 10 && code !== 12 && code !== 13) || code === 0xfffd) bad++;
    }
    return bad / text.length;
  }

  function decodeText(bytes) {
    if (!bytes.length) return "";
    try {
      if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) return utf8(bytes.subarray(3));
      if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
      if (bytes[0] === 0xfe && bytes[1] === 0xff) return new TextDecoder("utf-16be").decode(bytes.subarray(2));
    } catch {
      return null;
    }
    if (bytes.subarray(0, 65536).includes(0)) return null;
    let text;
    try {
      text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
      text = windows1252(bytes);
    }
    return controlRatio(text.slice(0, 65536)) < 0.01 ? text : null;
  }

  function binaryStrings(bytes) {
    const seen = new Set();
    const parts = [];
    let length = 0;
    const add = run => {
      const text = run.replace(/\s+/g, " ").trim();
      if (text.length < 6 || !/[A-Za-z\u00c0-\u024f]{3}/.test(text) || seen.has(text)) return;
      seen.add(text);
      parts.push(text);
      length += text.length;
    };
    const wide = code => code === 9 || code === 10 || code === 13 || (code >= 32 && code < 127) || (code >= 0xa0 && code < 0x2000) || (code >= 0x2010 && code < 0x2070) || code === 0x20ac;
    let run = "";
    for (let i = 0; i + 1 < bytes.length && length < MAX_TEXT; i += 2) {
      const code = bytes[i] | (bytes[i + 1] << 8);
      if (wide(code)) run += String.fromCharCode(code);
      else {
        add(run);
        run = "";
      }
    }
    add(run);
    run = "";
    for (let i = 0; i < bytes.length && length < MAX_TEXT; i++) {
      const code = bytes[i];
      if (code === 9 || code === 10 || code === 13 || (code >= 32 && code < 127) || code >= 0xc0) run += String.fromCharCode(code);
      else {
        add(run);
        run = "";
      }
    }
    add(run);
    return parts.join("\n");
  }

  function finish(result) {
    if (!result) return null;
    const text = cleanText(result.text || "");
    if (!text) return null;
    return {
      format: result.format,
      text: text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) : text,
      truncated: text.length > MAX_TEXT,
      partial: Boolean(result.partial)
    };
  }

  async function extractText(input, name, mime) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    const lowerName = String(name || "").toLowerCase();
    if (isZip(bytes)) {
      try {
        const result = finish(await extractZip(bytes));
        if (result) return result;
      } catch (error) {
        if (typeof console !== "undefined") console.warn("Lecture ZIP impossible", error);
      }
    }
    if (windows1252(bytes.subarray(0, 5)) === "{\\rtf") {
      const result = finish({ format: "document RTF", text: rtfToText(windows1252(bytes)) });
      if (result) return result;
    }
    const plain = decodeText(bytes);
    if (plain !== null) {
      const isHtml = /\.(x?html?|xht)$/.test(lowerName) || /html/i.test(String(mime || ""));
      const result = finish(isHtml ? { format: "page HTML", text: htmlToText(plain) } : { format: "texte", text: plain });
      if (result) return result;
    }
    const result = finish({ format: "fichier binaire", text: binaryStrings(bytes), partial: true });
    return result && result.text.replace(/\s/g, "").length >= 20 ? result : null;
  }

  function describe(input, name, mime) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input || []);
    const hex = Array.from(bytes.subarray(0, 16), b => b.toString(16).padStart(2, "0")).join(" ");
    return "Nom : " + (name || "fichier") +
      "\nType : " + (mime || "inconnu") +
      "\nTaille : " + bytes.length + " octets" +
      "\nSignature (16 premiers octets) : " + (hex || "vide") +
      "\nLe contenu de ce fichier n'a pas pu être converti en texte sur le téléphone.";
  }

  async function embeddedThumbnail(input) {
    const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
    if (!isZip(bytes)) return null;
    const entry = zipEntries(bytes).find(item => /^docProps\/thumbnail\.(png|jpeg|jpg)$/i.test(item.name));
    if (!entry || entry.size > 5*1024*1024) return null;
    return new Blob([await readEntry(bytes,entry)], {type:/\.png$/i.test(entry.name)?'image/png':'image/jpeg'});
  }
  const api = { embeddedThumbnail, extractText, describe, htmlToText, rtfToText, decodeText, binaryStrings, zipEntries, isZip, MAX_TEXT };
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.FileConvert = api;
})(typeof window !== "undefined" ? window : globalThis);
