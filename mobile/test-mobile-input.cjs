const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const read = name => fs.readFileSync(__dirname + '/www/' + name, 'utf8');

function target() {
  const events = new Map();
  const classes = new Set();
  return {
    events, attributes: {}, style: { setProperty(name, value) { this[name] = value; }, removeProperty(name) { delete this[name]; } },
    classList: { add: name => classes.add(name), remove: name => classes.delete(name), contains: name => classes.has(name), toggle(name, on) { if (on) classes.add(name); else classes.delete(name); } },
    addEventListener(name, fn) { if (!events.has(name)) events.set(name, []); events.get(name).push(fn); },
    emit(name, event = {}) { for (const fn of events.get(name) || []) fn(event); },
    setAttribute(name, value) { this.attributes[name] = value; }
  };
}

function viewport(native = true) {
  const root = target(), window = target(), document = target();
  window.innerHeight = 844;
  window.visualViewport = Object.assign(target(), { height: 844, offsetTop: 0 });
  window.Capacitor = { getPlatform: () => native ? 'ios' : 'web' };
  window.scrollTo = () => { window.scrollX = 0; window.scrollY = 0; };
  document.documentElement = root;
  const context = vm.createContext({ window, document, navigator: { userAgent: 'iPhone' }, console });
  vm.runInContext(read('js/ios-compat.js'), context);
  document.emit('DOMContentLoaded');
  return { root, window, document };
}
{
  const { root, window, document } = viewport();
  const height = () => root.style['--ios-viewport-height'];
  assert.equal(height(), '844px');
  document.emit('focusin');
  assert.equal(root.classList.contains('ios-keyboard-open'), false, 'Un clavier physique ne réduit pas la saisie');
  window.emit('keyboardWillShow', { keyboardHeight: 346 });
  assert.equal(height(), '498px', 'Saisie visible avant le redimensionnement de visualViewport');
  assert.equal(root.classList.contains('ios-keyboard-open'), true);
  window.visualViewport.height = 498;
  window.visualViewport.emit('resize');
  assert.equal(height(), '498px', 'Ne pas soustraire deux fois le clavier');
  window.emit('keyboardDidShow', { keyboardHeight: 346 });
  assert.equal(height(), '498px');
  window.emit('keyboardWillShow', { keyboardHeight: 300 });
  window.visualViewport.height = 544;
  window.visualViewport.emit('resize');
  assert.equal(height(), '544px', 'Suivre les changements de hauteur du clavier');
  window.emit('keyboardWillHide');
  assert.equal(height(), '844px', 'Restaurer sans attendre un viewport encore réduit');
  window.visualViewport.height = 844;
  window.emit('keyboardDidHide');
  assert.equal(height(), '844px');
  assert.equal(root.classList.contains('ios-keyboard-open'), false);
  window.innerHeight = 390;
  window.visualViewport.height = 390;
  window.emit('resize');
  assert.equal(height(), '390px', 'Suivre la rotation');
}
{
  const { root, window } = viewport(false);
  window.visualViewport.height = 500;
  window.visualViewport.offsetTop = 12;
  window.visualViewport.emit('resize');
  assert.equal(root.style['--ios-viewport-height'], '500px', 'Safari sans plugin natif');
  assert.equal(root.style['--ios-viewport-top'], '12px');
}

