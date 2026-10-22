"use strict";

/**
 * Lecture des formats Office (docx, xlsx, pptx) et des archives zip, sans dépendance :
 * lecteur zip maison (répertoire central + zlib.inflateRawSync) et extraction du texte XML.
 * Lecture seule : ces fichiers ne sont jamais réécrits.
 */

const fs = require("node:fs/promises");
const path = require("node:path");
const zlib = require("node:zlib");

const OFFICE_EXTS = new Set([".docx", ".xlsx", ".pptx", ".zip"]);
const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
const MAX_ENTRY_BYTES = 20 * 1024 * 1024;
const MAX_ENTRIES = 5000;

function isOfficeFile(target) {
    return OFFICE_EXTS.has(path.extname(String(target)).toLowerCase());
}

/** Répertoire central du zip : [{ name, method, compSize, size, offset }]. */
function listZipEntries(buf) {
    const min = Math.max(0, buf.length - 65557);
    let eocd = -1;
    for (let i = buf.length - 22; i >= min; i--) {
        if (buf.readUInt32LE(i) === 0x06054b50) {
            eocd = i;
            break;
        }
    }
    if (eocd < 0) throw new Error("Archive zip invalide (fin de répertoire central introuvable).");
    const count = buf.readUInt16LE(eocd + 10);
    if (count > MAX_ENTRIES) throw new Error(`Archive trop volumineuse (${count} entrées).`);
    let p = buf.readUInt32LE(eocd + 16);
    const entries = [];
    for (let n = 0; n < count; n++) {
        if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) {
            throw new Error("Archive zip invalide (répertoire central corrompu).");
        }
        const method = buf.readUInt16LE(p + 10);
        const compSize = buf.readUInt32LE(p + 20);
        const size = buf.readUInt32LE(p + 24);
        const nameLen = buf.readUInt16LE(p + 28);
        const extraLen = buf.readUInt16LE(p + 30);
        const commentLen = buf.readUInt16LE(p + 32);
        const offset = buf.readUInt32LE(p + 42);
        const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
        entries.push({ name, method, compSize, size, offset });
        p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
}

function readZipEntry(buf, entry) {
    const p = entry.offset;
    if (p + 30 > buf.length || buf.readUInt32LE(p) !== 0x04034b50) {
        throw new Error(`Entrée zip invalide : ${entry.name}`);
    }
    if (entry.size > MAX_ENTRY_BYTES) throw new Error(`Entrée trop grande : ${entry.name}`);
    const start = p + 30 + buf.readUInt16LE(p + 26) + buf.readUInt16LE(p + 28);
    const data = buf.subarray(start, start + entry.compSize);
    if (entry.method === 0) return Buffer.from(data);
    if (entry.method === 8) return zlib.inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES });
    throw new Error(`Méthode de compression non gérée (${entry.method}) : ${entry.name}`);
}

function decodeXml(text) {
    return text
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
        .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
        .replace(/&amp;/g, "&");
}

function stripTags(xml) {
    return decodeXml(xml.replace(/<[^>]+>/g, ""));
}

function entryText(buf, entries, name) {
    const entry = entries.find((e) => e.name === name);
    return entry ? readZipEntry(buf, entry).toString("utf8") : null;
}

function byNumber(re) {
    return (a, b) => Number(re.exec(a.name)[1]) - Number(re.exec(b.name)[1]);
}

function docxText(buf, entries) {
    const xml = entryText(buf, entries, "word/document.xml");
    if (xml == null) throw new Error("word/document.xml absent : document Word invalide.");
    const text = xml
        .replace(/<w:tab\/>/g, "\t")
        .replace(/<w:br\/>/g, "\n")
        .replace(/<\/w:p>/g, "\n");
    return stripTags(text).replace(/\n{3,}/g, "\n\n").trim();
}

function xlsxText(buf, entries) {
    const shared = [];
    const sst = entryText(buf, entries, "xl/sharedStrings.xml");
    if (sst) {
        for (const m of sst.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
            shared.push([...m[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)].map((t) => decodeXml(t[1])).join(""));
        }
    }
    const re = /^xl\/worksheets\/sheet(\d+)\.xml$/;
    const sheets = entries.filter((e) => re.test(e.name)).sort(byNumber(re));
    const out = [];
    for (const sheet of sheets) {
        out.push(`## Feuille ${re.exec(sheet.name)[1]}`);
        const xml = readZipEntry(buf, sheet).toString("utf8");
        for (const row of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
            const cells = [];
            for (const c of row[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
                const type = (/\bt="([^"]+)"/.exec(c[1]) || [])[1];
                const inner = c[2] || "";
                const v = (/<v>([\s\S]*?)<\/v>/.exec(inner) || [])[1];
                let value = "";
                if (type === "s" && v !== undefined) value = shared[Number(v)] ?? "";
                else if (type === "inlineStr") value = stripTags(inner);
                else if (v !== undefined) value = decodeXml(v);
                cells.push(value);
            }
            out.push(cells.join("\t"));
        }
    }
    return out.join("\n").trim();
}

function pptxText(buf, entries) {
    const re = /^ppt\/slides\/slide(\d+)\.xml$/;
    const slides = entries.filter((e) => re.test(e.name)).sort(byNumber(re));
    const out = [];
    for (const slide of slides) {
        const xml = readZipEntry(buf, slide).toString("utf8");
        const paragraphs = [...xml.matchAll(/<a:p>([\s\S]*?)<\/a:p>/g)]
            .map((p) => [...p[1].matchAll(/<a:t>([\s\S]*?)<\/a:t>/g)].map((t) => decodeXml(t[1])).join(""))
            .filter((t) => t.trim());
        out.push(`## Diapositive ${re.exec(slide.name)[1]}`, ...paragraphs, "");
    }
    return out.join("\n").trim();
}

function zipListing(entries) {
    const lines = entries.map((e) => (e.name.endsWith("/") ? e.name : `${e.name}  (${e.size} octets)`));
    return `Archive zip : ${entries.length} entrée(s)\n${lines.join("\n")}`;
}

/** Texte lisible d'un docx/xlsx/pptx, ou liste du contenu d'un zip. */
async function readOfficeFile(target) {
    const info = await fs.stat(target);
    if (!info.isFile()) throw new Error("Ce chemin n'est pas un fichier.");
    if (info.size > MAX_ARCHIVE_BYTES) {
        throw new Error(`Fichier trop grand (${info.size} octets, maximum ${MAX_ARCHIVE_BYTES}).`);
    }
    const buf = await fs.readFile(target);
    const entries = listZipEntries(buf);
    const ext = path.extname(target).toLowerCase();
    if (ext === ".docx") return docxText(buf, entries);
    if (ext === ".xlsx") return xlsxText(buf, entries);
    if (ext === ".pptx") return pptxText(buf, entries);
    return zipListing(entries);
}

module.exports = { isOfficeFile, readOfficeFile, listZipEntries, readZipEntry };
