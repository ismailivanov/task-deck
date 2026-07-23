const {
  remoteBoardToLocal,
  reconcileBoardStructure,
  mergeRemoteCardOntoLocal,
  localCardToDeckPatch,
  localCardToDeckCreate,
  remoteCardToLocal,
  localDescriptionToDeck,
  deckDescriptionToLocal,
} = require("./sync-mapper");
const { DeckApiError } = require("./deck-client");
const { detectFieldConflicts, applyPolicy, snapshotBaseline } = require("./conflict");
const { ConflictModal } = require("./conflict-modal");
const { AttachmentSyncer } = require("./attachment-sync");
const { labelKey } = require("./helpers");

// Coordinates two-way sync with Nextcloud Deck.
//
// `runSync` executes three phases in a single "tick":
//   1. Pull:  fetch remote state, reconcile boards/stacks, merge remote cards
//             onto local ones (respecting `localDirty`).
//   2. Push:  for every dirty local card, compute a 3-way field diff against
//             the freshly pulled remote and either auto-apply or prompt the
//             user based on the configured conflict policy.
//   3. Reap:  drain the pending deletions queue.
//
// The manager coalesces concurrent triggers (`this.running`) so a manual
// button press during a scheduled tick is a no-op.

const STATUS_IDLE = "idle";
const STATUS_RUNNING = "running";
const STATUS_ERROR = "error";
const STATUS_OK = "ok";

class SyncManager {
  constructor(plugin) {
    this.plugin = plugin;
    this.status = { state: STATUS_IDLE, at: 0, message: "" };
    this.running = null;
    this.attachments = new AttachmentSyncer(plugin);
  }

  getStatus() { return this.status; }

  async runPull({ manual = false } = {}) {
    return this.runSync({ manual });
  }

  async runSync({ manual = false } = {}) {
    if (this.running) return this.running;
    this.running = this.syncOnce({ manual }).finally(() => { this.running = null; });
    return this.running;
  }

  async syncOnce({ manual }) {
    const client = await this.plugin.getDeckClient();
    if (!client) {
      this.status = { state: STATUS_ERROR, at: Date.now(), message: "Nextcloud is not connected." };
      return this.status;
    }
    this.status = { state: STATUS_RUNNING, at: Date.now(), message: manual ? "Syncing…" : "Background sync…" };

    try {
      // ---- Phase 1: Pull ----------------------------------------------------
      const { data: remoteBoards } = await client.getBoards();
      if (!Array.isArray(remoteBoards)) throw new Error("Unexpected boards response.");
      this.plugin.debugLog({
        event: "sync.pull.boards",
        count: remoteBoards.length,
        // Emit our own view of local state at sync start so we can diagnose
        // "phantom boards multiplying". Users report empty boards appearing
        // after every sync; log2.json alone can't disambiguate whether
        // they were already in data.boards or created by this sync. This
        // gives us a before-vs-after picture per sync.
        localBoards: this.plugin.data.boards.length,
        bindings: Object.keys(this.plugin.data.nextcloud.boardBindings || {}).length,
      });

      const bindings = this.getBindings();
      const boardMap = new Map(this.plugin.data.boards.map((board) => [board.id, board]));
      const boundLocalIds = new Set();
      const boardContext = new Map(); // localBoardId -> { remoteBoard, remoteStacks }

      for (const remoteBoard of remoteBoards) {
        const localBoardId = this.findOrBindLocalBoard(remoteBoard, bindings, boardMap);
        boundLocalIds.add(localBoardId);
        const remoteStacks = await this.pullBoard(client, remoteBoard, localBoardId);
        boardContext.set(localBoardId, { remoteBoard, remoteStacks });
        this.plugin.debugLog({
          event: "sync.pull.board-done",
          boardId: localBoardId,
          remoteId: remoteBoard.id,
          stackCount: (remoteStacks || []).length,
        });
      }

      this.plugin.data.nextcloud.boardBindings = bindings;

      // Prune stale duplicate boards. Root cause: an older/buggy code
      // path (or a partial restore from vault index files) can leave
      // data.boards with more than one entry for the same remote board
      // (same folderPath, or same remoteId, or an unbound name-clone).
      // Reported symptom: empty phantom boards multiply in the tab bar
      // after each sync. Collapsing here is safe because we do it AFTER
      // pull has already merged remote content onto the bound copies.
      this.pruneDuplicateBoards(boundLocalIds);

      // ---- Phase 2: Push ---------------------------------------------------
      let pushed = 0;
      let conflicts = 0;
      for (const [localBoardId, ctx] of boardContext.entries()) {
        const localBoard = this.plugin.data.boards.find((b) => b.id === localBoardId);
        if (!localBoard) continue;
        const result = await this.pushBoard(client, localBoard, ctx);
        pushed += result.pushed;
        conflicts += result.conflicts;
      }

      // ---- Phase 3: Reap deletions ----------------------------------------
      const reaped = await this.reapDeletions(client);
      const attachmentsReaped = await this.attachments.reap(client);

      this.plugin.data.nextcloud.lastSyncAt = Date.now();

      // Rewrite the board index files so their embedded list metadata matches
      // the in-memory board state. Root cause we're fixing: pull replaces
      // localBoard.lists wholesale with fresh uids for stacks that had no
      // matching remoteId locally. Meanwhile our own writeCardFile at the
      // end of pull triggers a vault "modify" event → queueCardFolderSync →
      // reconcileListsFromIndex reads the *old* index file's meta and
      // resurrects the previous list uids as fresh empty lists. Symptom
      // is the exact "4 lists become 8, then stay at 8" pattern the user
      // reported. Refreshing the index files here — inside the plugin's
      // `reconciling` guard so our own writes don't kick the folder-sync
      // debounce — ensures reconcileListsFromIndex is a no-op after the
      // vault event fires. Best-effort per board.
      this.plugin.reconciling = true;
      try {
        for (const localBoardId of boundLocalIds) {
          const board = this.plugin.data.boards.find((b) => b.id === localBoardId);
          if (!board) continue;
          try {
            await this.plugin.writeBoardIndexFile(board);
          } catch (error) {
            this.plugin.pushSyncLog({ event: "sync.board-index-rewrite-failed", boardId: localBoardId, message: (error && error.message) || String(error) });
          }
        }
      } finally {
        this.plugin.reconciling = false;
      }

      await this.plugin.savePluginData();
      this.plugin.refreshViews();

      const parts = [`Pulled ${remoteBoards.length} board${remoteBoards.length === 1 ? "" : "s"}`];
      if (pushed) parts.push(`pushed ${pushed} card${pushed === 1 ? "" : "s"}`);
      if (reaped) parts.push(`deleted ${reaped} remote card${reaped === 1 ? "" : "s"}`);
      if (attachmentsReaped) parts.push(`removed ${attachmentsReaped} attachment${attachmentsReaped === 1 ? "" : "s"}`);
      if (conflicts) parts.push(`${conflicts} conflict${conflicts === 1 ? "" : "s"} skipped`);

      this.status = { state: STATUS_OK, at: Date.now(), message: `${parts.join(", ")}.` };
    } catch (error) {
      const message = error instanceof DeckApiError
        ? `Deck API ${error.status || "error"}: ${error.message}`
        : (error && error.message) || String(error);
      this.status = { state: STATUS_ERROR, at: Date.now(), message };
      this.plugin.pushSyncLog({ event: "sync-failed", message });
    }
    return this.status;
  }

