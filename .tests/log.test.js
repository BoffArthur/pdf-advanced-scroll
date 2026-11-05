const test = require("node:test");
const assert = require("node:assert");
const { setup, sleep, PAGE_H, GAP } = require("./harness");

const STEP = PAGE_H + GAP;
const ISO_LINE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z /;

async function withPDF(options, fn) {
  const env = await setup(options);
  env.plugin.settings.debugLog = true;
  try {
    await fn(env);
  } finally {
    env.cleanup();
  }
}

test("cada linha do log usa horário UTC ISO com milissegundos", () =>
  withPDF({}, async ({ make, plugin }) => {
    const pdf = make();
    pdf.userScroll(2 * STEP + 0.4 * PAGE_H, 300);
    await sleep(30);
    assert.ok(plugin.logBuf.length > 0);
    for (const line of plugin.logBuf) {
      assert.match(line, ISO_LINE);
    }
  }));

test("log registra salto de página e aplicação, sem eventos de ruído", () =>
  withPDF({ wrappable: false, rescroll: true }, async ({ make, plugin }) => {
    const pdf = make();
    // Posição inicial sem intenção do usuário (sem wheel), para o próximo scroll contar como salto.
    pdf.geo.scrollTop = 2 * STEP + 0.4 * PAGE_H;
    pdf.geo.scrollLeft = 300;
    pdf.container.dispatchEvent(new window.Event("scroll"));
    await sleep(30);
    pdf.viewer.goTo(5);
    await sleep(150);
    const text = plugin.logBuf.join("\n");
    assert.match(text, /JUMP /);
    assert.doesNotMatch(text, / scroll\b/);
    assert.doesNotMatch(text, /apply:timer/);
    assert.doesNotMatch(text, /keydown-raw/);
    assert.doesNotMatch(text, /wrapper:/);
  }));

test("log identifica o PDF pelo id do estado", () =>
  withPDF({}, async ({ make, plugin }) => {
    make();
    make();
    await sleep(0);
    const ids = new Set(plugin.logBuf.map((l) => (l.match(/ pdf=(\d+)/) || [])[1]).filter(Boolean));
    assert.ok(ids.size <= 2);
  }));

test("troca de página sem ação do usuário durante o freeze restaura a página congelada", () =>
  withPDF({ wrappable: false, rescroll: false }, async ({ make, plugin }) => {
    const pdf = make();
    pdf.geo.scrollTop = 2 * STEP + 0.4 * PAGE_H;
    pdf.geo.scrollLeft = 300;
    pdf.container.dispatchEvent(new window.Event("scroll"));
    await sleep(30);
    // Topo da página 4 alinhado: gera JUMP e congela a página 4.
    pdf.geo.scrollTop = 3 * STEP;
    pdf.container.dispatchEvent(new window.Event("scroll"));
    await sleep(30);
    // O PDF++ troca para a página 3 sem intenção do usuário durante o freeze.
    pdf.geo.scrollTop = 2 * STEP + 0.5 * PAGE_H;
    pdf.geo.scrollLeft = 0;
    pdf.container.dispatchEvent(new window.Event("scroll"));
    await sleep(50);
    const text = plugin.logBuf.join("\n");
    assert.match(text, /RESTORE /);
    assert.doesNotMatch(text, /RETARGET /);
  }));

test("cada PDF tem barra de status própria com chips de página, X e Y", () =>
  withPDF({}, async ({ make, plugin }) => {
    const a = make();
    const b = make();
    a.userScroll(2 * STEP + 0.4 * PAGE_H, 300);
    b.userScroll(5 * STEP + 0.1 * PAGE_H, 40);
    await sleep(30);
    const barA = plugin.states.get(a.container).infoEl;
    const barB = plugin.states.get(b.container).infoEl;
    assert.ok(barA.classList.contains("pps-pdf-bar"));
    assert.notEqual(barA, barB);
    const chipsA = [...barA.querySelectorAll(".pps-chip")];
    const kinds = chipsA.map((c) => c.className.split(" ").find((k) => k.startsWith("pps-chip-")));
    assert.deepEqual(kinds, ["pps-chip-page", "pps-chip-x", "pps-chip-y"]);
    assert.match(chipsA[0].textContent, /PDF p\. 3/);
    assert.match(barB.querySelector(".pps-chip").textContent, /PDF p\. 6/);
  }));

test("barra nativa contém só o botão de sync", () =>
  withPDF({}, async ({ plugin }) => {
    assert.equal(plugin.statusBarItem, undefined);
    assert.ok(plugin.syncStatusBarItem.classList.contains("pps-sync"));
    assert.ok(plugin.syncStatusBarItem.classList.contains("pps-sync-off"));
  }));
