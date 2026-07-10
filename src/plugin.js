const { Notice, Plugin, addIcon } = require("obsidian");

// Owns the Obsidian plugin lifecycle, saved board data, and Markdown card sync.
const {
  BOARD_INDEX_MARKER,
  DEFAULT_DATA,
  LEGACY_BOARD_INDEX_SUFFIX,
  LEGACY_CARD_FOLDER,
  LIST_COLORS,
  TASK_DECK_ICON,
  TASK_DECK_ICON_SVG,
  VIEW_TYPE,
  checklistToMarkdown,
  cleanDate,
  cleanColor,
  cleanLabelName,
  clone,
  labelKey,
  labelsToFrontmatter,
  assigneesToFrontmatter,
  imageRefsFromMarkdown,
  isImagePath,
  parseCardMarkdown,
  encodeListMeta,
  decodeListMeta,
  cardFileBaseName,
  taskDeckListTag,
  textLine,
  uid,
} = require("./helpers");
const { BoardView } = require("./board-view");
const { COMPLETION_SOUND_URL } = require("./completion-sound");
const { TextPromptModal } = require("./modals");
const { TaskDeckSettingTab } = require("./settings-tab");

/**
 * Main plugin controller.
 *
 * The board state is saved with Obsidian's plugin data API, while every card is
 * mirrored as a Markdown note. UI code calls this class for all mutations so
 * the JSON data and the Markdown files stay in sync.
 */
