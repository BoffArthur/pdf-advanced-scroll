// Harness: simula Obsidian + PDF.js (jsdom com geometria simulada) para testar main.js.
const Module = require("module");
const path = require("path");
const { JSDOM } = require("jsdom");

const PAGE_H = 1000;
const GAP = 10;
const VIEW_W = 800;
const VIEW_H = 600;

const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true });
const { window } = dom;
window.setInterval = () => 0;
global.window = window;
global.document = window.document;
global.Node = window.Node;
global.Element = window.Element;
global.HTMLElement = window.HTMLElement;

const resizeObservers = [];
global.ResizeObserver = class {
  constructor(cb) {
    this.cb = cb;
    resizeObservers.push(this);
  }
  observe() {}
  disconnect() {
    const i = resizeObservers.indexOf(this);
    if (i >= 0) resizeObservers.splice(i, 1);
  }
};

class Notice {}
class Plugin {
  constructor(app) {
    this.app = app;
  }
  async loadData() {
    return {};
  }
  async saveData() {}
  addStatusBarItem() {
    const item = document.createElement("div");
    item.setText = (text) => {
      item.textContent = text;
    };
    document.body.append(item);
    return item;
  }
  registerDomEvent(el, name, fn, opts) {
    el.addEventListener(name, fn, opts);
  }
  registerEvent() {}
  registerInterval() {}
  addCommand() {}
  addSettingTab() {}
}
class PluginSettingTab {}
class Setting {}

const originalLoad = Module._load;
Module._load = function (request, ...rest) {
  if (request === "obsidian") {
    return { Plugin, PluginSettingTab, Setting, Notice };
  }
  return originalLoad.call(this, request, ...rest);
};

const PluginClass = require(path.join(__dirname, "..", "main.js"));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function defineGeometry(container, pageCount, scrollWidth) {
  const geo = { hidden: false, scrollWidth, scrollTop: 0, scrollLeft: 0 };
  const define = (name, get, set) =>
    Object.defineProperty(container, name, { get, set, configurable: true });
  define("clientWidth", () => (geo.hidden ? 0 : VIEW_W));
  define("clientHeight", () => (geo.hidden ? 0 : VIEW_H));
  define("scrollWidth", () => geo.scrollWidth);
  define("scrollHeight", () => pageCount * (PAGE_H + GAP));
  define("scrollTop", () => geo.scrollTop, (v) => (geo.scrollTop = Math.max(0, v)));
  define("scrollLeft", () => geo.scrollLeft, (v) => (geo.scrollLeft = Math.max(0, v)));
  container.getBoundingClientRect = () => ({ top: 0, left: 0, bottom: VIEW_H, right: VIEW_W, width: VIEW_W, height: VIEW_H });
  container.scrollTo = ({ left, top }) => {
    if (left !== undefined) geo.scrollLeft = left;
    if (top !== undefined) geo.scrollTop = top;
    fireScroll(container);
  };
  return geo;
}

// Eventos de scroll são assíncronos no navegador.
function fireScroll(container) {
  setTimeout(() => container.dispatchEvent(new window.Event("scroll")), 0);
}