  // ---- Pull ---------------------------------------------------------------

  async pullBoard(client, remoteBoard, localBoardId) {
    const localBoard = this.plugin.data.boards.find((board) => board.id === localBoardId);
    // Deck's /boards list endpoint returns a slim board object without
    // the full label catalog on some deployments (Nextcloud config
    // dependent). Refetch the individual board so we always have
    // `remoteBoard.labels` populated — otherwise pushCardLabels ends up
    // trying to create labels that Deck already has, and Deck responds
    // with a duplicate-title 400.
    let hydrated = remoteBoard;
    try {
      const { data: full } = await client.getBoard(remoteBoard.id);
      if (full) hydrated = full;
    } catch (error) {
      this.plugin.pushSyncLog({ event: "board-hydrate-failed", boardId: remoteBoard.id, message: (error && error.message) || String(error) });
    }
    if (!localBoard) {
      const { data: stacks } = await client.getStacks(hydrated.id);
      const created = remoteBoardToLocal(hydrated, stacks || [], {
        boardId: localBoardId,
        folderPath: this.suggestFolder(hydrated),
      });
      this.plugin.data.boards.push(created);
      this.mergeBoardLabelsIntoGlobal(created);
      await this.pullCards(client, hydrated.id, created, stacks || []);
      return stacks || [];
    }

    const { data: stacks } = await client.getStacks(hydrated.id);
    const reconciled = reconcileBoardStructure(localBoard, hydrated, stacks || []);
    const index = this.plugin.data.boards.indexOf(localBoard);
    this.plugin.data.boards[index] = reconciled;
    this.mergeBoardLabelsIntoGlobal(reconciled);
    await this.pullCards(client, hydrated.id, reconciled, stacks || []);
    return stacks || [];
  }

