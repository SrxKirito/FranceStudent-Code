"use strict";

const MAX_FILE_BYTES = 50 * 1024 * 1024;
let pendingFiles = [];
let recognition = null;

function hasDraft() {
  return Boolean($("prompt").value.trim()) || pendingFiles.length > 0;
}

function updateSendButton() {
  const send = $("send");
  if (busy) {
    send.disabled = false;
    send.classList.add("stop");
    send.innerHTML = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
    send.setAttribute("aria-label", "Arrêter la génération");
    send.title = "Arrêter la génération";
  } else {
    send.disabled = !hasDraft();
    send.classList.remove("stop");
    send.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 19V5"/><path d="M6 11l6-6 6 6"/></svg>';
    send.setAttribute("aria-label", "Envoyer");
    send.title = "Envoyer (Entrée)";
  }
}

function resizePrompt() {
  const prompt = $("prompt");
  prompt.style.height = "auto";
  const limit = Math.min(200, (window.visualViewport?.height || window.innerHeight) * 0.3);
  prompt.style.height = Math.min(prompt.scrollHeight, limit) + "px";
  prompt.style.overflowY = prompt.scrollHeight > limit ? "auto" : "hidden";
}

const TEXT_EXTENSIONS = /\.(txt|md|markdown|csv|tsv|json|jsonl|js|mjs|cjs|jsx|ts|tsx|py|java|kt|c|cc|cpp|h|hpp|cs|go|rs|rb|php|swift|html|htm|css|scss|xml|yml|yaml|toml|ini|cfg|conf|sql|log|sh|bat|ps1|tex|srt|vtt)$/i;

function isTextFile(file) {
  const mime = String(file.type || "");
  if (mime.startsWith("text/")) return true;
  if (/^application\/(json|xml|javascript|x-yaml|x-sh|sql)/.test(mime)) return true;
  return TEXT_EXTENSIONS.test(String(file.name || ""));
}

function renderToggles() {
  const items = [
    ["toggle-web", store.webSearch === true, "Désactiver la recherche web", "Activer la recherche web"],
    ["toggle-image", store.imageMode === true, "Désactiver la génération d'image", "Activer la génération d'image"],
    ["toggle-powerpoint", store.powerpointMode === true, "Désactiver la création PowerPoint", "Créer un PowerPoint"]
  ];
  for (const [id, active, onTitle, offTitle] of items) {
    const button = $(id);
    if (!button) continue;
    button.setAttribute("aria-pressed", String(active));
    button.setAttribute("aria-checked", String(active));
    button.title = active ? onTitle : offTitle;
    if (id === "toggle-web") {
      button.disabled = store.webSearchMode === "disabled";
      if (button.disabled) button.title = "Recherche web désactivée dans Paramètres > Général";
    }
  }
  renderStudyToggle();
  renderImageModel();
}

function renderComposerTools() {
  const active = [];
  if (store.webSearch === true && store.webSearchMode !== "disabled") active.push("Recherche web");
  if (store.imageMode === true) active.push("Image");
  if (STUDY_MODES[store.studyMode]) active.push("Étudiant : " + STUDY_MODES[store.studyMode].label);
  $("attach").classList.toggle("has-active-tools", active.length > 0);
  const label = "Outils et pièces jointes" + (active.length ? ". Actifs : " + active.join(", ") : "");
  $("attach").setAttribute("aria-label", label);
  $("attach").title = label;
}

const STUDY_MODES = {
  fiches: {
    label: "Fiches",
    instruction: "Mode étudiant — FICHES DE RÉVISION. À partir du cours, du texte ou du document fourni ci-dessous, rédige des fiches de révision claires en français : pour chaque notion, un titre, une définition courte, les points clés, les formules ou dates importantes et un exemple. Termine par un court résumé des essentiels à retenir. Appuie-toi uniquement sur le contenu fourni; si rien n'est fourni, demande-moi le cours ou le PDF."
  },
  quiz: {
    label: "Quiz",
    instruction: "Mode étudiant — QUIZ. À partir du cours, du texte ou du document fourni ci-dessous, crée un quiz en français d'environ 10 questions (QCM avec 4 propositions, vrai/faux et quelques questions ouvertes) de difficulté progressive. Place les corrections détaillées avec explications à la fin, après la liste des questions. Appuie-toi uniquement sur le contenu fourni ; si rien n'est fourni, demande-moi le cours ou le PDF."
  },
  cartes: {
    label: "Cartes mémoire",
    instruction: "Mode étudiant — CARTES MÉMOIRE. À partir du cours, du texte ou du document fourni ci-dessous, génère des cartes mémoire (flashcards) en français, une vingtaine si le contenu le permet. Utilise le format « Carte N — Question : … / Réponse : … », avec des questions courtes et des réponses concises. Appuie-toi uniquement sur le contenu fourni ; si rien n'est fourni, demande-moi le cours ou le PDF."
  }
};

