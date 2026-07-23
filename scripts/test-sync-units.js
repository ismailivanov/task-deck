#!/usr/bin/env node
/* eslint-disable no-console */

// Unit tests for pure sync helpers. Uses only Node's built-in `assert` — no
// jest, no mocha, no external deps. Run with:
//
//   node scripts/test-sync-units.js
//
// Covers:
//   - conflict.detectFieldConflicts / applyPolicy / snapshotBaseline
//   - sync-mapper: remoteCardToLocal, mergeRemoteCardOntoLocal,
//     localCardToDeckPatch, reconcileBoardStructure, decodeDeckDate

const assert = require("assert");

// Shim window.btoa which is used by dependent modules on load-time. helpers.js
// pulls in obsidian's setIcon but only invokes it at runtime, so a lazy stub
// keeps require() honest.
global.window = global.window || {};
global.window.btoa = global.window.btoa || ((str) => Buffer.from(str, "binary").toString("base64"));
global.window.setTimeout = global.window.setTimeout || setTimeout;

// Obsidian is not available in Node; provide the tiny surface our pure modules
// touch during require().
require.cache[require.resolve("../src/helpers.js")] = require.cache[require.resolve("../src/helpers.js")] || undefined;
const Module = require("module");
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, parent, ...rest) {
  if (request === "obsidian") return require.resolve("./__obsidian-stub.js");
  return originalResolve.call(this, request, parent, ...rest);
};

// Register a minimal obsidian stub so helpers can import setIcon without
// blowing up. We only use pure exports so runtime side effects never fire.
const stubPath = require("path").join(__dirname, "__obsidian-stub.js");
if (!require("fs").existsSync(stubPath)) {
  require("fs").writeFileSync(stubPath, "module.exports = { setIcon: () => {}, Modal: class {}, Notice: class {}, PluginSettingTab: class {}, Setting: class {}, MarkdownRenderer: {}, requestUrl: async () => ({ status: 0 }), normalizePath: (p) => p, Plugin: class {}, addIcon: () => {} };\n");
}

const conflict = require("../src/conflict");
const mapper = require("../src/sync-mapper");

let passed = 0;
function test(name, fn) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); }
  catch (error) { console.error(`  FAIL ${name}`); console.error(error); process.exit(1); }
}

console.log("conflict");

test("detectFieldConflicts: local-only change auto-applies local", () => {
  const base = { title: "A", details: "", completed: false, dueDate: "", startDate: "" };
  const r = conflict.detectFieldConflicts(base, { ...base, title: "B" }, { ...base });
  assert.strictEqual(r.autoApplied.title, "B");
  assert.strictEqual(r.conflicts.length, 0);
});

test("detectFieldConflicts: remote-only change auto-applies remote", () => {
  const base = { title: "A", details: "", completed: false, dueDate: "", startDate: "" };
  const r = conflict.detectFieldConflicts(base, { ...base }, { ...base, title: "C" });
  assert.strictEqual(r.autoApplied.title, "C");
});

test("detectFieldConflicts: both changed => conflict entry", () => {
  const base = { title: "A", details: "", completed: false, dueDate: "", startDate: "" };
  const r = conflict.detectFieldConflicts(base, { ...base, title: "X" }, { ...base, title: "Y" });
  assert.strictEqual(r.autoApplied.title, undefined);
  assert.strictEqual(r.conflicts.length, 1);
  assert.strictEqual(r.conflicts[0].field, "title");
});

test("applyPolicy respects local / remote / prompt / newer-wins", () => {
  const entry = { field: "title", base: "A", local: "X", remote: "Y" };

  assert.strictEqual(conflict.applyPolicy("local", [entry]).resolved.title, "X");
  assert.strictEqual(conflict.applyPolicy("remote", [entry]).resolved.title, "Y");

  const prompt = conflict.applyPolicy("prompt", [entry]);
  assert.strictEqual(prompt.stillOpen.length, 1);

  const newerRemote = conflict.applyPolicy("newer-wins", [entry], { localUpdatedAt: 1, remoteUpdatedAt: 2 });
  assert.strictEqual(newerRemote.resolved.title, "Y");
  const newerLocal = conflict.applyPolicy("newer-wins", [entry], { localUpdatedAt: 3, remoteUpdatedAt: 2 });
  assert.strictEqual(newerLocal.resolved.title, "X");
});