function createPDF(app, { pages = 10, scrollWidth = 1200, rescroll = true, wrappable = true } = {}) {
  const leafEl = document.createElement("div");
  leafEl.className = "workspace-leaf";
  const viewContent = document.createElement("div");
  viewContent.className = "view-content";
  const toolbar = document.createElement("div");
  toolbar.className = "pdf-toolbar";
  const prev = document.createElement("button");
  prev.className = "clickable-icon";
  const next = document.createElement("button");
  next.className = "clickable-icon";
  toolbar.append(prev, next);
  const container = document.createElement("div");
  container.className = "pdf-viewer-container";
  const pagesEl = document.createElement("div");
  pagesEl.className = "pdfViewer";
  container.append(pagesEl);
  viewContent.append(toolbar, container);
  leafEl.append(viewContent);
  document.body.append(leafEl);

  const geo = defineGeometry(container, pages, scrollWidth);
  for (let n = 1; n <= pages; n++) {
    const page = document.createElement("div");
    page.className = "page";
    page.dataset.pageNumber = String(n);
    page.getBoundingClientRect = () => {
      const top = (n - 1) * (PAGE_H + GAP) - geo.scrollTop;
      return { top, bottom: top + PAGE_H, height: PAGE_H, left: -geo.scrollLeft, width: 900, right: 900 - geo.scrollLeft };
    };
    pagesEl.append(page);
  }

  const handlers = {};
  const eventBus = {
    on: (n, h) => (handlers[n] = [...(handlers[n] || []), h]),
    off: (n, h) => (handlers[n] = (handlers[n] || []).filter((x) => x !== h)),
    emit: (n, e) => (handlers[n] || []).forEach((h) => h(e))
  };
  const viewer = { eventBus, pagesCount: pages };
  // Como o PDF.js: alterar a escala dispara scalechanging (a geometria não é recalculada aqui).
  let scale = 1;
  Object.defineProperty(viewer, "currentScale", {
    get: () => scale,
    set: (value) => {
      scale = value;
      eventBus.emit("scalechanging", { scale: value });
    }
  });
  Object.defineProperty(viewer, "currentPageNumber", {
    get: () => viewer.forced ?? Math.floor(geo.scrollTop / (PAGE_H + GAP)) + 1,
    set: (n) => (viewer.forced = n)
  });
  // Como o PDF.js: salto síncrono ao canto da página, depois evento pagechanging.
  if (wrappable) {
    viewer.scrollPageIntoView = function ({ pageNumber, destArray }) {
      if (!destArray) {
        geo.scrollTop = (pageNumber - 1) * (PAGE_H + GAP);
        geo.scrollLeft = 0;
      }
      fireScroll(container);
      eventBus.emit("pagechanging", { pageNumber });
    };
  }
  // Reproduz o PDF.js: pagechanging e scrollIntoView alinhando ao canto da página.
  viewer.goTo = (n) => {
    if (n < 1 || n > pages) return;
    if (wrappable) {
      viewer.scrollPageIntoView({ pageNumber: n });
      return;
    }
    viewer.currentPageNumber = n;
    eventBus.emit("pagechanging", { pageNumber: n });
    const jump = () => {
      viewer.forced = undefined;
      geo.scrollTop = (n - 1) * (PAGE_H + GAP);
      geo.scrollLeft = 0;
      fireScroll(container);
    };
    jump();
    if (rescroll) {
      setTimeout(jump, 90);
      setTimeout(() => eventBus.emit("pagerendered", { pageNumber: n }), 100);
    }
  };
  prev.addEventListener("click", () => viewer.goTo(viewer.currentPageNumber - 1));
  next.addEventListener("click", () => viewer.goTo(viewer.currentPageNumber + 1));

  const leaf = {
    view: {
      containerEl: viewContent,
      getViewType: () => "pdf",
      child: { pdfViewer: { pdfViewer: viewer } }
    }
  };
  app.leaves.push(leaf);

  return {
    leaf,
    container,
    geo,
    viewer,
    prev,
    next,
    // Posição do usuário: define scroll e dispara o evento como o navegador.
    userScroll(top, left) {
      container.dispatchEvent(new window.Event("wheel", { bubbles: true }));
      geo.scrollTop = top;
      if (left !== undefined) geo.scrollLeft = left;
      fireScroll(container);
    },
    hide() {
      geo.hidden = true;
      geo.scrollTop = 0;
      geo.scrollLeft = 0;
      resizeObservers.slice().forEach((o) => o.cb());
    },
    show() {
      geo.hidden = false;
      resizeObservers.slice().forEach((o) => o.cb());
    },
    // Fração vertical dentro da página no topo da viewport.
    currentPage() {
      return Math.floor(geo.scrollTop / (PAGE_H + GAP)) + 1;
    },
    frac() {
      return (geo.scrollTop - (this.currentPage() - 1) * (PAGE_H + GAP)) / PAGE_H;
    }
  };
}

async function setup(options) {
  const app = {
    leaves: [],
    workspace: {
      activeLeaf: null,
      getLeavesOfType: () => app.leaves,
      on() {},
      onLayoutReady: (cb) => cb()
    }
  };
  const plugin = new PluginClass(app);
  await plugin.onload();
  const make = (opts) => {
    const pdf = createPDF(app, { ...options, ...opts });
    app.workspace.activeLeaf = pdf.leaf;
    plugin.scan();
    return pdf;
  };
  const activate = (pdf) => {
    app.workspace.activeLeaf = pdf.leaf;
    plugin.scan();
  };
  const cleanup = () => {
    plugin.onunload();
    document.body.innerHTML = "";
  };
  return { app, plugin, make, activate, cleanup };
}

module.exports = { setup, sleep, window, PAGE_H, GAP };