function renderStudyToggle() {
  const button = $("toggle-study");
  if (!button) return;
  const mode = STUDY_MODES[store.studyMode];
  button.setAttribute("aria-pressed", String(Boolean(mode)));
  const label = $("study-label");
  if (label) label.textContent = mode ? "Étudiant : " + mode.label : "Étudiant";
  button.title = mode ? "Mode étudiant : " + mode.label + " (toucher pour changer)" : "Mode étudiant : fiches, quiz ou cartes mémoire";
  renderComposerTools();
}

function cycleStudyMode() {
  const order = ["", "fiches", "quiz", "cartes"];
  const next = order[(order.indexOf(store.studyMode || "") + 1) % order.length];
  store.studyMode = next;
  saveStore();
  renderStudyToggle();
  showToast(next ? "Mode étudiant : " + STUDY_MODES[next].label + ". Joignez un cours ou un PDF,ou collez votre texte." : "Mode étudiant désactivé.");
}

function setupStudyMenu() {
  const button = $("toggle-study");
  const menu = $("study-menu");
  if (!button || !menu) return;
  const close = () => {
    menu.classList.add("hidden");
    button.setAttribute("aria-expanded", "false");
  };
  button.addEventListener("click", event => {
    event.stopPropagation();
    const open = menu.classList.contains("hidden");
    closeMenus();
    menu.querySelectorAll("[data-study]").forEach(option => {
      const selected = option.dataset.study === (store.studyMode || "");
      option.classList.toggle("selected", selected);
      option.setAttribute("aria-checked", String(selected));
    });
    menu.classList.toggle("hidden", !open);
    button.setAttribute("aria-expanded", String(open));
    if (open) menu.querySelector(".selected")?.focus();
  });
  menu.addEventListener("click", event => {
    const option = event.target.closest("[data-study]");
    if (!option || !menu.contains(option)) return;
    const mode = option.dataset.study;
    if (mode && !STUDY_MODES[mode]) return;
    store.studyMode = mode;
    if (mode) store.powerpointMode = false;
    saveStore();
    renderToggles();
    close();
    $("attach").focus();
  });
  document.addEventListener("click", event => {
    if (!menu.contains(event.target) && !button.contains(event.target)) close();
  });
  document.addEventListener("keydown", event => {
    if (menu.classList.contains("hidden")) return;
    if (event.key === "Escape") { close(); $("attach").focus(); }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const options = [...menu.querySelectorAll("[data-study]")];
      const index = options.indexOf(document.activeElement);
      options[(index + (event.key === "ArrowDown" ? 1 : -1) + options.length) % options.length].focus();
    }
  });
}

const IMAGE_MODELS = {
  "gpt-image-2.5-sunburst": { short: "Sunburst", name: "GPT Image 2.5 Sunburst" },
  "gpt-image-2.5-flare": { short: "Flare", name: "GPT Image 2.5 Flare" },
  "gpt-image-2": { short: "Image 2", name: "gpt-image-2" }
};

function renderImageModel() {
  const button = $("image-model");
  const menu = $("image-model-menu");
  if (!button || !menu) return;
  const on = store.imageMode === true;
  button.classList.toggle("hidden", !on);
  if (!on) closeImageModelMenu();
  const info = IMAGE_MODELS[store.imageModel] || IMAGE_MODELS["gpt-image-2.5-flare"];
  $("image-model-label").textContent = info.short;
  let logo = button.querySelector(".model-logo");
  if (!logo) {
    logo = document.createElement("span");
    logo.className = "model-logo";
    logo.setAttribute("aria-hidden", "true");
    button.prepend(logo);
  }
  logo.innerHTML = providerMark({ provider: "OpenAI" });
  button.title = "Modèle d'image : " + info.name;
  for (const option of menu.querySelectorAll(".image-model-option")) {
    const icon = option.querySelector(".image-model-icon");
    if (icon) icon.innerHTML = providerMark({ provider: "OpenAI" });
    const selected = option.dataset.model === store.imageModel;
    option.classList.toggle("selected", selected);
    option.setAttribute("aria-checked", String(selected));
  }
}

