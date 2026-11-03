"use strict";

function bindEvents() {
  $("library-open").addEventListener("click", openLibrary);
  $("france-ide-open").addEventListener("click", openFranceIDE);
  const layouts=Array.from(document.querySelectorAll('[data-library-columns]'));
  for(const button of layouts){
    button.addEventListener('click',()=>setLibraryColumns(Number(button.dataset.libraryColumns)));
    button.addEventListener('keydown',event=>{
      const key=event.key;if(!['ArrowLeft','ArrowRight','ArrowUp','ArrowDown','Home','End'].includes(key))return;
      event.preventDefault();const index=layouts.indexOf(button);
      const next=key==='Home'?0:key==='End'?layouts.length-1:(index+(['ArrowLeft','ArrowUp'].includes(key)?-1:1)+layouts.length)%layouts.length;
      setLibraryColumns(Number(layouts[next].dataset.libraryColumns));layouts[next].focus();
    });
  }
  $('completion-notifications').addEventListener('click',toggleCompletionNotifications);
  renderLibrarySettings();
  setupSidebarGestures();
  $("login-form").addEventListener("submit", login);
  $("cookie-form").addEventListener("submit", cookieLogin);
  $("logout").addEventListener("click", logout);
  $("new-chat").addEventListener("click", newConversation);
  $("menu-toggle").addEventListener("click", () => {
    if (window.innerWidth > 768) $("app").classList.remove("sidebar-collapsed");
    else openSidebar();
  });
  $("sidebar-collapse").addEventListener("click", () => {
    closeMenus();
    if (window.innerWidth > 768) $("app").classList.add("sidebar-collapsed");
    else closeSidebar();
  });
  $("overlay").addEventListener("click", () => {
    closeMenus();
    closeSidebar();
  });

  $("search-input").addEventListener("input", event => {
    historyQuery = event.target.value;
    closeMenus();
    renderHistory();
  });
  $("search-input").addEventListener("keydown", event => {
    if (event.key === "Escape") {
      event.target.value = "";
      historyQuery = "";
      renderHistory();
    }
  });
  $("history").addEventListener("scroll", () => {
    if (menuConversationId !== null) closeMenus();
  });

  $("conv-menu").addEventListener("click", event => event.stopPropagation());
  $("conv-rename").addEventListener("click", () => {
    const id = menuConversationId;
    closeMenus();
    if (id) renameConversation(id);
  });
  $("conv-pin").addEventListener("click", () => {
    const id = menuConversationId;
    closeMenus();
    if (id) togglePin(id);
  });
  $("conv-delete").addEventListener("click", () => {
    const id = menuConversationId;
    closeMenus();
    if (id) deleteConversation(id);
  });

  $("user-button").addEventListener("click", toggleSettingsMenu);
  setupSettings();
  $("settings-menu").addEventListener("click", event => {
    event.stopPropagation();
    if (!event.target.closest(".default-model-field")) closeDefaultModelMenu();
    if (!event.target.closest(".reasoning-field")) closeReasoningMenu();
    if (!event.target.closest("#settings-image-models") && !event.target.closest("#settings-image-model-button")) closeSettingsImageModelMenu();
  });
  $("default-model-button").addEventListener("click", toggleDefaultModelMenu);
  $("default-model-menu").addEventListener("click", event => {
    event.stopPropagation();
    const option = event.target.closest(".model-option");
    if (!option || option.getAttribute("aria-disabled") === "true") return;
    setDefaultModel(option.dataset.id || "");
    closeDefaultModelMenu();
    renderDefaultModelSelect();
    $("default-model-button").focus();
  });
  $("default-model-menu").addEventListener("keydown", event => {
    if (event.key === "Escape") {
      event.stopPropagation();
      closeDefaultModelMenu();
      $("default-model-button").focus();
      return;
    }
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const options = [...$("default-model-menu").querySelectorAll(".model-option:not([aria-disabled=\"true\"])")];
    if (!options.length) return;
    const index = options.indexOf(document.activeElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    options[(index + step + options.length) % options.length].focus();
  });
  $("quota-refresh").addEventListener("click", () => loadQuota());
  for (const button of document.querySelectorAll("[data-theme-choice]")) {
    button.addEventListener("click", () => {
      store.theme = button.dataset.themeChoice;
      saveStore();
      applyTheme();
    });
  }
  document.addEventListener("click", closeMenus);
  document.addEventListener("keydown", event => {
    if (event.key === "Escape") {
      const composerMenuOpen = !$("attach-menu").classList.contains("hidden") || !$("study-menu").classList.contains("hidden");
      closeMenus();
      if (composerMenuOpen) $("attach").focus();
    }
  });
  window.addEventListener("resize", closeMenus);
  applyTheme();
  renderProfile();
  $("messages").addEventListener("click", handleMessageClick);

  $("model-select").addEventListener("change", event => selectModel(Number(event.target.value)));
  $("model-button").addEventListener("click", toggleModelMenu);
  $("model-menu").addEventListener("click", event => {
    event.stopPropagation();
    const option = event.target.closest(".model-option");
    if (!option || option.getAttribute("aria-disabled") === "true") return;
    selectModel(Number(option.dataset.id));
    $("model-button").focus();
  });
  $("model-menu").addEventListener("keydown", event => {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const options = [...$("model-menu").querySelectorAll(".model-option")];
    if (!options.length) return;
    const index = options.indexOf(document.activeElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    options[(index + step + options.length) % options.length].focus();
  });

  $("composer").addEventListener("submit", event => {
    event.preventDefault();
    sendMessage();
  });

  $("attach").addEventListener("click", event => {
    event.stopPropagation();
    const menu = $("attach-menu");
    const opening = menu.classList.contains("hidden");
    closeMenus();
    if (!opening) return;
    menu.classList.remove("hidden");
    $("attach").setAttribute("aria-expanded", "true");
  });
  $("attach").addEventListener("keydown", event => {
    if (event.key !== "ArrowDown") return;
    event.preventDefault();
    if ($("attach-menu").classList.contains("hidden")) $("attach").click();
    $("attach-menu").querySelector("button:not(:disabled)")?.focus();
  });
  $("attach-menu").addEventListener("keydown", event => {
    if (event.key === "Escape") {
      event.stopPropagation();
      closeMenus();
      $("attach").focus();
    }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const options = [...$("attach-menu").querySelectorAll("button:not(:disabled)")];
    const index = options.indexOf(document.activeElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1 : (index + (event.key === "ArrowUp" ? -1 : 1) + options.length) % options.length;
    options[next]?.focus();
  });
  $("attach-menu").addEventListener("click", event => {
    event.stopPropagation();
    const option = event.target.closest(".attach-option");
    if (!option?.dataset.target) return;
    closeMenus();
    openAttachmentPicker(option.dataset.target);
  });
  for (const inputId of ["photo-input", "file-input", "camera-input"]) {
    $(inputId).addEventListener("change", async event => {
      const input = event.target;
      await addFiles(input.files);
      input.value = "";
    });
  }
  $("attachments").addEventListener("click", event => {
    const button = event.target.closest(".attachment-remove");
    if (button) removeAttachment(button.dataset.id);
  });
  const mic = $("mic");
  if (!speechRecognitionClass() && !nativeSpeechPlugin()) mic.classList.add("unsupported");
  mic.addEventListener("click", toggleDictation);

  renderToggles();
  $("toggle-web").addEventListener("click", () => {
    store.webSearch = !store.webSearch;
    saveStore();
    renderToggles();
  });
  $("toggle-image").addEventListener("click", () => {
    store.imageMode = !store.imageMode;
    if (store.imageMode) store.powerpointMode = false;
    saveStore();
    renderToggles();
  });
  setupStudyMenu();
  setupImageModelMenu();
  renderImageModel();
  if (typeof setupDropZone === "function") setupDropZone();

  const prompt = $("prompt");
  prompt.addEventListener("input", () => {
    resizePrompt();
    updateSendButton();
  });
  prompt.addEventListener("paste", event => {
    const items = event.clipboardData ? Array.from(event.clipboardData.files || []) : [];
    const pastedImages = items.filter(file => String(file.type || "").startsWith("image/"));
    if (pastedImages.length) {
      event.preventDefault();
      addFiles(pastedImages);
    }
  });
  prompt.addEventListener("keydown", event => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      if (!busy) sendMessage();
    }
  });
}

async function startApp() {
  saveStore();
  bindEvents();
  if (!store.session) {
    showLogin("");
    return;
  }
  try {
    await getAccessToken(true);
    await showApp();
  } catch (error) {
    if (error.auth) showLogin(error.message);
    else await showApp();
  }
}

async function init() {
  try {
    await startApp();
  } finally {
    const screen = $("startup-screen");
    if (screen) screen.remove();
  }
}

document.addEventListener("DOMContentLoaded", init);
