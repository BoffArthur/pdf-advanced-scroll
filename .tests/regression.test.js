const test = require("node:test");
const assert = require("node:assert");
const { setup, sleep, window, PAGE_H, GAP } = require("./harness");

const STEP = PAGE_H + GAP;
const near = (a, b, msg) => assert.ok(Math.abs(a - b) <= 1, `${msg}: esperado ${b}, obtido ${a}`);
// Posição de teste: página 3, 40% da altura, X=300 (ratio 0.75 de 400).
const POS_TOP = 2 * STEP + 0.4 * PAGE_H;
const POS_LEFT = 300;

async function withPDF(options, fn) {
  const env = await setup(options);
  try {
    await fn(env);
  } finally {
    env.cleanup();
  }
}

test("scroll é salvo automaticamente sem clicar em nada", () =>
  withPDF({}, async ({ make, plugin }) => {
    const pdf = make();
    pdf.userScroll(POS_TOP, POS_LEFT);
    await sleep(30);
    const state = plugin.getActiveState();
    assert.equal(state.snap.pageNumber, 3);
    near(state.snap.frac, 0.4, "frac");
    near(state.snap.left, POS_LEFT, "left");
  }));

test("scroll é salvo mesmo sem overflow horizontal", () =>
  withPDF({ scrollWidth: 800 }, async ({ make, plugin }) => {
    const pdf = make();
    pdf.userScroll(POS_TOP);
    await sleep(30);
    const state = plugin.getActiveState();
    assert.equal(state.snap.pageNumber, 3);
    near(state.snap.frac, 0.4, "frac");
  }));

for (const rescroll of [false, true]) {
  test(`botão próxima/anterior mantém posição relativa (rescroll=${rescroll})`, () =>
    withPDF({ rescroll }, async ({ make }) => {
      const pdf = make();
      pdf.userScroll(POS_TOP, POS_LEFT);
      await sleep(30);
      pdf.next.dispatchEvent(new window.Event("click", { bubbles: true }));
      await sleep(700);
      assert.equal(pdf.currentPage(), 4);
      near(pdf.frac(), 0.4, "frac após próxima");
      near(pdf.geo.scrollLeft, POS_LEFT, "X após próxima");
      pdf.prev.dispatchEvent(new window.Event("click", { bubbles: true }));
      pdf.prev.dispatchEvent(new window.Event("click", { bubbles: true }));
      await sleep(700);
      assert.equal(pdf.currentPage(), 2);
      near(pdf.frac(), 0.4, "frac após 2x anterior");
      near(pdf.geo.scrollLeft, POS_LEFT, "X após anterior");
    }));
}

test("salto de página sem botão reconhecido (ex.: ir para página) mantém posição", () =>
  withPDF({}, async ({ make }) => {
    const pdf = make();
    pdf.userScroll(POS_TOP, POS_LEFT);
    await sleep(500);
    pdf.viewer.goTo(7);
    await sleep(700);
    assert.equal(pdf.currentPage(), 7);
    near(pdf.frac(), 0.4, "frac");
    near(pdf.geo.scrollLeft, POS_LEFT, "X");
  }));

