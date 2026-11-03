"use strict";

// Fonctions de pièces jointes et d'images générées inspirées de src/api
// (svg-input.js, media-input.js) et de docs/attachments.md.

const MAX_PDF_RENDER_PAGES = 40;
const VIDEO_FRAMES = 4;
const AUDIO_EXTENSIONS = /\.(mp3|wav|ogg|oga|opus|m4a|aac|flac|weba|amr|3ga|mid|midi)$/i;
const VIDEO_EXTENSIONS = /\.(mp4|m4v|webm|mov|mkv|avi|3gp|ogv|wmv)$/i;

function isSvgFile(file) {
  return String(file.type || "") === "image/svg+xml" || /\.svg$/i.test(String(file.name || ""));
}

function mediaKind(file) {
  const mime = String(file.type || "");
  const name = String(file.name || "");
  if (mime.startsWith("video/") || VIDEO_EXTENSIONS.test(name)) return "video";
  if (mime.startsWith("audio/") || AUDIO_EXTENSIONS.test(name)) return "audio";
  return "";
}

function formatMediaBytes(size) {
  const n = Number(size) || 0;
  if (n < 1024) return n + " o";
  if (n < 1024 * 1024) return (n / 1024).toFixed(1) + " Ko";
  return (n / 1024 / 1024).toFixed(1) + " Mo";
}

function formatMediaDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return "inconnue";
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = v => String(v).padStart(2, "0");
  return (h ? h + ":" + pad(m) : m) + ":" + pad(s);
}

// --- SVG : source complète + rendu PNG sans scripts ni ressources externes ---

