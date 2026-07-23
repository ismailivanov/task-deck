const { uid, cleanColor, cleanDate } = require("./helpers");
const { snapshotBaseline, signatureOfLabels } = require("./conflict");

// Nextcloud Deck ↔ local board model translators.
//
// Everything here is a pure function so it can be exercised by node's own
// assert module without spinning up Obsidian. The sync manager is the only
// caller; the plugin talks to that instead of poking these helpers directly.

/** Convert Deck's #rrggbb-ish "0082c9" into our "#0082c9" convention. */
function decodeDeckColor(raw) {
  if (!raw) return "";
  const trimmed = String(raw).trim();
  if (!trimmed) return "";
  const withHash = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
  return cleanColor(withHash) || "";
}

/** Convert Deck's ISO 8601 duedate string into our YYYY-MM-DD storage form. */
function decodeDeckDate(raw) {
  if (!raw) return null;
  // Deck emits "2026-07-15T00:00:00+00:00"; cleanDate already tolerates that.
  return cleanDate(String(raw).slice(0, 10));
}

// Deck stores everything in `description` — there is no separate checklist
// field. We embed our local checklist as a fenced "## Checklist" section at
// the end of the description so it survives round-trips through Deck's
// Markdown renderer without being reinterpreted as inline bullets.
//
// splitDescriptionWithChecklist(text) -> { details, checklist }
// mergeDetailsAndChecklist({ details, checklist }) -> string

const CHECKLIST_HEADING_RE = /^\s*#{1,6}\s*(?:checklist|待办|清单)\s*$/im;

function splitDescriptionWithChecklist(text) {
  const raw = typeof text === "string" ? text : "";
  const match = raw.match(CHECKLIST_HEADING_RE);
  if (!match) return { details: raw, checklist: [] };

  const headingIndex = match.index;
  const details = raw.slice(0, headingIndex).replace(/\s+$/g, "");
  const rest = raw.slice(headingIndex + match[0].length).replace(/^\r?\n/, "");
  const checklist = [];
  const lines = rest.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) { if (!checklist.length) continue; else break; }
    const m = trimmed.match(/^-\s*\[([ xX])\]\s*(.*)$/);
    if (m) {
      const cleaned = m[2].replace(/\s*<!--@.*?-->\s*$/, "").trim();
      if (cleaned) checklist.push({ done: m[1].toLowerCase() === "x", text: cleaned });
      continue;
    }
    // Stop at the first non-checklist, non-empty line so we don't slurp
    // unrelated content that happens to sit under the heading.
    break;
  }
  return { details, checklist };
}

function mergeDetailsAndChecklist(details, checklist) {
  const base = typeof details === "string" ? details.replace(/\s+$/g, "") : "";
  const items = Array.isArray(checklist) ? checklist : [];
  if (!items.length) return base;
  const rendered = items.map((item) => `- [${item && item.done ? "x" : " "}] ${String((item && item.text) || "").trim()}`).join("\n");
  return `${base ? `${base}\n\n` : ""}## Checklist\n${rendered}`;
}

/**
 * Convert a remote card payload into the local card shape. Assignees are
 * preserved as-is (uid + display name) so future team support can round-trip
 * cleanly, but the MVP UI won't render them.
 */