test("PgDn / PgUp mantêm posição relativa na próxima página", () =>
  withPDF({}, async ({ make }) => {
    const pdf = make();
    pdf.userScroll(POS_TOP, POS_LEFT);
    await sleep(30);
    const press = (key) =>
      pdf.container.dispatchEvent(new window.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
    press("PageDown");
    await sleep(30);
    assert.equal(pdf.currentPage(), 4);
    near(pdf.frac(), 0.4, "frac PgDn");
    near(pdf.geo.scrollLeft, POS_LEFT, "X PgDn");
    press("PageDown");
    press("PageUp");
    press("PageUp");
    await sleep(30);
    assert.equal(pdf.currentPage(), 3);
    near(pdf.frac(), 0.4, "frac PgUp");
  }));

test("scroll manual (roda) entre páginas não é revertido", () =>
  withPDF({}, async ({ make, plugin }) => {
    const pdf = make();
    pdf.userScroll(POS_TOP, POS_LEFT);
    await sleep(30);
    pdf.userScroll(5 * STEP + 100, 50);
    await sleep(700);
    near(pdf.geo.scrollTop, 5 * STEP + 100, "top");
    near(pdf.geo.scrollLeft, 50, "left");
    assert.equal(plugin.getActiveState().snap.pageNumber, 6);
  }));

test("múltiplos PDFs: trocar de aba preserva a posição de cada um", () =>
  withPDF({}, async ({ make, activate }) => {
    const a = make();
    a.userScroll(POS_TOP, POS_LEFT);
    await sleep(30);
    a.hide();
    const b = make();
    b.userScroll(6 * STEP + 0.7 * PAGE_H, 120);
    await sleep(30);

    b.hide();
    a.show();
    activate(a);
    await sleep(700);
    near(a.geo.scrollTop, POS_TOP, "A top");
    near(a.geo.scrollLeft, POS_LEFT, "A left");

    a.hide();
    b.show();
    activate(b);
    await sleep(700);
    near(b.geo.scrollTop, 6 * STEP + 0.7 * PAGE_H, "B top");
    near(b.geo.scrollLeft, 120, "B left");
  }));

test("scroll resetado de aba oculta não sobrescreve a posição salva", () =>
  withPDF({}, async ({ make, plugin }) => {
    const pdf = make();
    pdf.userScroll(POS_TOP, POS_LEFT);
    await sleep(30);
    pdf.hide();
    pdf.container.dispatchEvent(new window.Event("scroll"));
    await sleep(30);
    assert.equal(plugin.getActiveState().snap.pageNumber, 3);
  }));

test("navegação por botão em um PDF não afeta o outro", () =>
  withPDF({}, async ({ make, activate }) => {
    const a = make();
    a.userScroll(POS_TOP, POS_LEFT);
    await sleep(30);
    const b = make();
    b.userScroll(STEP + 0.1 * PAGE_H, 10);
    await sleep(30);
    activate(a);
    a.next.dispatchEvent(new window.Event("click", { bubbles: true }));
    await sleep(700);
    assert.equal(a.currentPage(), 4);
    near(b.geo.scrollTop, STEP + 0.1 * PAGE_H, "B intacto");
  }));

test("controle de página fora dos seletores conhecidos (ex.: PDF++) mantém posição", () =>
  withPDF({}, async ({ make }) => {
    const pdf = make();
    pdf.userScroll(POS_TOP, POS_LEFT);
    await sleep(500);
    const custom = document.createElement("span");
    document.body.append(custom);
    custom.addEventListener("click", () => pdf.viewer.goTo(pdf.currentPage() + 1));
    custom.dispatchEvent(new window.Event("click", { bubbles: true }));
    await sleep(700);
    assert.equal(pdf.currentPage(), 4);
    near(pdf.frac(), 0.4, "frac");
    near(pdf.geo.scrollLeft, POS_LEFT, "X");
  }));

test("sem janela de tempo: clicar no botão logo após rolar com a roda mantém posição", () =>
  withPDF({}, async ({ make }) => {
    const pdf = make();
    pdf.userScroll(POS_TOP, POS_LEFT);
    await sleep(5);
    pdf.viewer.goTo(pdf.currentPage() + 1);
    await sleep(700);
    assert.equal(pdf.currentPage(), 4);
    near(pdf.frac(), 0.4, "frac");
    near(pdf.geo.scrollLeft, POS_LEFT, "X");
  }));

test("sem janela de tempo: rolar com a roda atravessando página não é revertido", () =>
  withPDF({}, async ({ make }) => {
    const pdf = make();
    pdf.userScroll(2 * STEP + 0.95 * PAGE_H, POS_LEFT);
    await sleep(10);
    pdf.userScroll(3 * STEP + 0.05 * PAGE_H, POS_LEFT);
    await sleep(700);
    near(pdf.geo.scrollTop, 3 * STEP + 0.05 * PAGE_H, "top");
  }));

test("interceptação na origem: salto de página já cai na posição relativa, sem passar pelo canto", () =>
  withPDF({}, async ({ make }) => {
    const pdf = make();
    pdf.userScroll(POS_TOP, POS_LEFT);
    await sleep(30);
    pdf.viewer.goTo(4);
    // Verificado de forma síncrona: nenhuma pintura intermediária no canto.
    assert.equal(pdf.currentPage(), 4);
    near(pdf.frac(), 0.4, "frac imediato");
    near(pdf.geo.scrollLeft, POS_LEFT, "X imediato");
    await sleep(500);
    near(pdf.frac(), 0.4, "frac final");
  }));

test("interceptação: saltos rápidos consecutivos mantêm a posição", () =>
  withPDF({}, async ({ make }) => {
    const pdf = make();
    pdf.userScroll(POS_TOP, POS_LEFT);
    await sleep(30);
    for (const n of [4, 5, 6, 7, 6, 5, 4, 3, 2, 3, 4, 5, 8, 9]) {
      pdf.viewer.goTo(n);
      assert.equal(pdf.currentPage(), n);
      near(pdf.frac(), 0.4, `frac na página ${n}`);
      near(pdf.geo.scrollLeft, POS_LEFT, `X na página ${n}`);
    }
    await sleep(500);
    assert.equal(pdf.currentPage(), 9);
    near(pdf.frac(), 0.4, "frac final");
  }));

test("interceptação: links com destino explícito (destArray) não são alterados", () =>
  withPDF({}, async ({ make }) => {
    const pdf = make();
    pdf.userScroll(POS_TOP, POS_LEFT);
    await sleep(30);
    const before = pdf.geo.scrollTop;
    pdf.viewer.scrollPageIntoView({ pageNumber: 5, destArray: [null, { name: "XYZ" }, 0, 0, null] });
    assert.equal(pdf.geo.scrollTop, before);
  }));

test("rolagem rápida com a roda parando exatamente no topo de páginas não é revertida", () =>
  withPDF({}, async ({ make }) => {
    const pdf = make();
    pdf.userScroll(POS_TOP, POS_LEFT);
    for (let n = 3; n <= 9; n++) {
      pdf.userScroll((n - 1) * STEP, POS_LEFT);
      await sleep(5);
    }
    await sleep(700);
    near(pdf.geo.scrollTop, 8 * STEP, "top final");
    near(pdf.geo.scrollLeft, POS_LEFT, "left final");
  }));

test("desativar o plugin restaura o scrollPageIntoView original", () =>
  withPDF({}, async ({ make, plugin }) => {
    const pdf = make();
    assert.ok(Object.prototype.hasOwnProperty.call(pdf.viewer, "scrollPageIntoView"));
    const wrapper = pdf.viewer.scrollPageIntoView;
    plugin.onunload();
    assert.notEqual(pdf.viewer.scrollPageIntoView, wrapper);
  }));

test("fallback sem scrollPageIntoView: botão ainda mantém posição", () =>
  withPDF({ wrappable: false, rescroll: true }, async ({ make }) => {
    const pdf = make();
    pdf.userScroll(POS_TOP, POS_LEFT);
    await sleep(30);
    pdf.next.dispatchEvent(new window.Event("click", { bubbles: true }));
    await sleep(700);
    assert.equal(pdf.currentPage(), 4);
    near(pdf.frac(), 0.4, "frac");
    near(pdf.geo.scrollLeft, POS_LEFT, "X");
  }));

test("botão da barra de status ativa e desativa a sincronização", () =>
  withPDF({}, async ({ make, plugin }) => {
    make();
    const button = plugin.syncStatusBarItem;
    assert.equal(plugin.settings.syncScrolling, false);
    button.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    await sleep(0);
    assert.equal(plugin.settings.syncScrolling, true);
    assert.equal(button.textContent, "⇅ Scroll Sync ligado");
    assert.ok(button.classList.contains("pps-sync-on"));
    button.dispatchEvent(new window.KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true }));
    await sleep(0);
    assert.equal(plugin.settings.syncScrolling, false);
    assert.equal(button.textContent, "⇅ Scroll Sync desligado");
    assert.ok(button.classList.contains("pps-sync-off"));
  }));

