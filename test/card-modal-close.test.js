const assert = require("assert");
const Module = require("module");

class Modal {
  constructor(app) {
    this.app = app;
    this.contentEl = { replaceChildren() {} };
  }
}

const obsidian = {
  Modal,
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

global.window = { clearInterval() {}, clearTimeout() {} };
const { CardModal } = require("../src/modals");
Module._load = originalLoad;

(async () => {
  const updates = [];
  const plugin = {
    data: { cards: {}, labels: [] },
    editingCardId: "card-1",
    async updateCard(id, patch) { updates.push({ id, patch }); },
  };
  const modal = new CardModal({}, plugin, "card-1");
  modal.card = { id: "card-1", title: "Card", details: "old" };
  modal.localTitle = "Card";
  modal.localDetails = "old";
  modal.detailsDraft = "unsaved draft";
  modal.editingDetails = true;

  modal.onClose();
  await modal.savePromise;

  assert.strictEqual(updates.length, 1);
  assert.strictEqual(updates[0].patch.details, "unsaved draft");
  console.log("card-modal-close.test.js passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