function remoteCardToLocal(remoteCard, { boardId, listId }) {
  if (!remoteCard) return null;
  const labels = Array.isArray(remoteCard.labels)
    ? remoteCard.labels.map((label) => ({
        // Preserve the server-side id so pushBoardLabels can round-trip
        // additions/removals through assignLabel / removeLabel. Without
        // this, a local edit had no way to reference the label back on
        // Nextcloud and label sync silently no-op'd.
        remoteId: label && label.id != null ? Number(label.id) : null,
        name: String(label.title || "").trim(),
        color: decodeDeckColor(label.color) || "#d43c35",
      })).filter((label) => label.name)
    : [];

  const assignees = Array.isArray(remoteCard.assignedUsers)
    ? remoteCard.assignedUsers
        .map((entry) => {
          const p = entry && entry.participant ? entry.participant : entry;
          if (!p) return null;
          return {
            email: p.email || p.primaryKey || p.uid || "",
            name: p.displayname || p.uid || "",
            color: "#8b5cf6",
          };
        })
        .filter((a) => a && a.email)
    : [];

  const card = {
    id: uid("card"),
    remoteId: remoteCard.id ?? null,
    etag: remoteCard.ETag || null,
    remoteUpdatedAt: remoteCard.lastModified || 0,
    baseline: null, // filled in below after we know the final field values
    localDirty: false,
    boardId,
    listId,
    title: String(remoteCard.title || "").trim() || "Untitled card",
    details: typeof remoteCard.description === "string" ? remoteCard.description : "",
    labels,
    assignees,
    checklist: [],
    completed: !!remoteCard.done, // Deck cards may carry `done` when archived; treat as complete for UX parity
    startDate: null,
    dueDate: decodeDeckDate(remoteCard.duedate),
    filePath: "", // assigned when the note is written to the vault
    position: typeof remoteCard.order === "number" ? remoteCard.order : null,
  };
  // Deck has no first-class checklist; extract our "## Checklist" section
  // from the description if present, and strip it from `details` so both
  // sides don't render it twice.
  const split = splitDescriptionWithChecklist(card.details);
  card.details = split.details;
  card.checklist = split.checklist;
  card.baseline = snapshotBaseline(card);
  return card;
}

/**
 * Merge a freshly pulled remote card onto an existing local card. Fields the
 * user hasn't touched locally (`localDirty === false`) are overwritten; the
 * local id and file path are preserved so vault notes don't churn.
 */
function mergeRemoteCardOntoLocal(existing, remoteCard, { boardId, listId }) {
  const remote = remoteCardToLocal(remoteCard, { boardId, listId });
  if (!existing) return remote;

  const merged = { ...existing };
  merged.remoteId = remote.remoteId;
  merged.etag = remote.etag;
  merged.remoteUpdatedAt = remote.remoteUpdatedAt;
  merged.listId = remote.listId;
  merged.boardId = remote.boardId;
  merged.position = remote.position;

  // Only overwrite user-editable fields when the local copy has no unsynced
  // changes. Field-level three-way merges live in sync-manager (M3+) which
  // will hand us a resolved card before it calls this. For the vanilla
  // "nothing local changed" case, remote wins wholesale.
  if (!existing.localDirty) {
    merged.title = remote.title;
    merged.details = remote.details;
    merged.checklist = remote.checklist;
    merged.labels = remote.labels;
    merged.assignees = remote.assignees;
    merged.completed = remote.completed;
    merged.dueDate = remote.dueDate;
    merged.startDate = remote.startDate;
  } else {
    // Local is dirty on *something* (title/details/etc.) but that doesn't
    // mean labels are dirty. Deck's REST API doesn't return an assignedAt
    // per label, so we approximate with a signature diff against the last
    // baseline: if local labels still match the baseline signature, the
    // user didn't touch them locally and the remote change wins. This is
    // what fixes the "webui-changed label reverts on next sync" bug: pre-
    // pre.20 we kept the stale local list wholesale whenever *any* local
    // field was dirty, then pushCardLabels would re-assign the stale set
    // and unassign whatever the webui had put on the card.
    const baseSig = existing.baseline && existing.baseline.labelsSignature;
    const localSig = signatureOfLabels(existing.labels);
    if (baseSig != null && localSig === baseSig) {
      merged.labels = remote.labels;
    }
  }
  // Baseline always tracks the *remote* view so the next push has an accurate
  // starting point for 3-way diffs.
  merged.baseline = remote.baseline;
  return merged;
}

/**
 * Build the JSON payload for `PUT /boards/{bid}/stacks/{sid}/cards/{cid}`.
 * Deck requires `title`, `type`, and `owner`; we omit fields we don't manage
 * (checklist etc.) so the server's canonical shape wins for them.
 */
function localCardToDeckPatch(card, { owner } = {}) {
  const payload = {
    title: card.title || "Untitled card",
    type: "plain",
    // Merge our checklist back into the description so Deck's UI + this
    // plugin see the same text. Round-trips cleanly because
    // splitDescriptionWithChecklist reverses this on pull.
    description: mergeDetailsAndChecklist(card.details || "", card.checklist),
    order: typeof card.position === "number" ? card.position : 0,
    duedate: card.dueDate ? new Date(`${card.dueDate}T00:00:00Z`).toISOString() : null,
  };
  if (owner) payload.owner = owner;
  return payload;
}