test("rolagem manual não move os demais PDFs (sync só por comando)", () =>
  withPDF({}, async ({ make, plugin }) => {
    const a = make();
    const b = make();
    plugin.settings.syncScrolling = true;
    a.userScroll(POS_TOP, POS_LEFT);
    await sleep(30);
    assert.equal(a.currentPage(), 3);
    assert.equal(b.currentPage(), 1);
  }));

test("scroll programático de layout não inicia uma sincronização", () =>
  withPDF({}, async ({ make, plugin }) => {
    const a = make();
    const b = make();
    plugin.settings.syncScrolling = true;
    a.geo.scrollTop = POS_TOP;
    a.container.dispatchEvent(new window.Event("scroll"));
    await sleep(30);
    assert.equal(b.currentPage(), 1);
  }));

test("PageDown avança cada PDF a partir da própria página, sem igualar números", () =>
  withPDF({}, async ({ make, plugin }) => {
    const a = make();
    const b = make();
    plugin.settings.syncScrolling = true;
    a.userScroll(POS_TOP, POS_LEFT);
    b.userScroll(6 * STEP + 0.2 * PAGE_H, 120);
    await sleep(20);
    plugin.app.workspace.activeLeaf = a.leaf;
    a.container.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "PageDown", bubbles: true, cancelable: true })
    );
    await sleep(30);
    assert.equal(a.currentPage(), 4);
    near(a.frac(), 0.4, "fração A");
    assert.equal(b.currentPage(), 8);
    near(b.frac(), 0.2, "fração B");
    near(b.geo.scrollLeft, POS_LEFT, "X");
  }));