function closeImageModelMenu() {
  const menu = $("image-model-menu");
  const button = $("image-model");
  if (menu) menu.classList.add("hidden");
  if (button) button.setAttribute("aria-expanded", "false");
}

function setupImageModelMenu() {
  const button = $("image-model");
  const menu = $("image-model-menu");
  if (!button || !menu) return;
  button.addEventListener("click", event => {
    event.stopPropagation();
    const open = menu.classList.contains("hidden");
    menu.classList.toggle("hidden", !open);
    button.setAttribute("aria-expanded", String(open));
  });
  menu.addEventListener("click", event => {
    event.stopPropagation();
    const option = event.target.closest(".image-model-option");
    if (!option || !IMAGE_MODELS[option.dataset.model]) return;
    store.imageModel = option.dataset.model;
    saveStore();
    renderImageModel();
    closeImageModelMenu();
  });
  document.addEventListener("click", event => {
    if (!menu.classList.contains("hidden") && !menu.contains(event.target) && event.target !== button) closeImageModelMenu();
  });
}

function readFileAs(file, mode) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("lecture impossible"));
    if (mode === "dataURL") reader.readAsDataURL(file);
    else reader.readAsText(file);
  });
}

const MAX_PDF_IMAGE_PAGES = typeof MAX_PDF_RENDER_PAGES === "number" ? MAX_PDF_RENDER_PAGES : 20;

function isPdfFile(file) {
  return String(file.type || "") === "application/pdf" || /\.pdf$/i.test(String(file.name || ""));
}

function pdfLib() {
  const lib = window.pdfjsLib;
  if (!lib) return null;
  if (lib.GlobalWorkerOptions && !lib.GlobalWorkerOptions.workerSrc) lib.GlobalWorkerOptions.workerSrc = "pdfjs/pdf.worker.min.js";
  return lib;
}

async function convertPdf(file) {
  const lib = pdfLib();
  if (!lib) return null;
  const buffer = await file.arrayBuffer();
  const pdf = await lib.getDocument({ data: new Uint8Array(buffer) }).promise;
  try {
    const parts = [];
    let length = 0;
    for (let n = 1; n <= pdf.numPages; n++) {
      const page = await pdf.getPage(n);
      const content = await page.getTextContent();
      let pageText = "";
      for (const item of content.items) {
        if (typeof item.str !== "string") continue;
        pageText += item.str + (item.hasEOL ? "\n" : " ");
      }
      pageText = pageText.replace(/[ \t]+\n/g, "\n").replace(/[ \t]{2,}/g, " ").trim();
      if (pageText) {
        parts.push("--- Page " + n + " ---\n" + pageText);
        length += pageText.length;
      }
    }
    const text = parts.join("\n\n");
    if (text.replace(/\s/g, "").length >= 20) return { text, pages: pdf.numPages };
    const images = [];
    const count = Math.min(pdf.numPages, MAX_PDF_IMAGE_PAGES);
    for (let n = 1; n <= count; n++) {
      const page = await pdf.getPage(n);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(2, 1600 / Math.max(base.width, base.height));
      const viewport = page.getViewport({ scale });
      const canvas = document.createElement("canvas");
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      const context = canvas.getContext("2d");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: context, viewport }).promise;
      images.push(canvas.toDataURL("image/jpeg", 0.85));
      canvas.width = 0;
      canvas.height = 0;
    }
    return { images, pages: pdf.numPages };
  } finally {
    pdf.destroy();
  }
}