/** Body for the initial `POST /cards` call. Same shape as the update payload. */
function localCardToDeckCreate(card, opts) {
  return localCardToDeckPatch(card, opts);
}

/**
 * Build a fresh local board shape from a remote board + its stacks. Cards live
 * separately in the plugin's `data.cards` map, so this helper only returns the
 * board skeleton; the sync manager stitches cards in afterwards.
 */
/**
 * Convert Deck board-level label objects to the shape we cache on the local
 * board. Retaining the remoteId is what lets pushBoardLabels resolve a
 * local label back to its server-side counterpart when calling
 * assignLabel / removeLabel.
 */
function remoteLabelsToLocal(remoteLabels) {
  return (Array.isArray(remoteLabels) ? remoteLabels : [])
    .map((label) => ({
      remoteId: label && label.id != null ? Number(label.id) : null,
      title: String((label && label.title) || "").trim(),
      color: decodeDeckColor(label && label.color) || "#d43c35",
    }))
    .filter((label) => label.remoteId != null && label.title);
}

function remoteBoardToLocal(remoteBoard, remoteStacks, { boardId, folderPath }) {
  const color = decodeDeckColor(remoteBoard.color);
  const lists = (remoteStacks || [])
    .slice()
    .sort((a, b) => (a.order || 0) - (b.order || 0))
    .map((stack) => ({
      id: uid("list"),
      remoteId: stack.id,
      title: String(stack.title || "").trim() || "List",
      color: color || "",
      cardIds: [],
    }));

  return {
    id: boardId || uid("board"),
    remoteId: remoteBoard.id,
    etag: remoteBoard.ETag || null,
    name: String(remoteBoard.title || "").trim() || "Board",
    folderPath: folderPath || "",
    lists,
    // Board-level catalog of labels defined on Deck. Distinct from
    // per-card `card.labels` which are resolved against this catalog when
    // pushing.
    labels: remoteLabelsToLocal(remoteBoard.labels),
    deletedListIds: [],
  };
}

/**
 * Given an existing local board and a fresh remote board + stacks, return an
 * updated board (immutable style). Stacks are keyed by `remoteId` so a rename
 * on Nextcloud doesn't rip the list apart.
 */
function reconcileBoardStructure(existingBoard, remoteBoard, remoteStacks) {
  const color = decodeDeckColor(remoteBoard.color);
  const known = new Map();
  (existingBoard.lists || []).forEach((list) => {
    if (list && list.remoteId != null) known.set(list.remoteId, list);
  });

  const nextLists = (remoteStacks || [])
    .slice()
    .sort((a, b) => (a.order || 0) - (b.order || 0))
    .map((stack) => {
      const prior = known.get(stack.id);
      if (prior) {
        return {
          ...prior,
          title: String(stack.title || "").trim() || prior.title,
          color: prior.color || color || "",
        };
      }
      return {
        id: uid("list"),
        remoteId: stack.id,
        title: String(stack.title || "").trim() || "List",
        color: color || "",
        cardIds: [],
      };
    });

  return {
    ...existingBoard,
    remoteId: remoteBoard.id,
    etag: remoteBoard.ETag || existingBoard.etag || null,
    name: String(remoteBoard.title || "").trim() || existingBoard.name,
    lists: nextLists,
    // Refresh the label catalog on every pull so renamed/recolored/added
    // labels flow through. We keep the same shape used by remoteBoardToLocal
    // (see remoteLabelsToLocal). Cards reference these by remoteId.
    labels: remoteLabelsToLocal(remoteBoard.labels),
  };
}

/** Utility used by tests: card is considered "remotely tracked" iff it has a numeric remoteId. */
function isRemoteTracked(card) {
  return !!(card && card.remoteId != null);
}

