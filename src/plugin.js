const { Notice, Plugin } = require("obsidian");

// Owns the Obsidian plugin lifecycle, saved board data, and Markdown card sync.
const {
  CARD_FOLDER,
  DEFAULT_DATA,
  VIEW_TYPE,
  checklistToMarkdown,
  cleanDate,
  cleanLabelName,
  clone,
  labelKey,
  labelsToFrontmatter,
  parseCardMarkdown,
  cardFileBaseName,
  textLine,
  uid,
} = require("./helpers");
const { BoardView } = require("./board-view");
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
    await this.loadPluginData();

    this.registerView(VIEW_TYPE, (leaf) => new BoardView(leaf, this));
    this.addSettingTab(new TaskDeckSettingTab(this.app, this));
    ["create", "modify", "rename"].forEach((eventName) => {
      this.registerEvent(this.app.vault.on(eventName, (file) => this.queueCardFolderSync(file)));
    });

    this.addRibbonIcon("layout-dashboard", "Open Task Deck", () => this.activateView());
    this.addCommand({
      id: "open-board",
      name: "Open board",
      callback: () => this.activateView(),
    });
    this.addCommand({
      id: "add-card-to-first-list",
      name: "Add card to first list",
      callback: async () => {
        const firstList = this.getBoard().lists[0];
        if (firstList) {
          await this.addCard(firstList.id);
        } else {
          new Notice("Add a list first.");
        }
      },
    });
  }

  async onunload() {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }

  /**
   * Loads saved board data, normalizes older/missing fields, then imports any
   * Markdown card notes that were created or edited outside the board.
   */
  async loadPluginData() {
    const saved = await this.loadData();
    this.data = Object.assign(clone(DEFAULT_DATA), saved || {});
    this.data.boards = this.data.boards && this.data.boards.length ? this.data.boards : clone(DEFAULT_DATA.boards);
    this.data.cards = this.data.cards || {};
    this.data.labels = this.data.labels || [];
    this.data.activeBoardId = this.data.activeBoardId || this.data.boards[0].id;
    Object.values(this.data.cards).forEach((card) => {
      card.labels = this.normalizeCardLabels(card.labels || []);
      card.completed = !!card.completed;
      card.startDate = cleanDate(card.startDate);
      card.dueDate = cleanDate(card.dueDate);
    });
    const renamed = await this.normalizeCardFilePaths();
    await this.syncCardsFromFolder();
    if (renamed) await this.savePluginData();
  }

  async savePluginData() {
    await this.saveData(this.data);
  }

  getBoard() {
    return this.data.boards.find((board) => board.id === this.data.activeBoardId) || this.data.boards[0];
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

  findList(listId) {
    return this.getBoard().lists.find((list) => list.id === listId);
  }

  findListByCard(cardId) {
    return this.getBoard().lists.find((list) => list.cardIds.includes(cardId));
  }

  refreshViews() {
    this.app.workspace.getLeavesOfType(VIEW_TYPE).forEach((leaf) => {
      if (leaf.view && leaf.view.render) leaf.view.render();
    });
  }

  isCardFile(file) {
    return file && file.path && file.path.startsWith(`${CARD_FOLDER}/`) && file.extension === "md";
  }

  /**
   * Debounces vault events so a save/rename burst only triggers one rescan.
   */
  queueCardFolderSync(file) {
    if (!this.isCardFile(file)) return;

    window.clearTimeout(this.cardFolderSyncTimer);
    this.cardFolderSyncTimer = window.setTimeout(async () => {
      await this.syncCardsFromFolder();
      this.refreshViews();
    }, 250);
  }

  /**
   * Imports Markdown files from CARD_FOLDER into the active board.
   *
   * Existing cards are matched first by frontmatter id, then by file path. When
   * a note has no list id, it stays in its current list or falls back to the
   * first list so manually-created notes still appear on the board.
   */
  async syncCardsFromFolder() {
    const board = this.getBoard();
    if (!board.lists.length) board.lists.push({ id: uid("list"), title: "TODO", cardIds: [] });

    const files = this.app.vault.getMarkdownFiles().filter((file) => file.path.startsWith(`${CARD_FOLDER}/`));
    let changed = false;
    for (const file of files) {
      const markdown = await this.app.vault.read(file);
      const parsed = parseCardMarkdown(markdown);
      const existingByPath = Object.values(this.data.cards).find((card) => card.filePath === file.path);
      const cardId = parsed.id || (existingByPath && existingByPath.id) || uid("card");
      const existing = this.data.cards[cardId] || existingByPath;
      const targetList = this.findList(parsed.listId) || this.findList(existing && existing.listId) || board.lists[0];
      const now = new Date().toISOString();
      const card = existing || { id: cardId, createdAt: now };

      Object.assign(card, {
        id: card.id || cardId,
        title: parsed.title || file.basename,
        listId: targetList.id,
        labels: parsed.labels.length ? this.normalizeCardLabels(parsed.labels) : this.normalizeCardLabels(card.labels || []),
        details: parsed.details,
        checklist: parsed.checklist,
        completed: parsed.completed !== null ? parsed.completed : !!card.completed,
        startDate: parsed.startDate !== null ? parsed.startDate : cleanDate(card.startDate),
        dueDate: parsed.dueDate !== null ? parsed.dueDate : cleanDate(card.dueDate),
        filePath: file.path,
        updatedAt: card.updatedAt || now,
      });
      if (await this.normalizeCardFilePath(card)) changed = true;

      if (!this.data.cards[card.id]) {
        this.data.cards[card.id] = card;
        changed = true;
      }

      const currentList = this.findListByCard(card.id);
      if (currentList && currentList.id !== targetList.id) {
        currentList.cardIds = currentList.cardIds.filter((id) => id !== card.id);
      }
      if (!targetList.cardIds.includes(card.id)) {
        targetList.cardIds.push(card.id);
        changed = true;
      }
    }

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

  addList() {
    this.promptText("Add list", "List name", "", async (title) => {
      this.getBoard().lists.push({ id: uid("list"), title, cardIds: [] });
      await this.savePluginData();
      this.refreshViews();
    });
  }

  renameList(listId) {
    const list = this.findList(listId);
    if (!list) return;

    this.promptText("Rename list", "List name", list.title, async (title) => {
      list.title = title;
      await this.savePluginData();
      this.refreshViews();
    });
  }

  async deleteList(listId) {
    const board = this.getBoard();
    const list = this.findList(listId);
    if (!list) return;

    const message = list.cardIds.length
      ? `Delete "${list.title}" and its ${list.cardIds.length} cards?`
      : `Delete "${list.title}"?`;
    if (!window.confirm(message)) return;

    for (const cardId of list.cardIds) {
      await this.deleteCard(cardId, false);
    }
    board.lists = board.lists.filter((item) => item.id !== listId);
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
    const list = this.findList(listId);
    if (!list) return;

    const now = new Date().toISOString();
    const card = {
      id: uid("card"),
      title,
      listId,
      labels: [],
      details: "",
      checklist: [],
      completed: false,
      startDate: "",
      dueDate: "",
      filePath: await this.nextCardPath(title),
      createdAt: now,
      updatedAt: now,
    };

    this.data.cards[card.id] = card;
    list.cardIds.unshift(card.id);
    await this.writeCardFile(card);
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
    const targetList = this.findList(targetListId);
    const card = this.data.cards[cardId];
    if (!targetList || !card) return;

    this.getBoard().lists.forEach((list) => {
      list.cardIds = list.cardIds.filter((id) => id !== cardId);
    });

    const beforeIndex = beforeCardId ? targetList.cardIds.indexOf(beforeCardId) : -1;
    if (beforeIndex === -1) {
      targetList.cardIds.push(cardId);
    } else {
      targetList.cardIds.splice(beforeIndex, 0, cardId);
    }

    card.listId = targetListId;
    await this.writeCardFile(card);
    await this.savePluginData();
    this.refreshViews();
  }

  async moveList(listId, targetListId, afterTarget = false) {
    if (!listId || listId === targetListId) return;

    const board = this.getBoard();
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
    await this.updateCard(cardId, { completed: !card.completed });
  }

  /**
   * Removes a card from all lists and trashes its linked Markdown note.
   */
  async deleteCard(cardId, saveAndRefresh = true) {
    const card = this.data.cards[cardId];
    if (!card) return;

    this.getBoard().lists.forEach((list) => {
      list.cardIds = list.cardIds.filter((id) => id !== cardId);
    });

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
    if (parsed.completed !== null) card.completed = parsed.completed;
    if (parsed.startDate !== null) card.startDate = parsed.startDate;
    if (parsed.dueDate !== null) card.dueDate = parsed.dueDate;
    card.details = parsed.details;
    card.checklist = parsed.checklist;
  }

  async openCardFile(cardId) {
    const card = this.data.cards[cardId];
    if (!card) return;

    await this.writeCardFile(card);
    const file = this.app.vault.getAbstractFileByPath(card.filePath);
    if (!file) return;

    await this.app.workspace.getLeaf(false).openFile(file);
  }

  async ensureCardFolder() {
    if (!this.app.vault.getAbstractFileByPath(CARD_FOLDER)) {
      await this.app.vault.createFolder(CARD_FOLDER);
    }
  }

  /**
   * Finds a unique path in CARD_FOLDER, allowing the current path during rename.
   */
  async nextCardPath(title, currentPath) {
    await this.ensureCardFolder();

    const base = cardFileBaseName(title);
    let path = `${CARD_FOLDER}/${base}.md`;
    let index = 2;
    while (path !== currentPath && this.app.vault.getAbstractFileByPath(path)) {
      path = `${CARD_FOLDER}/${base} ${index}.md`;
      index += 1;
    }
    return path;
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

    const nextPath = await this.nextCardPath(card.title, card.filePath);
    if (nextPath === card.filePath) return false;

    const file = this.app.vault.getAbstractFileByPath(card.filePath);
    if (!file || file.extension !== "md") return false;

    await this.app.vault.rename(file, nextPath);
    card.filePath = nextPath;
    return true;
  }

  async renameCardFile(card, title) {
    const nextPath = await this.nextCardPath(title, card.filePath);
    if (nextPath === card.filePath) return;

    const file = this.app.vault.getAbstractFileByPath(card.filePath);
    if (file && file.extension === "md") {
      await this.app.vault.rename(file, nextPath);
    }
    card.filePath = nextPath;
  }

  /**
   * Writes the card note used by both Obsidian and Task Deck.
   *
   * Frontmatter stores board metadata. The Details and Checklist sections stay
   * as normal Markdown so users can edit card content directly in the vault.
   */
  async writeCardFile(card) {
    await this.ensureCardFolder();

    const markdown = [
      "---",
      `kanban-card-id: ${card.id}`,
      `kanban-board-id: ${this.getBoard().id}`,
      `kanban-list-id: ${card.listId || ""}`,
      `labels: ${labelsToFrontmatter(card.labels)}`,
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
    if (file && file.extension === "md") {
      await this.app.vault.modify(file, markdown);
    } else {
      await this.app.vault.create(card.filePath, markdown);
    }
  }
};
