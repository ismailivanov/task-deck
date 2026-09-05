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
  let draftSaves = 0;
  const plugin = {
    data: { cards: {}, labels: [], detailsDrafts: {} },
    editingCardId: "card-1",
    async updateCard(id, patch) { updates.push({ id, patch }); },
    async saveData() { draftSaves += 1; },
    async hydrateCardFromFile() {},
  };
  const modal = new CardModal({}, plugin, "card-1");
  modal.card = { id: "card-1", title: "Card", details: "old" };
  modal.localTitle = "Card";
  modal.localDetails = "old";
  modal.detailsDraft = "unsaved draft";
  modal.editingDetails = true;
  assert.strictEqual(modal.cardPatch().details, "old");

  modal.onClose();
  await modal.draftSavePromise;

  assert.strictEqual(updates.length, 0);
  assert.strictEqual(plugin.data.detailsDrafts["card-1"], "unsaved draft");
  assert.strictEqual(draftSaves, 1);

  plugin.data.cards["card-1"] = modal.card;
  const resumed = new CardModal({}, plugin, "card-1");
  resumed.setupCardLock = async () => {};
  resumed.render = () => {};
  await resumed.load();
  assert.strictEqual(resumed.editingDetails, true);
  assert.strictEqual(resumed.detailsDraft, "unsaved draft");
  await resumed.clearDetailsDraft();
  assert.strictEqual(Object.prototype.hasOwnProperty.call(plugin.data.detailsDrafts, "card-1"), false);
  console.log("card-modal-close.test.js passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