module.exports = class ObsidianTasksKanbanPlugin extends Plugin {
  async onload() {
    // In-memory load only (reads data.json + normalizes) so this.data exists for
    // the board view. Heavy vault I/O is deferred to onLayoutReady below.
    await this.loadPluginData();

    // Live "someone else is editing this card" locks, keyed by card id. Filled
    // from the SyncDeck presence roster; read by the board and the card modal.
    this.cardLocks = new Map();
    this.editingCardId = null;

    // The exact Markdown we last read from (or wrote to) each card file, keyed by
    // card id. writeCardFile compares against it so a note another device just
    // delivered is never clobbered by our (possibly stale) in-memory card.
    this.diskSignatures = new Map();
    this.pendingResync = false;
    this.resyncTimer = null;

    addIcon(TASK_DECK_ICON, TASK_DECK_ICON_SVG);
    this.registerView(VIEW_TYPE, (leaf) => new BoardView(leaf, this));
    this.addSettingTab(new TaskDeckSettingTab(this.app, this));
    ["create", "modify", "rename", "delete"].forEach((eventName) => {
      this.registerEvent(this.app.vault.on(eventName, (file) => this.queueCardFolderSync(file, eventName)));
    });

    // Reconcile card notes AFTER the workspace + metadata cache are ready, and
    // never let it reject onload(): a startup file error used to crash onload and
    // leave the plugin disabled until manually toggled off/on on every restart.
    this.app.workspace.onLayoutReady(() => {
      this.reconcileVaultFiles().catch((error) => {
        console.error("Task Deck: startup vault reconcile failed", error);
        new Notice("Task Deck loaded, but reconciling notes hit an error. Your boards are intact.");
      });
    });

    // Boards sync themselves: vault events reconcile on change, and this periodic
    // safety net re-imports every ~30s so remote edits (pulled by Sync Deck) show
    // up even if an event is missed. Skipped while reconciling or editing a card,
    // so it never disrupts the user. The manual "Sync" button still works too.
    this.registerInterval(window.setInterval(() => {
      if (this.reconciling || this.editingCardId) return;
      const before = JSON.stringify(this.data.boards);
      Promise.resolve(this.syncCardsFromFolder())
        .then(() => { if (JSON.stringify(this.data.boards) !== before) this.refreshViews(); })
        .catch(() => {});
    }, 30000));

    this.addRibbonIcon(TASK_DECK_ICON, "Open Task Deck", () => this.activateView());
    this.addCommand({
      id: "open-board",
      name: "Open board",
      callback: () => this.activateView(),
    });
    this.addCommand({
      id: "add-card-to-first-list",
      name: "Add card to first list",
      callback: async () => {
        const board = this.getBoard();
        const firstList = board && board.lists[0];
        if (firstList) {
          await this.addCard(firstList.id);
        } else if (!board) {
          new Notice("Create a board first.");
        } else {
          new Notice("Add a list first.");
        }
      },
    });
  }

  async onunload() {
    if (this.explorerColorStyleEl) this.explorerColorStyleEl.remove();
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }

  /**
   * Loads saved board data, normalizes older/missing fields, then imports any
   * Markdown card notes that were created or edited outside the board.
   */
  async loadPluginData() {
    const saved = await this.loadData();
    this.data = Object.assign(clone(DEFAULT_DATA), saved || {});
    this.data.boards = Array.isArray(this.data.boards) ? this.data.boards : [];
    this.data.cards = this.data.cards || {};
    this.data.labels = this.data.labels || [];
    this.data.completionSound = this.data.completionSound !== false;
    this.data.compactLabels = !!this.data.compactLabels;
    this.data.labels = this.normalizeGlobalLabels(this.data.labels);
    this.data.boards = this.data.boards.map((board) => this.normalizeBoard(board));
    this.loadNeedsSave = this.ensureListColors();
    Object.values(this.data.cards).forEach((card) => {
      card.boardId = card.boardId || this.boardIdForList(card.listId) || this.data.activeBoardId || "";
      card.labels = this.normalizeCardLabels(card.labels || []);
      card.completed = !!card.completed;
      card.startDate = cleanDate(card.startDate);
      card.dueDate = cleanDate(card.dueDate);
    });
    this.data.boards.forEach((board) => {
      board.folderPath = board.folderPath || this.inferBoardFolder(board) || cardFileBaseName(board.name);
    });
    this.data.activeBoardId = this.findBoard(this.data.activeBoardId)
      ? this.data.activeBoardId
      : (this.data.boards[0] && this.data.boards[0].id) || "";
  }

  /**
   * Heavy vault reconciliation: import card notes, restore boards from index
   * files, and rewrite files. Deferred to onLayoutReady and guarded so a startup
   * file error can never reject onload() — which would disable the plugin and
   * force a manual re-enable on every restart. The `reconciling` flag stops our
   * own writes here from re-triggering the folder-sync event handler.
   */
  async reconcileVaultFiles() {
    this.reconciling = true;
    try {
      const restored = await this.restoreBoardsFromIndexFiles();
      // A Sync Deck vault switch trashes the PREVIOUS vault's board folders, but
      // our per-device data.json still lists those boards. Drop any whose folder
      // is gone from disk BEFORE the writes below — otherwise writeBoardIndexFiles
      // re-creates their folders + indexes in the vault we just switched into, so
      // every switch bled the old vault's Task Deck folders into the new one and
      // the user had to delete them by hand. (adopt just above re-added the boards
      // that DO have a folder here, so this only removes truly-vanished ones.)
      const prunedVanished = this.pruneVanishedBoards();
      const removedIndexCards = this.removeBoardIndexCards();
      this.data.activeBoardId = this.findBoard(this.data.activeBoardId)
        ? this.data.activeBoardId
        : (this.data.boards[0] && this.data.boards[0].id) || "";
      // Collapse any same-id duplicate card files (e.g. a sync split a move into
      // create+delete) BEFORE renaming, so a duplicate can't cause a name bump.
      const deduped = await this.dedupeCardFilesById();
      const renamed = await this.normalizeCardFilePaths();
      await this.syncCardsFromFolder();
      // One-time media tidy-up: move loose images/videos into <board>/attachments
      // and fix their card links. Runs after the folder sync (so details are
      // current) and before writeAllCardFiles (so the fixes get persisted).
      const migratedLayout = !this.data.layoutMigrated;
      if (migratedLayout) {
        await this.migrateExistingMedia();
        this.data.layoutMigrated = true;
      }
      await this.writeAllCardFiles();
      await this.writeBoardIndexFiles();
      await this.syncGraphColorGroups();
      this.updateExplorerColors();
      if (restored || prunedVanished || renamed || deduped || migratedLayout || this.loadNeedsSave || removedIndexCards) await this.saveData(this.data);
    } finally {
      this.reconciling = false;
    }

    // A write was skipped because the note on disk was newer than our memory
    // (a sync delivered it mid-reconcile, and its event was swallowed while
    // `reconciling`). Import it now that events flow again.
    if (this.pendingResync) {
      this.pendingResync = false;
      try {
        await this.syncCardsFromFolder();
        await this.saveData(this.data);
      } catch (error) {
        console.error("Task Deck: post-reconcile resync failed", error);
      }
    }
    this.refreshViews();
  }

  async savePluginData() {
    await this.writeBoardIndexFiles();
    await this.syncGraphColorGroups();
    await this.saveData(this.data);
  }

  getBoard() {
    return this.findBoard(this.data.activeBoardId) || this.data.boards[0] || null;
  }

  findBoard(boardId) {
    return this.data.boards.find((board) => board.id === boardId) || null;
  }

  normalizeBoard(board) {
    return {
      id: board && board.id ? board.id : uid("board"),
      name: textLine(board && board.name) || "Untitled board",
      folderPath: textLine(board && board.folderPath),
      lists: Array.isArray(board && board.lists)
        ? board.lists.map((list) => ({
          id: list && list.id ? list.id : uid("list"),
          title: textLine(list && list.title) || "Untitled list",
          color: cleanColor(list && list.color),
          cardIds: Array.isArray(list && list.cardIds) ? list.cardIds : [],
        }))
        : [],
      deletedListIds: Array.isArray(board && board.deletedListIds) ? board.deletedListIds : [],
    };
  }

  boardIdForList(listId) {
    const board = this.data.boards.find((item) => item.lists.some((list) => list.id === listId));
    return board ? board.id : "";
  }

  defaultListColor(index) {
    return LIST_COLORS[index % LIST_COLORS.length];
  }

  ensureListColors() {
    let changed = false;
    this.data.boards.forEach((board) => {
      board.lists.forEach((list, index) => {
        if (list.color) return;
        list.color = this.defaultListColor(index);
        changed = true;
      });
    });
    return changed;
  }

  findBoardForCard(card) {
    if (!card) return this.getBoard();
    return this.findBoard(card.boardId) || this.findBoard(this.boardIdForList(card.listId)) || this.getBoard();
  }

  inferBoardFolder(board) {
    const card = Object.values(this.data.cards).find((item) => {
      return item.boardId === board.id || board.lists.some((list) => list.id === item.listId || list.cardIds.includes(item.id));
    });
    if (card && card.filePath && card.filePath.includes("/")) return card.filePath.split("/").slice(0, -1).join("/");
    return board.id === "default" ? LEGACY_CARD_FOLDER : "";
  }

  boardIndexPath(board) {
    const name = cardFileBaseName(board.name || (board.folderPath || "").split("/").pop() || "Board");
    return `${board.folderPath}/${name}.md`;
  }

  legacyBoardIndexPath(board) {
    return `${board.folderPath}/${LEGACY_BOARD_INDEX_SUFFIX}`;
  }

  isPotentialBoardIndexFile(file) {
    if (!file || file.extension !== "md" || !file.path.includes("/")) return false;
    if (file.name === LEGACY_BOARD_INDEX_SUFFIX) return true;
    const parts = file.path.split("/");
    const parent = parts[parts.length - 2];
    return file.basename === parent || file.basename.endsWith(" Board");
  }

  async isGeneratedBoardIndexFile(file, markdown = null) {
    if (!this.isPotentialBoardIndexFile(file)) return false;
    const text = markdown === null ? await this.app.vault.read(file) : markdown;
    return text.includes("task-deck-board: true") || text.includes(BOARD_INDEX_MARKER);
  }

  async restoreBoardsFromIndexFiles() {
    const knownFolders = new Set(this.data.boards.map((board) => board.folderPath).filter(Boolean));
    const indexFiles = this.app.vault.getMarkdownFiles().filter((file) => this.isPotentialBoardIndexFile(file));
    let changed = false;

    for (const indexFile of indexFiles) {
      const markdown = await this.app.vault.read(indexFile);
      if (!(await this.isGeneratedBoardIndexFile(indexFile, markdown))) continue;

      const folderPath = indexFile.path.split("/").slice(0, -1).join("/");
      if (!folderPath || knownFolders.has(folderPath)) continue;

      const explicitIndex = markdown.includes("task-deck-board: true");
      const heading = markdown.match(/^#\s+(.+?)(?:\s+Board)?\s*$/m);
      const board = {
        id: uid("board"),
        name: textLine(heading && heading[1]) || folderPath.split("/").pop(),
        folderPath,
        lists: [],
      };
      // The index frontmatter carries the board's real id. Prefer it so a board
      // adopted from a synced index keeps the SAME id on every device — including
      // a board that has lists but no cards yet. Without this the adopter mints a
      // fresh uid, and since each device then regenerates the index with its own
      // id, the two devices rewrite the id back and forth on every sync forever.
      // (A card's kanban-board-id below agrees, and is the fallback for legacy
      // indexes written before this frontmatter line existed.)
      const fmBoardId = markdown.match(/^task-deck-board-id:\s*(.+?)\s*$/m);
      if (fmBoardId && textLine(fmBoardId[1])) board.id = textLine(fmBoardId[1]);
      const listsById = new Map();
      // Build the list structure from the synced metadata (correct ids/titles/
      // colors/order) so a board discovered here matches other devices; cards
      // then attach by their list id below. Legacy indexes (no meta) keep the
      // old heading/card-derived reconstruction.
      const listMeta = decodeListMeta(markdown);
      const metaLists = listMeta && Array.isArray(listMeta.lists) ? listMeta.lists : null;
      const metaTombstones = new Set(listMeta && Array.isArray(listMeta.deleted) ? listMeta.deleted : []);
      board.deletedListIds = Array.from(metaTombstones);
      if (metaLists && metaLists.length) {
        for (const entry of metaLists) {
          if (!entry || !entry.i || listsById.has(entry.i) || metaTombstones.has(entry.i)) continue;
          const list = { id: entry.i, title: entry.t || "List", color: cleanColor(entry.c) || this.defaultListColor(board.lists.length), cardIds: [] };
          listsById.set(entry.i, list);
          board.lists.push(list);
        }
      }
      const sectionMatches = Array.from(markdown.matchAll(/^##\s+(.+)$/gm));
      let restoredCards = 0;

      for (let index = 0; index < sectionMatches.length; index += 1) {
        const match = sectionMatches[index];
        const next = sectionMatches[index + 1];
        const title = textLine(match[1]) || "Untitled list";
        const body = markdown.slice(match.index + match[0].length, next ? next.index : markdown.length);
        const links = Array.from(body.matchAll(/\[\[([^|\]]+)(?:\|[^\]]+)?\]\]/g));
        const fallbackList = { id: uid("list"), title, color: this.defaultListColor(board.lists.length), cardIds: [] };
        const listCountBefore = board.lists.length;

        for (const link of links) {
          const target = link[1].endsWith(".md") ? link[1] : `${link[1]}.md`;
          const cardFile = this.app.vault.getAbstractFileByPath(target);
          if (!cardFile || cardFile.extension !== "md") continue;

          const parsed = parseCardMarkdown(await this.app.vault.read(cardFile));
          if (parsed.boardId) board.id = parsed.boardId;
          const listId = parsed.listId || uid("list");
          // With metadata present, NEVER create a list from a card link — the
          // meta is authoritative, and a card with a divergent list id must not
          // spawn a duplicate. It falls back to a real list on card import.
          if (!metaLists && !listsById.has(listId)) {
            const list = { id: listId, title, color: this.defaultListColor(board.lists.length), cardIds: [] };
            listsById.set(listId, list);
            board.lists.push(list);
          }
          restoredCards += 1;
        }

        if (!metaLists && explicitIndex && board.lists.length === listCountBefore) board.lists.push(fallbackList);
      }

      if (!explicitIndex && !restoredCards && !(metaLists && metaLists.length)) continue;
      this.data.boards.push(board);
      knownFolders.add(folderPath);
      changed = true;
    }

    return changed;
  }

  /**
   * Cleans duplicate labels by case-insensitive name while preserving color.
   */
  normalizeGlobalLabels(labels) {
    const seen = new Set();
    return (labels || [])
      .map((label) => ({
        name: cleanLabelName(label),
        color: label && label.color ? label.color : "#d43c35",
      }))
      .filter((label) => label.name)
      .filter((label) => {
        const key = labelKey(label);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }

  ensureGlobalLabel(label) {
    this.data.labels = this.normalizeGlobalLabels(this.data.labels);

    const cleanLabel = {
      name: cleanLabelName(label),
      color: label && label.color ? label.color : "#d43c35",
    };
    if (!cleanLabel.name) return null;

    const existing = this.data.labels.find((item) => labelKey(item) === labelKey(cleanLabel));
    if (existing) return existing;

    this.data.labels.push(cleanLabel);
    return cleanLabel;
  }

  /**
   * Normalizes a card's label list and registers every label globally.
   */
  normalizeCardLabels(labels) {
    const seen = new Set();
    return (labels || [])
      .map((label) => this.ensureGlobalLabel(label))
      .filter(Boolean)
      .filter((label) => {
        const key = labelKey(label);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
  }

  findList(listId, board = this.getBoard()) {
    if (!listId) return null;
    const boards = board ? [board] : this.data.boards;
    for (const item of boards) {
      const list = item.lists.find((candidate) => candidate.id === listId);
      if (list) return list;
    }
    return null;
  }

  findListByCard(cardId, board = this.getBoard()) {
    if (!cardId || !board) return null;
    return board.lists.find((list) => list.cardIds.includes(cardId)) || null;
  }

  refreshViews() {
    this.updateExplorerColors();
    this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach((leaf) => {
      if (leaf.view && leaf.view.render) leaf.view.render();
    });
  }

  getSyncDeckPlugin() {
    const plugins = this.app.plugins && this.app.plugins.plugins;
    return (plugins && plugins["sync-deck"]) || null;
  }

  // Open the Sync Deck panel (cloud sync for boards + vaults). If Sync Deck isn't
  // installed, point the user at it.
  async openSyncDeck() {
    const syncDeck = this.getSyncDeckPlugin();
    if (!syncDeck || typeof syncDeck.activateView !== "function") {
      new Notice("Install the Sync Deck plugin to sync your boards and vaults across devices.");
      window.open("https://github.com/ismailivanov/SyncDeck");
      return;
    }
    try {
      await syncDeck.activateView();
    } catch (error) {
      new Notice("Could not open Sync Deck.");
    }
  }

  // Free Sync Deck accounts can only sync a limited number of boards. The gate
  // applies ONLY when Sync Deck is installed AND signed in AND on the free plan,
  // so a standalone Task Deck (no cloud account) stays unlimited. Pro or an
  // unset/null limit => unlimited. Existing boards are never removed; only NEW
  // board creation past the limit is blocked.
  boardGate() {
    const syncDeck = this.getSyncDeckPlugin();
    const sd = syncDeck && syncDeck.data;
    // The board limit only applies to SYNCED boards: it bites only when the user
    // is signed in AND actively syncing on the free plan. Not syncing (sync off
    // or no Sync Deck account) => unlimited local boards.
    if (!sd || !sd.signedIn || !sd.syncEnabled) return { limited: false, limit: null };
    const limit = sd.boardLimit;
    if (sd.plan === "pro" || limit === null || limit === undefined || !Number.isFinite(Number(limit))) {
      return { limited: false, limit: null };
    }
    return { limited: true, limit: Number(limit) };
  }

  // True (and warns) when the free board limit is already reached.
  boardLimitReached(notify) {
    const gate = this.boardGate();
    if (!gate.limited || this.data.boards.length < gate.limit) return false;
    if (notify) {
      new Notice(`While syncing, the free plan covers ${gate.limit} board${gate.limit === 1 ? "" : "s"}. Upgrade Sync Deck to Pro to sync more.`);
    }
    return true;
  }

  getSyncDeckBridge() {
    const syncDeck = this.getSyncDeckPlugin();
    const data = syncDeck && syncDeck.data;
    if (!syncDeck || typeof syncDeck.api !== "function") return null;
    if (!data || !data.signedIn || !data.authToken || !data.vaultId) return null;
    return syncDeck;
  }

  // Assignable users = the SyncDeck vault members. Empty when SyncDeck is not
  // installed/signed in (the assignee UI then just shows nothing to assign).
  getVaultMembers() {
    const syncDeck = this.getSyncDeckPlugin();
    const members = syncDeck && syncDeck.data && syncDeck.data.members;
    if (!Array.isArray(members)) return [];
    return members
      .filter((m) => m && m.email)
      .map((m) => ({ email: m.email, name: m.name || m.email, color: m.color || "#8b5cf6", picture: m.picture || "" }));
  }

  // The avatar picture for an assignee, resolved live from SyncDeck (not stored
  // in the card frontmatter, since the URL can change/expire).
  getMemberPicture(email) {
    const member = this.getVaultMembers().find((m) => m.email === email);
    return (member && member.picture) || "";
  }

  normalizeAssignees(assignees) {
    const seen = new Set();
    return (Array.isArray(assignees) ? assignees : [])
      .filter((a) => a && a.email)
      .filter((a) => (seen.has(a.email) ? false : seen.add(a.email)))
      .map((a) => ({ email: String(a.email), name: a.name || a.email, color: a.color || "#8b5cf6" }));
  }

  cardImageRefs(card) {
    return imageRefsFromMarkdown(card && card.details);
  }

  resolveCardImage(card, ref) {
    const target = typeof ref === "string" ? ref : ref && ref.target;
    if (!target) return null;
    if (/^https?:\/\//i.test(target)) {
      return { src: target, name: target.split("/").pop() || "Image", file: null };
    }

    const sourcePath = (card && card.filePath) || "";
    let file = this.app.vault.getAbstractFileByPath(target);
    if (!file && this.app.metadataCache && this.app.metadataCache.getFirstLinkpathDest) {
      try {
        file = this.app.metadataCache.getFirstLinkpathDest(target, sourcePath);
      } catch (error) {
        file = null;
      }
    }
    if (!file || !isImagePath(file.path || file.name)) return null;
    return { src: this.app.vault.getResourcePath(file), name: file.name, file };
  }

  // Presence responses carry both the cursor roster (users) and the card-lock
  // roster (locks). Both helpers return { users, locks } on success, an empty
  // object-shaped roster when the bridge is unavailable (a real "nobody here"),
  // or null on a transient error so callers keep their last known state.
  async sendBoardPresence(board, point) {
    const syncDeck = this.getSyncDeckBridge();
    if (!syncDeck || !board || !point) return { users: [], locks: [] };

    try {
      const result = await syncDeck.api(`/vaults/${encodeURIComponent(syncDeck.data.vaultId)}/taskdeck/presence`, {
        method: "POST",
        body: {
          boardId: board.id,
          boardName: board.name,
          x: point.x,
          y: point.y,
          color: syncDeck.data.user.color || "#8b5cf6",
        },
      });
      return { users: result.users || [], locks: result.locks || [] };
    } catch (error) {
      return null;
    }
  }

  async fetchBoardPresence(boardId) {
    const syncDeck = this.getSyncDeckBridge();
    if (!syncDeck || !boardId) return { users: [], locks: [] };

    try {
      const result = await syncDeck.api(`/vaults/${encodeURIComponent(syncDeck.data.vaultId)}/taskdeck/presence?boardId=${encodeURIComponent(boardId)}`);
      return { users: result.users || [], locks: result.locks || [] };
    } catch (error) {
      return null;
    }
  }

  // Card edit locks ---------------------------------------------------------

  async postCardLock(boardId, cardId, action) {
    const syncDeck = this.getSyncDeckBridge();
    if (!syncDeck || !boardId || !cardId) return null;
    try {
      return await syncDeck.api(`/vaults/${encodeURIComponent(syncDeck.data.vaultId)}/taskdeck/lock`, {
        method: "POST",
        body: {
          boardId,
          cardId,
          action,
          color: syncDeck.data.user.color || "#8b5cf6",
        },
      });
    } catch (error) {
      return null;
    }
  }

  // Try to take the lock for a card. Returns { ok, lock } — ok:false means
  // someone else holds it (lock describes the holder). null means offline: we
  // fail open so a server hiccup never blocks local editing.
  async acquireCardLock(boardId, cardId) {
    const result = await this.postCardLock(boardId, cardId, "acquire");
    if (!result) return { ok: true, offline: true };
    if (Array.isArray(result.locks)) this.setCardLocks(result.locks);
    return result;
  }

  async releaseCardLock(boardId, cardId) {
    const result = await this.postCardLock(boardId, cardId, "release");
    if (result && Array.isArray(result.locks)) this.setCardLocks(result.locks);
    return result;
  }

  setCardLocks(locks) {
    const next = new Map();
    (locks || []).forEach((lock) => {
      if (lock && lock.cardId) next.set(lock.cardId, lock);
    });
    this.cardLocks = next;
  }

  // The holder if this card is being edited by someone else, otherwise null.
  getCardLockHolder(cardId) {
    return (this.cardLocks && this.cardLocks.get(cardId)) || null;
  }

  updateExplorerColors() {
    if (!this.explorerColorStyleEl) {
      this.explorerColorStyleEl = document.createElement("style");
      this.explorerColorStyleEl.id = "task-deck-explorer-colors";
      document.head.append(this.explorerColorStyleEl);
    }

    const escape = (value) => {
      if (window.CSS && window.CSS.escape) return window.CSS.escape(value);
      return String(value).replace(/["\\]/g, "\\$&");
    };
    const rules = Object.values(this.data.cards || {})
      .map((card) => {
        const board = this.findBoard(card.boardId);
        const list = this.findList(card.listId, board);
        const color = cleanColor(list && list.color);
        if (!card.filePath || !color) return "";
        const path = escape(card.filePath);
        return `.nav-file-title[data-path="${path}"]{border-left:3px solid ${color};padding-left:calc(var(--nav-item-padding-left) - 3px);}`;
      })
      .filter(Boolean);

    this.explorerColorStyleEl.textContent = rules.join("\n");
  }

  async toggleCompactLabels() {
    this.data.compactLabels = !this.data.compactLabels;
    await this.savePluginData();
    this.refreshViews();
  }

  isCardFile(file) {
    return !!this.boardForFile(file);
  }

  boardForFile(file) {
    if (!file || !file.path || file.extension !== "md") return null;
    return this.data.boards.find((board) => {
      return board.folderPath
        && file.path.startsWith(`${board.folderPath}/`)
        && file.path !== this.boardIndexPath(board)
        && file.path !== this.legacyBoardIndexPath(board);
    }) || null;
  }

  isBoardFolder(file) {
    return !!(file && file.path && this.data.boards.some((board) => board.folderPath === file.path));
  }

  removeBoardIndexCards() {
    const indexPaths = new Set();
    this.data.boards.forEach((board) => {
      indexPaths.add(this.boardIndexPath(board));
      indexPaths.add(this.legacyBoardIndexPath(board));
    });

    let changed = false;
    Object.values(this.data.cards).forEach((card) => {
      if (!indexPaths.has(card.filePath)) return;
      delete this.data.cards[card.id];
      changed = true;
    });
    if (!changed) return false;

    this.data.boards.forEach((board) => {
      board.lists.forEach((list) => {
        list.cardIds = list.cardIds.filter((cardId) => this.data.cards[cardId]);
      });
    });
    return true;
  }

  /**
   * Debounces vault events so a save/rename burst only triggers one rescan.
   */
  isBoardIndexFile(file) {
    return !!(file && file.path && file.extension === "md"
      && this.data.boards.some((board) => file.path === this.boardIndexPath(board) || file.path === this.legacyBoardIndexPath(board)));
  }

  /**
   * Re-import card notes from disk shortly after a write was skipped (or an event
   * was held back while a modal was open), so memory converges on what's actually
   * on disk. Waits until nothing is reconciling / being edited.
   */
  queueResync() {
    window.clearTimeout(this.resyncTimer);
    this.resyncTimer = window.setTimeout(async () => {
      if (this.reconciling || this.editingCardId) {
        this.queueResync(); // still busy — try again shortly
        return;
      }
      if (!this.pendingResync) return;
      this.pendingResync = false;
      try {
        await this.syncCardsFromFolder();
        await this.saveData(this.data);
      } catch (error) {
        console.error("Task Deck: resync failed", error);
      }
      this.refreshViews();
    }, 1500);
  }

  queueCardFolderSync(file, eventName) {
    // Ignore the writes our own startup reconcile makes; it re-imports at the end.
    if (this.reconciling) return;
    // Never re-import (and never advance a card's disk signature) while a card
    // modal is open — the modal holds its own copy, so importing underneath it
    // would let its next save overwrite whatever just arrived. Catch up after.
    if (this.editingCardId) {
      this.pendingResync = true;
      this.queueResync();
      return;
    }
    // Also re-sync when the board INDEX file changes, so a list add/rename/reorder
    // made on another device (which only edits the index) is picked up here.
    if (!this.isCardFile(file) && !this.isBoardFolder(file) && !this.isBoardIndexFile(file)) return;

    // Accumulate deletes across the debounce window. A single timer keyed to the
    // LAST event would drop every delete but one in a multi-file delete burst
    // (e.g. deleting a board folder with many cards, or a pull that removes
    // several), leaving stale cards that writeAllCardFiles later resurrects.
    if (eventName === "delete") {
      this.pendingCardDeletes = this.pendingCardDeletes || [];
      this.pendingCardDeletes.push(file);
    }

    window.clearTimeout(this.cardFolderSyncTimer);
    this.cardFolderSyncTimer = window.setTimeout(async () => {
      const deletes = this.pendingCardDeletes || [];
      this.pendingCardDeletes = [];
      let changed = false;
      for (const deleted of deletes) {
        if (this.removeDeletedBoardFolder(deleted)) { changed = true; continue; } // whole board folder gone
        if (this.removeDeletedBoardIndex(deleted)) { changed = true; continue; }  // board's index gone -> deleted elsewhere
        if (this.removeDeletedCardFile(deleted)) changed = true;
      }
      // Persist ONCE, after every deleted board/card is pruned. Saving per item
      // ran writeBoardIndexFiles mid-loop, which re-created (via ensureBoardFolder)
      // the folder of a board still queued for deletion — so a vault switch that
      // trashes several board folders at once bled the old vault's Task Deck
      // folders into the new one (the user had to delete them by hand).
      if (changed) await this.savePluginData();
      await this.syncCardsFromFolder();
      this.refreshViews();
    }, 250);
  }

  // Drop every board matching `predicate` and orphan-clean their cards. Returns
  // true if anything was removed.
  pruneBoardsMatching(predicate) {
    const removedBoardIds = new Set();
    this.data.boards = this.data.boards.filter((board) => {
      if (!predicate(board)) return true;
      removedBoardIds.add(board.id);
      return false;
    });
    if (!removedBoardIds.size) return false;

    Object.keys(this.data.cards).forEach((cardId) => {
      if (removedBoardIds.has(this.data.cards[cardId].boardId)) delete this.data.cards[cardId];
    });
    this.data.boards.forEach((board) => {
      board.lists.forEach((list) => {
        list.cardIds = list.cardIds.filter((cardId) => this.data.cards[cardId]);
      });
    });
    if (!this.findBoard(this.data.activeBoardId)) {
      this.data.activeBoardId = (this.data.boards[0] && this.data.boards[0].id) || "";
    }
    return true;
  }

  // Drop boards whose folder no longer exists on disk — they belong to a Sync
  // Deck vault we've switched away from. Safe because createBoard writes a board's
  // folder BEFORE its first save, so a board with no folder on disk was removed
  // externally (a switch, or a delete on another device), never a pending new one.
  pruneVanishedBoards() {
    return this.pruneBoardsMatching((board) =>
      !!board.folderPath && !this.app.vault.getAbstractFileByPath(board.folderPath));
  }

  removeDeletedBoardFolder(deletedFile) {
    const deletedPath = deletedFile && deletedFile.path;
    if (!deletedPath) return false;
    return this.pruneBoardsMatching((board) => board.folderPath === deletedPath);
  }

  // When a board's generated INDEX file is deleted, the board is gone — drop it.
  // This is the symmetric counterpart to restoreBoardsFromIndexFiles (adopt on an
  // index appearing): without it, a board deleted on one device is re-created here
  // from our own data.json and its index re-uploaded, resurrecting it for everyone
  // (Sync Deck delivers the deletion as an index-file delete, not a folder delete
  // — the emptied folder may not even be removed yet).
  //
  // Keyed ONLY on the CURRENT boardIndexPath — deliberately NOT the legacy path.
  // A board's live index is always the current path (writeBoardIndexFile writes it
  // there and cleanupBoardIndexFiles trashes the legacy `Task Deck Board.md`
  // during an unguarded save); matching the legacy path here would let that
  // self-generated cleanup delete prune a live board. A genuine deletion still
  // trashes the current index (and the folder, caught by removeDeletedBoardFolder),
  // so no real deletion is missed. A rename's stale-index cleanup is at the old
  // path, and a user's own UI delete already removed the board — neither matches.
  removeDeletedBoardIndex(deletedFile) {
    const deletedPath = deletedFile && deletedFile.path;
    if (!deletedPath) return false;
    return this.pruneBoardsMatching((board) => this.boardIndexPath(board) === deletedPath);
  }

  // In-memory only (no save) so a burst of deletes can be pruned together and
  // persisted ONCE — see the delete loop in queueCardFolderSync.
  removeDeletedCardFile(file) {
    const deletedPath = file && file.path;
    if (!deletedPath) return false;
    const card = Object.values(this.data.cards).find((item) => item.filePath === deletedPath);
    if (!card) return false;

    const board = this.findBoard(card.boardId);
    if (board) {
      board.lists.forEach((list) => {
        list.cardIds = list.cardIds.filter((cardId) => cardId !== card.id);
      });
    }
    delete this.data.cards[card.id];
    return true;
  }

  async syncCardsFromFolder(board = null) {
    const restored = board ? false : await this.restoreBoardsFromIndexFiles();
    if (restored) {
      this.ensureListColors();
      if (!this.findBoard(this.data.activeBoardId)) {
        this.data.activeBoardId = (this.data.boards[0] && this.data.boards[0].id) || "";
      }
    }

    const boards = board ? [board] : this.data.boards;
    for (const item of boards) {
      await this.syncBoardCardsFromFolder(item);
    }

    if (restored) {
      await this.savePluginData();
    }
  }

  /**
   * Imports Markdown files from a board folder into that board.
   */
  // Heal boards corrupted by an earlier bug that created a list titled with the
  // raw QUOTED frontmatter value (e.g. `"Todo"`) when a card's list id didn't
  // match. A real list title never has surrounding quotes, so such a list is
  // always spurious: merge its cards into the real same-named list (moving, not
  // deleting) and drop it; if there is no match, just strip the quotes.
  healQuotedDuplicateLists(board) {
    if (!board || !Array.isArray(board.lists)) return false;
    const isQuoted = (t) => /^".*"$|^'.*'$/.test(String(t == null ? "" : t).trim());
    const norm = (t) => String(t == null ? "" : t).replace(/^["']+|["']+$/g, "").trim().toLowerCase();
    let changed = false;
    for (const dup of board.lists.filter((l) => isQuoted(l.title))) {
      const target = board.lists.find((l) => l !== dup && !isQuoted(l.title) && norm(l.title) === norm(dup.title));
      if (target) {
        for (const cardId of dup.cardIds) {
          if (!target.cardIds.includes(cardId)) target.cardIds.push(cardId);
          const card = this.data.cards[cardId];
          if (card) card.listId = target.id;
        }
        board.lists = board.lists.filter((l) => l !== dup);
        changed = true;
      } else {
        dup.title = norm(dup.title) ? dup.title.replace(/^["']+|["']+$/g, "").trim() : dup.title;
        changed = true;
      }
    }
    return changed;
  }

  // Sync the board's list STRUCTURE from the index file (which carries list
  // id/title/color/order and syncs across devices): add lists present in the
  // index but missing here, update titles/colors, and apply the index order.
  // Conservative — it NEVER drops a list, so a device's own not-yet-synced lists
  // (and any list a delete didn't propagate) are kept, appended after the index
  // order. No list or its cards can be lost. Returns true if anything changed.
  async reconcileListsFromIndex(board) {
    if (!board || !Array.isArray(board.lists)) return false;
    const indexFile = this.app.vault.getAbstractFileByPath(this.boardIndexPath(board));
    if (!indexFile || indexFile.extension !== "md") return false;
    let markdown;
    try { markdown = await this.app.vault.read(indexFile); } catch (error) { return false; }
    const meta = decodeListMeta(markdown);
    if (!meta || !Array.isArray(meta.lists) || !meta.lists.length) return false;

    board.deletedListIds = Array.isArray(board.deletedListIds) ? board.deletedListIds : [];
    const tombstones = new Set([...board.deletedListIds, ...meta.deleted]);

    const byId = new Map(board.lists.map((l) => [l.id, l]));
    const ordered = [];
    const used = new Set();
    let changed = false;
    for (const entry of meta.lists) {
      if (!entry || !entry.i || used.has(entry.i) || tombstones.has(entry.i)) continue;
      used.add(entry.i);
      let list = byId.get(entry.i);
      if (list) {
        if (entry.t != null && list.title !== entry.t) { list.title = entry.t; changed = true; }
        const color = cleanColor(entry.c);
        if (color && list.color !== color) { list.color = color; changed = true; }
      } else {
        list = { id: entry.i, title: entry.t || "List", color: cleanColor(entry.c) || this.defaultListColor(ordered.length), cardIds: [] };
        changed = true;
      }
      ordered.push(list);
    }
    // Keep this device's own not-yet-synced lists; DROP a list deleted elsewhere.
    for (const list of board.lists) {
      if (used.has(list.id)) continue;
      if (tombstones.has(list.id)) { changed = true; continue; }
      ordered.push(list);
      used.add(list.id);
    }
    // Merge tombstone sets so deletion converges and no list resurrects. Sorted
    // so the persisted/encoded set is order-independent across devices.
    const merged = Array.from(tombstones).sort().slice(-200);
    if (merged.join("|") !== board.deletedListIds.join("|")) { board.deletedListIds = merged; changed = true; }

    const orderChanged = board.lists.map((l) => l.id).join("") !== ordered.map((l) => l.id).join("");
    if (changed || orderChanged) {
      board.lists = ordered;
      return true;
    }
    return false;
  }

  async syncBoardCardsFromFolder(board) {
    if (!board || !board.folderPath) return;
    let changed = false;
    if (this.healQuotedDuplicateLists(board)) changed = true;
    if (await this.reconcileListsFromIndex(board)) changed = true;
    const files = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!file.path.startsWith(`${board.folderPath}/`)) continue;
      if (file.path === this.boardIndexPath(board) || file.path === this.legacyBoardIndexPath(board)) continue;
      if (await this.isGeneratedBoardIndexFile(file)) continue;
      files.push(file);
    }
    if (!files.length) {
      if (changed) await this.savePluginData();
      return;
    }
    if (!board.lists.length) board.lists.push({ id: uid("list"), title: "TODO", cardIds: [] });

    for (const file of files) {
      const markdown = await this.app.vault.read(file);
      const parsed = parseCardMarkdown(markdown);
      const existingByPath = Object.values(this.data.cards).find((card) => card.filePath === file.path);
      const cardId = parsed.id || (existingByPath && existingByPath.id) || uid("card");
      const existing = this.data.cards[cardId] || existingByPath;
      // Resolve the card's list from its frontmatter id, falling back to the list
      // it is already in on this device, then the first list. We do NOT create a
      // new list from a mismatching id — list ids can differ between devices, and
      // creating one produces a duplicate list.
      const targetList = this.findList(parsed.listId, board) || this.findList(existing && existing.listId, board) || board.lists[0];
      const now = new Date().toISOString();
      const card = existing || { id: cardId, createdAt: now };

      Object.assign(card, {
        id: card.id || cardId,
        boardId: board.id,
        title: parsed.title || file.basename,
        listId: targetList.id,
        position: parsed.position !== null ? parsed.position : (card.position != null ? card.position : 0),
        labels: parsed.labels.length ? this.normalizeCardLabels(parsed.labels) : this.normalizeCardLabels(card.labels || []),
        assignees: this.normalizeAssignees(parsed.assignees !== null ? parsed.assignees : card.assignees || []),
        details: parsed.details,
        checklist: parsed.checklist,
        completed: parsed.completed !== null ? parsed.completed : !!card.completed,
        startDate: parsed.startDate !== null ? parsed.startDate : cleanDate(card.startDate),
        dueDate: parsed.dueDate !== null ? parsed.dueDate : cleanDate(card.dueDate),
        filePath: file.path,
        updatedAt: card.updatedAt || now,
      });
      // Remember exactly what this card's file looked like on disk, so a later
      // writeCardFile can tell "nothing changed" from "someone else changed it".
      this.diskSignatures.set(card.id, markdown);

      if (await this.normalizeCardFilePath(card)) changed = true;

      if (!this.data.cards[card.id]) {
        this.data.cards[card.id] = card;
        changed = true;
      }

      const currentList = this.findListByCard(card.id, board);
      if (currentList && currentList.id !== targetList.id) {
        currentList.cardIds = currentList.cardIds.filter((id) => id !== card.id);
      }
      if (!targetList.cardIds.includes(card.id)) {
        targetList.cardIds.push(card.id);
        changed = true;
      }
    }

    // Restore each list's order from the synced `position` frontmatter. Stable
    // sort, so cards that share a position (e.g. legacy files with no position)
    // keep their relative order. Only flags changed when the order actually moved.
    board.lists.forEach((list) => {
      const before = list.cardIds.join(",");
      list.cardIds.sort((a, b) => {
        const ca = this.data.cards[a];
        const cb = this.data.cards[b];
        const pa = ca && ca.position != null ? ca.position : 0;
        const pb = cb && cb.position != null ? cb.position : 0;
        return pa - pb;
      });
      if (list.cardIds.join(",") !== before) changed = true;
    });

    if (changed) await this.savePluginData();
  }

  promptText(title, placeholder, initialValue, onSubmit) {
    new TextPromptModal(this.app, title, placeholder, initialValue, onSubmit).open();
  }

  async activateView() {
    const leaves = this.app.workspace.getLeavesOfType(VIEW_TYPE);
    const leaf = leaves[0] || this.app.workspace.getLeaf(true);
    await leaf.setViewState({ type: VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  createBoardPrompt() {
    if (this.boardLimitReached(true)) return;
    this.promptText("Create board", "Board name", "", async (name) => {
      await this.createBoard(name);
    });
  }

  async createBoard(name) {
    // Safety net: never exceed the free board limit even via a non-prompt caller.
    if (this.boardLimitReached(true)) return null;
    const board = {
      id: uid("board"),
      name,
      folderPath: await this.nextBoardFolder(name),
      lists: [],
    };

    this.data.boards.push(board);
    this.data.activeBoardId = board.id;
    await this.ensureBoardFolder(board);
    await this.savePluginData();
    this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach((leaf) => {
      if (leaf.view) leaf.view.showingBoardHome = false;
    });
    this.refreshViews();
  }

  async setActiveBoard(boardId) {
    if (!this.findBoard(boardId)) return;
    this.data.activeBoardId = boardId;
    await this.syncCardsFromFolder(this.getBoard());
    await this.savePluginData();
    this.refreshViews();
  }

  renameBoard(boardId) {
    const board = this.findBoard(boardId);
    if (!board) return;

    this.promptText("Rename board", "Board name", board.name, async (name) => {
      await this.renameBoardTo(board, name);
    });
  }

  async renameBoardTo(board, name) {
    const nextFolder = await this.nextBoardFolder(name, board.folderPath);
    if (nextFolder !== board.folderPath) {
      const folder = this.app.vault.getAbstractFileByPath(board.folderPath);
      if (folder) await this.app.vault.rename(folder, nextFolder);
      Object.values(this.data.cards).forEach((card) => {
        if (card.boardId === board.id && card.filePath && card.filePath.startsWith(`${board.folderPath}/`)) {
          card.filePath = `${nextFolder}/${card.filePath.slice(board.folderPath.length + 1)}`;
        }
      });
      board.folderPath = nextFolder;
    }

    board.name = name;
    await this.savePluginData();
    this.refreshViews();
  }

  addList() {
    if (!this.getBoard()) {
      this.createBoardPrompt();
      return;
    }

    this.promptText("Add list", "List name", "", async (title) => {
      const board = this.getBoard();
      board.lists.push({ id: uid("list"), title, color: this.defaultListColor(board.lists.length), cardIds: [] });
      await this.savePluginData();
      this.refreshViews();
    });
  }

  renameList(listId) {
    const list = this.findList(listId);
    if (!list) return;

    this.promptText("Rename list", "List name", list.title, async (title) => {
      list.title = title;
      await this.writeCardsForList(list);
      await this.savePluginData();
      this.refreshViews();
    });
  }

  async cycleListColor(listId) {
    const list = this.findList(listId);
    if (!list) return;

    const current = LIST_COLORS.indexOf(cleanColor(list.color));
    await this.setListColor(listId, LIST_COLORS[(current + 1) % LIST_COLORS.length]);
  }

  async setListColor(listId, color) {
    const list = this.findList(listId);
    const clean = cleanColor(color);
    if (!list || !clean) return;

    list.color = clean;
    await this.writeCardsForList(list);
    await this.savePluginData();
    this.refreshViews();
  }

  async writeCardsForList(list) {
    for (const cardId of list.cardIds) {
      const card = this.data.cards[cardId];
      if (card) await this.writeCardFile(card);
    }
  }

  async writeAllCardFiles() {
    for (const card of Object.values(this.data.cards)) {
      await this.writeCardFile(card, { bulk: true });
    }
  }

  async deleteList(listId) {
    const board = this.getBoard();
    const list = this.findList(listId);
    if (!board || !list) return;

    const message = list.cardIds.length
      ? `Delete "${list.title}" and its ${list.cardIds.length} cards?`
      : `Delete "${list.title}"?`;
    if (!window.confirm(message)) return;

    for (const cardId of list.cardIds) {
      await this.deleteCard(cardId, false);
    }
    board.lists = board.lists.filter((item) => item.id !== listId);
    // Tombstone the deletion so it syncs (via the index) and the list never
    // resurrects from another device that still has it.
    board.deletedListIds = Array.isArray(board.deletedListIds) ? board.deletedListIds : [];
    if (!board.deletedListIds.includes(listId)) board.deletedListIds = [...board.deletedListIds, listId].slice(-200);
    await this.savePluginData();
    this.refreshViews();
  }

  async addCard(listId) {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      await this.activateView();
      leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    }

    if (leaf && leaf.view && leaf.view.showCardComposer) {
      leaf.view.showCardComposer(listId);
    }
  }

  /**
   * Creates a card at the top of a list and immediately writes its note file.
   */
  async createCard(listId, title) {
    const board = this.data.boards.find((item) => item.lists.some((list) => list.id === listId));
    const list = this.findList(listId, board);
    if (!board || !list) return;

    const now = new Date().toISOString();
    const card = {
      id: uid("card"),
      boardId: board.id,
      title,
      listId,
      labels: [],
      assignees: [],
      details: "",
      checklist: [],
      completed: false,
      startDate: "",
      dueDate: "",
      filePath: await this.nextCardPath(title, null, board),
      createdAt: now,
      updatedAt: now,
    };

    this.data.cards[card.id] = card;
    list.cardIds.unshift(card.id);
    // Inserting at the top shifts every other card's index, so rewrite the whole
    // list's files to keep their `position` frontmatter in sync (not just the new
    // card) — otherwise the new order wouldn't propagate to other devices.
    await this.writeListCardFiles(list);
    await this.savePluginData();
    this.refreshViews();
  }

  /**
   * Applies a card patch, including linked file renames when the title changes.
   */
  async updateCard(cardId, patch, globalLabels) {
    const card = this.data.cards[cardId];
    if (!card) return;

    if (globalLabels) this.data.labels = this.normalizeGlobalLabels(globalLabels);
    if (patch.labels) patch.labels = this.normalizeCardLabels(patch.labels);
    if (Object.prototype.hasOwnProperty.call(patch, "assignees")) patch.assignees = this.normalizeAssignees(patch.assignees);
    if (Object.prototype.hasOwnProperty.call(patch, "completed")) patch.completed = !!patch.completed;
    if (Object.prototype.hasOwnProperty.call(patch, "startDate")) patch.startDate = cleanDate(patch.startDate);
    if (Object.prototype.hasOwnProperty.call(patch, "dueDate")) patch.dueDate = cleanDate(patch.dueDate);
    if (patch.title && textLine(patch.title) !== textLine(card.title)) {
      await this.renameCardFile(card, patch.title);
    }
    Object.assign(card, patch, { updatedAt: new Date().toISOString() });
    await this.writeCardFile(card);
    await this.savePluginData();
    this.refreshViews();
  }

  /**
   * Moves a card between lists or before another card, then updates its note
   * frontmatter with the new list id.
   */
  async moveCard(cardId, targetListId, beforeCardId) {
    if (!cardId || cardId === beforeCardId) return;
    const targetBoard = this.data.boards.find((board) => board.lists.some((list) => list.id === targetListId));
    const targetList = this.findList(targetListId, targetBoard);
    const card = this.data.cards[cardId];
    if (!targetBoard || !targetList || !card) return;

    // Remember where it came from so we can rewrite that list's order too.
    const sourceList = this.data.boards.flatMap((board) => board.lists).find((list) => list.cardIds.includes(cardId)) || null;

    this.data.boards.forEach((board) => board.lists.forEach((list) => {
      list.cardIds = list.cardIds.filter((id) => id !== cardId);
    }));

    const beforeIndex = beforeCardId ? targetList.cardIds.indexOf(beforeCardId) : -1;
    if (beforeIndex === -1) {
      targetList.cardIds.push(cardId);
    } else {
      targetList.cardIds.splice(beforeIndex, 0, cardId);
    }

    card.boardId = targetBoard.id;
    card.listId = targetListId;
    // Persist the new order: rewrite every card in the affected list(s) so their
    // `position` frontmatter reflects the new order and syncs to other devices.
    await this.writeListCardFiles(targetList);
    if (sourceList && sourceList.id !== targetList.id) await this.writeListCardFiles(sourceList);
    await this.savePluginData();
    this.refreshViews();
  }

  // Rewrite the .md of every card in a list so their `position` frontmatter
  // matches the list's current order.
  async writeListCardFiles(list) {
    for (const id of list.cardIds) {
      const c = this.data.cards[id];
      if (c) await this.writeCardFile(c);
    }
  }

  async moveList(listId, targetListId, afterTarget = false) {
    if (!listId || listId === targetListId) return;

    const board = this.getBoard();
    if (!board) return;
    const fromIndex = board.lists.findIndex((list) => list.id === listId);
    if (fromIndex === -1) return;

    const [list] = board.lists.splice(fromIndex, 1);
    const targetIndex = board.lists.findIndex((item) => item.id === targetListId);
    if (targetIndex === -1) {
      board.lists.push(list);
    } else {
      board.lists.splice(targetIndex + (afterTarget ? 1 : 0), 0, list);
    }

    await this.savePluginData();
    this.refreshViews();
  }

  async toggleCardCompleted(cardId) {
    const card = this.data.cards[cardId];
    if (!card) return;
    const completed = !card.completed;
    if (completed) {
      this.completedAnimationCardId = cardId;
      if (this.data.completionSound) this.playCompletionSound();
    } else if (this.completedAnimationCardId === cardId) {
      this.completedAnimationCardId = null;
    }
    await this.updateCard(cardId, { completed });
  }

  playCompletionSound() {
    try {
      const audio = new Audio(COMPLETION_SOUND_URL);
      audio.volume = 0.6;
      const play = audio.play();
      if (play && play.catch) play.catch(() => {});
    } catch (error) {
      // Sound is a small optional cue; completion should never fail because of it.
    }
  }

  /**
   * Removes a card from all lists and trashes its linked Markdown note.
   */
  async deleteCard(cardId, saveAndRefresh = true) {
    const card = this.data.cards[cardId];
    if (!card) return;

    this.data.boards.forEach((board) => board.lists.forEach((list) => {
      list.cardIds = list.cardIds.filter((id) => id !== cardId);
    }));

    const file = this.app.vault.getAbstractFileByPath(card.filePath);
    if (file) await this.app.vault.trash(file, true);
    delete this.data.cards[cardId];

    if (saveAndRefresh) {
      await this.savePluginData();
      this.refreshViews();
    }
  }

  /**
   * Refreshes a card from its Markdown note before opening the edit modal.
   */
  async hydrateCardFromFile(card) {
    const file = this.app.vault.getAbstractFileByPath(card.filePath);
    if (!file || file.extension !== "md") return;

    const markdown = await this.app.vault.read(file);
    const parsed = parseCardMarkdown(markdown);
    card.title = parsed.title || card.title;
    card.labels = parsed.labels.length ? this.normalizeCardLabels(parsed.labels) : this.normalizeCardLabels(card.labels || []);
    if (parsed.assignees !== null) card.assignees = parsed.assignees;
    if (parsed.completed !== null) card.completed = parsed.completed;
    if (parsed.startDate !== null) card.startDate = parsed.startDate;
    if (parsed.dueDate !== null) card.dueDate = parsed.dueDate;
    if (parsed.position !== null) card.position = parsed.position;
    card.details = parsed.details;
    card.checklist = parsed.checklist;
    this.diskSignatures.set(card.id, markdown);
  }

  async openCardFile(cardId) {
    const card = this.data.cards[cardId];
    if (!card) return;

    await this.writeCardFile(card);
    const file = this.app.vault.getAbstractFileByPath(card.filePath);
    if (!file) return;

    await this.app.workspace.getLeaf(false).openFile(file);
  }

  async ensureBoardFolder(board) {
    if (!board) return;
    if (!board.folderPath) board.folderPath = await this.nextBoardFolder(board.name);
    if (!this.app.vault.getAbstractFileByPath(board.folderPath)) {
      await this.app.vault.createFolder(board.folderPath);
    }
  }

  async nextBoardFolder(name, currentPath) {
    const base = cardFileBaseName(name || "Task Board");
    let path = base;
    let index = 2;
    while (path !== currentPath && this.app.vault.getAbstractFileByPath(path)) {
      path = `${base} ${index}`;
      index += 1;
    }
    return path;
  }

  /**
   * Finds a unique path in a board folder, allowing the current path during rename.
   */
  async nextCardPath(title, currentPath, board = null) {
    const targetBoard = board || this.findBoardForCard(Object.values(this.data.cards).find((card) => card.filePath === currentPath)) || this.getBoard();
    if (!targetBoard) return `${cardFileBaseName(title)}.md`;
    await this.ensureBoardFolder(targetBoard);

    // Card notes live in a "cards" subfolder so the board root stays tidy
    // (index + cards/ + attachments/), Trello-like.
    const cardsDir = `${targetBoard.folderPath}/cards`;
    if (!this.app.vault.getAbstractFileByPath(cardsDir)) {
      await this.app.vault.createFolder(cardsDir).catch(() => {});
    }

    const base = cardFileBaseName(title);
    let path = `${cardsDir}/${base}.md`;
    let index = 2;
    while (path !== currentPath && this.app.vault.getAbstractFileByPath(path)) {
      path = `${cardsDir}/${base} ${index}.md`;
      index += 1;
    }
    return path;
  }

  /**
   * Two card files sharing one kanban-card-id are the SAME card — e.g. a move
   * that Sync Deck (a generic file syncer with no rename concept) split into a
   * create+delete across devices, leaving a duplicate. Keep one canonical file
   * and send the rest to the recoverable trash. The winner is chosen
   * deterministically (device-independent) so peers converge instead of fight.
   */
  async dedupeCardFilesById() {
    const byId = new Map();
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!this.boardForFile(file)) continue; // only card files (never the index)
      let id = "";
      try { id = parseCardMarkdown(await this.app.vault.read(file)).id || ""; } catch (error) { id = ""; }
      if (!id) continue;
      if (!byId.has(id)) byId.set(id, []);
      byId.get(id).push(file);
    }

    let changed = false;
    for (const [id, files] of byId) {
      if (files.length < 2) continue;
      // Prefer a file under cards/, then the shortest path, then lexicographic —
      // all device-independent, so every device keeps the same one.
      files.sort((a, b) => {
        const aCards = /(^|\/)cards\//.test(a.path) ? 0 : 1;
        const bCards = /(^|\/)cards\//.test(b.path) ? 0 : 1;
        if (aCards !== bCards) return aCards - bCards;
        if (a.path.length !== b.path.length) return a.path.length - b.path.length;
        return a.path < b.path ? -1 : 1;
      });
      const keep = files[0];
      const card = this.data.cards[id];
      if (card) card.filePath = keep.path;
      for (let i = 1; i < files.length; i += 1) {
        try {
          await this.app.vault.trash(files[i], false); // recoverable vault .trash
          changed = true;
        } catch (error) {
          console.error("Task Deck: could not de-duplicate card file", files[i].path, error);
        }
      }
    }
    return changed;
  }

  async normalizeCardFilePaths() {
    let changed = false;
    for (const card of Object.values(this.data.cards)) {
      if (await this.normalizeCardFilePath(card)) changed = true;
    }
    return changed;
  }

  async normalizeCardFilePath(card) {
    if (!card || !card.title || !card.filePath) return false;

    const file = this.app.vault.getAbstractFileByPath(card.filePath);
    if (!file || file.extension !== "md") return false;

    const board = this.findBoardForCard(card);

    // If a DIFFERENT file already sits at this card's plain target and carries THIS
    // card's id, it's the same card that arrived as a create+delete from a sync
    // (which has no rename concept). Adopt it and trash our copy — never bump to
    // "<title> 2.md", which would mint a permanent cross-device duplicate.
    const desired = board && board.folderPath
      ? `${board.folderPath}/cards/${cardFileBaseName(card.title)}.md`
      : `${cardFileBaseName(card.title)}.md`;
    if (desired !== card.filePath) {
      const occupant = this.app.vault.getAbstractFileByPath(desired);
      if (occupant && occupant.path !== card.filePath && occupant.extension === "md") {
        let occId = "";
        try { occId = parseCardMarkdown(await this.app.vault.read(occupant)).id || ""; } catch (error) { occId = ""; }
        if (occId && occId === card.id) {
          await this.app.vault.trash(file, false); // recoverable
          card.filePath = desired;
          return true;
        }
      }
    }

    const nextPath = await this.nextCardPath(card.title, card.filePath, board);
    if (nextPath === card.filePath) return false;

    await this.app.vault.rename(file, nextPath);
    card.filePath = nextPath;
    return true;
  }

  /**
   * One-time: moves loose board media (images/videos pasted before the
   * cards/attachments layout) into <board>/attachments and repoints the card
   * links that used a full path. Card notes are relocated separately by
   * normalizeCardFilePaths. Must run AFTER syncCardsFromFolder and BEFORE
   * writeAllCardFiles so the rewritten details are the ones persisted.
   */
  async migrateExistingMedia() {
    let moved = false;
    for (const board of this.data.boards) {
      if (await this.migrateBoardMedia(board)) moved = true;
    }
    return moved;
  }

  async migrateBoardMedia(board) {
    if (!board || !board.folderPath) return false;
    const root = this.app.vault.getAbstractFileByPath(board.folderPath);
    if (!root || !root.children) return false;
    const attachDir = `${board.folderPath}/attachments`;

    // Loose (non-Markdown) files sitting directly in the board root — don't
    // descend into subfolders (cards, attachments, nested boards, or media the
    // user organised themselves).
    const looseRoot = new Set(
      (root.children || [])
        .filter((child) => !child.children && child.extension && child.extension.toLowerCase() !== "md")
        .map((child) => child.path)
    );
    if (!looseRoot.size) return false;

    // Build the plan from EVERY embed (image or not) that still resolves to a
    // loose root file, resolving BEFORE moving so basename lookups can't drift.
    // We move ONLY files a card actually references here — so every moved file's
    // link can be fixed, and a file whose card already points into attachments/
    // (e.g. a peer already migrated it) is never re-moved.
    const embedRe = /!\[\[([^\]]+)\]\]|!\[[^\]]*\]\(([^)]+)\)/g;
    const plan = [];
    const toMove = new Set();
    for (const card of Object.values(this.data.cards)) {
      if (!card || !card.details) continue;
      let match;
      embedRe.lastIndex = 0;
      while ((match = embedRe.exec(card.details))) {
        const isWiki = match[1] !== undefined;
        let target = (isWiki ? match[1] : match[2]) || "";
        target = target.split("|")[0].split("#")[0].trim();
        if (!isWiki) target = target.split(/\s+/)[0];
        const file = this.resolveEmbedFile(card, target);
        if (file && looseRoot.has(file.path)) {
          plan.push({ card, markup: match[0], oldPath: file.path });
          toMove.add(file.path);
        }
      }
    }
    if (!toMove.size) return false;

    if (!this.app.vault.getAbstractFileByPath(attachDir)) {
      await this.app.vault.createFolder(attachDir).catch(() => {});
    }

    // Move each referenced file into attachments/, recording old -> new. If a
    // file of that name is already there (e.g. a synced peer already migrated
    // it), leave the loose file alone rather than creating a deduped duplicate —
    // its link stays valid and sync converges on its own.
    const newPathByOld = {};
    let moved = false;
    for (const oldPath of toMove) {
      const file = this.app.vault.getAbstractFileByPath(oldPath);
      if (!file) continue;
      const dest = `${attachDir}/${file.name}`;
      if (dest === oldPath || this.app.vault.getAbstractFileByPath(dest)) continue;
      try {
        await this.app.vault.rename(file, dest);
        newPathByOld[oldPath] = dest;
        moved = true;
      } catch (error) {
        console.error("Task Deck: could not move media", oldPath, error);
      }
    }

    // Repoint every referencing embed to its file's new path, by exact markup.
    plan.forEach(({ card, markup, oldPath }) => {
      const dest = newPathByOld[oldPath];
      if (!dest || dest === oldPath) return;
      card.details = card.details.split(markup).join(`![[${dest}]]`);
    });

    return moved;
  }

  // Resolve an embed target (any file type) to a vault TFile, tolerating
  // URL-encoded Markdown-link paths. Returns null for URLs / unresolved links.
  resolveEmbedFile(card, target) {
    if (!target || /^https?:\/\//i.test(target)) return null;
    const sourcePath = (card && card.filePath) || "";
    const lookup = (value) => {
      let file = this.app.vault.getAbstractFileByPath(value);
      if (!file && this.app.metadataCache && this.app.metadataCache.getFirstLinkpathDest) {
        try { file = this.app.metadataCache.getFirstLinkpathDest(value, sourcePath); } catch (error) { file = null; }
      }
      return file && file.path ? file : null;
    };
    let file = lookup(target);
    if (!file) {
      try { file = lookup(decodeURIComponent(target)); } catch (error) { file = null; }
    }
    return file;
  }

  async renameCardFile(card, title) {
    const nextPath = await this.nextCardPath(title, card.filePath, this.findBoardForCard(card));
    if (nextPath === card.filePath) return;

    const file = this.app.vault.getAbstractFileByPath(card.filePath);
    if (file && file.extension === "md") {
      await this.app.vault.rename(file, nextPath);
    }
    card.filePath = nextPath;
  }

  cardWikiLink(card) {
    if (!card || !card.filePath) return "";

    const target = card.filePath.replace(/\.md$/i, "");
    const alias = textLine(card.title || target.split("/").pop()).replace(/[|[\]]/g, " ");
    return `[[${target}|${alias}]]`;
  }

  /**
   * Keeps card notes connected in Obsidian's graph without adding extra text to
   * every card file.
   */
  async writeBoardIndexFiles() {
    for (const board of this.data.boards) {
      await this.writeBoardIndexFile(board);
    }
    await this.cleanupOrphanBoardIndexFiles();
    this.updateExplorerColors();
  }

  async writeBoardIndexFile(board) {
    if (!board) return;
    await this.ensureBoardFolder(board);

    const lines = [
      "---",
      "task-deck-board: true",
      `task-deck-board-id: ${board.id}`,
      "---",
      "",
      `# ${textLine(board.name)}`,
      "",
      BOARD_INDEX_MARKER,
      // Machine-readable list structure (id/title/color/order) + deleted-list
      // tombstones so lists sync (incl. deletion) across devices. Invisible in
      // preview; the headings below stay readable.
      `<!--task-deck-lists:${encodeListMeta(board.lists, board.deletedListIds)}-->`,
      "",
    ];

    board.lists.forEach((list) => {
      lines.push(`## ${textLine(list.title) || "Untitled list"}`, "");
      const cards = list.cardIds.map((cardId) => this.data.cards[cardId]).filter(Boolean);
      if (cards.length) {
        cards.forEach((card) => lines.push(`- ${this.cardWikiLink(card)}`));
      } else {
        lines.push("- No cards");
      }
      lines.push("");
    });

    const markdown = lines.join("\n");
    const file = this.app.vault.getAbstractFileByPath(this.boardIndexPath(board));
    if (file && file.extension === "md") {
      // Only rewrite when content actually changed. Rewriting an identical index
      // would re-upload it and re-trigger the peer's reconcile, causing endless
      // index churn between two devices.
      let current = null;
      try { current = await this.app.vault.read(file); } catch (error) { current = null; }
      if (current !== markdown) await this.app.vault.modify(file, markdown);
    } else if (!file) {
      await this.app.vault.create(this.boardIndexPath(board), markdown);
    }
    await this.cleanupBoardIndexFiles(board);
  }

  async cleanupBoardIndexFiles(board) {
    const currentPath = this.boardIndexPath(board);
    const files = this.app.vault.getMarkdownFiles().filter((file) => {
      return file.path.startsWith(`${board.folderPath}/`) && file.path !== currentPath;
    });

    for (const file of files) {
      if (await this.isGeneratedBoardIndexFile(file)) await this.app.vault.trash(file, true);
    }
  }

  async cleanupOrphanBoardIndexFiles() {
    // A generated board index whose folder has no board in THIS device's
    // data.json is almost always a board just delivered by sync that we haven't
    // imported yet — NOT junk. We used to trash it here, which was catastrophic:
    // it destroyed the only cross-device carrier of the board's definition, and
    // because Sync Deck propagates local deletes, that delete flowed back to the
    // server and every other device — leaving the board's cards behind as an
    // invisible, board-less folder everywhere. (restoreBoardsFromIndexFiles only
    // runs in the one-time reconcile, so an index that syncs in later, or a
    // savePluginData that races ahead of the reconcile, hit this cleanup first.)
    //
    // Adopt the orphan instead: restore the board from its index. It reuses the
    // board id from the cards, so the adopted board matches other devices. A real
    // board deletion removes the folder + index explicitly and propagates, so
    // nothing legitimately orphaned lingers here for us to clean.
    const activeFolders = new Set(this.data.boards.map((board) => board.folderPath).filter(Boolean));
    const orphanGenerated = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!this.isPotentialBoardIndexFile(file)) continue;
      const folderPath = file.path.split("/").slice(0, -1).join("/");
      if (activeFolders.has(folderPath)) continue;
      if (await this.isGeneratedBoardIndexFile(file)) orphanGenerated.push(file);
    }
    if (!orphanGenerated.length) return;

    const restored = await this.restoreBoardsFromIndexFiles();
    if (restored) {
      await this.saveData(this.data);
      this.refreshViews();
    }
  }

  frontmatterText(value) {
    return JSON.stringify(textLine(value));
  }

  taskDeckTag(board, list) {
    if (!board || !list) return "";
    return taskDeckListTag(board.name, list.title);
  }

  extractTags(markdown) {
    const frontmatter = String(markdown || "").match(/^---\n([\s\S]*?)\n---/);
    if (!frontmatter) return [];

    const lines = frontmatter[1].split(/\r?\n/);
    const tags = [];
    for (let index = 0; index < lines.length; index += 1) {
      const match = lines[index].match(/^tags:\s*(.*)$/);
      if (!match) continue;

      const value = match[1].trim();
      if (value.startsWith("[") && value.endsWith("]")) {
        value.slice(1, -1).split(",").forEach((part) => tags.push(part.trim().replace(/^["'#]+|["']+$/g, "")));
        break;
      }
      if (value) {
        value.split(/[,\s]+/).forEach((part) => tags.push(part.trim().replace(/^#/, "")));
        break;
      }
      for (let itemIndex = index + 1; itemIndex < lines.length; itemIndex += 1) {
        const item = lines[itemIndex].match(/^\s*-\s*(.+)$/);
        if (!item) break;
        tags.push(item[1].trim().replace(/^["'#]+|["']+$/g, ""));
      }
      break;
    }

    return tags.filter(Boolean);
  }

  async cardTags(card, taskTag) {
    const file = this.app.vault.getAbstractFileByPath(card.filePath);
    const existing = file && file.extension === "md" ? this.extractTags(await this.app.vault.read(file)) : [];
    const tags = existing.filter((tag) => !tag.startsWith("task-deck/"));
    if (taskTag) tags.push(taskTag);
    return Array.from(new Set(tags));
  }

  tagFrontmatter(tags) {
    if (!tags.length) return "tags: []";
    return `tags: [${tags.map((tag) => JSON.stringify(tag)).join(", ")}]`;
  }

  graphColorGroup(board, list) {
    const tag = this.taskDeckTag(board, list);
    const color = cleanColor(list && list.color);
    if (!tag || !color) return null;

    return {
      query: `tag:#${tag}`,
      color: {
        a: 1,
        rgb: parseInt(color.slice(1), 16),
      },
    };
  }

  async syncGraphColorGroups() {
    const adapter = this.app.vault.adapter;
    if (!adapter || !adapter.exists || !adapter.read || !adapter.write) return;

    const graphPath = `${this.app.vault.configDir || ".obsidian"}/graph.json`;
    const exists = await adapter.exists(graphPath);
    const graph = exists ? JSON.parse(await adapter.read(graphPath)) : {};
    const existing = Array.isArray(graph.colorGroups) ? graph.colorGroups : [];
    const keep = existing.filter((group) => !(group && String(group.query || "").startsWith("tag:#task-deck/")));
    const taskDeckGroups = [];

    this.data.boards.forEach((board) => {
      board.lists.forEach((list) => {
        if (!list.cardIds.length) return;
        const group = this.graphColorGroup(board, list);
        if (group) taskDeckGroups.push(group);
      });
    });

    graph["collapse-color-groups"] = false;
    graph.colorGroups = keep.concat(taskDeckGroups);
    await adapter.write(graphPath, JSON.stringify(graph, null, 2));
  }

  /**
   * Writes the card note used by both Obsidian and Task Deck.
   *
   * Frontmatter stores board metadata. The Details and Checklist sections stay
   * as normal Markdown so users can edit card content directly in the vault.
   */
  async writeCardFile(card, options = {}) {
    const board = this.findBoardForCard(card);
    if (board) card.boardId = board.id;
    await this.ensureBoardFolder(board);
    const list = this.findList(card.listId, board);
    const tags = await this.cardTags(card, this.taskDeckTag(board, list));
    // Position within the list, from the live cardIds order. This is the ONLY
    // place card order is persisted to a synced file (data.json order does not
    // sync), so the other device can restore the same order.
    const position = list ? list.cardIds.indexOf(card.id) : -1;

    const markdown = [
      "---",
      `kanban-card-id: ${card.id}`,
      `kanban-board-id: ${card.boardId || ""}`,
      `kanban-list-id: ${card.listId || ""}`,
      `position: ${position >= 0 ? position : 0}`,
      this.tagFrontmatter(tags),
      `task-deck-board: ${this.frontmatterText(board && board.name)}`,
      `task-deck-list: ${this.frontmatterText(list && list.title)}`,
      `task-deck-list-color: ${this.frontmatterText(cleanColor(list && list.color))}`,
      `labels: ${labelsToFrontmatter(card.labels)}`,
      `assignees: ${assigneesToFrontmatter(card.assignees)}`,
      `completed: ${card.completed ? "true" : "false"}`,
      `start: ${cleanDate(card.startDate)}`,
      `due: ${cleanDate(card.dueDate)}`,
      "---",
      "",
      `# ${textLine(card.title)}`,
      "",
      "## Details",
      card.details || "",
      "",
      "## Checklist",
      checklistToMarkdown(card.checklist),
      "",
    ].join("\n");

    const file = this.app.vault.getAbstractFileByPath(card.filePath);
    if (!file || file.extension !== "md") {
      await this.app.vault.create(card.filePath, markdown);
      this.diskSignatures.set(card.id, markdown);
      return;
    }

    let current = null;
    try { current = await this.app.vault.read(file); } catch (error) { current = null; }

    // Already byte-identical: don't touch the file. Avoids a pointless mtime bump
    // that would make the sync push a needless copy.
    if (current === markdown) return;

    // The file changed on disk since we last read it — e.g. a sync just delivered
    // a newer note from another device (checklist assignees, labels, details…).
    // NEVER overwrite it with our possibly-stale in-memory card.
    const seen = this.diskSignatures.get(card.id);
    const changedUnderUs = current !== null && seen !== undefined && current !== seen;
    // A bulk rewrite must not blind-overwrite a file we never read this session:
    // we have no baseline, so we can't tell our memory from a fresh delivery.
    // (A user-initiated write still lands — dropping it would lose their edit.)
    const unknownDisk = options.bulk && current !== null && seen === undefined;

    if (changedUnderUs || unknownDisk) {
      this.diskSignatures.set(card.id, current);
      this.pendingResync = true;
      // Don't let a user's edit vanish silently; the resync below repaints the
      // board with what's actually on disk.
      if (!options.bulk && changedUnderUs) {
        new Notice("This card changed elsewhere — your edit wasn't saved. Reopen it to see the latest.");
      }
      this.queueResync();
      return;
    }

    await this.app.vault.modify(file, markdown);
    this.diskSignatures.set(card.id, markdown);
  }
};