/**
 * Translate a card description from Obsidian's `![[…]]` embed syntax into
 * the shape Deck's Markdown renderer actually understands: an inline
 * `[caption](https://<server>/f/<fileid> (preview))` markdown link. Deck's
 * renderer specifically looks for the trailing `(preview)` title to swap
 * the link for a thumbnail image.
 *
 * Matches are resolved by looking up the wikilink target in
 * `card.attachments[]` (compared by both filePath and basename to be
 * tolerant of authoring quirks) and using its `fileid` from
 * `extendedData.fileid`. Anything we can't resolve — outbound URLs,
 * references to unsynced files — is left untouched. Never mutate user
 * content on ambiguous matches; a wrong replacement is worse than an
 * unresolved wikilink.
 */
function localDescriptionToDeck(description, card, { serverUrl } = {}) {
  if (typeof description !== "string" || !description) return description;
  if (!card || !Array.isArray(card.attachments) || !card.attachments.length) return description;
  if (!serverUrl) return description;
  const server = String(serverUrl).replace(/\/+$/, "");
  const byPath = new Map();
  const byBase = new Map();
  for (const att of card.attachments) {
    if (!att || att.fileid == null) continue;
    if (att.filePath) byPath.set(att.filePath, att);
    if (att.filename) {
      const key = String(att.filename).toLowerCase();
      // Only remember the first match on basename — multiple attachments
      // sharing a filename should be resolved by full path anyway.
      if (!byBase.has(key)) byBase.set(key, att);
    }
  }
  return description.replace(/(!?)\[\[([^\]\n]+)\]\]/g, (raw, bang, inner) => {
    const parts = String(inner).split("|");
    const target = parts[0].trim();
    if (!target) return raw;
    // Skip absolute URLs — those are external images, not Deck attachments.
    if (/^https?:\/\//i.test(target)) return raw;
    const alias = (parts[1] || "").trim();
    const att = byPath.get(target) || byBase.get(target.split("/").pop().toLowerCase());
    if (!att) return raw;
    const caption = alias || att.filename || target.split("/").pop();
    return `[${caption}](${server}/f/${att.fileid} (preview))`;
  });
}

/**
 * Inverse of localDescriptionToDeck: turn Deck's inline attachment links
 * back into Obsidian wikilinks so the Markdown renders inline in Obsidian.
 * Recognises exactly the shape Deck writes — `[caption](server/f/<id>
 * (preview))` — and looks the `fileid` up in `card.attachments[]` to get
 * the vault-relative path. Non-matching links are preserved verbatim.
 */
function deckDescriptionToLocal(description, card, { serverUrl } = {}) {
  if (typeof description !== "string" || !description) return description;
  if (!card || !Array.isArray(card.attachments) || !card.attachments.length) return description;
  if (!serverUrl) return description;
  const server = String(serverUrl).replace(/\/+$/, "");
  const byFileId = new Map();
  for (const att of card.attachments) {
    if (att && att.fileid != null && att.filePath) byFileId.set(Number(att.fileid), att);
  }
  if (!byFileId.size) return description;
  // Pattern: [caption](<url> (preview)) — Deck may or may not include the
  // leading `!`; we accept either. Server prefix must match exactly to
  // avoid mistakenly rewriting a link to a different Nextcloud instance.
  const re = /!?\[([^\]\n]*)\]\((\S+?)\s*\(preview\)\)/g;
  return description.replace(re, (raw, caption, url) => {
    const trimmed = url.trim();
    if (!trimmed.startsWith(`${server}/f/`)) return raw;
    const fileidStr = trimmed.slice(`${server}/f/`.length).replace(/[/?#].*$/, "");
    const fileid = Number(fileidStr);
    if (!Number.isFinite(fileid)) return raw;
    const att = byFileId.get(fileid);
    if (!att) return raw;
    return `![[${att.filePath}]]`;
  });
}

module.exports = {
  decodeDeckColor,
  decodeDeckDate,
  splitDescriptionWithChecklist,
  mergeDetailsAndChecklist,
  remoteCardToLocal,
  mergeRemoteCardOntoLocal,
  localCardToDeckPatch,
  localCardToDeckCreate,
  remoteBoardToLocal,
  reconcileBoardStructure,
  remoteLabelsToLocal,
  localDescriptionToDeck,
  deckDescriptionToLocal,
  isRemoteTracked,
};