"use strict";

const WEB_SEARCH_CARD = '<div class="web-search-card"><span class="sk sk-line"></span><span class="sk sk-line short"></span><span class="sk-row"><span class="sk sk-dot"></span><span class="sk sk-line tiny"></span></span></div>';
const WEB_SEARCH_HTML = '<div class="web-search-indicator" role="status" aria-live="polite">' +
  '<div class="web-search-pill"><span class="web-search-globe" aria-hidden="true">' +
  '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>' +
  '<span class="web-search-spinner"></span></span><span class="web-search-label">Recherche sur le web…</span></div>' +
  '<div class="web-search-grid" aria-hidden="true">' + WEB_SEARCH_CARD + WEB_SEARCH_CARD + WEB_SEARCH_CARD + WEB_SEARCH_CARD + '</div></div>';

const SOURCES_GLOBE_SVG = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>';

function sourceLabel(host) {
  const parts = String(host || "").split(".");
  if (parts.length < 2) return host || "";
  let i = parts.length - 2;
  if (parts.length >= 3 && parts[i].length <= 3) i -= 1;
  return parts[i] || host;
}

function sourceIcon(host) {
  const letter = escapeHtml((sourceLabel(host)[0] || "?").toUpperCase());
  return '<span class="source-icon"><span>' + letter + '</span><img src="https://www.google.com/s2/favicons?domain=' +
    encodeURIComponent(host) + '&amp;sz=64" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()"></span>';
}

// Bloc « N sites consultés » : pilule + grille de cartes (3 cartes + « N autres sources » au-delà de 4).
function sourcesHtml(sources, searching) {
  const list = Array.isArray(sources) ? sources : [];
  const n = list.length;
  const label = searching
    ? "Recherche sur le web… · " + n + (n > 1 ? " sites" : " site")
    : n + (n > 1 ? " sites consultés" : " site consulté");
  const collapsed = n > 4;
  const cards = list.map((s, i) =>
    '<a class="source-card' + (collapsed && i >= 3 ? " extra" : "") + '" href="' + escapeHtml(s.url) + '" target="_blank" rel="noopener noreferrer"' +
    (s.title ? ' title="' + escapeHtml(s.title) + '"' : "") + '>' +
    '<span class="source-url">' + escapeHtml(s.url) + '</span>' +
    '<span class="source-meta">' + sourceIcon(s.host) + '<span class="source-name">' + escapeHtml(sourceLabel(s.host)) +
    '</span><span class="source-num">' + (i + 1) + '</span></span></a>').join("");
  const more = collapsed
    ? '<button type="button" class="source-card sources-more"><span class="source-icons">' +
      list.slice(3, 7).map(s => sourceIcon(s.host)).join("") + '</span><span class="source-url">' + (n - 3) + ' autres sources</span></button>'
    : "";
  return '<div class="sources-block open' + (searching ? " searching" : "") + '" role="status" aria-live="polite">' +
    '<button type="button" class="sources-pill" aria-expanded="true"><span class="web-search-globe" aria-hidden="true">' + SOURCES_GLOBE_SVG +
    (searching ? '<span class="web-search-spinner"></span>' : "") + '</span>' +
    '<span class="sources-label' + (searching ? " web-search-label" : "") + '">' + label + '</span>' +
    '<span class="source-icons">' + list.slice(0, 4).map(s => sourceIcon(s.host)).join("") + '</span>' +
    '<span class="sources-chevron" aria-hidden="true"></span></button>' +
    '<div class="sources-grid">' + cards + more + '</div></div>';
}

document.addEventListener("click", event => {
  const target = event.target;
  if (!target || typeof target.closest !== "function") return;
  const more = target.closest(".sources-more");
  if (more) {
    more.closest(".sources-block").classList.add("all");
    return;
  }
  const pill = target.closest(".sources-pill");
  if (pill) {
    const block = pill.closest(".sources-block");
    const open = block.classList.toggle("open");
    pill.setAttribute("aria-expanded", open ? "true" : "false");
  }
});

