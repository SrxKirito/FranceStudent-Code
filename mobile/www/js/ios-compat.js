"use strict";

function setupIOSViewport() {
  const cap = window.Capacitor;
  const native = cap?.getPlatform?.() === "ios";
  const safari = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  if (!native && !safari) return;
  const root = document.documentElement;
  root.classList.add("ios-viewport");
  if (native) root.classList.add("native-ios");
  let keyboardHeight = 0;
  let hiding = false;
  const update = () => {
    // resize=none keeps the native background behind the keyboard's rounded
    // corners. Anticipate its height on willShow; never subtract it twice.
    const fullHeight = window.innerHeight;
    const viewport = window.visualViewport;
    const height = hiding ? fullHeight : Math.min(fullHeight - keyboardHeight, viewport?.height || fullHeight);
    root.classList.toggle("ios-keyboard-open", keyboardHeight > 0 || (!hiding && fullHeight - height > 120));
    root.style.setProperty("--ios-viewport-height", Math.round(Math.max(1, height)) + "px");
    root.style.setProperty("--ios-viewport-top", Math.round(hiding ? 0 : viewport?.offsetTop || 0) + "px");
    if (window.scrollY || window.scrollX) window.scrollTo(0, 0);
    if (typeof resizePrompt === "function") resizePrompt();
  };
  const show = event => {
    hiding = false;
    const height = Number(event.keyboardHeight ?? event.detail?.keyboardHeight);
    if (Number.isFinite(height)) keyboardHeight = Math.max(0, height);
    update();
  };
  window.addEventListener("keyboardWillShow", show);
  window.addEventListener("keyboardDidShow", show);
  window.addEventListener("keyboardWillHide", () => { keyboardHeight = 0; hiding = true; update(); });
  window.addEventListener("keyboardDidHide", () => { hiding = false; update(); });
  cap?.Plugins?.Keyboard?.setAccessoryBarVisible({ isVisible: false }).catch(console.warn);
  window.visualViewport?.addEventListener("resize", update);
  window.visualViewport?.addEventListener("scroll", update);
  document.addEventListener("focusin", update);
  window.addEventListener("resize", update);
  update();
}

document.addEventListener("DOMContentLoaded", setupIOSViewport);