  /**
   * Sweep `data.boards` for duplicates that render as phantom empty
   * boards in the tab bar. Called once at the end of pull, after every
   * remote board has been merged onto its bound local copy.
   *
   * `boundLocalIds` is the set of board ids that this sync's pull loop
   * bound to a remote board — those are the canonical entries. Any other
   * board that shadows one of them (by remoteId, folderPath, or name) is
   * a leftover phantom. Two bound boards with the same folderPath are
   * also collapsed (keeps the one that iterates first).
   *
   * Bindings pointing at removed boards are cleaned up so a future sync
   * doesn't resurrect them via findOrBindLocalBoard's nameMatch branch.
   */
  pruneDuplicateBoards(boundLocalIds) {
    const bindings = this.plugin.data.nextcloud.boardBindings || {};
    const boards = this.plugin.data.boards;
    const bound = boards.filter((b) => boundLocalIds.has(b.id));
    const boundFolderPaths = new Set(bound.map((b) => (b.folderPath || "").trim()).filter(Boolean));
    const boundNames = new Set(bound.map((b) => (b.name || "").trim().toLowerCase()).filter(Boolean));
    const boundRemoteIds = new Set(bound.map((b) => b.remoteId).filter((r) => r != null));

    const kept = [];
    const dropped = [];
    const seenBoundFolders = new Set();
    for (const board of bound) {
      const key = (board.folderPath || "").trim();
      if (key && seenBoundFolders.has(key)) { dropped.push(board); continue; }
      if (key) seenBoundFolders.add(key);
      kept.push(board);
    }
    for (const board of boards) {
      if (boundLocalIds.has(board.id)) continue;
      const folder = (board.folderPath || "").trim();
      const name = (board.name || "").trim().toLowerCase();
      const isPhantom =
        (board.remoteId != null && boundRemoteIds.has(board.remoteId))
        || (folder && boundFolderPaths.has(folder))
        || (name && boundNames.has(name));
      if (isPhantom) { dropped.push(board); continue; }
      kept.push(board);
    }
    if (!dropped.length) return;

    this.plugin.data.boards = kept;
    const droppedIds = new Set(dropped.map((b) => b.id));
    for (const key of Object.keys(bindings)) {
      if (droppedIds.has(key)) delete bindings[key];
    }
    if (this.plugin.data.activeBoardId && droppedIds.has(this.plugin.data.activeBoardId)) {
      this.plugin.data.activeBoardId = (kept[0] && kept[0].id) || "";
    }
    this.plugin.debugLog({
      event: "sync.prune-duplicate-boards",
      droppedIds: Array.from(droppedIds),
      keptCount: kept.length,
    });
  }

  /**
   * After hydrating a board, promote its per-board label catalog into the
   * plugin's global `data.labels` list — that's what the LabelPicker modal
   * shows when the user clicks the label button on a card. Without this
   * step, labels created on the Deck Web UI would only exist inside
   * `localBoard.labels` (which is only used for push-side reconciliation)
   * and would never surface in the picker, giving the appearance that the
   * local label list is a subset of what Deck has.
   *
   * Merge is done by `labelKey` (case-insensitive name) to avoid loading
   * the picker with duplicates when the same title exists in both sources.
   * `board.labels` uses `title`, `data.labels` uses `name`, so we adapt.
   */
  mergeBoardLabelsIntoGlobal(board) {
    if (!board || !Array.isArray(board.labels)) return;
    if (!Array.isArray(this.plugin.data.labels)) this.plugin.data.labels = [];
    const seen = new Set(this.plugin.data.labels.map((l) => labelKey(l && l.name)));
    let added = 0;
    for (const boardLabel of board.labels) {
      const name = boardLabel && (boardLabel.name || boardLabel.title);
      if (!name) continue;
      const key = labelKey(name);
      if (seen.has(key)) continue;
      seen.add(key);
      this.plugin.data.labels.push({
        name: String(name).trim(),
        color: (boardLabel && boardLabel.color) || "#d43c35",
      });
      added += 1;
    }
    if (added) {
      this.plugin.debugLog({ event: "sync.pull.global-labels-added", boardId: board.id, added });
    }
  }