test("snapshotBaseline emits stable label signature", () => {
  const snap = conflict.snapshotBaseline({
    title: "t", details: "d", completed: true, dueDate: "2026-01-01", startDate: "",
    labels: [{ name: "b", color: "#000" }, { name: "a", color: "#fff" }],
  });
  assert.strictEqual(snap.title, "t");
  assert.strictEqual(snap.completed, true);
  assert.ok(snap.labelsSignature.startsWith("a|"), "labels sorted alphabetically");
});

console.log("sync-mapper");

test("decodeDeckDate strips ISO time component", () => {
  assert.strictEqual(mapper.decodeDeckDate("2026-07-15T12:00:00+00:00"), "2026-07-15");
  assert.strictEqual(mapper.decodeDeckDate(""), null);
  assert.strictEqual(mapper.decodeDeckDate(null), null);
});

test("decodeDeckColor normalises to a #rrggbb hex string", () => {
  assert.strictEqual(mapper.decodeDeckColor("0082c9"), "#0082c9");
  // cleanColor preserves the input case; we just need `#` prefix and 6 hex chars.
  assert.strictEqual(mapper.decodeDeckColor("#FF0000").toLowerCase(), "#ff0000");
  assert.strictEqual(mapper.decodeDeckColor(""), "");
});

test("remoteCardToLocal populates baseline and preserves description", () => {
  const local = mapper.remoteCardToLocal({
    id: 42,
    title: "Card X",
    description: "hello **world**",
    order: 3,
    duedate: "2026-07-15T00:00:00+00:00",
    labels: [{ title: "Urgent", color: "ff0000" }],
    ETag: "etag-1",
    lastModified: 1_700_000_000,
  }, { boardId: "board-1", listId: "list-1" });

  assert.strictEqual(local.remoteId, 42);
  assert.strictEqual(local.title, "Card X");
  assert.strictEqual(local.details, "hello **world**");
  assert.strictEqual(local.dueDate, "2026-07-15");
  assert.strictEqual(local.labels.length, 1);
  assert.strictEqual(local.labels[0].name, "Urgent");
  assert.strictEqual(local.etag, "etag-1");
  assert.ok(local.baseline);
  assert.strictEqual(local.baseline.title, "Card X");
});

test("mergeRemoteCardOntoLocal preserves local changes when localDirty", () => {
  const existing = {
    id: "card-local", remoteId: 42, title: "Local title", details: "local details",
    labels: [], completed: false, dueDate: null, startDate: null, localDirty: true, baseline: null,
  };
  const merged = mapper.mergeRemoteCardOntoLocal(existing, {
    id: 42, title: "Remote title", description: "remote details",
    labels: [], ETag: "etag-2", lastModified: 999,
  }, { boardId: "board-1", listId: "list-2" });

  assert.strictEqual(merged.title, "Local title", "local dirty preserves local title");
  assert.strictEqual(merged.details, "local details");
  assert.strictEqual(merged.remoteId, 42);
  assert.strictEqual(merged.listId, "list-2");
  assert.ok(merged.baseline, "baseline is refreshed to remote view");
  assert.strictEqual(merged.baseline.title, "Remote title");
});

test("localCardToDeckPatch emits ISO duedate for local YYYY-MM-DD", () => {
  const patch = mapper.localCardToDeckPatch({
    title: "T", details: "D", dueDate: "2026-08-01", position: 4,
  });
  assert.strictEqual(patch.title, "T");
  assert.strictEqual(patch.description, "D");
  assert.strictEqual(patch.order, 4);
  assert.ok(String(patch.duedate).startsWith("2026-08-01T00:00:00"), "ISO duedate emitted");
});