function sanitizeSvg(source) {
  if (/<!DOCTYPE|<!ENTITY/i.test(source)) return null;
  const doc = new DOMParser().parseFromString(source, "image/svg+xml");
  const root = doc.documentElement;
  if (!root || root.localName !== "svg" || doc.getElementsByTagName("parsererror").length) return null;
  for (const element of Array.from(doc.getElementsByTagName("*"))) {
    if (["script", "foreignObject"].includes(element.localName) ||
      (element.localName === "style" && /url\s*\(|@import|\\/i.test(element.textContent))) {
      if (element.parentNode) element.parentNode.removeChild(element);
      continue;
    }
    for (const attribute of Array.from(element.attributes || [])) {
      const name = attribute.localName.toLowerCase();
      if (name.startsWith("on") || name === "base" ||
        (["href", "src"].includes(name) && !/^(?:#|data:image\/(?:png|jpeg|gif|webp);base64,)/i.test(attribute.value)) ||
 /url\s*\(\s*['"]?(?!#)|@import|\\/i.test(attribute.value)) {
        element.removeAttributeNode(attribute);
      }
    }
  }
  if (!root.getAttribute("xmlns")) root.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  return { svg: new XMLSerializer().serializeToString(doc), root };
}

async function svgToPng(svg, root) {
  const img = await loadImage("data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg));
  let width = img.naturalWidth || 0;
  let height = img.naturalHeight || 0;
  if (!width || !height) {
    const box = String(root.getAttribute("viewBox") || "").trim().split(/[\s,]+/).map(Number);
    width = box[2] > 0 ? box[2] : 1024;
    height = box[3] > 0 ? box[3] : 1024;
  }
  const scale = Math.min(4, 2048 / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  const context = canvas.getContext("2d");
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(img, 0, 0, canvas.width, canvas.height);
  const data = canvas.toDataURL("image/png");
  canvas.width = 0;
  canvas.height = 0;
  return data;
}

async function addSvgFile(file) {
  const name = file.name || "image.svg";
  const source = await file.text();
  let note = "[Source SVG complète ; rendu désactivé pour les déclarations externes.]\n";
  try {
    const clean = sanitizeSvg(source);
    if (clean) {
      const data = await svgToPng(clean.svg, clean.root);
      pendingFiles.push({ id: makeId(), name: name.replace(/\.svg$/i, "") + " (rendu).png", kind: "image", mime: "image/png", size: Math.round(data.length * 0.75), data });
      note = "[Source SVG complète ; un rendu PNG sans scripts ni ressources externes est joint.]\n";
    }
  } catch (error) {
    console.warn("Rendu SVG impossible", error);
    note = "[Source SVG complète ; le rendu visuel a échoué.]\n";
  }
  pendingFiles.push({ id: makeId(), name, kind: "text", mime: "text/plain", size: file.size, data: note + source });
  return true;
}

// --- Audio et vidéo : métadonnées + images clés de la vidéo ---

function waitMediaEvent(element, name, ms) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      clearTimeout(timer);
      element.removeEventListener(name, ok);
      element.removeEventListener("error", ko);
    };
    const ok = () => { cleanup(); resolve(); };
    const ko = () => { cleanup(); reject(new Error("média illisible")); };
    const timer = setTimeout(() => { cleanup(); reject(new Error("délai dépassé")); }, ms);
    element.addEventListener(name, ok);
    element.addEventListener("error", ko);
  });
}

function captureVideoFrame(video) {
  const width = video.videoWidth;
  const height = video.videoHeight;
  const scale = Math.min(1, 1280 / Math.max(width, height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
  const data = canvas.toDataURL("image/jpeg", 0.85);
  canvas.width = 0;
  canvas.height = 0;
  return data;
}

async function addMediaFile(file, kind) {
  const name = file.name || (kind === "video" ? "video" : "audio");
  const url = URL.createObjectURL(file);
  const element = document.createElement(kind);
  element.preload = kind === "video" ? "auto" : "metadata";
  element.muted = true;
  element.playsInline = true;
  try {
    const loaded = waitMediaEvent(element, "loadedmetadata", 15000);
    element.src = url;
    await loaded;
    const duration = element.duration;
    const lines = [
      "Analyse multimédia partielle faite sur le téléphone : métadonnées" + (kind === "video" ? " et quelques images clés." : "."),
      "Le son n'est pas transcrit : ne prétends pas avoir entendu le contenu" + (kind === "video" ? " ni visionné la vidéo en entier." : "."),
      "Nom : " + name,
      "Type : " + (file.type || "inconnu"),
      "Taille : " + formatMediaBytes(file.size),
      "Durée : " + formatMediaDuration(duration)
    ];
    const frames = [];
    if (kind === "video" && element.videoWidth && element.videoHeight) {
      lines.push("Dimensions : " + element.videoWidth + " × " + element.videoHeight + " px");
      const times = Number.isFinite(duration) && duration > 0
 ? Array.from({ length: VIDEO_FRAMES }, (_, i) => duration * (i + 0.5) / VIDEO_FRAMES)
        : [0];
      for (const time of times) {
        try {
   if (time > 0) {
     const seeked = waitMediaEvent(element, "seeked", 10000);
     element.currentTime = time;
     await seeked;
   } else if (element.readyState < 2) {
     await waitMediaEvent(element, "loadeddata", 10000);
          }
   frames.push({ time, data: captureVideoFrame(element) });
        } catch (error) {
   console.warn("Image clé impossible", error);
 }
      }
      if (frames.length) lines.push("Images clés jointes : " + frames.map(frame => formatMediaDuration(frame.time)).join(", "));
    }
    pendingFiles.push({ id: makeId(), name, kind: "text", mime: "text/plain", size: file.size, data: "[" + (kind === "video" ? "Vidéo" : "Audio") + " analysé sur le téléphone]\n" + lines.join("\n") });
    const base = name.replace(/\.[^.]+$/, "");
    for (const frame of frames) {
      pendingFiles.push({ id: makeId(), name: base + " (" + formatMediaDuration(frame.time).replace(/:/g, "m") + "s).jpg", kind: "image", mime: "image/jpeg", size: Math.round(frame.data.length * 0.75), data: frame.data });
    }
    return true;
  } catch (error) {
    console.warn("Analyse multimédia impossible", error);
    return false;
  } finally {
    element.removeAttribute("src");
    try { element.load(); } catch {}
    URL.revokeObjectURL(url);
  }
}

// --- Images identiques : une seule transmission ---

function dedupePendingImages() {
  const seen = new Set();
  const before = pendingFiles.length;
  pendingFiles = pendingFiles.filter(file => {
    if (file.kind !== "image" || typeof file.data !== "string") return true;
    if (seen.has(file.data)) return false;
    seen.add(file.data);
    return true;
  });
  return before - pendingFiles.length;
}

// --- Glisser-déposer de fichiers dans le chat ---

function setupDropZone() {
  const target = $("app") || document.body;
  let depth = 0;
  const hasFiles = event => event.dataTransfer && Array.from(event.dataTransfer.types || []).includes("Files");
  target.addEventListener("dragenter", event => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    depth++;
    target.classList.add("drop-active");
  });
  target.addEventListener("dragover", event => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  });
  target.addEventListener("dragleave", event => {
    if (!hasFiles(event)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) target.classList.remove("drop-active");
  });
  target.addEventListener("drop", event => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    depth = 0;
    target.classList.remove("drop-active");
    const files = event.dataTransfer.files;
    if (files && files.length) addFiles(files);
  });
}

// --- Visionneuse des images générées : agrandir, télécharger, partager, modifier ---

let imageViewer = null;

function closeImageViewer() {
  if (!imageViewer) return;
  imageViewer.classList.add("hidden");
  imageViewer.querySelector("img").removeAttribute("src");
}

async function shareGeneratedImage(src) {
  try {
    const blob = await (await fetch(src)).blob();
    const ext = blob.type === "image/jpeg" ? "jpg" : blob.type === "image/webp" ? "webp" : "png";
    const file = new File([blob], "image-generee." + ext, { type: blob.type || "image/png" });
    if (navigator.canShare && !navigator.canShare({ files: [file] })) throw new Error("partage non pris en charge");
    await navigator.share({ files: [file], title: "Image générée" });
  } catch (error) {
    if (error && error.name === "AbortError") return;
    showToast("Partage impossible : " + (error && error.message ? error.message : error), true);
  }
}

// Joint l'image générée au brouillon pour demander une variante ou une retouche.
function useImageAsAttachment(src) {
  const match = /^data:(image\/(?:png|jpe?g|webp));base64,/i.exec(String(src || ""));
  if (!match) {
    showToast("Image non disponible pour la retouche.", true);
    return;
  }
  if (!pendingFiles.some(file => file.kind === "image" && file.data === src)) {
    const ext = /jpe?g/i.test(match[1]) ? "jpg" : match[1].split("/")[1];
    pendingFiles.push({ id: makeId(), name: "image-a-modifier." + ext, kind: "image", mime: match[1].toLowerCase(), size: Math.round(src.length * 0.75), data: src });
  }
  if (store.imageMode !== true) {
    store.imageMode = true;
    saveStore();
    renderToggles();
  }
  renderAttachments();
  updateSendButton();
  closeImageViewer();
  const prompt = $("prompt");
  prompt.focus();
  showToast("Image jointe : décris la modification ou la variante souhaitée.");
}

function openImageViewer(src) {
  if (!src) return;
  if (!imageViewer) {
    const viewer = document.createElement("div");
    viewer.className = "image-viewer hidden";
    viewer.setAttribute("role", "dialog");
    viewer.setAttribute("aria-modal", "true");
    viewer.setAttribute("aria-label", "Image générée");
    viewer.innerHTML = '<img class="image-viewer-img" alt="Image générée">' +
      '<div class="image-viewer-bar">' +
      '<button type="button" data-act="download">Télécharger</button>' +
      '<button type="button" data-act="edit">Modifier</button>' +
      '<button type="button" data-act="share">Partager</button>' +
      '<button type="button" data-act="close">Fermer</button>' +
      '</div>';
    viewer.addEventListener("click", event => {
      const button = event.target.closest("button[data-act]");
      if (!button) {
        if (event.target === viewer) closeImageViewer();
 return;
      }
      const current = viewer.querySelector("img").src;
      const act = button.dataset.act;
      if (act === "download") downloadGeneratedImage(current);
      else if (act === "edit") useImageAsAttachment(current);
      else if (act === "share") shareGeneratedImage(current);
      else closeImageViewer();
    });
    document.addEventListener("keydown", event => {
      if (event.key === "Escape" && imageViewer && !imageViewer.classList.contains("hidden")) closeImageViewer();
    });
    document.body.appendChild(viewer);
    imageViewer = viewer;
  }
  imageViewer.querySelector('[data-act="share"]').classList.toggle("hidden", typeof navigator.share !== "function");
  imageViewer.querySelector("img").src = src;
  imageViewer.classList.remove("hidden");
  imageViewer.querySelector('[data-act="close"]').focus();
}