  async pullCards(client, remoteBoardId, localBoard, remoteStacks) {
    const cardMap = new Map();
    // Cards whose local model was refreshed from remote in this pull;
    // we'll flush their md files at the end so open cards (which
    // re-hydrate from disk via hydrateCardFromFile on modal load) see
    // the same state as the board view. Without this the board tile
    // shows the new label but opening the modal shows stale ones.
    const dirtyForDisk = [];
    Object.values(this.plugin.data.cards).forEach((card) => {
      // Coerce to Number so a remoteId stored as string still matches a
      // number coming back from Deck (belt-and-suspenders; the API returns
      // numeric ids, but we've seen serialization gymnastics elsewhere).
      if (card.boardId === localBoard.id && card.remoteId != null) cardMap.set(Number(card.remoteId), card);
    });

    // Detect duplicates that have already sneaked into data.cards — same
    // remoteId owned by two local cards. This causes the "creeping
    // duplicates" pattern where every pull creates yet another entry. We
    // consolidate down to the first one seen and drop the extras from
    // data.cards outright.
    const duplicates = new Map(); // remoteId -> [cards]
    Object.values(this.plugin.data.cards).forEach((card) => {
      if (card.boardId !== localBoard.id || card.remoteId == null) return;
      const key = Number(card.remoteId);
      if (!duplicates.has(key)) duplicates.set(key, []);
      duplicates.get(key).push(card);
    });
    let dedupedLocal = 0;
    duplicates.forEach((cards, remoteId) => {
      if (cards.length < 2) return;
      // Keep the first one, drop the rest.
      cards.slice(1).forEach((extra) => {
        delete this.plugin.data.cards[extra.id];
        dedupedLocal += 1;
      });
      this.plugin.pushSyncLog({
        event: "pull.dedupe-local",
        boardId: localBoard.id,
        remoteId,
        kept: cards[0].id,
        droppedIds: cards.slice(1).map((c) => c.id),
      });
    });

    this.plugin.debugLog({
      event: "sync.pull.cards.start",
      boardId: localBoard.id,
      remoteBoardId,
      localTracked: cardMap.size,
      dedupedLocal,
      totalDataCards: Object.keys(this.plugin.data.cards).length,
    });

    // Track which lists were rebuilt so we can preserve the ordering of any
    // local-only (unsynced) cards on the same list.
    const rebuiltListIds = new Set();
    localBoard.lists.forEach((list) => { rebuiltListIds.add(list.id); list.cardIds = []; });

    for (const stack of remoteStacks) {
      const localList = localBoard.lists.find((list) => list.remoteId === stack.id);
      if (!localList) continue;

      const cards = Array.isArray(stack.cards) && stack.cards.length
        ? stack.cards
        : await this.fallbackFetchStackCards(client, remoteBoardId, stack.id);

      const sorted = cards.slice().sort((a, b) => (a.order || 0) - (b.order || 0));
      for (const remoteCard of sorted) {
        const remoteIdKey = Number(remoteCard.id);
        const existing = cardMap.get(remoteIdKey);
        const merged = mergeRemoteCardOntoLocal(existing, remoteCard, { boardId: localBoard.id, listId: localList.id });
        const cardId = existing ? existing.id : merged.id;
        merged.id = cardId;
        merged.boardId = localBoard.id;
        merged.listId = localList.id;
        // Preserve filePath from existing local card if we had one, so a
        // subsequent writeCardFile updates the same note instead of
        // generating a fresh path each pull.
        if (existing && existing.filePath) merged.filePath = existing.filePath;
        this.plugin.data.cards[cardId] = merged;
        localList.cardIds.push(cardId);
        cardMap.delete(remoteIdKey);
        dirtyForDisk.push(merged);
        this.plugin.debugLog({
          event: "sync.pull.card",
          cardId,
          remoteId: remoteIdKey,
          matched: !!existing,
          title: merged.title,
        });

        // Fetch attachments for the card (only if feature-enabled). Must
        // run BEFORE the description rewrite below so `merged.attachments`
        // is populated with the fresh `fileid` values we need to resolve
        // Deck's `[caption](server/f/<id> (preview))` links back into
        // Obsidian wikilink form.
        try {
          await this.attachments.pullCard(client, merged, localBoard, localList);
        } catch (error) {
          this.plugin.pushSyncLog({ event: "attachment-pull-failed", cardId, message: (error && error.message) || String(error) });
        }

        // Now that attachments are known, translate any Deck-style
        // attachment preview links back into Obsidian's `![[…]]` embed
        // syntax so the local markdown renders inline. Non-matching links
        // (external URLs, references to other Nextcloud instances) are
        // preserved untouched — see deckDescriptionToLocal.
        const serverUrl = this.plugin.data.nextcloud && this.plugin.data.nextcloud.serverUrl;
        if (serverUrl && typeof merged.details === "string") {
          const converted = deckDescriptionToLocal(merged.details, merged, { serverUrl });
          if (converted !== merged.details) {
            merged.details = converted;
            this.plugin.debugLog({ event: "sync.pull.attachment-links-rewritten", cardId });
          }
        }
      }
    }

    // Cards left in `cardMap` used to be on Nextcloud but no longer are; drop
    // them locally so Deck stays authoritative for tracked cards.
    cardMap.forEach((orphan) => {
      if (orphan.boardId === localBoard.id) delete this.plugin.data.cards[orphan.id];
    });

    // Fold local-only (never synced) cards back into their list. They stayed
    // in this.plugin.data.cards but were dropped from cardIds when we cleared
    // the lists above.
    Object.values(this.plugin.data.cards).forEach((card) => {
      if (card.boardId !== localBoard.id) return;
      if (card.remoteId != null) return;
      const list = localBoard.lists.find((l) => l.id === card.listId);
      if (list && !list.cardIds.includes(card.id)) list.cardIds.push(card.id);
    });

    // Flush the refreshed cards back to their Markdown files. The card
    // modal calls plugin.hydrateCardFromFile(card) on open, which reads
    // labels/details/etc. from disk and overwrites the in-memory card —
    // so if the md file is stale (which it always was pre-pre.22 for
    // pull-only changes), the modal shows the old data even though the
    // board view (which reads from data.cards directly) shows the new
    // one. Best-effort per card; a single write failure shouldn't
    // abort the rest of the sync.
    for (const card of dirtyForDisk) {
      try {
        await this.plugin.writeCardFile(card);
      } catch (error) {
        this.plugin.pushSyncLog({ event: "card-writeback-failed", cardId: card.id, message: (error && error.message) || String(error) });
      }
    }
  }