test("reconcileBoardStructure keeps existing lists by remoteId even after rename", () => {
  const existing = {
    id: "board-1", remoteId: 99, name: "Old name", folderPath: "Boards/Old",
    lists: [{ id: "list-a", remoteId: 10, title: "Backlog", cardIds: ["c1"] }],
  };
  const remote = { id: 99, title: "New name" };
  const stacks = [{ id: 10, title: "Backlog v2", order: 0 }];
  const next = mapper.reconcileBoardStructure(existing, remote, stacks);
  assert.strictEqual(next.name, "New name");
  assert.strictEqual(next.lists.length, 1);
  assert.strictEqual(next.lists[0].id, "list-a", "list id preserved");
  assert.strictEqual(next.lists[0].title, "Backlog v2");
  assert.deepStrictEqual(next.lists[0].cardIds, ["c1"], "card assignments untouched by structure reconcile");
});

test("splitDescriptionWithChecklist extracts checklist from description tail", () => {
  const raw = "hello\n\n## Checklist\n- [ ] first\n- [x] second";
  const out = mapper.splitDescriptionWithChecklist(raw);
  assert.strictEqual(out.details, "hello");
  assert.deepStrictEqual(out.checklist, [
    { done: false, text: "first" },
    { done: true, text: "second" },
  ]);
});

test("splitDescriptionWithChecklist returns empty checklist when no heading", () => {
  const out = mapper.splitDescriptionWithChecklist("body without a checklist");
  assert.deepStrictEqual(out.checklist, []);
  assert.strictEqual(out.details, "body without a checklist");
});

test("mergeDetailsAndChecklist round-trips through split", () => {
  const merged = mapper.mergeDetailsAndChecklist("body", [{ done: false, text: "a" }, { done: true, text: "b" }]);
  assert.ok(merged.includes("## Checklist"));
  const split = mapper.splitDescriptionWithChecklist(merged);
  assert.strictEqual(split.details, "body");
  assert.deepStrictEqual(split.checklist, [
    { done: false, text: "a" },
    { done: true, text: "b" },
  ]);
});

test("remoteCardToLocal moves description checklist into card.checklist", () => {
  const local = mapper.remoteCardToLocal({
    id: 7, title: "T", description: "hi\n\n## Checklist\n- [ ] test\n- [ ] 222test",
    ETag: "e", lastModified: 1,
  }, { boardId: "b", listId: "l" });
  assert.strictEqual(local.details, "hi");
  assert.strictEqual(local.checklist.length, 2);
  assert.strictEqual(local.checklist[0].text, "test");
  assert.strictEqual(local.checklist[1].text, "222test");
});

test("localCardToDeckPatch embeds checklist inside description", () => {
  const patch = mapper.localCardToDeckPatch({
    title: "T", details: "hi", checklist: [{ done: false, text: "a" }, { done: true, text: "b" }],
  });
  assert.ok(patch.description.includes("## Checklist"));
  assert.ok(patch.description.includes("- [ ] a"));
  assert.ok(patch.description.includes("- [x] b"));
});

// ---- Attachment link rewrite (image handling in card description) --------
//
// Local wikilinks must become Deck's `(preview)` markdown links on push
// and revert on pull. External URLs and unresolved paths are left alone.

const SERVER = "https://nc.example.com";
const cardWithAttachments = {
  attachments: [
    { fileid: 5210, filename: "foo.png", filePath: "Deck/Welcome/attachments/card-1/foo.png" },
    { fileid: 5211, filename: "bar.jpg", filePath: "Deck/Welcome/attachments/card-1/bar.jpg" },
  ],
};

test("localDescriptionToDeck rewrites matching wikilink to preview link", () => {
  const input = "before ![[Deck/Welcome/attachments/card-1/foo.png]] after";
  const out = mapper.localDescriptionToDeck(input, cardWithAttachments, { serverUrl: SERVER });
  assert.strictEqual(out, `before [foo.png](${SERVER}/f/5210 (preview)) after`);
});

test("localDescriptionToDeck leaves external URLs untouched", () => {
  const input = "hello ![[https://cdn.example.com/logo.png]] world";
  const out = mapper.localDescriptionToDeck(input, cardWithAttachments, { serverUrl: SERVER });
  assert.strictEqual(out, input);
});