function prefersReducedMotion() {
  return !!(window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
}

// Affichage progressif mot par mot : le texte reçu est la cible, on en dévoile une partie croissante.
function createTypewriter(onRender) {
  let target = "";
  let shown = 0;
  let timer = null;
  let finished = false;
  let resolveDone = null;
  // L'option Android « Supprimer les animations » active prefers-reduced-motion dans le WebView :
  // on garde quand même l'affichage mot par mot, qui n'est pas une animation de mouvement.
  const reduced = false;
  const advance = (from, words) => {
    let i = from;
    for (let w = 0; w < words && i < target.length; w++) {
      while (i < target.length && /\s/.test(target[i])) i++;
      while (i < target.length && !/\s/.test(target[i])) i++;
    }
    return i;
  };
  const done = () => {
    if (resolveDone) {
      const resolve = resolveDone;
      resolveDone = null;
      resolve();
    }
  };
  const tick = () => {
    timer = null;
    if (stopRequested && shown < target.length) {
      shown = target.length;
      onRender(target);
    }
    if (shown >= target.length) {
      if (finished) done();
      return;
    }
    const backlog = target.length - shown;
    const words = backlog > 2000 ? 14 : backlog > 800 ? 6 : backlog > 300 ? 3 : backlog > 120 ? 2 : 1;
    shown = advance(shown, words);
    onRender(target.slice(0, shown));
    timer = setTimeout(tick, 30);
  };
  return {
    push(text) {
      target = typeof text === "string" ? text : "";
      if (reduced) {
        shown = target.length;
        onRender(target);
        return;
      }
      if (!timer) timer = setTimeout(tick, 0);
    },
    finish() {
      finished = true;
      if (reduced || shown >= target.length) return Promise.resolve();
      return new Promise(resolve => {
        resolveDone = resolve;
        if (!timer) timer = setTimeout(tick, 0);
      });
    },
    stop() {
      if (timer) clearTimeout(timer);
      timer = null;
      shown = target.length;
      done();
    }
  };
}

// Repli : si le flux n'a fourni aucune source, on lit le dernier message assistant enregistré sur le serveur
// (parts, webSearchDomains) pour retrouver les sites consultés.
async function fetchMessageSources(chatId) {
  if (!chatId) return [];
  try {
    const response = await apiFetch("/chats/" + encodeURIComponent(chatId));
    if (!response.ok) return [];
    const detail = await response.json().catch(() => null);
    const list = detail && Array.isArray(detail.chatMessages) ? detail.chatMessages.slice() : [];
    list.sort((a, b) => serverTime(a.createdAt) - serverTime(b.createdAt));
    for (let i = list.length - 1; i >= 0; i--) {
      const item = list[i];
      if (String(item && item.role || "").toLowerCase() !== "assistant") continue;
      const found = [];
      collectSourceUrls({ parts: item.parts, webSearchDomains: item.webSearchDomains }, found, new Set());
      return found;
    }
  } catch (error) {
    console.warn("Lecture des sources impossible :", error && error.message);
  }
  return [];
}

// Animation dédiée à la création d'une image (distincte des points de saisie du texte).
const IMAGE_GEN_HTML = '<div class="image-gen-loader" role="status" aria-live="polite" aria-label="Création de l\'image en cours">' +
  '<span class="image-gen-glow" aria-hidden="true"></span>' +
  '<span class="image-gen-frame" aria-hidden="true"><svg viewBox="0 0 24 24" width="34" height="34" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="3"/><circle cx="9" cy="10" r="1.8"/><path d="M21 16l-5-5-8 9"/></svg></span>' +
  '<span class="image-gen-label">Création de l\'image<span class="image-gen-dots" aria-hidden="true"><i>.</i><i>.</i><i>.</i></span></span>' +
  '<span class="image-gen-bar" aria-hidden="true"><span></span></span></div>';

function showImageGenPlaceholder(bubble) {
  if (!bubble || !bubble.parentElement) return;
  let box = bubble.parentElement.querySelector(".generated-images");
  if (!box) {
    box = document.createElement("div");
    box.className = "generated-images";
    box._keys = new Set();
    bubble.after(box);
  }
  if (box.querySelector(".image-gen-placeholder")) return;
  const placeholder = document.createElement("figure");
  placeholder.className = "generated-image image-gen-placeholder";
  placeholder.innerHTML = IMAGE_GEN_HTML;
  box.appendChild(placeholder);
  scrollToBottom();
}

function hideImageGenPlaceholder(bubble) {
  if (!bubble || !bubble.parentElement) return;
  const box = bubble.parentElement.querySelector(".generated-images");
  if (!box) return;
  const placeholder = box.querySelector(".image-gen-placeholder");
  if (placeholder) placeholder.remove();
  if (!box.children.length) box.remove();
}

// Heuristique FR/EN : le message ressemble-t-il à une demande de création d'image ?
function looksLikeImageRequest(text) {
  const t = String(text || "").toLowerCase();
  if (!t) return false;
  const verb = /\b(g[ée]n[èe]re[rz]?|cr[ée]+[ez]?r?|dessine[rz]?|fais|faire|produi[st]|r[ée]alise[rz]?|imagine[rz]?|montre|make|draw|generate|create|paint|design|render|show me)\b/;
  const noun = /\b(images?|photos?|illustrations?|logos?|dessins?|affiches?|portraits?|pictures?|wallpapers?|fonds? d'[ée]cran|avatars?|ic[ôo]nes?|icons?|posters?|sch[ée]mas?)\b/;
  return verb.test(t) && noun.test(t);
}

async function runAssistant(conversation, text, images = [], resume = false) {
  if (resume && conversation.pendingResponse) {
    const index = conversation.pendingResponse.userIndex;
    if (Number.isInteger(index)) conversation.messages = conversation.messages.slice(0,index+1);
    if (currentId === conversation.id) renderMessages();
  }
  if (!resume) conversation.pendingResponse = {text,startedAt:Date.now(),output:'',lastEventId:'',userIndex:conversation.messages.length-1,owner:store.profile?.email || ''};
  saveStore();
  const powerpoint = typeof isPowerPointPrompt === "function" && isPowerPointPrompt(text);
  const bubble = appendMessage("assistant", "");
  const searching = store.webSearch === true;
  bubble.innerHTML = searching ? WEB_SEARCH_HTML : TYPING_HTML;
  bubble.classList.add("pending");
  if (searching) bubble.classList.add("searching");
  // L'animation démarre dès l'envoi : mode Image forcé, ou demande d'image détectée en mode automatique.
  let guessedImage = !powerpoint && store.imageMode !== true && store.imageTool !== false && looksLikeImageRequest(text);
  if ((!powerpoint && store.imageMode === true) || guessedImage) {
    bubble.classList.add("image-generating");
    showImageGenPlaceholder(bubble);
  }

  busy = true;
  stopRequested = false;
  activeConversation = conversation;
  updateSendButton();

  let imageStartSeen = false;
  let sources = resume ? conversation.pendingResponse?.sources || [] : [];
  const generatedImages = resume && conversation.pendingResponse?.lastEventId ? [...(conversation.pendingResponse.images || [])] : [];
  if (generatedImages.length) renderGeneratedImages(bubble,generatedImages);
  let sourcesBox = null;
  const renderSources = searchingNow => {
    if (!sources.length) return;
    if (!sourcesBox) {
      sourcesBox = document.createElement("div");
      sourcesBox.className = "sources-container";
      bubble.parentElement.insertBefore(sourcesBox, bubble);
    }
    const old = sourcesBox.querySelector(".sources-block");
    const wasClosed = old && !old.classList.contains("open");
    const wasAll = old && old.classList.contains("all");
    sourcesBox.innerHTML = sourcesHtml(sources, searchingNow);
    const block = sourcesBox.querySelector(".sources-block");
    if (wasClosed) {
      block.classList.remove("open");
      block.querySelector(".sources-pill").setAttribute("aria-expanded", "false");
    }
    if (wasAll) block.classList.add("all");
  };

  const typer = createTypewriter(partial => {
    if (bubble.classList.contains("pending") && sources.length) renderSources(false);
    bubble.classList.remove("pending", "searching");
    if (guessedImage && !imageStartSeen) {
      // Fausse alerte : le serveur répond en texte sans lancer d'image.
      guessedImage = false;
      bubble.classList.remove("image-generating");
      hideImageGenPlaceholder(bubble);
    }
    bubble.classList.add("streaming");
    bubble.innerHTML = renderMarkdown(partial, true);
    scrollToBottom();
  });

  try {
    const answer = await streamChat(conversation, text, images, partial => typer.push(partial), (event, data) => {
      if (event === "web_search" && bubble.classList.contains("pending") && !bubble.classList.contains("searching") && !sources.length) {
        bubble.classList.add("searching");
 bubble.innerHTML = WEB_SEARCH_HTML;
        scrollToBottom();
      }
      if (event === "image_start") {
        if(conversation.pendingResponse)conversation.pendingResponse.imageStarted=true;
        imageStartSeen = true;
        bubble.classList.add("image-generating");
        showImageGenPlaceholder(bubble);
      }
      if (event === "image" && data) {
        if(generatedImages.some(image=>generatedImageKey(image)===generatedImageKey(data)))return;
        generatedImages.push(data);
        if(conversation.pendingResponse)conversation.pendingResponse.images=generatedImages.filter(image=>image.id || image.url || image.data?.length<1500000);
        hideImageGenPlaceholder(bubble);
        bubble.classList.remove("image-generating");
        renderGeneratedImages(bubble, [data]);
      }
      if (event === "sources" && Array.isArray(data)) {
 sources = data;
        if(conversation.pendingResponse)conversation.pendingResponse.sources=data;
        const stillSearching = bubble.classList.contains("pending");
 renderSources(stillSearching);
        if (stillSearching && bubble.classList.contains("searching")) {
          // Les cartes réelles remplacent le squelette ; la bulle garde l'indicateur de saisie.
          bubble.classList.remove("searching");
   bubble.innerHTML = TYPING_HTML;
        }
        scrollToBottom();
      }
    }, resume);
    if (stopRequested) typer.stop();
    else await typer.finish();
    bubble.classList.remove("pending", "streaming", "searching", "image-generating");
    hideImageGenPlaceholder(bubble);
    if (!sources.length && searching && !stopRequested) {
      const found = await fetchMessageSources(conversation.chatId);
      if (found.length) sources = found;
    }
    renderSources(false);
    let emptyText = "*Réponse vide.*";
    if (!answer && !generatedImages.length && !stopRequested) {
      // Diagnostic : liste des événements reçus du serveur (voir stream.js).
      const log = typeof window !== "undefined" && Array.isArray(window.__lastStreamLog) ? window.__lastStreamLog.join(" → ").replace(/`/g, "'").slice(-1500) : "";
      emptyText = store.imageMode === true ? "*Aucune image reçue du serveur.*" : "*Réponse vide.*";
      if (log) emptyText += "\n\nÉvénements reçus : `" + log + "`";
    }
    const content = answer || (generatedImages.length ? "" : stopRequested ? "*Génération arrêtée.*" : emptyText);
    bubble.innerHTML = renderMarkdown(content);
    bubble.classList.toggle("image-only", !content && generatedImages.length > 0);
    const message = { role: "assistant", content };
    if (sources.length) message.sources = sources;
    if (generatedImages.length) {
      // On garde les identifiants ; le base64 seulement s'il est raisonnable (limite du stockage local).
      message.images = generatedImages
        .map(img => img.id && img.messageId ? { id: img.id, messageId: img.messageId, chatId: img.chatId } : img.data && img.data.length < 1500000 ? { data: img.data } : img.url ? { url: img.url } : null)
        .filter(Boolean);
    }
    conversation.messages.push(message);
    delete conversation.pendingResponse;
    if (typeof indexConversationFiles === 'function') indexConversationFiles(conversation,generatedImages).catch(console.warn);
    if (currentId === conversation.id) addMessageActions(bubble.parentElement, message, conversation.messages.length - 1);
  } catch (error) {
    if (stopRequested || error.auth || error.localPlugin || error.fromStream || (error.status && ![404,409,410].includes(error.status))) delete conversation.pendingResponse;
    else if (conversation.pendingResponse) conversation.pendingResponse.state = 'interrupted';
    typer.stop();
    if (error.partialOutput) {
      bubble.classList.remove('pending','streaming','searching','image-generating');
      hideImageGenPlaceholder(bubble);
      bubble.innerHTML = renderMarkdown(error.partialOutput);
      conversation.messages.push({role:'assistant',content:error.partialOutput});
    } else bubble.parentElement.remove();
    const message = { role: "error", content: friendlyError(error) };
    conversation.messages.push(message);
    if (currentId === conversation.id) {
      const index = conversation.messages.length - 1;
      const errorBubble = appendMessage("error", message.content, index);
      addErrorActions(errorBubble.parentElement, index);
    }
    if (error.auth) {
      showLogin(error.message);
    }
  } finally {
    busy = false;
    stopRequested = false;
    activeConversation = null;
    conversation.updatedAt = Date.now();
    saveStore();
    renderHistory();
    updateSendButton();
    scrollToBottom();
  }
}

function openSidebar() {
  document.activeElement?.blur();
  $("sidebar").classList.add("open");
  $("overlay").classList.remove("hidden");
  $("menu-toggle").setAttribute("aria-expanded", "true");
  clearSidebarDrag();
}

function closeSidebar() {
  $("sidebar").classList.remove("open");
  $("overlay").classList.add("hidden");
  $("menu-toggle").setAttribute("aria-expanded", "false");
  clearSidebarDrag();
}

function clearSidebarDrag() {
  $("app").classList.remove("sidebar-dragging");
  $("sidebar").style.removeProperty("transform");
  $("overlay").style.removeProperty("opacity");
}

function setupSidebarGestures() {
  const app = $("app");
  const sidebar = $("sidebar");
  const overlay = $("overlay");
  let gesture = null;
  let suppressClickUntil = 0;
  function move(touch) {
    const dx = touch.clientX - gesture.x;
    const dy = touch.clientY - gesture.y;
    if (!gesture.dragging) {
      if (Math.abs(dy) > 8 && Math.abs(dy) > Math.abs(dx)) { gesture = null; return; }
      if (Math.abs(dx) < 8 || Math.abs(dx) < Math.abs(dy) * 1.5) return;
      if (gesture.closing ? dx > 0 : dx < 0) { gesture = null; return; }
      gesture.dragging = true;
      closeMenus();
      document.activeElement?.blur();
      app.classList.add("sidebar-dragging");
      overlay.classList.remove("hidden");
    }
    const now = Date.now();
    const elapsed = now - gesture.lastTime;
    if (elapsed > 0 && touch.clientX !== gesture.lastX) {
      gesture.velocity = (touch.clientX - gesture.lastX) / elapsed;
      gesture.lastTime = now;
      gesture.lastX = touch.clientX;
    }
    gesture.position = Math.max(0, Math.min(gesture.width, (gesture.closing ? gesture.width : 0) + dx));
    sidebar.style.transform = `translateX(${gesture.position - gesture.width}px)`;
    overlay.style.opacity = String(gesture.position / gesture.width);
  }
  function finish(cancelled = false) {
    const start = gesture;
    gesture = null;
    if (!start?.dragging) return;
    suppressClickUntil = Date.now() + 400;
    const velocity = Date.now() - start.lastTime <= 100 ? start.velocity : 0;
    const travelled = Math.abs(start.position - (start.closing ? start.width : 0));
    const open = cancelled ? start.closing
      : travelled >= 18 && Math.abs(velocity) > 0.5 ? velocity > 0
      : start.position >= start.width / 2;
    // Restore transitions at the current position before snapping to an endpoint.
    app.classList.remove("sidebar-dragging");
    sidebar.getBoundingClientRect();
    if (open) openSidebar(); else closeSidebar();
  }
  app.addEventListener("touchstart", event => {
    finish(true);
    gesture = null;
    if (window.innerWidth > 768 || event.touches.length !== 1) return;
    const target = event.target;
    if (target.closest("input, textarea, select, [contenteditable], dialog, .popover, .settings-modal")) return;
    if (target.closest("button, a") && !sidebar.contains(target)) return;
    if (window.getSelection()?.toString()) return;
    // Preserve horizontal scrolling in tables and code blocks.
    for (let node = target; node && node !== app; node = node.parentElement) {
      if (node.scrollWidth > node.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(node).overflowX)) return;
    }
    const touch = event.touches[0];
    gesture = { x: touch.clientX, y: touch.clientY, lastX: touch.clientX, lastTime: Date.now(), velocity: 0,
      closing: sidebar.classList.contains("open"), width: sidebar.getBoundingClientRect().width,
      viewportWidth: window.innerWidth, dragging: false };
  }, { passive: true });
  app.addEventListener("touchmove", event => {
    if (!gesture) return;
    if (event.touches.length !== 1) { finish(true); return; }
    move(event.touches[0]);
    if (gesture?.dragging && event.cancelable) event.preventDefault();
  }, { passive: false });
  app.addEventListener("touchend", event => {
    if (gesture && event.changedTouches.length === 1) move(event.changedTouches[0]);
    finish();
  }, { passive: true });
  app.addEventListener("touchcancel", () => finish(true), { passive: true });
  app.addEventListener("click", event => {
    if (Date.now() < suppressClickUntil) { event.preventDefault(); event.stopImmediatePropagation(); }
  }, true);
  window.addEventListener("resize", () => {
    if (gesture && window.innerWidth !== gesture.viewportWidth) finish(true);
  });
}

