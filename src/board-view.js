const { ItemView, Menu, setIcon } = require("obsidian");

// Renders the kanban board and handles inline card/list interactions.
const {
  DONATION_URL,
  LIST_DRAG_TYPE,
  TASK_DECK_ICON,
  VIEW_TYPE,
  checklistStats,
  createElement,
  dateRangeLabel,
  hasDragType,
  iconButton,
  textButton,
  textLine,
} = require("./helpers");
const { AboutModal, CardDatesModal, CardModal } = require("./modals");

/**
 * Obsidian view for the task board.
 *
 * This class owns rendering and short-lived UI state only. Persistent changes
 * are delegated back to the plugin so board data and card notes remain synced.
 */
class BoardView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.addingCardListId = null;
    this.editingCardId = null;
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return "Task Deck";
  }

  getIcon() {
    return TASK_DECK_ICON;
  }

  async onOpen() {
    this.render();
  }

  render() {
    const board = this.plugin.getBoard();
    this.contentEl.replaceChildren();
    this.contentEl.addClass("ot-board-root");

    const toolbar = createElement("div", "ot-toolbar");
    toolbar.append(createElement("h2", "", board.name));
    const actions = createElement("div", "ot-toolbar-actions");
    actions.append(
      textButton("info", "About", () => new AboutModal(this.app, this.plugin).open()),
      textButton("heart", "Support", () => window.open(DONATION_URL, "_blank")),
      textButton("plus", "Add list", () => this.plugin.addList())
    );
    toolbar.append(actions);

    const scroller = createElement("div", "ot-board-scroll");
    board.lists.forEach((list) => scroller.append(this.renderList(list)));

    this.contentEl.append(toolbar, scroller);
  }

  /**
   * Renders one column and wires list-level drag/drop targets.
   */
  renderList(list) {
    const column = createElement("section", "ot-list");
    column.dataset.listId = list.id;
    const clearListDropState = () => {
      column.classList.remove("is-list-drop-before", "is-list-drop-after");
    };

    const header = createElement("div", "ot-list-header");
    header.draggable = true;
    header.classList.add("ot-list-drag-source");
    header.addEventListener("dragstart", (event) => {
      event.dataTransfer.setData(LIST_DRAG_TYPE, list.id);
      event.dataTransfer.effectAllowed = "move";
      column.classList.add("is-dragging-list");
    });
    header.addEventListener("dragend", () => {
      column.classList.remove("is-dragging-list");
      clearListDropState();
    });

    const dragHandle = createElement("span", "ot-list-drag-handle");
    try {
      setIcon(dragHandle, "grip-vertical");
    } catch (error) {
      dragHandle.textContent = "";
    }

    header.append(dragHandle, createElement("h3", "", list.title));
    header.append(createElement("span", "ot-list-count", String(list.cardIds.length)));
    header.append(iconButton("ellipsis", "List menu", (event) => this.showListMenu(event, list)));

    column.addEventListener("dragover", (event) => {
      if (!hasDragType(event, LIST_DRAG_TYPE)) return;
      event.preventDefault();
      const rect = column.getBoundingClientRect();
      const after = event.clientX > rect.left + rect.width / 2;
      column.classList.toggle("is-list-drop-before", !after);
      column.classList.toggle("is-list-drop-after", after);
    });
    column.addEventListener("dragleave", (event) => {
      if (!column.contains(event.relatedTarget)) clearListDropState();
    });
    column.addEventListener("drop", async (event) => {
      if (!hasDragType(event, LIST_DRAG_TYPE)) return;
      event.preventDefault();
      event.stopPropagation();
      const rect = column.getBoundingClientRect();
      const after = event.clientX > rect.left + rect.width / 2;
      const draggedListId = event.dataTransfer.getData(LIST_DRAG_TYPE);
      clearListDropState();
      await this.plugin.moveList(draggedListId, list.id, after);
    });

    const cards = createElement("div", "ot-cards");
    cards.addEventListener("dragover", (event) => {
      if (hasDragType(event, LIST_DRAG_TYPE)) return;
      event.preventDefault();
      cards.classList.add("is-drop-zone");
    });
    cards.addEventListener("dragleave", () => cards.classList.remove("is-drop-zone"));
    cards.addEventListener("drop", async (event) => {
      if (hasDragType(event, LIST_DRAG_TYPE)) return;
      event.preventDefault();
      cards.classList.remove("is-drop-zone");
      const cardId = event.dataTransfer.getData("text/plain");
      await this.plugin.moveCard(cardId, list.id);
    });

    if (this.addingCardListId === list.id) {
      cards.append(this.renderCardComposer(list));
    }

    list.cardIds.forEach((cardId) => {
      const card = this.plugin.data.cards[cardId];
      if (card) cards.append(this.renderCard(card, list.id));
    });

    const footer = createElement("div", "ot-list-footer");
    if (this.addingCardListId !== list.id) {
      footer.append(textButton("plus", "Add card", () => this.showCardComposer(list.id)));
    }

    column.append(header, cards);
    if (footer.childElementCount) column.append(footer);
    return column;
  }

  showCardComposer(listId) {
    this.addingCardListId = listId;
    this.render();
  }

  hideCardComposer() {
    this.addingCardListId = null;
    this.render();
  }

  renderCardComposer(list) {
    const form = createElement("form", "ot-card-composer");
    const input = createElement("input", "ot-inline-card-input");
    input.type = "text";
    input.placeholder = "Card title";

    const actions = createElement("div", "ot-card-composer-actions");
    const add = createElement("button", "mod-cta", "Add");
    const cancel = iconButton("x", "Cancel", () => this.hideCardComposer());
    add.type = "submit";
    actions.append(add, cancel);

    form.append(input, actions);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const title = textLine(input.value);
      if (!title) {
        input.focus();
        return;
      }

      this.addingCardListId = null;
      await this.plugin.createCard(list.id, title);
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") this.hideCardComposer();
    });

    requestAnimationFrame(() => input.focus());
    return form;
  }

  /**
   * Renders one card, including drag/drop, completion toggle, rename trigger,
   * and compact metadata badges.
   */
  renderCard(card, listId) {
    const element = createElement("article", "ot-card");
    const isRenaming = this.editingCardId === card.id;
    element.draggable = !isRenaming;
    element.dataset.cardId = card.id;
    if (card.completed) element.classList.add("is-completed");
    if (card.completed && this.plugin.completedAnimationCardId === card.id) {
      element.classList.add("is-just-completed");
      this.plugin.completedAnimationCardId = null;
      window.setTimeout(() => element.classList.remove("is-just-completed"), 650);
    }

    element.addEventListener("dragstart", (event) => {
      event.dataTransfer.setData("text/plain", card.id);
      event.dataTransfer.effectAllowed = "move";
      element.classList.add("is-dragging");
    });
    element.addEventListener("dragend", () => element.classList.remove("is-dragging"));
    element.addEventListener("dragover", (event) => {
      event.preventDefault();
      element.classList.add("is-drop-target");
    });
    element.addEventListener("dragleave", () => element.classList.remove("is-drop-target"));
    element.addEventListener("drop", async (event) => {
      event.preventDefault();
      event.stopPropagation();
      element.classList.remove("is-drop-target");
      const draggedId = event.dataTransfer.getData("text/plain");
      await this.plugin.moveCard(draggedId, listId, card.id);
    });
    element.addEventListener("click", () => new CardModal(this.app, this.plugin, card.id).open());

    const labels = createElement("div", "ot-card-labels");
    (card.labels || []).forEach((label) => {
      const pill = createElement("span", "ot-card-label", label.name);
      pill.style.backgroundColor = label.color;
      pill.title = label.name;
      labels.append(pill);
    });

    const completeButton = iconButton(card.completed ? "check" : "circle", card.completed ? "Mark as incomplete" : "Mark as complete", async (event) => {
      event.stopPropagation();
      await this.plugin.toggleCardCompleted(card.id);
    });
    completeButton.classList.add("ot-card-complete-toggle");
    completeButton.draggable = false;
    completeButton.replaceChildren();
    if (card.completed) completeButton.append(createElement("span", "ot-card-complete-mark", "✓"));

    const title = isRenaming ? this.renderCardTitleEditor(card) : createElement("div", "ot-card-title", card.title);
    const editButton = iconButton("pencil", "Edit card", (event) => {
      event.stopPropagation();
      this.editingCardId = card.id;
      this.showCardMenu(event, card);
      this.render();
    });
    editButton.classList.add("ot-card-action-button");
    editButton.draggable = false;
    const actions = createElement("div", "ot-card-actions");
    actions.append(editButton);

    const main = createElement("div", "ot-card-main");
    main.append(completeButton, title, actions);
    if (labels.childElementCount) element.append(labels);
    element.append(main);

    const meta = this.renderCardMeta(card);
    if (meta.childElementCount) element.append(meta);

    return element;
  }

  /**
   * Inline title editor used by the card edit button.
   */
  renderCardTitleEditor(card) {
    const form = createElement("form", "ot-card-title-form");
    const input = createElement("input", "ot-card-title-input");
    let finished = false;
    input.type = "text";
    input.value = card.title;
    input.placeholder = "Card title";

    const finish = async (save) => {
      if (finished) return;
      finished = true;
      const title = textLine(input.value);
      this.editingCardId = null;
      if (save && title && title !== card.title) {
        await this.plugin.updateCard(card.id, { title });
      } else {
        this.render();
      }
    };

    form.addEventListener("click", (event) => event.stopPropagation());
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      event.stopPropagation();
      finish(true).catch(console.error);
    });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        event.preventDefault();
        finish(false).catch(console.error);
      }
    });
    input.addEventListener("blur", () => finish(true).catch(console.error));

    form.append(input);
    requestAnimationFrame(() => {
      input.focus();
      input.select();
    });
    return form;
  }

  /**
   * Builds the small date/checklist/details indicators shown on closed cards.
   */
  renderCardMeta(card) {
    const meta = createElement("div", "ot-card-meta");
    const dates = dateRangeLabel(card.startDate, card.dueDate);

    if (dates) {
      const badge = createElement("span", "ot-card-meta-item ot-card-date-badge");
      const icon = createElement("span", "ot-card-date-icon");
      try {
        setIcon(icon, "clock");
      } catch (error) {
        icon.textContent = "";
      }
      badge.append(icon, createElement("span", "", dates));
      meta.append(badge);
    }

    if ((card.checklist || []).length) {
      const stats = checklistStats(card.checklist);
      const badge = createElement("span", "ot-card-meta-item ot-card-checklist-badge");
      const icon = createElement("span", "ot-card-checklist-icon");
      try {
        setIcon(icon, "check-square");
      } catch (error) {
        icon.textContent = "☑";
      }
      badge.append(icon, createElement("span", "", `${stats.done}/${stats.total}`));
      meta.append(badge);
    }

    if (card.details) {
      meta.append(createElement("span", "ot-card-meta-item", "☰"));
    }

    return meta;
  }

  showCardMenu(event, card) {
    event.stopPropagation();
    const menu = new Menu();
    menu.addItem((item) => {
      item
        .setTitle("Edit dates")
        .setIcon("calendar-days")
        .onClick(() => new CardDatesModal(this.app, this.plugin, card.id).open());
    });
    menu.addItem((item) => {
      item
        .setTitle("Delete card")
        .setIcon("trash")
        .onClick(async () => {
          if (!window.confirm("Delete this card and its linked Markdown note?")) return;
          await this.plugin.deleteCard(card.id);
        });
    });
    menu.showAtMouseEvent(event);
  }

  showListMenu(event, list) {
    const menu = new Menu();
    menu.addItem((item) => {
      item
        .setTitle("Rename list")
        .setIcon("pencil")
        .onClick(() => this.plugin.renameList(list.id));
    });
    menu.addItem((item) => {
      item
        .setTitle("Delete list")
        .setIcon("trash")
        .onClick(() => this.plugin.deleteList(list.id));
    });
    menu.showAtMouseEvent(event);
  }
}

module.exports = { BoardView };