  async fallbackFetchStackCards(client, boardId, stackId) {
    this.plugin.pushSyncLog({ event: "stack-embed-missing", boardId, stackId });
    return [];
  }

  // ---- Push ---------------------------------------------------------------

  async pushBoard(client, localBoard, { remoteBoard, remoteStacks }) {
    let pushed = 0;
    let conflicts = 0;
    const policy = this.plugin.data.nextcloud.conflictPolicy || "prompt";
    const remoteCardIndex = buildRemoteCardIndex(remoteStacks);

    // Snapshot the card list first — pushing mutates data.cards, and we don't
    // want to iterate while modifying.
    const dirtyCards = Object.values(this.plugin.data.cards)
      .filter((card) => card.boardId === localBoard.id && card.localDirty);

    for (const card of dirtyCards) {
      const listBinding = localBoard.lists.find((l) => l.id === card.listId);
      if (!listBinding || listBinding.remoteId == null) {
        // The card lives on a list that isn't bound to a remote stack yet.
        // Creating stacks on-demand is out of scope for M3; log and skip.
        this.plugin.pushSyncLog({ event: "push-skip-unbound-list", cardId: card.id });
        continue;
      }

      try {
        if (card.remoteId == null) {
          await this.pushCreate(client, localBoard, listBinding, card);
          pushed += 1;
          continue;
        }
        const remoteSnapshot = remoteCardIndex.get(card.remoteId);
        const outcome = await this.pushUpdate(client, localBoard, listBinding, card, remoteSnapshot, policy);
        if (outcome === "pushed") pushed += 1;
        else if (outcome === "conflict-skipped") conflicts += 1;
      } catch (error) {
        this.plugin.pushSyncLog({
          event: "push-failed",
          cardId: card.id,
          message: (error && error.message) || String(error),
        });
      }
    }

    return { pushed, conflicts };
  }

  async pushCreate(client, localBoard, list, card) {
    const payload = localCardToDeckCreate(card, { owner: this.plugin.data.nextcloud.username });
    this.plugin.debugLog({
      event: "sync.push.create.request",
      cardId: card.id,
      listRemoteId: list.remoteId,
      descriptionLen: (payload.description || "").length,
      hasChecklist: /(^|\n)#{1,6}\s*checklist/i.test(payload.description || ""),
      // First 200 chars of the payload description so we can see the exact
      // wire format going up to Deck. Debug-only, so users who don't enable
      // logging never leak card content.
      descriptionPreview: (payload.description || "").slice(0, 200),
      titlePreview: payload.title,
      checklistLen: (card.checklist || []).length,
    });
    const { data: created } = await client.createCard(remoteBoard(localBoard), list.remoteId, payload);
    if (!created) throw new Error("Empty response from createCard");
    this.plugin.debugLog({ event: "sync.push.create.done", cardId: card.id, remoteId: created.id });
    this.applyRemoteToCard(card, created, localBoard.id, list.id);
    card.localDirty = false;
    await this.attachments.pushCard(client, card, localBoard, list).catch((error) => {
      this.plugin.pushSyncLog({ event: "attachment-push-failed", cardId: card.id, message: (error && error.message) || String(error) });
    });
    await this.pushCardLabels(client, localBoard, list, card).catch((error) => {
      this.plugin.pushSyncLog({ event: "labels-push-failed", cardId: card.id, message: (error && error.message) || String(error) });
    });

    // After attachments upload we may now be able to translate any
    // `![[…]]` embeds in the description into Deck's inline preview
    // link syntax (`[caption](server/f/<id> (preview))`). This is the
    // safe form of the description rewrite that pre.10–pre.14 got
    // wrong: it only replaces wikilinks whose target resolves to a
    // freshly uploaded attachment (matched by filePath / basename and
    // fileid), and it never touches the local card — only the payload
    // going to Deck. Unresolvable wikilinks are left alone verbatim
    // rather than mangled into filename captions.
    const serverUrl = this.plugin.data.nextcloud && this.plugin.data.nextcloud.serverUrl;
    const rewritten = serverUrl ? localDescriptionToDeck(payload.description || "", card, { serverUrl }) : payload.description;
    if (rewritten && rewritten !== payload.description) {
      try {
        const { data: updated } = await client.updateCard(remoteBoard(localBoard), list.remoteId, card.remoteId, Object.assign({}, payload, { description: rewritten }));
        if (updated) this.applyRemoteToCard(card, updated, localBoard.id, list.id);
        this.plugin.debugLog({ event: "sync.push.create.attachment-links-rewritten", cardId: card.id });
      } catch (error) {
        this.plugin.pushSyncLog({ event: "attachment-link-rewrite-failed", cardId: card.id, message: (error && error.message) || String(error) });
      }
    }
  }

