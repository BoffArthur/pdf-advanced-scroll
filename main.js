const { Plugin, PluginSettingTab, Setting, Notice } = require("obsidian");

const PDF_CONTAINER_SELECTOR =
  ".pdf-viewer-container, .pdfViewerContainer, #viewerContainer";
const PAGE_SELECTOR = ".page[data-page-number]";
const FREEZE_MS = 450;
const SELF_SCROLL_MS = 250;
const PAGE_TOP_TOLERANCE_PX = 24;
const DEFAULT_SETTINGS = {
  positionMode: "proportional",
  manualWindowMs: 0,
  debugLog: false,
  syncScrolling: false
};
const LOG_MAX = 400;
const USER_INTENT_MS = 500;
const NAV_CONTROL_SELECTOR = [
  "button",
  "[role='button']",
  ".clickable-icon",
  ".pdf-toolbar",
  ".pdf-plus-toolbar",
  ".pdf-sidebar-container"
].join(",");

module.exports = class PDFPreserveHorizontalScroll extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    if (!["proportional", "absolute", "center"].includes(this.settings.positionMode)) {
      this.settings.positionMode = DEFAULT_SETTINGS.positionMode;
    }
    const windowMs = Number(this.settings.manualWindowMs);
    this.settings.manualWindowMs =
      Number.isFinite(windowMs) && windowMs > 0 ? windowMs : 0;
    this.settings.syncScrolling = this.settings.syncScrolling === true;
    // Um estado por contêiner de PDF; sobrevive à troca de abas.
    this.states = new Map();
    this.logBuf = [];
    this.pdfSeq = 0;
    this.buildSyncStatusItem();
    this.setupSyncStatusItem();

    this.boundDocs = new WeakSet();
    this.bindDocument(document);

    const scan = () => this.scan();
    this.registerEvent(this.app.workspace.on("window-open", (_win, win) => {
      this.bindDocument(win.document);
      scan();
    }));
    this.registerEvent(this.app.workspace.on("active-leaf-change", scan));
    this.registerEvent(this.app.workspace.on("layout-change", scan));
    this.registerEvent(this.app.workspace.on("file-open", scan));
    this.registerInterval(window.setInterval(scan, 1000));

    this.addCommand({
      id: "restore-pdf-horizontal-position",
      name: "Restaurar posição salva do PDF",
      callback: () => {
        const state = this.getActiveState();
        if (!state?.snap) {
          new Notice("Nenhuma posição de PDF salva.");
          return;
        }
        this.startFreeze(state, state.snap);
        this.scheduleApply(state);
      }
    });
    this.addCommand({
      id: "copy-pdf-debug-log",
      name: "Copiar log de diagnóstico do PDF",
      callback: async () => {
        const text = this.logBuf.join("\n");
        try {
          await navigator.clipboard.writeText(text);
          new Notice(`Log copiado (${this.logBuf.length} linhas).`);
        } catch (e) {
          new Notice("Falha ao copiar o log.");
        }
      }
    });
    this.addCommand({
      id: "clear-pdf-debug-log",
      name: "Limpar log de diagnóstico do PDF",
      callback: () => {
        this.logBuf = [];
        new Notice("Log limpo.");
      }
    });
    this.addSettingTab(new PDFPreserveScrollSettingTab(this.app, this));

    this.app.workspace.onLayoutReady(scan);
  }

  // ---------- diagnóstico ----------

  // Horário UTC (ISO 8601, com ms) para cruzar com outros logs; `pdf` identifica o contêiner.
  log(state, tag, data) {
    if (!this.settings.debugLog) {
      return;
    }
    const pdf = state ? ` pdf=${state.id}` : "";
    const extra = data === undefined ? "" : " " + JSON.stringify(data);
    this.logBuf.push(`${new Date().toISOString()} ${tag}${pdf}${extra}`);
    if (this.logBuf.length > LOG_MAX) {
      this.logBuf.splice(0, this.logBuf.length - LOG_MAX);
    }
  }

  // ---------- descoberta de PDFs ----------

  // Janelas destacadas têm outro document: os listeners precisam ser registrados em cada um.
  bindDocument(doc) {
    if (!doc || this.boundDocs.has(doc)) {
      return;
    }
    this.boundDocs.add(doc);
    this.registerDomEvent(doc, "scroll", (e) => this.onScroll(e), true);
    this.registerDomEvent(doc, "keydown", (e) => this.onKeyDown(e), true);
    this.registerDomEvent(doc, "click", (e) => this.onClick(e), true);
    this.registerDomEvent(doc, "pointerup", () => this.onPointerUp(), true);
    for (const name of ["wheel", "touchstart", "touchmove", "pointerdown"]) {
      this.registerDomEvent(doc, name, (e) => this.onManualIntent(e), {
        capture: true,
        passive: true
      });
    }

  }

  // instanceof falha entre janelas (cada uma tem seus próprios construtores DOM).
  isNode(x) {
    return !!x && typeof x.nodeType === "number";
  }

  isElement(x) {
    return !!x && x.nodeType === 1;
  }

  scan() {
    for (const leaf of this.app.workspace.getLeavesOfType("pdf")) {
      this.bindDocument(leaf.view?.containerEl?.ownerDocument);
    }
    for (const [el, state] of this.states) {
      if (!el.isConnected) {
        this.disposeState(state);
        this.states.delete(el);
      }
    }

    for (const leaf of this.app.workspace.getLeavesOfType("pdf")) {
      const viewRoot = leaf.view?.containerEl;
      const el = viewRoot?.querySelector(PDF_CONTAINER_SELECTOR);
      if (!el) {
        continue;
      }
      let state = this.states.get(el);
      if (!state) {
        state = this.createState(el, leaf);
        this.states.set(el, state);
      }
      state.leaf = leaf;
      this.bindViewer(state);
    }
    this.updateStatus();
  }

  createState(el, leaf) {
    const state = {
      id: ++this.pdfSeq,
      el,
      leaf,
      snap: null,
      pendingSyncSnap: null,
      syncTarget: null,
      freeze: null,
      manualUntil: 0,
      wrapped: null,
      dragging: false,
      visible: this.isVisible(el),
      viewer: null,
      eventBus: null,
      handlers: [],
      resizeObserver: null,
      applyTimers: []
    };
    state.resizeObserver = new (el.ownerDocument.defaultView?.ResizeObserver ?? ResizeObserver)(
      () => this.onResize(state)
    );
    state.resizeObserver.observe(el);
    state.infoEl = this.createInfoBar(el);
    return state;
  }

  disposeState(state) {
    this.clearFreeze(state);
    state.resizeObserver?.disconnect();
    state.infoEl?.remove();
    state.infoEl = null;
    this.unbindViewer(state);
  }

  getPDFViewer(view) {
    const candidates = [
      view?.child?.pdfViewer?.pdfViewer,
      view?.child?.pdfViewer,
      view?.child?.viewer?.pdfViewer,
      view?.pdfViewer,
      view?.viewer,
      view?.viewer?.pdfViewer,
      view?.pdfView?.pdfViewer,
      view?.pdfViewer?.pdfViewer
    ];
    return candidates.find(
      (c) => c && (typeof c.currentPageNumber === "number" || c.eventBus)
    );
  }

  bindViewer(state) {
    const viewer = this.getPDFViewer(state.leaf?.view);
    if (viewer === state.viewer) {
      return;
    }
    this.unbindViewer(state);
    state.viewer = viewer;
    state.eventBus = viewer?.eventBus;
    this.wrapPageJump(state);
    if (typeof state.eventBus?.on !== "function") {
      return;
    }

    const pageChanging = (event) => {
      const freeze = state.freeze;
      if (!freeze) {
        return;
      }
      const page = Number(event?.pageNumber);
      if (freeze.page === null && Number.isInteger(page) && page > 0) {
        freeze.page = page;
      }
      this.extendFreeze(state);
      this.scheduleApply(state);
    };
    const pageRendered = (event) => {
      if (state.pendingSyncSnap) {
        this.applyPendingSync(state);
      }
      if (state.freeze) {
        this.applyFreeze(state);
      }
    };
    for (const [name, handler] of [
      ["pagechanging", pageChanging],
      ["pagerendered", pageRendered]
    ]) {
      state.eventBus.on(name, handler);
      state.handlers.push([name, handler]);
    }
  }

  // Intercepta o salto de página na origem: o PDF.js posiciona a nova página e, no mesmo
  // ciclo síncrono (antes de qualquer pintura), aplicamos a posição relativa anterior.
  wrapPageJump(state) {
    const viewer = state.viewer;
    if (typeof viewer?.scrollPageIntoView !== "function") {
      return;
    }
    const hadOwn = Object.prototype.hasOwnProperty.call(viewer, "scrollPageIntoView");
    const original = viewer.scrollPageIntoView;
    const plugin = this;
    const wrapper = function (params) {
      const isPlainPageJump =
        params && !params.destArray && Number.isInteger(params.pageNumber);
      const before = isPlainPageJump
        ? state.freeze?.snap ?? plugin.captureSnap(state)
        : null;
      if (before && plugin.syncBlocked(params.pageNumber - before.pageNumber, state, before)) {
        plugin.showSyncLimit();
        return undefined;
      }
      const result = original.apply(this, arguments);
      if (before && plugin.applySnap(state, before, params.pageNumber, "wrapper")) {
        const syncSnap = { ...before, pageNumber: params.pageNumber };
        if (plugin.settings.syncScrolling) {
          plugin.markSyncTarget(state);
        }
        state.snap = plugin.captureSnap(state) ?? syncSnap;
        plugin.syncFromState(state, params.pageNumber - before.pageNumber, syncSnap);
      }
      return result;
    };
    viewer.scrollPageIntoView = wrapper;
    state.wrapped = { viewer, original, hadOwn, wrapper };
  }

  unwrapPageJump(state) {
    const wrapped = state.wrapped;
    state.wrapped = null;
    if (!wrapped || wrapped.viewer.scrollPageIntoView !== wrapped.wrapper) {
      return;
    }
    if (wrapped.hadOwn) {
      wrapped.viewer.scrollPageIntoView = wrapped.original;
    } else {
      delete wrapped.viewer.scrollPageIntoView;
    }
  }

  unbindViewer(state) {
    this.unwrapPageJump(state);
    for (const [name, handler] of state.handlers) {
      state.eventBus?.off?.(name, handler);
    }
    state.handlers = [];
    state.viewer = null;
    state.eventBus = null;
  }

  stateFor(target) {
    if (!this.isNode(target)) {
      return null;
    }
    for (const state of this.states.values()) {
      if (state.el === target || state.el.contains(target)) {
        return state;
      }
    }
    return null;
  }

  getActiveState() {
    const leaf = this.app.workspace.activeLeaf;
    if (!leaf) {
      return null;
    }
    for (const state of this.states.values()) {
      if (state.leaf === leaf) {
        return state;
      }
    }
    return null;
  }

  getStateForEvent(event) {
    const target = event?.target;
    const direct = this.stateFor(target);
    if (direct) {
      return direct;
    }
    const doc = target?.ownerDocument;
    const documentStates = [...this.states.values()].filter(
      (state) => state.leaf?.view?.containerEl?.ownerDocument === doc
    );
    const containingLeaf = documentStates.find((state) =>
      state.leaf.view.containerEl.contains(target)
    );
    if (containingLeaf) {
      return containingLeaf;
    }
    const active = this.getActiveState();
    if (documentStates.includes(active)) {
      return active;
    }
    const visibleStates = documentStates.filter((state) => this.isVisible(state.el));
    return visibleStates.length === 1 ? visibleStates[0] : null;
  }

  isVisible(el) {
    return el.isConnected && el.clientWidth > 0 && el.clientHeight > 0;
  }

  hasPage(state, pageNumber) {
    if (!Number.isInteger(pageNumber) || pageNumber < 1) {
      return false;
    }
    const pageCount = Number(state.viewer?.pagesCount);
    if (Number.isFinite(pageCount) && pageCount > 0) {
      return pageNumber <= pageCount;
    }
    return !!state.el.querySelector(`.page[data-page-number="${pageNumber}"]`);
  }

  markSyncTarget(state) {
    state.syncTarget = {
      top: state.el.scrollTop,
      left: state.el.scrollLeft,
      expires: performance.now() + 500
    };
  }

  consumeSyncTarget(state) {
    if (!this.settings.syncScrolling) {
      state.syncTarget = null;
      return false;
    }
    const target = state.syncTarget;
    if (!target) {
      return false;
    }
    if (performance.now() > target.expires) {
      state.syncTarget = null;
      return false;
    }
    const matches =
      Math.abs(state.el.scrollTop - target.top) <= 1 &&
      Math.abs(state.el.scrollLeft - target.left) <= 1;
    if (!matches) {
      state.syncTarget = null;
    }
    return matches;
  }

  applyPendingSync(state) {
    const snap = state.pendingSyncSnap;
    if (!snap || !this.settings.syncScrolling || !this.isVisible(state.el)) {
      return false;
    }
    if (!this.hasPage(state, snap.pageNumber)) {
      state.pendingSyncSnap = null;
      this.showSyncLimit();
      return false;
    }
    this.clearFreeze(state);
    if (!this.applySnap(state, snap, snap.pageNumber, "sync")) {
      return false;
    }
    this.markSyncTarget(state);
    state.pendingSyncSnap = null;
    state.snap = this.captureSnap(state) ?? snap;
    return true;
  }

  // Posição de referência de um PDF: destino pendente, posição atual ou última salva.
  baseSnap(state) {
    return state.pendingSyncSnap ?? this.captureSnap(state) ?? state.snap ?? null;
  }

  // Comando de página é relativo: se algum PDF não tiver a página de destino, o comando
  // é bloqueado para todos. `sourceBase` é a posição do PDF de origem antes do comando.
  syncBlocked(delta, source, sourceBase) {
    if (!this.settings.syncScrolling || !delta) {
      return false;
    }
    for (const state of this.states.values()) {
      const base = state === source ? sourceBase : this.baseSnap(state);
      if (base && !this.hasPage(state, base.pageNumber + delta)) {
        return true;
      }
    }
    return false;
  }

  // Replica o mesmo número de páginas em cada PDF, a partir da página em que ele está.
  // Mantém a posição vertical de cada um; a horizontal vem da origem.
  syncFromState(source, delta, snap) {
    if (!this.settings.syncScrolling || !snap || !delta) {
      return;
    }
    for (const target of this.states.values()) {
      if (target === source) {
        continue;
      }
      const base = this.baseSnap(target);
      if (!base) {
        continue;
      }
      target.pendingSyncSnap = {
        ...base,
        pageNumber: base.pageNumber + delta,
        left: snap.left,
        ratioX: snap.ratioX
      };
    }
    for (const target of this.states.values()) {
      if (target !== source && target.pendingSyncSnap && this.isVisible(target.el)) {
        this.applyPendingSync(target);
      }
    }
  }

  // ---------- captura e aplicação de posição ----------

  getPages(state) {
    return state.el.querySelectorAll(PAGE_SELECTOR);
  }

  viewportTop(el) {
    return el.getBoundingClientRect().top + el.clientTop;
  }

  // Posição atual: página sob o topo da viewport + fração vertical dentro dela + X.
  captureSnap(state) {
    const el = state.el;
    if (!this.isVisible(el)) {
      return null;
    }
    const top = this.viewportTop(el);
    let page = null;
    let rect = null;
    let found = false;
    for (const candidate of this.getPages(state)) {
      const r = candidate.getBoundingClientRect();
      if (r.height <= 0) {
        continue;
      }
      page = candidate;
      rect = r;
      if (r.bottom > top + 0.5) {
        found = true;
        break;
      }
    }
    if (!page) {
      return null;
    }
    const maxX = Math.max(0, el.scrollWidth - el.clientWidth);
    if (!found) {
      // O topo da viewport passou do fim da última página renderizada no DOM: a posição
      // não é confiável agora. Não inventa página seguinte; quem chama mantém o snap anterior.
      return null;
    }
    return {
      pageNumber: Number(page.dataset.pageNumber),
      frac: (top - rect.top) / rect.height,
      offsetPx: top - rect.top,
      left: el.scrollLeft,
      ratioX: maxX > 0 ? el.scrollLeft / maxX : 0
    };
  }

  savePosition(state) {
    const snap = this.captureSnap(state);
    if (snap) {
      state.snap = snap;
      this.updateStatus();
    }
  }

  applySnap(state, snap, pageNumber, src = "?") {
    const el = state.el;
    if (!snap || !this.isVisible(el)) {
      return false;
    }
    const page = el.querySelector(`.page[data-page-number="${pageNumber}"]`);
    const rect = page?.getBoundingClientRect();
    if (!rect || rect.height <= 0) {
      this.log(state, "APPLY_SKIP", { src, page: pageNumber, found: !!page });
      return false;
    }

    const maxX = Math.max(0, el.scrollWidth - el.clientWidth);
    let left;
    switch (this.settings.positionMode) {
      case "absolute":
        left = snap.left;
        break;
      case "center":
        left = maxX / 2;
        break;
      default:
        left = snap.ratioX * maxX;
    }
    const top =
      el.scrollTop + rect.top - this.viewportTop(el) + snap.frac * rect.height;

    // Reaplicações por timer repetem o mesmo destino; registra só a aplicação original.
    if (!src.startsWith("timer")) {
      this.log(state, "APPLY", {
        src,
        page: pageNumber,
        from: snap.pageNumber,
        frac: Number(snap.frac.toFixed(3)),
        left: Math.round(left),
        top: Math.round(top)
      });
    }
    // O PDF++ reage a este scroll; o evento resultante não é uma ação do usuário.
    state.selfScrollUntil = performance.now() + SELF_SCROLL_MS;
    el.scrollTo({
      left: Math.max(0, Math.min(maxX, left)),
      top: Math.max(0, top),
      behavior: "instant"
    });
    state.expect =  { page: pageNumber, frac: snap.frac, at: performance.now(), snap, fixes: 0 };
    return true;
  }

  // ---------- congelamento (navegação programática / troca de aba) ----------

  startFreeze(state, snap, page = null) {
    this.clearFreeze(state);
    state.freeze = { snap, page, timer: null };
    this.log(state, "FREEZE_START", { page, snapPg: snap.pageNumber });
    this.extendFreeze(state);
  }

  extendFreeze(state) {
    const freeze = state.freeze;
    if (!freeze) {
      return;
    }
    clearTimeout(freeze.timer);
    freeze.timer = setTimeout(() => this.endFreeze(state), FREEZE_MS);
  }

  applyFreeze(state, src = "freeze") {
    const freeze = state.freeze;
    if (freeze) {
      this.applySnap(state, freeze.snap, freeze.page ?? freeze.snap.pageNumber, src);
    }
  }

  scheduleApply(state) {
    for (const t of state.applyTimers) {
      clearTimeout(t);
    }
    state.applyTimers = [0, 60, 150, 300].map((delay) =>
      setTimeout(() => this.applyFreeze(state, "timer" + delay), delay)
    );
  }

  clearFreeze(state) {
    if (state.freeze) {
      this.log(state, "FREEZE_END");
      clearTimeout(state.freeze.timer);
      state.freeze = null;
    }
    for (const t of state.applyTimers) {
      clearTimeout(t);
    }
    state.applyTimers = [];
  }

  endFreeze(state) {
    this.clearFreeze(state);
    this.savePosition(state);
  }

  // ---------- eventos ----------

  onScroll(event) {
    const el = event.target;
    if (!this.isElement(el)) {
      return;
    }
    let state = this.states.get(el);
    if (!state) {
      if (!el.matches(PDF_CONTAINER_SELECTOR)) {
        return;
      }
      this.scan();
      state = this.states.get(el);
    }
    if (!state || !this.isVisible(el)) {
      return;
    }
    if (this.consumeSyncTarget(state)) {
      state.snap = this.captureSnap(state) ?? state.snap;
      this.updateStatus();
      return;
    }
    // Roda/toque/arraste de barra: rolagem do usuário nunca é "salto" a corrigir.
    if (state.dragging || Date.now() < (state.userUntil ?? 0)) {
      if (state.freeze) {
        this.clearFreeze(state);
      }
      state.expect = null;
      this.savePosition(state);
      return;
    }
    if (state.freeze) {
      const freeze = state.freeze;
      const current = this.captureSnap(state);
      const target = freeze.page ?? freeze.snap.pageNumber;
      // Novo salto de página durante o freeze: retarget em vez de deixar o timer reverter.
      if (current && current.pageNumber !== target) {
        // Troca de página sem ação do usuário durante o freeze: não é novo destino.
        // Reaplica a posição congelada e não estende o freeze, para que o ciclo termine pelo timer.
        this.log(state, "RESTORE", { from: current.pageNumber, to: target });
        this.applyFreeze(state, "restore");
      } else if (
        current &&
        current.pageNumber === target &&
        Math.abs(current.frac - freeze.snap.frac) > 0.02 &&
        (freeze.fixes = (freeze.fixes ?? 0) + 1) <= 4
      ) {
        // Algo (PDF++/render) moveu a rolagem para outro ponto da mesma página.
        this.log(state, "DESVIO", {
          frac: Number(current.frac.toFixed(3)),
          want: Number(freeze.snap.frac.toFixed(3))
        });
        this.extendFreeze(state);
        this.applyFreeze(state, "desvio");
      }
      this.updateStatus();
      return;
    }

    const snap = this.captureSnap(state);
    if (!snap) {
      return;
    }
    const previous = state.snap;
    if (performance.now() < (state.selfScrollUntil ?? 0) && previous && snap.pageNumber !== previous.pageNumber) {
      // Scroll causado pelo próprio plugin (ou pelo PDF++ reagindo a ele): não é salto do usuário.
      return;
    }
    const exp = state.expect;
    if (
      exp &&
      performance.now() - exp.at < 800 &&
      (snap.pageNumber !== exp.page || Math.abs(snap.frac - exp.frac) > 0.02)
    ) {
      this.log(state, "ANOMALIA", {
        expected: { page: exp.page, frac: Number(exp.frac.toFixed(3)) },
        got: { page: snap.pageNumber, frac: Number(snap.frac.toFixed(3)) },
        ageMs: Math.round(performance.now() - exp.at)
      });
      if (snap.pageNumber === exp.page && exp.snap && (exp.fixes ?? 0) < 2) {
        // Mesma página, posição deslocada sem ação do usuário: restaura uma vez.
        const fixes = (exp.fixes ?? 0) + 1;
        this.applySnap(state, exp.snap, exp.page, "anomaly-fix");
        if (state.expect) {
          state.expect.fixes = fixes;
          state.expect.at = exp.at;
        }
        return;
      }
    }
    const windowMs = this.settings.manualWindowMs;
    const userScrolling =
      state.dragging || (windowMs > 0 && Date.now() < state.manualUntil);
    // Sem a janela de tempo, só é salto de página o que cai alinhado ao topo da página.
    const alignedToPageTop =
      windowMs > 0 || Math.abs(snap.offsetPx) <= PAGE_TOP_TOLERANCE_PX;
    if (
      !state.wrapped &&
      previous &&
      !userScrolling &&
      alignedToPageTop &&
      snap.pageNumber !== previous.pageNumber
    ) {
      // Salto de página sem ação do usuário no scroll (botões, "ir para página"...):
      // o PDF.js alinha ao canto da nova página; reaplica a posição relativa anterior.
      const delta = snap.pageNumber - previous.pageNumber;
      if (this.syncBlocked(delta, state, previous)) {
        // Sync bloqueado: o PDF que saltou volta à página anterior, como os demais.
        this.startFreeze(state, previous);
        this.applyFreeze(state, "onScroll");
        this.scheduleApply(state);
        this.showSyncLimit();
        return;
      }
      this.log(state, "JUMP", {
        from: previous.pageNumber,
        to: snap.pageNumber,
        restoreFrac: Number(previous.frac.toFixed(3)),
        restoreLeft: Math.round(previous.left)
      });
      this.startFreeze(state, previous, snap.pageNumber);
      this.applyFreeze(state, "onScroll");
      if (this.settings.syncScrolling) {
        this.markSyncTarget(state);
      }
      this.syncFromState(state, delta, previous);
      this.scheduleApply(state);
      return;
    }
    state.snap = snap;
    this.updateStatus();
  }

  onResize(state) {
    const visible = this.isVisible(state.el);
    const becameVisible = visible && !state.visible;
    state.visible = visible;
    if (becameVisible && state.pendingSyncSnap) {
      this.applyPendingSync(state);
      return;
    }
    if (becameVisible && state.snap) {
      // Aba reaberta: o navegador zera a rolagem de elementos ocultos.
      this.startFreeze(state, state.snap);
      this.scheduleApply(state);
    }
  }

  onKeyDown(event) {
    const eventState = this.getStateForEvent(event);
    if (event.key === "Enter") {
      this.freezeOnControl(event);
      return;
    }
    if (
      eventState &&
      ["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", " ", "Home", "End"].includes(
        event.key
      )
    ) {
      eventState.syncTarget = null;
      eventState.manualUntil = Date.now() + this.settings.manualWindowMs;
      eventState.userUntil = Date.now() + USER_INTENT_MS;
    }
    if (
      (event.key !== "PageUp" && event.key !== "PageDown") ||
      event.ctrlKey ||
      event.altKey ||
      event.metaKey ||
      event.shiftKey
    ) {
      return;
    }

    const state = eventState;
    const target = event.target;
    if (
      !state ||
      !this.isVisible(state.el) ||
      (this.isElement(target) &&
        (target.closest("input, textarea, select, [contenteditable='true']") ||
          (target !== target.ownerDocument.body && !state.leaf.view.containerEl.contains(target))))
    ) {
      return;
    }
    const snap = state.freeze?.snap ?? this.captureSnap(state);
    if (!snap) {
      return;
    }
    const delta = event.key === "PageDown" ? 1 : -1;
    const next = snap.pageNumber + delta;
    if (this.syncBlocked(delta, state, snap)) {
      event.preventDefault();
      event.stopImmediatePropagation();
      this.showSyncLimit();
      return;
    }
    if (!this.hasPage(state, next)) {
      return;
    }

    this.log(state, "KEY", { key: event.key, from: snap.pageNumber, to: next });
    event.preventDefault();
    event.stopImmediatePropagation();
    state.manualUntil = Date.now() + this.settings.manualWindowMs;
    this.clearFreeze(state);
    const nextSnap = { ...snap, pageNumber: next };
    if (this.applySnap(state, nextSnap, next, "key")) {
      if (this.settings.syncScrolling) {
        this.markSyncTarget(state);
      }
      state.snap = this.captureSnap(state) ?? nextSnap;
      this.syncFromState(state, delta, nextSnap);
    }
  }

  onClick(event) {
    this.freezeOnControl(event);
  }

  // Controles da barra (próxima página, ir para página...) também mantêm a posição.
  freezeOnControl(event) {
    const state = this.getStateForEvent(event);
    const target = event.target;
    if (
      !state ||
      state.wrapped ||
      !this.isElement(target) ||
      state.el.contains(target) ||
      !state.leaf.view.containerEl.contains(target) ||
      !target.closest(NAV_CONTROL_SELECTOR)
    ) {
      return;
    }
    const snap = state.freeze?.snap ?? this.captureSnap(state) ?? state.snap;
    state.userUntil = 0;
    this.log(state, "CONTROL", { tag: target.tagName });
    if (snap) {
      this.startFreeze(state, snap);
    }
  }

  onManualIntent(event) {
    const state = this.stateFor(event.target);
    if (!state) {
      return;
    }
    if (event.type === "pointerdown") {
      // Clique direto no contêiner = barra de rolagem.
      if (event.target !== state.el) {
        return;
      }
      state.dragging = true;
    }
    state.syncTarget = null;
    state.manualUntil = Date.now() + this.settings.manualWindowMs;
    state.userUntil = Date.now() + USER_INTENT_MS;
    this.log(state, "INTENT", { type: event.type });
    if (state.freeze) {
      this.endFreeze(state);
    }
  }

  onPointerUp() {
    for (const state of this.states.values()) {
      state.dragging = false;
    }
  }

  // ---------- UI ----------

  // Único item na barra nativa: o botão de Sync. As informações ficam em uma barra por PDF.
  buildSyncStatusItem() {
    this.syncStatusBarItem = this.addStatusBarItem();
    this.syncStatusBarItem.classList.add("pps-sync");
  }

  createInfoBar(el) {
    const bar = el.ownerDocument.createElement("div");
    bar.className = "pps-pdf-bar";
    el.insertAdjacentElement("afterend", bar);
    return bar;
  }

  // `chips` = [[tipo, texto], ...]; tipo define a cor do texto em styles.css.
  setStatus(state, chips) {
    const bar = state.infoEl;
    if (!bar) {
      return;
    }
    bar.textContent = "";
    for (const [kind, text] of chips) {
      const chip = document.createElement("span");
      chip.className = `pps-chip pps-chip-${kind}`;
      chip.textContent = text;
      bar.appendChild(chip);
    }
  }

  setupSyncStatusItem() {
    const item = this.syncStatusBarItem;
    item?.setAttribute?.("role", "button");
    item?.setAttribute?.("tabindex", "0");
    item?.setAttribute?.("title", "Ativar ou desativar a rolagem síncrona entre PDFs");
    item?.addEventListener?.("click", () => this.toggleSyncScrolling());
    item?.addEventListener?.("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        this.toggleSyncScrolling();
      }
    });
    this.updateSyncStatus();
  }

  async toggleSyncScrolling() {
    this.settings.syncScrolling = !this.settings.syncScrolling;
    if (!this.settings.syncScrolling) {
      for (const state of this.states.values()) {
        state.pendingSyncSnap = null;
        state.syncTarget = null;
      }
    }
    this.updateSyncStatus();
    await this.saveSettings();
  }

  updateSyncStatus(warning = null) {
    const item = this.syncStatusBarItem;
    if (!item) {
      return;
    }
    if (this.syncStatusTimer) {
      clearTimeout(this.syncStatusTimer);
      this.syncStatusTimer = null;
    }
    const enabled = this.settings.syncScrolling;
    const kind = warning ? "warn" : enabled ? "on" : "off";
    item.setText(
      warning
        ? `⇅ Scroll Sync: ${warning}`
        : enabled
          ? "⇅ Scroll Sync ligado"
          : "⇅ Scroll Sync desligado"
    );
    item.classList.remove("pps-sync-on", "pps-sync-off", "pps-sync-warn");
    item.classList.add(`pps-sync-${kind}`);
    item.setAttribute?.("aria-pressed", String(enabled));
    item.setAttribute?.(
      "aria-label",
      warning
        ? `Rolagem síncrona ligada: ${warning}.`
        : `Rolagem síncrona ${enabled ? "ligada" : "desligada"}`
    );
    if (warning) {
      this.syncStatusTimer = setTimeout(() => this.updateSyncStatus(), 3000);
    }
  }

  showSyncWarning(message) {
    this.updateSyncStatus(message);
  }

  showSyncLimit() {
    this.showSyncWarning("limite de página atingido");
  }

  updateStatus() {
    for (const state of this.states.values()) {
      this.updateStateStatus(state);
    }
  }

  updateStateStatus(state) {
    const snap = this.isVisible(state.el) ? this.captureSnap(state) : null;
    if (!snap) {
      const page = state.snap?.pageNumber;
      this.setStatus(
        state,
        page
          ? [["page", `PDF p. ${page}`], ["state", "posição salva"]]
          : [["state", "acompanhando"]]
      );
      return;
    }
    const el = state.el;
    const maxX = Math.max(0, el.scrollWidth - el.clientWidth);
    const xPct = maxX > 0 ? (el.scrollLeft / maxX) * 100 : 0;
    this.setStatus(state, [
      ["page", `PDF p. ${snap.pageNumber}`],
      ["x", `X ${Math.round(el.scrollLeft)}px · ${xPct.toFixed(1)}%`],
      ["y", `Y ${Math.round(snap.offsetPx)}px · ${(snap.frac * 100).toFixed(1)}%`]
    ]);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  onunload() {
    clearTimeout(this.syncStatusTimer);
    for (const state of this.states.values()) {
      this.disposeState(state);
    }
    this.states.clear();
    this.syncStatusBarItem?.remove();
  }
};

class PDFPreserveScrollSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "PDF Preserve Horizontal Scroll" });

    new Setting(containerEl)
      .setName("Modo de preservação horizontal")
      .setDesc(
        "Proporcional adapta a posição à largura da página; absoluto mantém pixels; centralizado usa o meio da área rolável."
      )
      .addDropdown((dropdown) =>
        dropdown
          .addOption("proportional", "Proporcional (recomendado)")
          .addOption("absolute", "Absoluto")
          .addOption("center", "Alinhamento central fixo")
          .setValue(this.plugin.settings.positionMode)
          .onChange(async (value) => {
            this.plugin.settings.positionMode = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Janela de proteção do scroll manual (ms)")
      .setDesc(
        "0 = desativado (padrão). Acima de 0, saltos de página logo após rolar manualmente (roda, toque, teclas) não são corrigidos pelo plugin."
      )
      .addText((text) =>
        text
          .setValue(String(this.plugin.settings.manualWindowMs))
          .onChange(async (value) => {
            const ms = Number(value);
            this.plugin.settings.manualWindowMs =
              Number.isFinite(ms) && ms > 0 ? ms : 0;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Registro de diagnóstico")
      .setDesc(
        "Grava eventos de rolagem/salto (últimas 400 linhas). Use o comando 'Copiar log de diagnóstico do PDF' após reproduzir o salto."
      )
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.debugLog).onChange(async (value) => {
          this.plugin.settings.debugLog = value;
          await this.plugin.saveSettings();
        })
      );
  }
}
