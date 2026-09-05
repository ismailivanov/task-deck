const assert = require("assert");
const Module = require("module");

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === "obsidian") return { setIcon() {} };
  return originalLoad.call(this, request, parent, isMain);
};

const { DEFAULT_LABEL_COLOR, cardReferenceMarkup, suggestedLabelColor } = require("../src/helpers");
Module._load = originalLoad;

assert.strictEqual(suggestedLabelColor("Bug"), "#be332b");
assert.strictEqual(suggestedLabelColor("Kritik"), "#f46b66");
assert.strictEqual(suggestedLabelColor("Özellik"), "#247b55");
assert.strictEqual(suggestedLabelColor("Customer"), DEFAULT_LABEL_COLOR);
assert.strictEqual(
  cardReferenceMarkup({ title: "Fix login", filePath: "Sprint/Fix login.md" }, "this issue"),
  "[[Sprint/Fix login|this issue]]"
);

console.log("helpers.test.js passed");