async function addPdfFile(file) {
  const converted = await convertPdf(file);
  if (!converted) return false;
  const name = file.name || "document.pdf";
  if (converted.text) {
    pendingFiles.push({
      id: makeId(),
      name,
      kind: "text",
      mime: "text/plain",
      size: file.size,
      data: converted.text
    });
    return true;
  }
  if (!converted.images || !converted.images.length) return false;
  const base = name.replace(/\.pdf$/i, "");
  converted.images.forEach((data, index) => {
    pendingFiles.push({
      id: makeId(),
      name: base + " (page " + (index + 1) + ").jpg",
      kind: "image",
      mime: "image/jpeg",
      size: Math.round(data.length * 0.75),
      data
    });
  });
  if (converted.pages > converted.images.length) {
    alert(name + " ne contient pas de texte lisible : seules les " + converted.images.length + " premières pages sont envoyées en images.");
  }
  return true;
}

const UPLOADABLE_IMAGES = /^image\/(png|jpe?g|webp)$/i;
const IMAGE_EXTENSIONS = /\.(png|jpe?g|webp|gif|bmp|svg|heic|heif|avif|ico|tiff?)$/i;

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("image illisible"));
    img.src = src;
  });
}

async function imageToJpeg(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const width = img.naturalWidth || img.width || 1;
    const height = img.naturalHeight || img.height || 1;
    const scale = Math.min(1, 2048 / Math.max(width, height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));
    const context = canvas.getContext("2d");
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(img, 0, 0, canvas.width, canvas.height);
    const data = canvas.toDataURL("image/jpeg", 0.9);
    canvas.width = 0;
    canvas.height = 0;
    return data;
  } finally {
    URL.revokeObjectURL(url);
  }
}

async function addImageFile(file, mime) {
  const name = file.name || "image";
  if (UPLOADABLE_IMAGES.test(mime)) {
    const data = await readFileAs(file, "dataURL");
    pendingFiles.push({ id: makeId(), name, kind: "image", mime, size: file.size, data: String(data) });
    return true;
  }
  try {
    const data = await imageToJpeg(file);
    pendingFiles.push({
      id: makeId(),
      name: name.replace(/\.[^.]+$/, "") + ".jpg",
      kind: "image",
      mime: "image/jpeg",
      size: Math.round(data.length * 0.75),
      data
    });
    return true;
  } catch (error) {
    console.warn("Conversion d'image impossible", error);
    return false;
  }
}

async function addConvertedFile(file, mime) {
  const name = file.name || "fichier";
  const bytes = new Uint8Array(await file.arrayBuffer());
  const converter = window.FileConvert;
  let text;
  let note = "";
  if (converter) {
    const result = await converter.extractText(bytes, name, mime);
    if (result) {
      text = result.text;
      if (result.format && result.format !== "texte") note += "[" + result.format + " converti en texte sur le téléphone]\n";
      if (result.partial) note += "[Texte extrait d'un fichier binaire : le contenu peut être incomplet.]\n";
    } else {
      text = converter.describe(bytes, name, mime);
    }
  } else {
    text = new TextDecoder("utf-8").decode(bytes);
  }
  pendingFiles.push({
    id: makeId(),
    name,
    kind: "text",
    mime: "text/plain",
    size: file.size,
    data: note + text
  });
}

async function addFiles(fileList) {
  const files = Array.from(fileList || []);
  const queued = (addFiles.queue || Promise.resolve()).catch(() => {}).then(() => addFilesBatch(files));
  addFiles.queue = queued;
  return queued;
}

async function addFilesBatch(fileList) {
  const files = Array.from(fileList || []);
  for (const file of files) {
    if (file.size > MAX_FILE_BYTES) {
      alert(file.name + " dépasse 50 Mo.");
      continue;
    }
    const start = pendingFiles.length;
    const previewId = typeof rememberPreview === 'function' ? await rememberPreview(file) : null;
    try {
    if (isPdfFile(file)) {
      try {
        if (await addPdfFile(file)) continue;
      } catch (error) {
        console.warn("Conversion PDF impossible", error);
      }
    }
    const mime = String(file.type || "");
    try {
      if (typeof isSvgFile === "function" && isSvgFile(file)) {
        if (await addSvgFile(file)) continue;
      }
      const media = typeof mediaKind === "function" ? mediaKind(file) : "";
      if (media) {
        if (await addMediaFile(file, media)) continue;
      }
      if (mime.startsWith("image/") || IMAGE_EXTENSIONS.test(String(file.name || ""))) {
        if (await addImageFile(file, mime)) continue;
      }
      await addConvertedFile(file, mime);
    } catch (error) {
      alert("Impossible de lire " + file.name + " : " + (error && error.message ? error.message : error));
    }
    } finally {
      if (previewId) for (const entry of pendingFiles.slice(start)) entry.previewId = previewId;
    }
  }
  if (typeof dedupePendingImages === "function") {
    const removed = dedupePendingImages();
    if (removed > 0) showToast(removed + " image(s) identique(s) ignorée(s) : une seule copie est envoyée.");
  }
  renderAttachments();
  updateSendButton();
}