  async pushUpdate(client, localBoard, list, card, remoteSnapshot, policy) {
    // If the remote counterpart is gone, treat this as a create.
    if (!remoteSnapshot) {
      await this.pushCreate(client, localBoard, list, card);
      return "pushed";
    }

    const remoteView = remoteCardToLocal(remoteSnapshot, { boardId: localBoard.id, listId: list.id });
    const baseline = card.baseline || null;
    const diff = detectFieldConflicts(baseline, card, remoteView);

    // If the remote has autoApplied fields, fold them into the local card so
    // the push payload we send back is a full merge (Deck's PUT replaces the
    // whole record).
    Object.entries(diff.autoApplied).forEach(([field, value]) => {
      if (Object.prototype.hasOwnProperty.call(card, field)) card[field] = value;
    });

    if (diff.conflicts.length) {
      const { resolved, stillOpen } = applyPolicy(policy, diff.conflicts, {
        localUpdatedAt: card.remoteUpdatedAt,
        remoteUpdatedAt: remoteView.remoteUpdatedAt,
      });
      Object.entries(resolved).forEach(([field, value]) => { card[field] = value; });

      if (stillOpen.length) {
        // Only `prompt` policy leaves fields open; ask the user.
        const modal = new ConflictModal(this.plugin.app, {
          cardTitle: card.title,
          conflicts: stillOpen,
        });
        const answer = await modal.await();
        if (!answer) return "conflict-skipped";
        Object.entries(answer).forEach(([field, value]) => { card[field] = value; });
      }
    }

    // Upload attachments FIRST so we can rewrite Obsidian wikilinks in the
    // description into `/apps/deck/cards/<id>/attachment/<attId>` URLs that
    // Deck's Markdown renderer can actually display. If attachments arrived
    // after the description update, the first push would ship the raw
    // `![[…]]` and Deck would spin forever on a broken image tile.
    await this.attachments.pushCard(client, card, localBoard, list).catch((error) => {
      this.plugin.pushSyncLog({ event: "attachment-push-failed", cardId: card.id, message: (error && error.message) || String(error) });
    });

    const payload = localCardToDeckPatch(card, { owner: this.plugin.data.nextcloud.username });
    // Safe wikilink rewrite: only substitute `![[…]]` embeds whose target
    // resolves to an attachment we just uploaded (see localDescriptionToDeck).
    // Unresolvable wikilinks and external URLs are left verbatim so we can't
    // silently mangle user content the way pre.10–pre.14 did.
    const serverUrl = this.plugin.data.nextcloud && this.plugin.data.nextcloud.serverUrl;
    if (serverUrl) {
      payload.description = localDescriptionToDeck(payload.description || "", card, { serverUrl });
    }
    const board = remoteBoard(localBoard);
    this.plugin.debugLog({
      event: "sync.push.update.request",
      cardId: card.id,
      remoteId: card.remoteId,
      descriptionLen: (payload.description || "").length,
      hasChecklist: /(^|\n)#{1,6}\s*checklist/i.test(payload.description || ""),
      descriptionPreview: (payload.description || "").slice(0, 200),
      titlePreview: payload.title,
      checklistLen: (card.checklist || []).length,
      attachmentCount: (card.attachments || []).length,
    });
    const { data: updated } = await client.updateCard(board, list.remoteId, card.remoteId, payload);
    if (!updated) throw new Error("Empty response from updateCard");
    this.plugin.debugLog({ event: "sync.push.update.done", cardId: card.id, remoteId: card.remoteId });
    this.applyRemoteToCard(card, updated, localBoard.id, list.id);
    card.localDirty = false;
    await this.pushCardLabels(client, localBoard, list, card).catch((error) => {
      this.plugin.pushSyncLog({ event: "labels-push-failed", cardId: card.id, message: (error && error.message) || String(error) });
    });
    return "pushed";
  }

  applyRemoteToCard(card, remoteResp, boardId, listId) {
    const remote = remoteCardToLocal(remoteResp, { boardId, listId });
    card.remoteId = remote.remoteId;
    card.etag = remote.etag;
    card.remoteUpdatedAt = remote.remoteUpdatedAt;
    // After a successful push, the *local* state is now the truth for the
    // baseline. Fields we didn't touch on Deck (checklist etc.) came back
    // unchanged, so hashing what we have is safe.
    card.baseline = snapshotBaseline(card);
  }

