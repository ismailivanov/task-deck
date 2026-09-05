const assert = require("assert");
const Module = require("module");
const path = require("path");

class BrowserWindow {
  constructor() {
    this.webContents = { async printToPDF() { return Buffer.from("pdf"); } };
  }
  async loadFile() {}
  destroy() {}
}

const obsidian = {
  Modal: class {},
  Menu: class {},
  Notice: class {},
  MarkdownRenderer: {},
  arrayBufferToBase64() { return ""; },
  setIcon() {},
};
const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === "obsidian") return obsidian;
  return originalLoad.call(this, request, parent, isMain);
};

let html = "";
const fakeFs = {
  writeFileSync(file, data) { if (String(file).endsWith(".html")) html = String(data); },
  unlinkSync() {},
};
global.window = {
  require(request) {
    if (request === "@electron/remote") {
      return { BrowserWindow, dialog: { async showSaveDialog() { return { canceled: false, filePath: "/tmp/Board.pdf" }; } } };
    }
    if (request === "fs") return fakeFs;
    if (request === "os") return { tmpdir() { return "/tmp"; } };
    if (request === "path") return path;
    throw new Error(`Unexpected require: ${request}`);
  },
};

const { exportListPdf } = require("../src/modals");
Module._load = originalLoad;

(async () => {
  const card = {
    id: "card-1",
    title: "First card",
    listId: "list-1",
    labels: [{ name: "Bug", color: "#be332b" }],
    details: "See [[Board/cards/Other|related task]].",
    checklist: [],
  };
  const hiddenCard = { id: "card-2", title: "Hidden card", listId: "list-2", details: "", checklist: [] };
  const board = {
    id: "board-1",
    name: "Board",
    lists: [
      { id: "list-1", title: "Todo", cardIds: [card.id] },
      { id: "list-2", title: "Done", cardIds: [hiddenCard.id] },
    ],
  };
  const plugin = {
    data: { cards: { [card.id]: card, [hiddenCard.id]: hiddenCard } },
    async hydrateCardFromFile() {},
    resolveCardImage() { return null; },
  };

  await exportListPdf({}, plugin, board, board.lists[0]);

  assert.match(html, /<h1>Todo<\/h1>/);
  assert.match(html, /<h2>First card<\/h2>/);
  assert.match(html, /class="task-card-ref"/);
  assert.match(html, />related task<\/a>/);
  assert.doesNotMatch(html, /Hidden card/);
  console.log("pdf-export.test.js passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