async function openAttachmentPicker(inputId) {
  const cap = window.Capacitor;
  if (cap?.getPlatform?.() !== "ios" || !["photo-input", "file-input"].includes(inputId)) {
    $(inputId).click();
    return;
  }
  if (openAttachmentPicker.busy) return;
  openAttachmentPicker.busy = true;
  try {
    const picker = cap.Plugins?.AttachmentPicker;
    if (!picker || typeof picker.pickPhotos !== 'function' || typeof picker.pickFiles !== 'function') throw new Error('Le sélecteur iPhone est indisponible. Ferme puis rouvre l’app après sa mise à jour.');
    const result = await (inputId === "photo-input" ? picker.pickPhotos() : picker.pickFiles());
    const files = (result.files || []).map(item => {
      const binary = atob(item.data);
      const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
      return new File([bytes], item.name, { type: item.mime || "application/octet-stream" });
    });
    if (files.length) await addFiles(files);
  } catch (error) {
    showToast("Sélection impossible : " + (error.message || "réessaie dans un instant."), true);
  } finally { openAttachmentPicker.busy = false; }
}

function renderAttachments() {
  const box = $("attachments");
  box.innerHTML = "";
  box.classList.toggle("hidden", !pendingFiles.length);
  for (const file of pendingFiles) {
    const chip = document.createElement("div");
    chip.className = "attachment-chip";
    chip.addEventListener('click', event => { if (!event.target.closest('.attachment-remove')) previewAttachment(file); });
    chip.tabIndex = 0;
    chip.setAttribute('role', 'group');
    chip.setAttribute('aria-label', 'Pièce jointe : ' + file.name + '. Entrée pour l’aperçu.');
    chip.addEventListener('keydown', event => { if (event.target === chip && (event.key === 'Enter' || event.key === ' ')) { event.preventDefault(); previewAttachment(file); } });
    if (file.kind === "image") {
      const img = document.createElement("img");
      img.src = file.data;
      img.alt = "";
      chip.appendChild(img);
    } else {
      const icon = document.createElement("span");
      icon.className = "attachment-icon";
      icon.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + ICON_PATHS.file + '</svg>';
      chip.appendChild(icon);
    }
    const name = document.createElement("span");
    name.className = "attachment-name";
    name.textContent = file.name;
    name.title = file.name;
    chip.appendChild(name);
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "attachment-remove";
    remove.dataset.id = file.id;
    remove.setAttribute("aria-label", "Retirer " + file.name);
    remove.textContent = "\u00d7";
    chip.appendChild(remove);
    box.appendChild(chip);
  }
}

function removeAttachment(id) {
  pendingFiles = pendingFiles.filter(file => file.id !== id);
  renderAttachments();
  updateSendButton();
}

function buildMessageText(text, files) {
  let result = text;
  for (const file of files) {
    if (file.kind !== "text") continue;
    result += (result ? "\n\n" : "") + "Fichier joint : " + file.name + "\n```\n" + file.data + "\n```";
  }
  return result;
}