  /**
   * Reconcile a card's labels with Deck. Deck's card PUT does not accept a
   * labels array (only title/description/type/order/duedate), so label
   * changes have to go through the dedicated assignLabel / removeLabel
   * endpoints, keyed on the board-level label catalog.
   *
   * Flow per label the user has attached locally:
   *   1. Find a matching label on the board by title (case-insensitive).
   *   2. If none, POST /boards/{id}/labels to create one, then use its id.
   *   3. If not yet attached to the card on Deck, PUT assignLabel.
   * And per label attached on Deck that no longer exists locally:
   *   - PUT removeLabel.
   *
   * We deliberately avoid deleting the label from the board catalog even
   * when no card references it anymore — a user might be about to reuse it.
   */
  async pushCardLabels(client, localBoard, list, card) {
    if (!card || card.remoteId == null) return;
    const localLabels = Array.isArray(card.labels) ? card.labels : [];
    if (!localBoard.labels) localBoard.labels = [];

    // Snapshot what Deck currently has for this card. We re-fetch instead
    // of trusting card.baseline because the baseline may be stale after a
    // pull-then-push sequence.
    let remoteCard;
    try {
      const { data } = await client.getCard(remoteBoard(localBoard), list.remoteId, card.remoteId);
      remoteCard = data || {};
    } catch (error) {
      this.plugin.pushSyncLog({ event: "labels.fetch-failed", cardId: card.id, message: (error && error.message) || String(error) });
      return;
    }
    const remoteLabels = Array.isArray(remoteCard.labels) ? remoteCard.labels : [];
    const remoteByTitle = new Map(remoteLabels.map((l) => [String(l.title || "").toLowerCase(), l]));
    const catalogByTitle = new Map(localBoard.labels.map((l) => [String(l.title || "").toLowerCase(), l]));

    // 1. Ensure every local label maps to a catalog entry (create on Deck
    //    if missing), then assign it to the card if not already attached.
    for (const local of localLabels) {
      const key = String(local.name || "").trim().toLowerCase();
      if (!key) continue;
      let catalog = catalogByTitle.get(key);
      if (!catalog) {
        try {
          const { data: created } = await client.createLabel(remoteBoard(localBoard), {
            title: local.name.trim(),
            // Deck stores colors as bare 6-char hex without the leading '#'.
            color: String(local.color || "31CC7C").replace(/^#/, "").padStart(6, "0").slice(0, 6),
          });
          if (created && created.id != null) {
            catalog = { remoteId: Number(created.id), title: created.title || local.name, color: local.color || "#31CC7C" };
            localBoard.labels.push(catalog);
            catalogByTitle.set(key, catalog);
            this.plugin.debugLog({ event: "labels.created", boardId: localBoard.id, title: local.name, remoteId: catalog.remoteId });
          }
        } catch (error) {
          // A 400 usually means "label with this title already exists" —
          // our catalog was stale. Try to recover by pulling the board's
          // full label list and matching on title before giving up.
          if (error && error.status === 400) {
            try {
              const { data: freshBoard } = await client.getBoard(remoteBoard(localBoard));
              const freshLabels = Array.isArray(freshBoard && freshBoard.labels) ? freshBoard.labels : [];
              const match = freshLabels.find((l) => String((l && l.title) || "").toLowerCase() === key);
              if (match && match.id != null) {
                catalog = { remoteId: Number(match.id), title: match.title || local.name, color: local.color || "#31CC7C" };
                localBoard.labels.push(catalog);
                catalogByTitle.set(key, catalog);
                this.plugin.debugLog({ event: "labels.recovered-existing", boardId: localBoard.id, title: local.name, remoteId: catalog.remoteId });
              }
            } catch (retryError) {
              // Fall through to the generic failure log.
            }
          }
          if (!catalog) {
            this.plugin.pushSyncLog({ event: "labels.create-failed", boardId: localBoard.id, title: local.name, message: (error && error.message) || String(error) });
            continue;
          }
        }
      }
      if (!catalog || catalog.remoteId == null) continue;
      // Also stash the resolved remoteId back on the local label so the
      // next diff has it without needing another server round-trip.
      local.remoteId = catalog.remoteId;
      if (!remoteByTitle.has(key)) {
        try {
          await client.assignLabel(remoteBoard(localBoard), list.remoteId, card.remoteId, catalog.remoteId);
          this.plugin.debugLog({ event: "labels.assigned", cardId: card.id, labelRemoteId: catalog.remoteId });
        } catch (error) {
          this.plugin.pushSyncLog({ event: "labels.assign-failed", cardId: card.id, labelRemoteId: catalog.remoteId, message: (error && error.message) || String(error) });
        }
      }
    }

    // 2. Remove labels the card has on Deck but no longer locally.
    const localByTitle = new Set(localLabels.map((l) => String(l.name || "").trim().toLowerCase()).filter(Boolean));
    for (const remote of remoteLabels) {
      const key = String(remote.title || "").trim().toLowerCase();
      if (!key || localByTitle.has(key)) continue;
      try {
        await client.removeLabel(remoteBoard(localBoard), list.remoteId, card.remoteId, remote.id);
        this.plugin.debugLog({ event: "labels.removed", cardId: card.id, labelRemoteId: remote.id });
      } catch (error) {
        this.plugin.pushSyncLog({ event: "labels.remove-failed", cardId: card.id, labelRemoteId: remote.id, message: (error && error.message) || String(error) });
      }
    }
  }

  // ---- Reap ---------------------------------------------------------------

  async reapDeletions(client) {
    const nc = this.plugin.data.nextcloud;
    if (!Array.isArray(nc.pendingDeletions) || !nc.pendingDeletions.length) return 0;
    const remaining = [];
    let removed = 0;
    for (const entry of nc.pendingDeletions) {
      try {
        await client.deleteCard(entry.boardRemoteId, entry.stackRemoteId, entry.remoteId);
        removed += 1;
      } catch (error) {
        // Treat these as "already gone" and drop from the queue:
        //   404 — the card genuinely doesn't exist on the server anymore
        //   403 — Deck's soft-delete state: the card was trashed (deletedAt
        //         set), so DELETE returns Permission denied instead of 404.
        //         Retrying will keep failing forever; leaving it in
        //         pendingDeletions was what caused the "creeping duplicate"
        //         observed in the field (see log complaint 2026-07-09).
        //   410 — some Nextcloud deployments return Gone.
        if (error instanceof DeckApiError && (error.status === 404 || error.status === 403 || error.status === 410)) {
          this.plugin.debugLog({ event: "reap.treat-as-gone", entry, status: error.status });
          removed += 1;
        } else {
          this.plugin.pushSyncLog({ event: "reap-failed", entry, message: (error && error.message) || String(error) });
          remaining.push(entry);
        }
      }
    }
    nc.pendingDeletions = remaining;
    return removed;
  }

  // ---- Bindings -----------------------------------------------------------

  getBindings() {
    const bindings = this.plugin.data.nextcloud.boardBindings || {};
    return typeof bindings === "object" ? { ...bindings } : {};
  }

  findOrBindLocalBoard(remoteBoard, bindings, boardMap) {
    for (const [localId, remoteId] of Object.entries(bindings)) {
      if (Number(remoteId) === Number(remoteBoard.id) && boardMap.get(localId)) return localId;
    }
    const nameMatch = this.plugin.data.boards.find(
      (board) => !bindings[board.id] && board.name && board.name.trim() === String(remoteBoard.title || "").trim(),
    );
    if (nameMatch) {
      bindings[nameMatch.id] = remoteBoard.id;
      return nameMatch.id;
    }
    const created = `board-${remoteBoard.id}`;
    bindings[created] = remoteBoard.id;
    return created;
  }

  suggestFolder(remoteBoard) {
    const title = String(remoteBoard.title || "Board").replace(/[\\/:*?"<>|]/g, " ").trim() || "Board";
    // User-configurable root, defaults to "Deck". Empty string means "put
    // boards at the vault root" — respect that literally.
    const raw = this.plugin.data.nextcloud && Object.prototype.hasOwnProperty.call(this.plugin.data.nextcloud, "rootFolder")
      ? this.plugin.data.nextcloud.rootFolder
      : "Deck";
    const root = typeof raw === "string" ? raw.trim().replace(/^\/+|\/+$/g, "") : "Deck";
    return root ? `${root}/${title}` : title;
  }
}

// ---- Local helpers --------------------------------------------------------

function remoteBoard(localBoard) {
  if (localBoard.remoteId == null) throw new Error("Board is not linked to Nextcloud yet.");
  return localBoard.remoteId;
}

function buildRemoteCardIndex(remoteStacks) {
  const index = new Map();
  (remoteStacks || []).forEach((stack) => {
    (stack.cards || []).forEach((card) => {
      if (card && card.id != null) index.set(card.id, card);
    });
  });
  return index;
}

// The `rewriteWikilinksForDeck` helper that used to live here has been
// removed. It attempted to translate Obsidian's `![[…]]` embeds into
// something Deck's description renderer could handle. Two rounds of
// experimentation (CommonMark image link with an internal /apps/deck URL,
// then dropping the embed / substituting the filename caption) both
// mangled user content on the server side. Attachments are handled through
// the dedicated attachment API instead; description text is now shipped
// verbatim. See .trae/documents/attachment-rework-plan.md for the full
// history.

module.exports = {
  SyncManager,
  STATUS_IDLE,
  STATUS_RUNNING,
  STATUS_ERROR,
  STATUS_OK,
};