test("localDescriptionToDeck leaves unresolved wikilinks untouched", () => {
  const input = "x ![[not-in-list.png]] y";
  const out = mapper.localDescriptionToDeck(input, cardWithAttachments, { serverUrl: SERVER });
  assert.strictEqual(out, input);
});

test("localDescriptionToDeck matches by basename fallback", () => {
  const input = "just ![[foo.png]] here";
  const out = mapper.localDescriptionToDeck(input, cardWithAttachments, { serverUrl: SERVER });
  assert.strictEqual(out, `just [foo.png](${SERVER}/f/5210 (preview)) here`);
});

test("deckDescriptionToLocal rewrites matching preview link to wikilink", () => {
  const input = `pre [foo.png](${SERVER}/f/5210 (preview)) post`;
  const out = mapper.deckDescriptionToLocal(input, cardWithAttachments, { serverUrl: SERVER });
  assert.strictEqual(out, "pre ![[Deck/Welcome/attachments/card-1/foo.png]] post");
});

test("deckDescriptionToLocal leaves non-preview markdown links untouched", () => {
  const input = `see [docs](${SERVER}/index.php/apps/wiki) for details`;
  const out = mapper.deckDescriptionToLocal(input, cardWithAttachments, { serverUrl: SERVER });
  assert.strictEqual(out, input);
});

test("deckDescriptionToLocal ignores links pointing to a different server", () => {
  const input = "keep [foo.png](https://other.host/f/5210 (preview))";
  const out = mapper.deckDescriptionToLocal(input, cardWithAttachments, { serverUrl: SERVER });
  assert.strictEqual(out, input);
});

test("push+pull round-trip preserves the source string", () => {
  const original = "look ![[Deck/Welcome/attachments/card-1/foo.png]] here";
  const roundtripped = mapper.deckDescriptionToLocal(
    mapper.localDescriptionToDeck(original, cardWithAttachments, { serverUrl: SERVER }),
    cardWithAttachments,
    { serverUrl: SERVER },
  );
  assert.strictEqual(roundtripped, original);
});

// ---- Label merge on dirty card ------------------------------------------
//
// Regression: pre-pre.20 kept the stale local labels wholesale whenever
// any local field was dirty, causing webui-side label changes to revert
// on next sync. Now the merge does a signature diff against baseline.

test("mergeRemoteCardOntoLocal adopts remote labels when local labels match baseline (even if card is dirty)", () => {
  const baseLabels = [{ name: "Old", color: "#111111" }];
  const existing = {
    id: "card-1",
    remoteId: 11,
    localDirty: true, // title changed locally, say
    title: "Local title",
    labels: [{ name: "Old", color: "#111111" }],
    baseline: { title: "Original", labelsSignature: mapper.__signatureOfLabels
      ? mapper.__signatureOfLabels(baseLabels)
      : "old|#111111",
    },
  };
  const remoteCard = {
    id: 11,
    title: "Original",
    description: "",
    labels: [{ id: 5, title: "New", color: "d43c35" }],
    stackId: 1,
  };
  const merged = mapper.mergeRemoteCardOntoLocal(existing, remoteCard, { boardId: "b", listId: "l" });
  // labels should be replaced with remote since local didn't diverge
  assert.strictEqual(merged.labels.length, 1);
  assert.strictEqual(merged.labels[0].name, "New");
  // title stays local because it IS dirty relative to baseline
  assert.strictEqual(merged.title, "Local title");
});

test("mergeRemoteCardOntoLocal preserves local labels when they diverge from baseline", () => {
  const existing = {
    id: "card-1",
    remoteId: 11,
    localDirty: true,
    title: "T",
    labels: [{ name: "LocalOnly", color: "#222222" }],
    baseline: { title: "T", labelsSignature: "originalonly|#111111" },
  };
  const remoteCard = {
    id: 11,
    title: "T",
    description: "",
    labels: [{ id: 5, title: "RemoteOnly", color: "d43c35" }],
    stackId: 1,
  };
  const merged = mapper.mergeRemoteCardOntoLocal(existing, remoteCard, { boardId: "b", listId: "l" });
  assert.strictEqual(merged.labels[0].name, "LocalOnly");
});

console.log(`\n${passed} tests passed.`);