function speechRecognitionClass() {
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

function setMicState(active) {
  const mic = $("mic");
  const label = active ? "Arrêter la dictée" : "Dicter un message";
  mic.classList.toggle("recording", active);
  mic.setAttribute("aria-pressed", String(active));
  mic.setAttribute("aria-label", label);
  mic.title = label;
}

let nativeDictation = null;

function nativeSpeechPlugin() {
  const cap = window.Capacitor;
  if (!cap || typeof cap.isNativePlatform !== "function" || !cap.isNativePlatform()) return null;
  if (cap.Plugins && cap.Plugins.SpeechRecognition) return cap.Plugins.SpeechRecognition;
  return typeof cap.registerPlugin === "function" ? cap.registerPlugin("SpeechRecognition") : null;
}

async function stopNativeDictation() {
  const session = nativeDictation;
  if (!session) return;
  nativeDictation = null;
  setMicState(false);
  try {
    await session.plugin.removeAllListeners();
  } catch {
  }
  try {
    await Promise.race([session.plugin.stop(), new Promise(resolve => setTimeout(resolve, 1500))]);
  } catch {
  }
}

async function startNativeDictation(plugin) {
  try {
    const availability = await plugin.available();
    if (!availability || !availability.available) return false;
    let status = await plugin.checkPermissions();
    if (!status || status.speechRecognition !== "granted") status = await plugin.requestPermissions();
    if (!status || status.speechRecognition !== "granted") {
      alert("L'accès au micro a été refusé.");
      return true;
    }
    const prompt = $("prompt");
    const base = prompt.value && !/\s$/.test(prompt.value) ? prompt.value + " " : prompt.value;
    const session = { plugin };
    await plugin.removeAllListeners();
    nativeDictation = session;
    setMicState(true);
    await plugin.addListener("partialResults", data => {
      if (nativeDictation !== session) return;
      const text = data && Array.isArray(data.matches) ? data.matches[0] || "" : "";
      prompt.value = base + text;
      resizePrompt();
      updateSendButton();
    });
    await plugin.addListener("listeningState", data => {
      if (data && data.status === "stopped" && nativeDictation === session) {
        nativeDictation = null;
        setMicState(false);
        plugin.removeAllListeners().catch(() => {});
      }
    });
    await plugin.start({ language: "fr-FR", maxResults: 1, partialResults: true, popup: false });
    return true;
  } catch (error) {
    nativeDictation = null;
    setMicState(false);
    alert("Impossible de démarrer la dictée : " + (error && error.message ? error.message : error));
    return true;
  }
}

function stopDictation() {
  if (nativeDictation) stopNativeDictation();
  if (!recognition) return;
  const current = recognition;
  current.onresult = null;
  try {
    current.stop();
  } catch {
  }
}

async function toggleDictation() {
  if (nativeDictation) {
    await stopNativeDictation();
    return;
  }
  if (recognition) {
    recognition.stop();
    return;
  }
  const plugin = nativeSpeechPlugin();
  if (plugin && await startNativeDictation(plugin)) return;
  toggleWebDictation();
}

function toggleWebDictation() {
  const Recognition = speechRecognitionClass();
  if (!Recognition) {
    alert("La dictée vocale n'est pas disponible sur cet appareil.");
    return;
  }
  const prompt = $("prompt");
  const base = prompt.value && !/\s$/.test(prompt.value) ? prompt.value + " " : prompt.value;
  let finalText = "";
  const current = new Recognition();
  recognition = current;
  current.lang = "fr-FR";
  current.interimResults = true;
  current.continuous = true;
  current.onresult = event => {
    let interim = "";
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const transcript = event.results[i][0].transcript;
      if (event.results[i].isFinal) finalText += transcript;
      else interim += transcript;
    }
    prompt.value = base + finalText + interim;
    resizePrompt();
    updateSendButton();
  };
  current.onerror = event => {
    if (event.error === "not-allowed" || event.error === "service-not-allowed") {
      alert("L'accès au micro a été refusé.");
    } else if (event.error !== "no-speech" && event.error !== "aborted") {
      alert("Erreur de dictée : " + event.error);
    }
  };
  current.onend = () => {
    if (recognition === current) recognition = null;
    setMicState(false);
  };
  try {
    current.start();
    setMicState(true);
  } catch (error) {
    recognition = null;
    setMicState(false);
    alert("Impossible de démarrer la dictée : " + (error && error.message ? error.message : error));
  }
}

function stopGeneration() {
  if (!busy || stopRequested) return;
  stopRequested = true;
  if (activeConversation) cancelStream(activeConversation.chatId);
}

