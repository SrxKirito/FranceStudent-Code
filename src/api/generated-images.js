"use strict";
// Seules les images de sortie complètes sont retenues ; jamais les images envoyées.
const MAX_IMAGE_DATA = 8 * 1024 * 1024;
function collectGeneratedImages(root) {
    const images = [], seen = new Set();
    function visit(node, depth) {
        if (depth > 10 || !node) return;
        if (typeof node === "string") {
            if (/^\s*[\[{]/.test(node) && node.length <= MAX_IMAGE_DATA * 2) { try { visit(JSON.parse(node), depth + 1); } catch { /* texte ordinaire */ } }
            return;
        }
        if (typeof node !== "object") return;
        if (Array.isArray(node)) { for (const item of node) visit(item, depth + 1); return; }
        const type = String(node.type || "");
        if (/partial|input/i.test(type) || /^(user|system)$/i.test(String(node.role || ""))) return;
        if (/image_generation|imagegeneration|generated[_-]?image|output_image|^image$|^image_file$/i.test(type) || /image.?generation/i.test(String(node.toolName || node.tool_name || "")) || /^image\//i.test(String(node.mimeType || node.mime_type || ""))) {
            const raw = [node.result, node.b64_json, node.image_base64, node.base64, node.imageData, node.data, node.url, node.image_url?.url, node.image_url, node.imageUrl]
                .find(value => typeof value === "string" && value.length > 200 && value.length <= MAX_IMAGE_DATA && /^(?:data:image\/(?:png|jpeg|webp|gif);base64,|iVBORw0KGgo|\/9j\/|UklGR|R0lGOD)/i.test(value));
            if (raw) {
                const mime = raw.startsWith("/9j/") ? "image/jpeg" : raw.startsWith("UklGR") ? "image/webp" : raw.startsWith("R0lGOD") ? "image/gif" : "image/png";
                const data = raw.startsWith("data:") ? raw : `data:${mime};base64,${raw}`;
                const key = `${data.length}:${data.slice(-64)}`;
                if (!seen.has(key)) { seen.add(key); images.push(data); }
            }
        }
        for (const [key, value] of Object.entries(node)) {
            if (/partial|input/i.test(key) || ["result", "b64_json", "image_base64", "base64", "imageData", "data"].includes(key) && typeof value === "string") continue;
            visit(value, depth + 1);
        }
    }
    visit(root, 0); return images;
}
function collectImageReferences(message) {
    const refs = [], seen = new Set();
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const messageId = String(message?.id || message?.messageId || "");
    if (!uuid.test(messageId)) return refs;
    function visit(node, depth) {
        if (depth > 10 || !node) return;
        if (typeof node === "string") { if (/^\s*[\[{]/.test(node)) { try { visit(JSON.parse(node), depth + 1); } catch {} } return; }
        if (typeof node !== "object") return;
        if (Array.isArray(node)) { for (const item of node) visit(item, depth + 1); return; }
        const type = String(node.type || "");
        if (/partial|input/i.test(type) || /^(user|system)$/i.test(String(node.role || ""))) return;
        // Le service conserve aussi le résultat dans parts[].output avec kind:image.
        // On récupère son UUID via l'API authentifiée, jamais via une URL arbitraire.
        if (/image_generation|imagegeneration|generated[_-]?image|output_image|^image$|^image_file$/i.test(type) || node.kind === "image" && /^(?:COMPLETED|completed|succeeded|success)$/.test(String(node.status || "")) || ["imageId", "image_id", "generatedImageId", "generated_image_id", "fileId", "file_id"].some(key => typeof node[key] === "string")) {
            const inline = [node.result, node.b64_json, node.image_base64, node.base64, node.imageData, node.data].some(value => typeof value === "string" && value.length > 200 && value.length <= MAX_IMAGE_DATA && /^(?:data:image\/|iVBORw0KGgo|\/9j\/|UklGR|R0lGOD)/i.test(value));
            const id = [node.imageId, node.image_id, node.generatedImageId, node.generated_image_id, node.fileId, node.file_id, node.result, type !== "image_generation_call" ? node.id : null].find(value => typeof value === "string" && uuid.test(value));
            if (id && !inline && !seen.has(id)) { seen.add(id); refs.push({ messageId, id }); }
        }
        for (const [key, value] of Object.entries(node)) {
            if (/partial|input/i.test(key)) continue;
            if (key === "images" && Array.isArray(value)) for (const image of value) {
                if (typeof image === "string" && uuid.test(image) && !seen.has(image)) { seen.add(image); refs.push({ messageId, id: image }); }
            }
            visit(value, depth + 1);
        }
    }
    visit(message, 0); return refs.slice(0, 8);
}
module.exports = { collectGeneratedImages, collectImageReferences, MAX_IMAGE_DATA };