{
  const nodes = Object.fromEntries(['app', 'sidebar', 'overlay', 'menu-toggle'].map(id => [id, target()]));
  nodes.overlay.classList.add('hidden');
  const document = Object.assign(target(), { activeElement: { blur() {} } });
  const window = Object.assign(target(), { innerWidth: 390, getSelection: () => '' });
  nodes.sidebar.getBoundingClientRect = () => ({ width: 300 });
  nodes.sidebar.contains = element => element.inSidebar || false;
  let now = 0;
  const context = vm.createContext({ window, document, $: id => nodes[id], getComputedStyle: () => ({ overflowX: 'auto' }), closeMenus() {}, Date: { now: () => now }, console });
  vm.runInContext(read('js/assistant.js'), context);
  vm.runInContext('setupSidebarGestures()', context);
  const app = nodes.app;
  const plain = { closest: () => null, parentElement: app, scrollWidth: 390, clientWidth: 390 };
  function swipe(from, to, eventTarget = plain, vertical = 0) {
    app.emit('touchstart', { target: eventTarget, touches: [{ clientX: from, clientY: 300 }] });
    now += 100;
    app.emit('touchmove', { touches: [{ clientX: to, clientY: 300 + vertical }], cancelable: true, preventDefault() {} });
    app.emit('touchend', { changedTouches: [{ clientX: to, clientY: 300 + vertical }] });
  }
  swipe(30, 150);
  assert.equal(nodes.sidebar.classList.contains('open'), true);
  assert.equal(nodes.overlay.classList.contains('hidden'), false);
  swipe(220, 50);
  assert.equal(nodes.sidebar.classList.contains('open'), false);
  swipe(30, 60);
  assert.equal(nodes.sidebar.classList.contains('open'), false, 'Ignorer les petits mouvements');
  swipe(30, 130, plain, 200);
  assert.equal(nodes.sidebar.classList.contains('open'), false, 'Préserver le défilement vertical');
  swipe(30, 150, { ...plain, closest: () => ({}) });
  assert.equal(nodes.sidebar.classList.contains('open'), false, 'Préserver les champs et contrôles');
  swipe(30, 150, { ...plain, scrollWidth: 800 });
  assert.equal(nodes.sidebar.classList.contains('open'), false, 'Préserver le défilement des tableaux');

  const start = x => app.emit('touchstart', { target: plain, touches: [{ clientX: x, clientY: 300 }] });
  const move = (x, dt = 200) => {
    now += dt;
    app.emit('touchmove', { touches: [{ clientX: x, clientY: 300 }], cancelable: true, preventDefault() {} });
  };
  const end = (x, dt = 200) => {
    now += dt;
    app.emit('touchend', { changedTouches: [{ clientX: x, clientY: 300 }] });
  };
  start(20);
  move(110);
  assert.equal(nodes.sidebar.style.transform, 'translateX(-210px)', 'Le menu suit le doigt avant le relâchement');
  assert.equal(nodes.overlay.style.opacity, '0.3', 'Le fond suit la progression');
  assert.equal(app.classList.contains('sidebar-dragging'), true);
  move(80);
  assert.equal(nodes.sidebar.style.transform, 'translateX(-240px)', 'Suivre les retours en arrière sans saut');
  end(80);
  assert.equal(nodes.sidebar.classList.contains('open'), false, 'Un geste court et lent revient au départ');
  assert.equal(nodes.sidebar.style.transform, undefined);
  assert.equal(app.classList.contains('sidebar-dragging'), false);
  start(20);
  move(190, 1200);
  end(190);
  assert.equal(nodes.sidebar.classList.contains('open'), true, 'Une ouverture lente reste possible');
  start(250);
  move(160);
  assert.equal(nodes.sidebar.style.transform, 'translateX(-90px)', 'Fermeture progressive');
  app.emit('touchcancel');
  assert.equal(nodes.sidebar.classList.contains('open'), true, 'Un geste interrompu restaure le menu');
  assert.equal(nodes.sidebar.style.transform, undefined);
  start(250);
  move(50);
  end(50);
  assert.equal(nodes.sidebar.classList.contains('open'), false);
  start(20);
  move(65, 40);
  end(65, 10);
  assert.equal(nodes.sidebar.classList.contains('open'), true, 'Une impulsion rapide termine l’ouverture');
  start(250);
  move(205, 40);
  end(205, 10);
  assert.equal(nodes.sidebar.classList.contains('open'), false, 'Une impulsion rapide termine la fermeture');
  let suppressed = false;
  app.emit('click', { preventDefault() { suppressed = true; }, stopImmediatePropagation() {} });
  assert.equal(suppressed, true, 'Ne pas activer un lien ou bouton à la fin du glissement');
  start(20);
  move(900);
  assert.equal(nodes.sidebar.style.transform, 'translateX(0px)', 'Limiter la position à l’ouverture complète');
  window.emit('resize');
  assert.equal(nodes.sidebar.style.transform, 'translateX(0px)', 'Masquer le clavier ne coupe pas le geste');
  window.innerWidth = 844;
  window.emit('resize');
  assert.equal(nodes.sidebar.style.transform, undefined, 'Nettoyer le déplacement lors d’une rotation');
  window.innerWidth = 1024;
  swipe(30, 150);
  assert.equal(nodes.sidebar.classList.contains('open'), false, 'Ne pas déclencher sur grand écran');
}
console.log('OK : clavier anticipé, hauteur soustraite une seule fois, fermeture, rotation, Safari et gestes de la barre latérale.');