async function sendMessage() {
  if (currentConversation()?.pendingResponse) { showToast('Reprends ou annule la réponse en cours depuis la bibliothèque.'); return; }
  if (busy) {
    stopGeneration();
    return;
  }
  const prompt = $("prompt");
  const text = prompt.value.trim();
  const files = pendingFiles;
  if (!text && !files.length) return;
  stopDictation();

  const uploads = files.filter(file => file.kind !== "text");
  let sentText = buildMessageText(text, files);
  if (!sentText && uploads.length) sentText = uploads.some(file => file.kind === "image") ? "Décris cette image." : "Analyse ce fichier.";
  // Mode étudiant : activé par le bouton, ou automatiquement si le message demande un quiz / des cartes / des fiches.
  const powerpoint = (typeof detectsPowerPointRequest === "function" && detectsPowerPointRequest(text)) ||
    (typeof isPowerPointFollowup === "function" && isPowerPointFollowup(text, currentConversation()));
  const studyKey = STUDY_MODES[store.studyMode] ? store.studyMode : (typeof detectStudyIntent === "function" ? detectStudyIntent(text) : "");
  if (powerpoint) {
    sentText = POWERPOINT_INSTRUCTION + "\n\n" + sentText;
  } else if (STUDY_MODES[studyKey]) {
    // Quiz et cartes : consigne JSON (quiz.js) pour un rendu interactif ; fiches : consigne texte.
    let studyInstruction = STUDY_MODES[studyKey].instruction;
    if (studyKey === "quiz" && typeof QUIZ_INSTRUCTION !== "undefined") studyInstruction = QUIZ_INSTRUCTION;
    if (studyKey === "cartes" && typeof CARDS_INSTRUCTION !== "undefined") studyInstruction = CARDS_INSTRUCTION;
    sentText = studyInstruction + "\n\n" + sentText;
  }
  const names = files.map(file => file.name);
  const display = text;
  const titleSource = text || names[0] || sentText;

  let conversation = currentConversation();
  if (!conversation) {
    conversation = {
      id: makeId(),
      chatId: null,
      projectId: typeof currentProject !== "undefined" && currentProject ? currentProject.id : null,
      title: titleSource.length > 40 ? titleSource.slice(0, 40) + "\u2026" : titleSource,
      agentId: store.agentId,
      messages: [],
      updatedAt: Date.now()
    };
    store.conversations.push(conversation);
    currentId = conversation.id;
  }
  if (conversation.agentId !== store.agentId) {
    conversation.agentId = store.agentId;
    conversation.chatId = null;
  }
  rememberAgent(conversation);

  if (conversation.contextRecap) {
    sentText = conversation.contextRecap + sentText;
    delete conversation.contextRecap;
  }
  const userMessage = { role: "user", content: display };
  if (sentText !== display) userMessage.prompt = sentText;
  if (files.length) userMessage.attachments = files.map(file => ({ id: file.id, name: file.name, kind: file.kind, mime: file.mime, size: file.size, data: file.data, previewId: file.previewId || null }));
  conversation.messages.push(userMessage);
  if (typeof indexConversationFiles === 'function') indexConversationFiles(conversation).catch(console.warn);
  conversation.updatedAt = Date.now();
  saveStore();
  renderHistory();

  prompt.value = "";
  pendingFiles = [];
  renderAttachments();
  resizePrompt();
  const userBubble = appendMessage("user", display, conversation.messages.length - 1);
  renderMessageAttachments(userBubble, userMessage.attachments);
  addUserActions(userBubble.parentElement, conversation.messages.length - 1);

  await runAssistant(conversation, sentText, (userMessage.attachments || []).filter(file => file.kind !== "text"));
}

async function regenerate(index) {
  if (busy) return;
  const conversation = currentConversation();
  if (!conversation) return;
  if (conversation.pendingResponse) { await runAssistant(conversation,conversation.pendingResponse.text,[],true); return; }
  let userIndex = index - 1;
  while (userIndex >= 0 && conversation.messages[userIndex].role !== "user") userIndex--;
  if (userIndex < 0) return;
  const userMessage = conversation.messages[userIndex];
  const text = userMessage.prompt || userMessage.content;
  conversation.messages = conversation.messages.slice(0, userIndex + 1);
  saveStore();
  renderMessages();
  await runAssistant(conversation, text, (userMessage.attachments || []).filter(file => file.kind !== "text"));
}