test("controle de próxima página avança cada PDF a partir da própria página", () =>
  withPDF({}, async ({ make, plugin }) => {
    const a = make();
    const b = make();
    plugin.settings.syncScrolling = true;
    a.userScroll(POS_TOP, POS_LEFT);
    b.userScroll(6 * STEP + 0.2 * PAGE_H, 120);
    await sleep(20);
    a.next.dispatchEvent(new window.Event("click", { bubbles: true }));
    await sleep(30);
    assert.equal(a.currentPage(), 4);
    assert.equal(b.currentPage(), 8);
    near(b.frac(), 0.2, "fração");
  }));

test("comando de página é bloqueado para todos quando um PDF está no limite", () =>
  withPDF({}, async ({ make, plugin }) => {
    const a = make({ pages: 6 });
    const b = make({ pages: 3 });
    plugin.settings.syncScrolling = true;
    a.userScroll(2 * STEP + 0.2 * PAGE_H, POS_LEFT);
    b.userScroll(2 * STEP + 0.2 * PAGE_H, POS_LEFT);
    await sleep(20);
    plugin.app.workspace.activeLeaf = a.leaf;
    const oldATop = a.geo.scrollTop;
    const oldBTop = b.geo.scrollTop;
    a.container.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "PageDown", bubbles: true, cancelable: true })
    );
    await sleep(20);
    near(a.geo.scrollTop, oldATop, "origem não avança");
    near(b.geo.scrollTop, oldBTop, "destino não avança");
    assert.match(plugin.syncStatusBarItem.textContent, /limite/);
  }));

test("PageDown é interrompido se o PDF de origem estiver no fim", () =>
  withPDF({}, async ({ make, plugin }) => {
    const a = make({ pages: 3 });
    const b = make({ pages: 6 });
    plugin.settings.syncScrolling = true;
    a.userScroll(2 * STEP + 0.2 * PAGE_H, POS_LEFT);
    await sleep(20);
    plugin.app.workspace.activeLeaf = a.leaf;
    const before = a.geo.scrollTop;
    a.container.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "PageDown", bubbles: true, cancelable: true })
    );
    await sleep(20);
    near(a.geo.scrollTop, before, "origem não avança");
    assert.match(plugin.syncStatusBarItem.textContent, /limite/);
  }));

test("rolagem de origem avança e não move os demais PDFs", () =>
  withPDF({}, async ({ make, plugin }) => {
    const a = make({ pages: 6 });
    const b = make({ pages: 3 });
    plugin.settings.syncScrolling = true;
    a.userScroll(3 * STEP + 0.2 * PAGE_H, POS_LEFT);
    await sleep(30);
    assert.equal(a.currentPage(), 4);
    assert.equal(b.currentPage(), 1);
    assert.doesNotMatch(plugin.syncStatusBarItem.textContent, /limite/);
  }));

test("PDF oculto recebe o mesmo deslocamento de páginas ao voltar a ficar visível", () =>
  withPDF({}, async ({ make, plugin }) => {
    const a = make();
    const b = make();
    plugin.settings.syncScrolling = true;
    b.userScroll(2 * STEP + 0.4 * PAGE_H, POS_LEFT);
    await sleep(20);
    b.hide();
    a.userScroll(POS_TOP, POS_LEFT);
    await sleep(20);
    plugin.app.workspace.activeLeaf = a.leaf;
    a.container.dispatchEvent(
      new window.KeyboardEvent("keydown", { key: "PageDown", bubbles: true, cancelable: true })
    );
    await sleep(20);
    b.show();
    await sleep(30);
    assert.equal(a.currentPage(), 4);
    assert.equal(b.currentPage(), 4);
    near(b.frac(), 0.4, "fração");
  }));
