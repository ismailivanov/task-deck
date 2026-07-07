const { MarkdownRenderer, Menu, Modal, Notice, setIcon } = require("obsidian");

// Modal UIs for cards, labels, dates, prompts, and the short about panel.
const {
  DEFAULT_LABEL_COLOR,
  LABEL_COLORS,
  LIST_COLORS,
  addMonths,
  addButtonIcon,
  checklistStats,
  cardFileBaseName,
  cleanDate,
  cleanColor,
  cleanLabelName,
  clone,
  createElement,
  dateFromISO,
  fieldDateLabel,
  iconButton,
  imageRefsFromMarkdown,
  isoFromDate,
  labelKey,
  stripImageEmbeds,
  textButton,
  textLine,
  initials,
} = require("./helpers");

// Pull image files out of a paste/drop DataTransfer (empty if none).
function imageFilesFromTransfer(dt) {
  if (!dt) return [];
  const out = [];
  if (dt.files && dt.files.length) {
    for (const file of Array.from(dt.files)) {
      if (file && file.type && file.type.startsWith("image/")) out.push(file);
    }
  }
  if (!out.length && dt.items && dt.items.length) {
    for (const item of Array.from(dt.items)) {
      if (item.kind === "file" && item.type && item.type.startsWith("image/")) {
        const file = item.getAsFile();
        if (file) out.push(file);
      }
    }
  }
  return out;
}

// Timestamp for auto-named pasted images, e.g. 20260706T....
function imageStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function safeImageFileName(rawName, fallbackExt) {
  const clean = textLine(rawName);
  const match = clean.match(/\.([a-z0-9]+)$/i);
  const ext = textLine(match ? match[1] : fallbackExt || "png").replace(/[^a-z0-9]/gi, "").toLowerCase() || "png";
  const base = match ? clean.slice(0, -match[0].length) : clean;
  return `${cardFileBaseName(base || `Pasted image ${imageStamp()}`)}.${ext}`;
}

/**
 * Small reusable text prompt for list names and other one-field actions.
 */
class TextPromptModal extends Modal {
  constructor(app, title, placeholder, initialValue, onSubmit) {
    super(app);
    this.title = title;
    this.placeholder = placeholder;
    this.initialValue = initialValue || "";
    this.onSubmit = onSubmit;
    this.submitting = false;
  }

  onOpen() {
    this.contentEl.replaceChildren();
    this.contentEl.addClass("ot-prompt-modal");

    this.contentEl.append(createElement("h2", "", this.title));

    const input = createElement("input", "ot-input");
    input.type = "text";
    input.placeholder = this.placeholder;
    input.value = this.initialValue;
    this.contentEl.append(input);

    const actions = createElement("div", "ot-modal-actions");
    const cancel = createElement("button", "", "Cancel");
    const save = createElement("button", "mod-cta", "Save");
    addButtonIcon(cancel, "x");
    addButtonIcon(save, "check");
    cancel.type = "button";
    save.type = "button";

    cancel.addEventListener("click", () => this.close());
    save.addEventListener("click", () => this.submit(input.value));
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        this.submit(input.value);
      }
    });

    actions.append(cancel, save);
    this.contentEl.append(actions);

    requestAnimationFrame(() => input.focus());
  }

  submit(value) {
    if (this.submitting) return;
    const cleanValue = textLine(value);
    if (!cleanValue) {
      new Notice("Name cannot be empty.");
      return;
    }

    this.submitting = true;
    this.close();
    Promise.resolve(this.onSubmit(cleanValue)).catch((error) => {
      console.error(error);
      new Notice("Could not save.");
    });
  }
}

/**
 * Label picker and label editor.
 *
 * The modal keeps local copies of global labels and selected labels, then sends
 * both back through onChange so the card modal can save them together.
 */
class LabelPickerModal extends Modal {
  constructor(app, labels, selectedLabels, onChange) {
    super(app);
    this.labels = clone(labels || []);
    this.selectedLabels = clone(selectedLabels || []);
    this.onChange = onChange;
    this.creating = false;
    this.editingKey = null;
    this.query = "";
    this.createName = "";
    this.createColor = DEFAULT_LABEL_COLOR;
  }

  onOpen() {
    this.render();
  }

  isSelected(label) {
    const key = labelKey(label);
    return this.selectedLabels.some((item) => labelKey(item) === key);
  }

  emitChange() {
    this.onChange(clone(this.labels), clone(this.selectedLabels));
  }

  dedupeLabels(labels) {
    const seen = new Set();
    return (labels || []).filter((label) => {
      const key = labelKey(label);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  toggleLabel(label) {
    if (this.isSelected(label)) {
      this.selectedLabels = this.selectedLabels.filter((item) => labelKey(item) !== labelKey(label));
    } else {
      this.selectedLabels.push(clone(label));
    }
    this.emitChange();
    this.render();
  }

  /**
   * Creates or updates a global label and keeps selected labels in sync.
   */
  createLabel(name, color) {
    const cleanName = textLine(name);
    if (!cleanName) return;

    const label = { name: cleanName, color: color || DEFAULT_LABEL_COLOR };
    if (this.editingKey) {
      const oldKey = this.editingKey;
      const update = (item) => (labelKey(item) === oldKey ? clone(label) : item);
      this.labels = this.dedupeLabels(this.labels.map(update));
      this.selectedLabels = this.dedupeLabels(this.selectedLabels.map(update));
    } else {
      const existing = this.labels.find((item) => labelKey(item) === labelKey(cleanName));
      const nextLabel = existing || label;
      if (!existing) this.labels.push(nextLabel);
      if (!this.isSelected(nextLabel)) this.selectedLabels.push(clone(nextLabel));
    }

    this.creating = false;
    this.editingKey = null;
    this.query = "";
    this.createName = "";
    this.createColor = DEFAULT_LABEL_COLOR;
    this.emitChange();
    this.render();
  }

  editLabel(label) {
    this.creating = true;
    this.editingKey = labelKey(label);
    this.createName = label.name;
    this.createColor = label.color || DEFAULT_LABEL_COLOR;
    this.render();
  }

  render() {
    this.contentEl.replaceChildren();
    this.contentEl.addClass("ot-label-modal");

    if (this.creating) {
      this.renderCreateScreen();
      return;
    }

    const header = createElement("div", "ot-label-modal-header");
    header.append(createElement("h2", "", "Labels"));

    const search = createElement("input", "ot-label-search");
    search.type = "text";
    search.placeholder = "Search labels";
    search.value = this.query;
    search.addEventListener("input", () => {
      this.query = search.value;
      renderList();
    });

    const labelTitle = createElement("h3", "ot-label-modal-subtitle", "Labels");
    const list = createElement("div", "ot-label-picker-list");
    const createArea = createElement("div", "ot-label-create-area");

    const renderList = () => {
      const query = this.query.trim().toLowerCase();
      list.replaceChildren();

      this.labels
        .filter((label) => !query || label.name.toLowerCase().includes(query))
        .forEach((label) => {
          const row = createElement("div", "ot-label-option-row");
          const checkbox = createElement("input");
          checkbox.type = "checkbox";
          checkbox.checked = this.isSelected(label);

          const labelButton = createElement("button", "ot-label-option", label.name);
          labelButton.type = "button";
          labelButton.style.backgroundColor = label.color || "#2f6fd6";

          const edit = iconButton("pencil", "Edit label", (event) => {
            event.stopPropagation();
            this.editLabel(label);
          });

          checkbox.addEventListener("change", () => this.toggleLabel(label));
          labelButton.addEventListener("click", () => this.toggleLabel(label));
          row.append(checkbox, labelButton, edit);
          list.append(row);
        });
    };

    const renderCreateArea = () => {
      createArea.replaceChildren();

    const create = createElement("button", "ot-label-create-button", "Create new label");
    addButtonIcon(create, "plus");
    create.type = "button";
      create.addEventListener("click", () => {
        this.creating = true;
        this.editingKey = null;
        this.createName = this.query;
        this.createColor = DEFAULT_LABEL_COLOR;
        this.render();
      });
      createArea.append(create);
    };

    this.contentEl.append(header, search, labelTitle, list, createArea);
    renderList();
    renderCreateArea();
    requestAnimationFrame(() => search.focus());
  }

  renderCreateScreen() {
    const header = createElement("div", "ot-label-modal-header");
    const back = iconButton("arrow-left", "Back", () => {
      this.creating = false;
      this.editingKey = null;
      this.render();
    });
    back.classList.add("ot-label-back");
    header.append(back, createElement("h2", "", this.editingKey ? "Edit label" : "Create label"));

    const previewBand = createElement("div", "ot-label-create-preview-band");
    const preview = createElement("div", "ot-label-preview-pill", this.createName || "Label preview");
    preview.style.backgroundColor = this.createColor;
    previewBand.append(preview);

    const form = createElement("form", "ot-label-create-screen");
    const titleField = createElement("label", "ot-field");
    titleField.append(createElement("span", "", "Title"));
    const title = createElement("input", "ot-label-create-title");
    title.type = "text";
    title.value = this.createName;
    title.placeholder = "Label name";
    titleField.append(title);

    const colorField = createElement("div", "ot-field");
    colorField.append(createElement("span", "", "Choose color"));
    const swatches = createElement("div", "ot-label-color-grid");
    LABEL_COLORS.forEach((color) => {
      const swatch = createElement("button", "ot-label-color-swatch");
      swatch.type = "button";
      swatch.style.backgroundColor = color;
      swatch.setAttribute("aria-label", color);
      if (color === this.createColor) {
        swatch.classList.add("is-selected");
        try {
          setIcon(swatch, "check");
        } catch (error) {
          swatch.textContent = "✓";
        }
      }
      swatch.addEventListener("click", () => {
        this.createColor = color;
        this.render();
      });
      swatches.append(swatch);
    });
    colorField.append(swatches);

    const removeColor = textButton("x", "Remove color", () => {
      this.createColor = "#6f737a";
      this.render();
    });
    removeColor.classList.add("ot-remove-color-button");

    const footer = createElement("div", "ot-label-create-footer");
    const create = createElement("button", "mod-cta", this.editingKey ? "Save" : "Create");
    addButtonIcon(create, this.editingKey ? "check" : "plus");
    create.type = "submit";
    footer.append(create);

    title.addEventListener("input", () => {
      this.createName = title.value;
      preview.textContent = this.createName || "Label preview";
    });
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      this.createLabel(title.value, this.createColor);
    });

    form.append(titleField, colorField, removeColor, footer);
    this.contentEl.append(header, previewBand, form);
    requestAnimationFrame(() => title.focus());
  }
}

class ListColorModal extends Modal {
  constructor(app, title, currentColor, onSelect) {
    super(app);
    this.title = title;
    this.currentColor = cleanColor(currentColor) || LIST_COLORS[0];
    this.onSelect = onSelect;
  }

  onOpen() {
    this.contentEl.replaceChildren();
    this.contentEl.addClass("ot-label-modal", "ot-list-color-modal");

    const header = createElement("div", "ot-label-modal-header");
    header.append(createElement("h2", "", "List color"));

    const previewBand = createElement("div", "ot-label-create-preview-band");
    const preview = createElement("div", "ot-label-preview-pill", this.title || "List");
    preview.style.backgroundColor = this.currentColor;
    previewBand.append(preview);

    const field = createElement("div", "ot-field");
    field.append(createElement("span", "", "Choose color"));
    const swatches = createElement("div", "ot-label-color-grid");
    LIST_COLORS.forEach((color) => {
      const swatch = createElement("button", "ot-label-color-swatch");
      swatch.type = "button";
      swatch.style.backgroundColor = color;
      swatch.setAttribute("aria-label", color);
      if (color === this.currentColor) {
        swatch.classList.add("is-selected");
        try {
          setIcon(swatch, "check");
        } catch (error) {
          swatch.textContent = "✓";
        }
      }
      swatch.addEventListener("click", async () => {
        await this.onSelect(color);
        this.close();
      });
      swatches.append(swatch);
    });
    field.append(swatches);

    const customField = createElement("label", "ot-field");
    customField.append(createElement("span", "", "Custom color"));
    const custom = createElement("input", "ot-color-input");
    custom.type = "color";
    custom.value = this.currentColor;
    custom.addEventListener("input", () => {
      this.currentColor = custom.value;
      preview.style.backgroundColor = this.currentColor;
    });
    customField.append(custom);

    const actions = createElement("div", "ot-modal-actions");
    const cancel = createElement("button", "", "Cancel");
    const save = createElement("button", "mod-cta", "Save");
    addButtonIcon(cancel, "x");
    addButtonIcon(save, "check");
    cancel.type = "button";
    save.type = "button";
    cancel.addEventListener("click", () => this.close());
    save.addEventListener("click", async () => {
      await this.onSelect(custom.value);
      this.close();
    });
    actions.append(cancel, save);

    this.contentEl.append(header, previewBand, field, customField, actions);
  }
}

/**
 * Compact start/due date picker for a single card.
 */
class CardDatesModal extends Modal {
  constructor(app, plugin, cardId) {
    super(app);
    this.plugin = plugin;
    this.cardId = cardId;
    this.activeField = "due";
    this.startDate = "";
    this.dueDate = "";
    this.visibleMonth = new Date();
  }

  onOpen() {
    const card = this.plugin.data.cards[this.cardId];
    if (!card) {
      this.close();
      return;
    }

    this.card = card;
    this.startDate = cleanDate(card.startDate);
    this.dueDate = cleanDate(card.dueDate);
    this.activeField = this.startDate && !this.dueDate ? "start" : "due";
    const seed = dateFromISO(this.dueDate || this.startDate) || new Date();
    this.visibleMonth = new Date(seed.getFullYear(), seed.getMonth(), 1);
    this.render();
  }

  render() {
    this.contentEl.replaceChildren();
    this.contentEl.addClass("ot-date-modal");
    this.contentEl.append(createElement("h2", "", "Dates"));

    this.contentEl.append(this.renderCalendar(), this.renderDateFields(), this.renderActions());
  }

  renderCalendar() {
    const calendar = createElement("div", "ot-date-calendar");
    const nav = createElement("div", "ot-date-calendar-nav");
    const title = createElement("div", "ot-date-month-title");
    title.textContent = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" }).format(this.visibleMonth);

    nav.append(
      iconButton("chevrons-left", "Previous year", () => {
        this.visibleMonth = addMonths(this.visibleMonth, -12);
        this.render();
      }),
      iconButton("chevron-left", "Previous month", () => {
        this.visibleMonth = addMonths(this.visibleMonth, -1);
        this.render();
      }),
      title,
      iconButton("chevron-right", "Next month", () => {
        this.visibleMonth = addMonths(this.visibleMonth, 1);
        this.render();
      }),
      iconButton("chevrons-right", "Next year", () => {
        this.visibleMonth = addMonths(this.visibleMonth, 12);
        this.render();
      })
    );

    const weekdays = createElement("div", "ot-date-weekdays");
    const monday = new Date(2024, 0, 1);
    for (let index = 0; index < 7; index += 1) {
      const date = new Date(monday.getFullYear(), monday.getMonth(), monday.getDate() + index);
      weekdays.append(createElement("span", "", new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(date).replace(/\.$/, "")));
    }

    const grid = createElement("div", "ot-date-grid");
    const firstDay = new Date(this.visibleMonth.getFullYear(), this.visibleMonth.getMonth(), 1);
    const mondayOffset = (firstDay.getDay() + 6) % 7;
    const firstCell = new Date(firstDay.getFullYear(), firstDay.getMonth(), firstDay.getDate() - mondayOffset);

    for (let index = 0; index < 42; index += 1) {
      const date = new Date(firstCell.getFullYear(), firstCell.getMonth(), firstCell.getDate() + index);
      const iso = isoFromDate(date);
      const button = createElement("button", "ot-date-day", String(date.getDate()));
      button.type = "button";
      if (date.getMonth() !== this.visibleMonth.getMonth()) button.classList.add("is-outside");
      if (iso === this.startDate || iso === this.dueDate) button.classList.add("is-selected");
      if (this.startDate && this.dueDate && iso > this.startDate && iso < this.dueDate) button.classList.add("is-range");
      button.addEventListener("click", () => this.selectDate(iso));
      grid.append(button);
    }

    calendar.append(nav, weekdays, grid);
    return calendar;
  }

  renderDateFields() {
    const fields = createElement("div", "ot-date-fields");
    fields.append(
      this.renderDateField("start", "Start date", this.startDate),
      this.renderDateField("due", "Due date", this.dueDate)
    );
    return fields;
  }

  renderDateField(field, label, value) {
    const wrap = createElement("div", "ot-date-field");
    wrap.append(createElement("span", "ot-date-field-label", label));

    const row = createElement("div", "ot-date-field-row");
    const checkbox = createElement("input", "ot-date-checkbox");
    checkbox.type = "checkbox";
    checkbox.checked = !!value;
    checkbox.addEventListener("change", () => {
      this.activeField = field;
      if (!checkbox.checked) this[field === "start" ? "startDate" : "dueDate"] = "";
      this.render();
    });

    const dateButton = createElement("button", `ot-date-field-button${value ? "" : " is-empty"}`, fieldDateLabel(value));
    dateButton.type = "button";
    if (this.activeField === field) dateButton.classList.add("is-active");
    dateButton.addEventListener("click", () => {
      this.activeField = field;
      this.render();
    });

    row.append(checkbox, dateButton);
    wrap.append(row);
    return wrap;
  }

  renderActions() {
    const actions = createElement("div", "ot-modal-actions");
    const clear = createElement("button", "", "Clear dates");
    const cancel = createElement("button", "", "Cancel");
    const save = createElement("button", "mod-cta", "Save");
    addButtonIcon(clear, "x");
    addButtonIcon(cancel, "x");
    addButtonIcon(save, "check");

    [clear, cancel, save].forEach((button) => {
      button.type = "button";
    });

    clear.addEventListener("click", async () => {
      await this.plugin.updateCard(this.card.id, { startDate: "", dueDate: "" });
      this.close();
    });
    cancel.addEventListener("click", () => this.close());
    save.addEventListener("click", async () => {
      await this.plugin.updateCard(this.card.id, {
        startDate: this.startDate,
        dueDate: this.dueDate,
      });
      this.close();
    });

    actions.append(clear, cancel, save);
    return actions;
  }

  /**
   * Applies the clicked calendar day to whichever date field is active.
   */
  selectDate(date) {
    if (this.activeField === "start") {
      this.startDate = date;
      if (this.dueDate && this.dueDate < date) this.dueDate = "";
    } else {
      this.dueDate = date;
      if (this.startDate && this.startDate > date) this.startDate = "";
    }
    this.render();
  }
}

/**
 * Short in-app about panel with settings, sync, and close actions.
 */
class AboutModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen() {
    this.contentEl.replaceChildren();
    this.contentEl.addClass("ot-about-modal");
    this.contentEl.append(
      createElement("h2", "", "Task Deck"),
      createElement("p", "", "A Trello-style task board for Obsidian with Markdown-backed cards, labels, dates, and checklists.")
    );

    const actions = createElement("div", "ot-modal-actions");
    const openSettings = createElement("button", "", "Open settings");
    const sync = createElement("button", "", "Sync notes");
    const close = createElement("button", "mod-cta", "Close");
    addButtonIcon(openSettings, "settings");
    addButtonIcon(sync, "refresh-cw");
    addButtonIcon(close, "x");
    [openSettings, sync, close].forEach((button) => {
      button.type = "button";
    });
    openSettings.addEventListener("click", () => {
      this.app.setting.open();
      this.app.setting.openTabById(this.plugin.manifest.id);
      this.close();
    });
    sync.addEventListener("click", async () => {
      await this.plugin.syncCardsFromFolder();
      this.plugin.refreshViews();
      new Notice("Task Deck synced.");
    });
    close.addEventListener("click", () => this.close());
    actions.append(openSettings, sync, close);
    this.contentEl.append(actions);
  }
}

/**
 * Full card editor.
 *
 * Card edits are persisted while the modal is open so closing the editor never
 * drops checklist, label, title, or details changes.
 */
class CardModal extends Modal {
  constructor(app, plugin, cardId) {
    super(app);
    this.plugin = plugin;
    this.cardId = cardId;
    this.localTitle = "";
    this.localLabels = [];
    this.localGlobalLabels = [];
    this.localDetails = "";
    this.detailsDraft = "";
    this.editingDetails = false;
    this.localChecklist = [];
    this.detailsTextarea = null;
    this.addingChecklistItem = false;
    this.saveTimer = null;
    this.savePromise = Promise.resolve();
    this.readOnly = false;
    this.lockHolder = null;
    this.lockAcquired = false;
    this.lockBoardId = null;
    this.lockHeartbeat = null;
  }

  onOpen() {
    this.contentEl.replaceChildren(createElement("div", "ot-loading", "Opening card..."));
    this.load().catch((error) => {
      console.error(error);
      new Notice("Could not open card.");
      this.close();
    });
  }

  /**
   * Pulls the latest Markdown note content before rendering the editor.
   */
  async load() {
    const card = this.plugin.data.cards[this.cardId];
    if (!card) {
      new Notice("Card not found.");
      this.close();
      return;
    }

    await this.plugin.hydrateCardFromFile(card);
    this.card = card;
    this.localTitle = card.title || "";
    this.localLabels = clone(card.labels || []);
    this.localGlobalLabels = clone(this.plugin.data.labels || []);
    this.localLabels.forEach((label) => this.ensureLocalGlobalLabel(label));
    this.localDetails = card.details || "";
    this.detailsDraft = "";
    this.editingDetails = false;
    this.localChecklist = clone(card.checklist || []);
    this.localAssignees = clone(card.assignees || []);
    await this.setupCardLock();
    this.render();
  }

  /**
   * Decide whether this card can be edited. If someone else already holds the
   * lock we open read-only; otherwise we take the lock and keep it warm with a
   * heartbeat until the modal closes. Offline / no-SyncDeck falls open (editable).
   */
  async setupCardLock() {
    const board = this.plugin.getBoard();
    this.lockBoardId = board && board.id;

    const holder = this.plugin.getCardLockHolder && this.plugin.getCardLockHolder(this.cardId);
    if (holder) {
      this.readOnly = true;
      this.lockHolder = holder;
      return;
    }
    if (!this.lockBoardId || !this.plugin.acquireCardLock) return;

    const result = await this.plugin.acquireCardLock(this.lockBoardId, this.cardId);
    if (result && result.ok === false) {
      this.readOnly = true;
      this.lockHolder = result.lock || null;
      return;
    }
    this.lockAcquired = !!(result && result.ok && !result.offline);
    this.plugin.editingCardId = this.cardId;
    this.startLockHeartbeat();
  }

  startLockHeartbeat() {
    this.stopLockHeartbeat();
    // Re-take the lock well within its server TTL so it never lapses mid-edit.
    // If the server now reports someone else holds it (we opened while offline,
    // or another editor took over), drop this modal to read-only.
    this.lockHeartbeat = window.setInterval(async () => {
      if (!this.lockBoardId || this.readOnly) return;
      const result = await this.plugin.acquireCardLock(this.lockBoardId, this.cardId).catch(() => null);
      if (result && result.ok === false) this.enterReadOnly(result.lock);
    }, 5000);
  }

  // Convert an open editable modal into a read-only view after losing the lock.
  // Unsaved edits are dropped rather than saved, so we never persist a write that
  // would conflict with the real editor's changes.
  enterReadOnly(holder) {
    if (this.readOnly) return;
    this.readOnly = true;
    this.lockHolder = holder || this.lockHolder;
    this.lockAcquired = false;
    if (this.saveTimer) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.stopLockHeartbeat();
    if (this.plugin.editingCardId === this.cardId) this.plugin.editingCardId = null;
    new Notice(`🔒 ${(holder && holder.name) || "Someone"} is editing this card`);
    this.render();
  }

  stopLockHeartbeat() {
    if (this.lockHeartbeat) {
      window.clearInterval(this.lockHeartbeat);
      this.lockHeartbeat = null;
    }
  }

  /**
   * Ensures labels found on a card are available in the modal's label picker.
   */
  ensureLocalGlobalLabel(label) {
    const name = cleanLabelName(label);
    if (!name) return null;

    const key = labelKey(name);
    const existing = this.localGlobalLabels.find((item) => labelKey(item) === key);
    if (existing) return existing;

    const globalLabel = { name, color: label.color || "#d43c35" };
    this.localGlobalLabels.push(globalLabel);
    return globalLabel;
  }

  isSelectedLabel(label) {
    const key = labelKey(label);
    return this.localLabels.some((item) => labelKey(item) === key);
  }

  renderAssigneesField() {
    const field = createElement("div", "ot-field ot-assignee-editor");
    field.append(createElement("span", "", "Members"));
    const row = createElement("div", "ot-assignee-row");

    const rebuild = () => {
      row.replaceChildren();
      (this.localAssignees || []).forEach((assignee) => {
        const chip = createElement("span", "ot-assignee-chip");
        const avatar = createElement("span", "ot-card-avatar");
        avatar.style.setProperty("--ot-avatar-color", assignee.color || "#8b5cf6");
        const picture = this.plugin.getMemberPicture(assignee.email);
        if (picture) {
          const img = createElement("img", "");
          img.src = picture;
          img.alt = "";
          avatar.append(img);
        } else {
          avatar.textContent = initials(assignee.name || assignee.email);
          avatar.classList.add("is-initials");
        }
        const remove = iconButton("x", "Remove member", () => {
          this.localAssignees = (this.localAssignees || []).filter((a) => a.email !== assignee.email);
          rebuild();
          this.queueSave();
        });
        remove.classList.add("ot-assignee-remove");
        chip.append(avatar, createElement("span", "ot-assignee-name", assignee.name || assignee.email), remove);
        row.append(chip);
      });
      const addButton = iconButton("plus", "Assign a member", (event) => this.showMemberMenu(event, rebuild));
      addButton.classList.add("ot-assignee-add");
      row.append(addButton);
    };

    rebuild();
    field.append(row);
    return field;
  }

  showMemberMenu(event, rebuild) {
    const members = this.plugin.getVaultMembers();
    const menu = new Menu();
    if (!members.length) {
      menu.addItem((item) => item.setTitle("No members — sign in to Sync Deck").setDisabled(true));
    } else {
      members.forEach((member) => {
        const assigned = (this.localAssignees || []).some((a) => a.email === member.email);
        menu.addItem((item) => {
          item.setTitle(member.name || member.email).setChecked(assigned).onClick(() => {
            if (assigned) {
              this.localAssignees = (this.localAssignees || []).filter((a) => a.email !== member.email);
            } else {
              this.localAssignees = [...(this.localAssignees || []), { email: member.email, name: member.name, color: member.color }];
            }
            rebuild();
            this.queueSave();
          });
        });
      });
    }
    menu.showAtMouseEvent(event);
  }

  render() {
    const card = this.card;
    this.contentEl.replaceChildren();
    this.contentEl.addClass("ot-card-modal");

    const title = createElement("input", "ot-title-input");
    title.type = "text";
    title.value = this.localTitle;
    title.placeholder = "Card title";
    title.addEventListener("input", () => {
      this.localTitle = title.value;
      this.queueSave();
    });

    const labelsField = this.renderLabelsField();
    const assigneesField = this.renderAssigneesField();
    const detailsField = this.renderDetailsField();
    const checklistField = this.renderChecklistField();

    const actions = createElement("div", "ot-modal-actions");
    const deleteButton = createElement("button", "mod-warning", "Delete");
    const openNote = createElement("button", "", "Open note");
    const close = createElement("button", "mod-cta", "Close");
    addButtonIcon(deleteButton, "trash");
    addButtonIcon(openNote, "file-text");
    addButtonIcon(close, "x");

    [deleteButton, openNote, close].forEach((button) => {
      button.type = "button";
    });

    deleteButton.addEventListener("click", async () => {
      if (!window.confirm("Delete this card and its linked Markdown note?")) return;
      await this.plugin.deleteCard(card.id);
      this.close();
    });

    openNote.addEventListener("click", async () => {
      await this.saveNow();
      await this.plugin.openCardFile(card.id);
      this.close();
    });

    close.addEventListener("click", async () => {
      await this.saveNow();
      this.close();
    });

    actions.append(deleteButton, openNote, close);

    const children = [title, labelsField, assigneesField, detailsField, checklistField, actions];
    if (this.readOnly) {
      this.contentEl.addClass("ot-card-readonly");
      const holderName = (this.lockHolder && this.lockHolder.name) || "Someone";
      children.unshift(createElement("div", "ot-card-lock-banner", `🔒 ${holderName} is editing this card — read only`));
    }
    this.contentEl.append(...children);

    if (this.readOnly) {
      title.disabled = true;
      deleteButton.disabled = true;
      this.disableEditing([labelsField, assigneesField, detailsField, checklistField]);
    } else if (!this.editingDetails) {
      requestAnimationFrame(() => title.focus());
    }
  }

  // Freeze every editable control inside the given fields so a read-only viewer
  // can look but not change anything (Open note / Close stay usable).
  disableEditing(fields) {
    fields.forEach((field) => {
      field.querySelectorAll("input, textarea, button, [contenteditable]").forEach((el) => {
        if (el.classList.contains("ot-image-tile")) return;
        if (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.tagName === "BUTTON") {
          el.disabled = true;
        } else {
          el.setAttribute("contenteditable", "false");
        }
        el.classList.add("is-disabled");
      });
    });
  }

  onClose() {
    this.stopLockHeartbeat();
    if (!this.readOnly && this.lockBoardId && this.plugin.releaseCardLock) {
      this.plugin.releaseCardLock(this.lockBoardId, this.cardId).catch(() => {});
    }
    if (this.plugin.editingCardId === this.cardId) this.plugin.editingCardId = null;
    if (this.saveTimer) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
      this.saveNow().catch(console.error);
    }
    this.contentEl.replaceChildren();
  }

  renderLabelsField() {
    const field = createElement("div", "ot-field ot-label-editor");
    field.append(createElement("span", "", "Labels"));
    const labelsWrap = createElement("div", "ot-selected-labels");
    const addButton = iconButton("plus", "Choose labels", () => {
      new LabelPickerModal(this.app, this.localGlobalLabels, this.localLabels, (labels, selectedLabels) => {
        this.localGlobalLabels = labels;
        this.localLabels = selectedLabels;
        renderLabels();
        this.saveNow().catch(console.error);
      }).open();
    });
    addButton.classList.add("ot-label-add-button");

    const renderLabels = () => {
      labelsWrap.replaceChildren();

      this.localLabels.forEach((label, index) => {
        const pill = createElement("button", "ot-large-label-pill");
        pill.type = "button";
        pill.textContent = label.name;
        pill.style.backgroundColor = label.color;
        pill.title = "Remove label";
        pill.addEventListener("click", () => {
          this.localLabels.splice(index, 1);
          renderLabels();
          this.saveNow().catch(console.error);
        });
        labelsWrap.append(pill);
      });

      labelsWrap.append(addButton);
    };
    renderLabels();
    field.append(labelsWrap);
    return field;
  }

  currentDetailsText() {
    return this.editingDetails ? this.detailsDraft : this.localDetails;
  }

  /**
   * Splits details Markdown into ordered segments so text and images render
   * inline, in the order they appear: [{type:'md',text} | {type:'img',target}].
   */
  splitDetailSegments(markdown) {
    const text = String(markdown || "");
    const re = /!\[\[([^\]]+)\]\]|!\[[^\]]*\]\(([^)]+)\)/g;
    const IMG_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif|ico)(\?|#|$)/i;
    const segments = [];
    let last = 0;
    let match;
    while ((match = re.exec(text))) {
      const isWiki = match[1] !== undefined;
      let target = (isWiki ? match[1] : match[2]) || "";
      target = target.split("|")[0].split("#")[0].trim();
      if (!isWiki) target = target.split(/\s+/)[0]; // md link: drop optional "title"
      if (!IMG_EXT.test(target)) continue; // not an image link — leave it in the text
      if (match.index > last) segments.push({ type: "md", text: text.slice(last, match.index) });
      segments.push({ type: "img", target });
      last = match.index + match[0].length;
    }
    if (last < text.length) segments.push({ type: "md", text: text.slice(last) });
    if (!segments.length) segments.push({ type: "md", text });
    return segments;
  }

  /**
   * Shows rendered Markdown by default, with a textarea editor on demand.
   */
  renderDetailsField() {
    const field = createElement("section", "ot-field ot-details-field");
    const header = createElement("div", "ot-details-heading");
    const heading = createElement("div", "ot-details-heading-title");
    const headingIcon = createElement("span", "ot-details-heading-icon");
    try {
      setIcon(headingIcon, "align-left");
    } catch (error) {
      headingIcon.textContent = "";
    }
    heading.append(headingIcon, createElement("span", "", "Description"));
    const gallery = createElement("div", "ot-image-gallery");
    const preview = createElement("div", "ot-markdown-preview");
    const editor = createElement("textarea", "ot-textarea ot-details-editor is-hidden");
    const isEditing = !this.readOnly && (this.editingDetails || !this.localDetails.trim());

    if (isEditing && !this.editingDetails) {
      this.editingDetails = true;
      this.detailsDraft = this.localDetails;
    }

    editor.placeholder = "Write a description...";
    editor.value = isEditing ? this.detailsDraft : this.localDetails;
    this.detailsTextarea = editor;
    this.detailsPreview = preview;

    // Images are saved one at a time so concurrent inserts don't race the caret.
    const insertImagesSequentially = async (images) => {
      for (const file of images) await this.insertImageFromFile(file);
      // When adding from the read view, re-render so the new image shows inline.
      if (!this.editingDetails) renderPreview();
    };

    // Hidden file input backing the "Add image" button (works on mobile too).
    const imageInput = createElement("input", "ot-hidden-file-input");
    imageInput.type = "file";
    imageInput.accept = "image/*";
    imageInput.multiple = true;
    imageInput.addEventListener("change", () => {
      const files = Array.from(imageInput.files || []);
      imageInput.value = "";
      if (files.length) insertImagesSequentially(files).catch(console.error);
    });

    const renderGallery = () => {
      this.renderImageGallery(gallery, () => {
        renderGallery();
        renderPreview();
      });
    };

    const renderPreviewFallback = (markdown, error) => {
      if (error) console.error(error);
      preview.replaceChildren();
      preview.append(createElement("pre", "ot-markdown-fallback", markdown || "Could not render details."));
    };

    const COLLAPSED_MAX = 340;
    const renderPreview = () => {
      preview.replaceChildren();
      preview.classList.remove("is-hidden");
      const markdown = this.currentDetailsText();
      if (!markdown.trim()) {
        preview.append(createElement("span", "ot-empty-text", "No description"));
        return;
      }

      // Render the note as ONE flowing document: split into ordered text/image
      // segments, render text via Markdown and images ourselves (MarkdownRenderer
      // doesn't reliably turn ![[img]] into a real image inside a modal). This
      // keeps each image exactly where it was added, inline with the text.
      const body = createElement("div", "ot-details-body");
      preview.append(body);
      this.splitDetailSegments(markdown).forEach((seg) => {
        if (seg.type === "img") {
          const resolved = this.plugin.resolveCardImage(this.card, seg.target);
          const wrap = createElement("div", "ot-inline-image");
          if (resolved && resolved.src) {
            const img = createElement("img", "");
            img.src = resolved.src;
            img.alt = resolved.name || "";
            img.loading = "lazy";
            img.addEventListener("click", (event) => {
              event.stopPropagation();
              if (resolved.file) this.app.workspace.getLeaf(false).openFile(resolved.file);
              else if (resolved.src) window.open(resolved.src, "_blank");
            });
            wrap.append(img);
          } else {
            wrap.append(createElement("span", "ot-image-missing", seg.target.split("/").pop() || "image"));
          }
          body.append(wrap);
          return;
        }
        const text = seg.text.trim();
        if (!text) return;
        const chunk = createElement("div", "ot-md-chunk");
        body.append(chunk);
        try {
          Promise.resolve(
            MarkdownRenderer.render(this.app, text, chunk, this.card.filePath || "", this)
          ).catch((error) => {
            console.error(error);
            chunk.textContent = text;
          });
        } catch (error) {
          chunk.textContent = text;
        }
      });

      // Collapse a long description behind a "Show more" toggle. Re-checked once
      // more after a moment so late-loading images are counted.
      const applyClamp = () => {
        if (preview.querySelector(".ot-details-more")) return;
        if (body.scrollHeight <= COLLAPSED_MAX + 48) return;
        body.classList.add("is-clamped");
        const more = createElement("button", "ot-details-more", "Show more");
        more.type = "button";
        more.addEventListener("click", (event) => {
          event.stopPropagation();
          const collapsed = body.classList.toggle("is-clamped");
          more.textContent = collapsed ? "Show more" : "Show less";
        });
        preview.append(more);
      };
      requestAnimationFrame(applyClamp);
      window.setTimeout(applyClamp, 400);
    };

    const showEditor = () => {
      if (this.readOnly) return;
      this.editingDetails = true;
      this.detailsDraft = this.localDetails;
      this.render();
    };

    const saveDetails = async () => {
      this.localDetails = editor.value.trim();
      this.detailsDraft = "";
      this.editingDetails = false;
      await this.saveNow();
      this.render();
    };

    const cancelDetails = () => {
      this.detailsDraft = "";
      this.editingDetails = false;
      this.render();
    };
    this.showDetailsPreview = () => {
      renderPreview();
    };

    const makeTool = (icon, label, onClick) => {
      const button = iconButton(icon, label, (event) => {
        event.preventDefault();
        event.stopPropagation();
        onClick();
      });
      button.classList.add("ot-details-tool");
      return button;
    };

    const makeTextTool = (label, title, onClick) => {
      const button = createElement("button", "ot-details-tool ot-details-text-tool", label);
      button.type = "button";
      button.title = title;
      button.setAttribute("aria-label", title);
      button.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        onClick();
      });
      return button;
    };

    const setEditorText = (value, start, end) => {
      editor.value = value;
      this.detailsDraft = value;
      editor.selectionStart = start;
      editor.selectionEnd = end;
      renderGallery();
      editor.focus();
    };

    const wrapSelection = (before, after, placeholder) => {
      const start = editor.selectionStart || 0;
      const end = editor.selectionEnd || start;
      const selected = editor.value.slice(start, end) || placeholder;
      const next = editor.value.slice(0, start) + before + selected + after + editor.value.slice(end);
      setEditorText(next, start + before.length, start + before.length + selected.length);
    };

    const prefixLines = (prefix) => {
      const start = editor.selectionStart || 0;
      const end = editor.selectionEnd || start;
      const lineStart = editor.value.lastIndexOf("\n", start - 1) + 1;
      const lineEndIndex = editor.value.indexOf("\n", end);
      const lineEnd = lineEndIndex === -1 ? editor.value.length : lineEndIndex;
      const block = editor.value.slice(lineStart, lineEnd) || "";
      const nextBlock = block.split("\n").map((line) => (line.startsWith(prefix) ? line : `${prefix}${line || " "}`)).join("\n");
      const next = editor.value.slice(0, lineStart) + nextBlock + editor.value.slice(lineEnd);
      setEditorText(next, lineStart, lineStart + nextBlock.length);
    };

    const insertBlock = (text) => {
      const start = editor.selectionStart || editor.value.length;
      const end = editor.selectionEnd || start;
      const before = editor.value.slice(0, start);
      const after = editor.value.slice(end);
      const prefix = before && !before.endsWith("\n") ? "\n" : "";
      const suffix = after && !after.startsWith("\n") ? "\n" : "";
      const inserted = `${prefix}${text}${suffix}`;
      const next = before + inserted + after;
      setEditorText(next, start + inserted.length, start + inserted.length);
    };

    // Paste or drop an image straight into the notes: it's saved into the vault
    // (respecting the attachment-folder setting) and embedded compactly.
    const isFileDrag = (event) => {
      const types = event.dataTransfer && Array.from(event.dataTransfer.types || []);
      return !!(types && types.includes("Files"));
    };
    const handlePaste = (event) => {
      const images = imageFilesFromTransfer(event.clipboardData);
      if (!images.length) return; // plain text paste — leave it alone
      event.preventDefault();
      insertImagesSequentially(images).catch(console.error);
    };
    const handleDrop = (event) => {
      if (this.readOnly || !isFileDrag(event)) return; // not a file drop — leave it
      // We invited this drop, so consume it whether or not it's an image, else a
      // stray file would fall through to Obsidian's own handling.
      event.preventDefault();
      event.stopPropagation();
      field.classList.remove("is-image-drag");
      const images = imageFilesFromTransfer(event.dataTransfer);
      if (!images.length) {
        new Notice("Only images can be embedded here.");
        return;
      }
      insertImagesSequentially(images).catch(console.error);
    };
    // Handlers live on the whole field so crossing between the preview/editor and
    // their own children (e.g. an embedded image) never flickers the hint.
    field.addEventListener("dragover", (event) => {
      if (this.readOnly || !isFileDrag(event)) return;
      event.preventDefault();
      field.classList.add("is-image-drag");
    });
    field.addEventListener("dragleave", (event) => {
      if (!field.contains(event.relatedTarget)) field.classList.remove("is-image-drag");
    });
    field.addEventListener("drop", handleDrop);

    if (isEditing) {
      const toolbar = createElement("div", "ot-details-toolbar");
      const leftTools = createElement("div", "ot-details-toolbar-group");
      leftTools.append(
        makeTextTool("Tt", "Heading", () => prefixLines("### ")),
        makeTextTool("B", "Bold", () => wrapSelection("**", "**", "bold text")),
        makeTextTool("I", "Italic", () => wrapSelection("*", "*", "italic text")),
        makeTool("ellipsis", "More", () => insertBlock("> ")),
        makeTool("list", "List", () => prefixLines("- ")),
        makeTool("link", "Link", () => wrapSelection("[", "](https://)", "link")),
        makeTool("image", "Add image", () => imageInput.click()),
        makeTool("plus", "Divider", () => insertBlock("---"))
      );

      const rightTools = createElement("div", "ot-details-toolbar-group");
      rightTools.append(
        makeTool("paperclip", "Attach image", () => imageInput.click()),
        makeTextTool("M", "Markdown", () => wrapSelection("`", "`", "code")),
        makeTool("help-circle", "Formatting help", () => new Notice("Markdown: **bold**, *italic*, - list, [link](url)."))
      );
      toolbar.append(leftTools, rightTools);

      const editorFrame = createElement("div", "ot-trello-editor");
      editor.classList.remove("is-hidden");
      editor.addEventListener("input", () => {
        this.detailsDraft = editor.value;
      });
      editor.addEventListener("paste", handlePaste);

      const actions = createElement("div", "ot-details-actions");
      const save = createElement("button", "mod-cta", "Save");
      const cancel = createElement("button", "", "Cancel");
      addButtonIcon(save, "check");
      addButtonIcon(cancel, "x");
      save.type = "button";
      cancel.type = "button";
      save.addEventListener("click", () => saveDetails().catch(console.error));
      cancel.addEventListener("click", cancelDetails);
      actions.append(save, cancel);

      header.append(heading);
      editorFrame.append(toolbar, editor);
      field.append(header, editorFrame, actions, imageInput);
      requestAnimationFrame(() => editor.focus());
      return field;
    }

    header.append(heading);
    if (!this.readOnly) header.append(textButton("pencil", "Edit", showEditor, "ot-details-edit-button"));
    renderPreview();
    field.append(preview, editor, imageInput);
    field.prepend(header);
    return field;
  }

  renderImageGallery(container, onChange) {
    const refs = imageRefsFromMarkdown(this.currentDetailsText());
    container.replaceChildren();
    container.classList.toggle("is-empty", !refs.length);
    container.classList.toggle("is-editing", !!this.editingDetails);
    container.classList.toggle("is-preview", !this.editingDetails);
    if (!refs.length) return;

    const grid = createElement("div", "ot-image-gallery-grid");
    refs.forEach((ref) => {
      const resolved = this.plugin.resolveCardImage(this.card, ref);
      const item = createElement("div", "ot-image-item");
      const tile = createElement("button", "ot-image-tile");
      tile.type = "button";

      if (resolved && resolved.src) {
        const img = createElement("img", "");
        img.src = resolved.src;
        img.alt = resolved.name || "";
        img.loading = "lazy";
        tile.append(img);
      } else {
        tile.append(createElement("span", "ot-image-missing", ref.target.split("/").pop() || "Image"));
      }

      tile.addEventListener("click", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.openImageRef(ref);
      });
      item.append(tile);

      if (this.editingDetails && !this.readOnly) {
        const remove = iconButton("x", "Remove image", async (event) => {
          event.preventDefault();
          event.stopPropagation();
          this.removeImageRef(ref);
          onChange();
          if (this.editingDetails) return;
          await this.saveNow();
        });
        remove.classList.add("ot-image-remove");
        item.append(remove);
      } else if (resolved && resolved.file) {
        const info = iconButton("info", "Open image", (event) => {
          event.preventDefault();
          event.stopPropagation();
          this.openImageRef(ref);
        });
        info.classList.add("ot-image-info");
        item.append(info);
      }

      grid.append(item);
    });
    container.append(grid);
  }

  openImageRef(ref) {
    const resolved = this.plugin.resolveCardImage(this.card, ref);
    if (resolved && resolved.file) {
      this.app.workspace.getLeaf(false).openFile(resolved.file);
    } else if (resolved && resolved.src) {
      window.open(resolved.src, "_blank");
    }
  }

  removeImageRef(ref) {
    if (this.readOnly || !ref || !ref.markup) return;
    const next = String(this.currentDetailsText() || "")
      .replace(ref.markup, "")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (this.editingDetails) {
      this.detailsDraft = next;
    } else {
      this.localDetails = next;
    }
    if (this.detailsTextarea) this.detailsTextarea.value = next;
  }

  /**
   * Inserts text at the details caret, switching from preview to the editor if
   * needed, and queues a save. Embeds land on their own line.
   */
  insertDetailText(text) {
    if (this.readOnly) return false;
    const ta = this.detailsTextarea;
    // In the editor, drop the embed at the caret so it lands where you're typing.
    if (this.editingDetails && ta && !ta.classList.contains("is-hidden")) {
      const start = typeof ta.selectionStart === "number" ? ta.selectionStart : ta.value.length;
      const end = typeof ta.selectionEnd === "number" ? ta.selectionEnd : ta.value.length;
      const before = ta.value.slice(0, start);
      const after = ta.value.slice(end);
      const prefix = before && !before.endsWith("\n") ? "\n" : "";
      const suffix = after && !after.startsWith("\n") ? "\n" : "";
      const inserted = `${prefix}${text}${suffix}`;
      ta.value = before + inserted + after;
      const caret = start + inserted.length;
      ta.selectionStart = ta.selectionEnd = caret;
      this.detailsDraft = ta.value;
      ta.focus();
      return true;
    }
    // From the read view, append the embed on its own line.
    const base = String(this.localDetails || "");
    const sep = !base ? "" : (base.endsWith("\n") ? "\n" : "\n\n");
    this.localDetails = `${base}${sep}${text}`;
    return true;
  }

  /**
   * Saves a pasted/dropped image into the vault (via the attachment-folder
   * setting) and inserts a compact embed at the caret.
   */
  async insertImageFromFile(file) {
    if (this.readOnly || !file) return;
    try {
      const data = await file.arrayBuffer();
      const type = file.type || "image/png";
      let ext = (type.split("/")[1] || "png").split("+")[0].toLowerCase();
      if (ext === "jpeg") ext = "jpg";
      const rawName = (file.name || "").trim();
      // Keep a real, human filename; replace empty/generic/UUID names (typical of
      // clipboard pastes) with a tidy "Pasted image <timestamp>".
      const realName = rawName
        && /\.[a-z0-9]+$/i.test(rawName)
        && rawName.toLowerCase() !== "image.png"
        && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\./i.test(rawName);
      const fileName = safeImageFileName(realName ? rawName : `Pasted image ${imageStamp()}.${ext}`, ext);
      const sourcePath = (this.card && this.card.filePath) || "";
      // Card media lives in <board>/attachments so the board folder stays tidy.
      const board = this.plugin.findBoardForCard(this.card);
      let targetPath;
      if (board && board.folderPath) {
        targetPath = this.uniqueVaultPath(`${board.folderPath}/attachments/${fileName}`);
      } else {
        const fm = this.app.fileManager;
        targetPath = fm && typeof fm.getAvailablePathForAttachment === "function"
          ? await fm.getAvailablePathForAttachment(fileName, sourcePath)
          : fileName;
      }
      const parent = targetPath.split("/").slice(0, -1).join("/");
      if (parent && !this.app.vault.getAbstractFileByPath(parent)) {
        await this.app.vault.createFolder(parent).catch(() => {});
      }
      // The card lock can be lost during the awaits above; don't write a binary
      // we can no longer reference into the note.
      if (this.readOnly || !this.detailsTextarea) return;
      await this.app.vault.createBinary(targetPath, data);
      const inserted = this.insertDetailText(`![[${targetPath}]]`);
      if (!inserted) {
        // Couldn't place the reference — trash the orphan instead of leaving it.
        const created = this.app.vault.getAbstractFileByPath(targetPath);
        if (created) await this.app.vault.trash(created, false).catch(() => {});
        return;
      }
      if (this.editingDetails) this.localDetails = this.detailsDraft;
      // Persist the binary and its embed together (not just the debounced save),
      // so a crash right after can't leave an unreferenced attachment.
      await this.saveNow();
    } catch (error) {
      console.error(error);
      new Notice("Couldn't add the image.");
    }
  }

  // Returns `path`, or the next free "name N.ext" variant if it already exists.
  uniqueVaultPath(path) {
    if (!this.app.vault.getAbstractFileByPath(path)) return path;
    const dot = path.lastIndexOf(".");
    const base = dot > 0 ? path.slice(0, dot) : path;
    const ext = dot > 0 ? path.slice(dot) : "";
    let i = 1;
    let candidate = `${base} ${i}${ext}`;
    while (this.app.vault.getAbstractFileByPath(candidate)) {
      i += 1;
      candidate = `${base} ${i}${ext}`;
    }
    return candidate;
  }

  /**
   * MarkdownRenderer inside a Modal doesn't auto-load ![[image]] embeds, so fill
   * any unresolved image embed with a real <img> pointing at the vault resource.
   */
  hydrateImageEmbeds(container) {
    const sourcePath = (this.card && this.card.filePath) || "";
    container.querySelectorAll(".internal-embed").forEach((embed) => {
      if (embed.querySelector("img")) return; // already loaded
      const link = embed.getAttribute("src") || embed.getAttribute("data-src") || embed.getAttribute("alt");
      if (!link) return;
      let target = null;
      try {
        target = this.app.metadataCache.getFirstLinkpathDest(link.split("|")[0], sourcePath);
      } catch (error) {
        target = null;
      }
      if (!target || !this.plugin.resolveCardImage(this.card, target.path)) return;
      const img = container.ownerDocument.createElement("img");
      img.src = this.app.vault.getResourcePath(target);
      img.alt = target.name;
      embed.replaceChildren(img);
      embed.classList.add("image-embed", "media-embed", "is-loaded");
    });
  }

  /**
   * Renders checklist items plus the progress bar used by the card badges.
   */
  renderChecklistField() {
    const field = createElement("div", "ot-field");
    const header = createElement("div", "ot-checklist-header");
    const heading = createElement("div", "ot-checklist-heading");
    const headingIcon = createElement("span", "ot-checklist-heading-icon");
    try {
      setIcon(headingIcon, "check-square");
    } catch (error) {
      headingIcon.textContent = "☑";
    }
    heading.append(headingIcon, createElement("span", "", "Checklist"));
    header.append(heading);

    const progress = createElement("div", "ot-checklist-progress");
    const progressText = createElement("span", "ot-checklist-percent", "0%");
    const progressTrack = createElement("div", "ot-progress-track");
    const progressFill = createElement("div", "ot-progress-fill");
    progressTrack.append(progressFill);
    progress.append(progressText, progressTrack);

    const list = createElement("div", "ot-checklist");
    const updateProgress = () => {
      const stats = checklistStats(this.localChecklist);
      progressText.textContent = `${stats.percent}%`;
      progressFill.style.width = `${stats.percent}%`;
    };

    const renderChecklist = () => {
      list.replaceChildren();
      if (!this.localChecklist.length) {
        list.append(createElement("span", "ot-empty-text", "No checklist items"));
      }

      this.localChecklist.forEach((item, index) => {
        const row = createElement("div", "ot-checklist-row");
        const checkbox = createElement("input");
        checkbox.type = "checkbox";
        checkbox.checked = !!item.done;
        const input = createElement("input", "ot-checklist-title");
        input.type = "text";
        input.value = item.text || "";
        const remove = iconButton("x", "Remove item", () => {
          this.localChecklist.splice(index, 1);
          renderChecklist();
          this.saveNow().catch(console.error);
        });
        remove.addEventListener("click", (event) => event.stopPropagation());

        checkbox.addEventListener("change", () => {
          item.done = checkbox.checked;
          updateProgress();
          this.saveNow().catch(console.error);
        });
        input.addEventListener("input", () => {
          item.text = input.value;
          this.queueSave();
        });
        row.append(checkbox, input, remove);
        list.append(row);
      });
      updateProgress();
    };

    const addArea = createElement("div", "ot-checklist-add");
    const renderAddArea = () => {
      addArea.replaceChildren();

      if (!this.addingChecklistItem) {
        addArea.append(textButton("plus", "Add item", () => {
          this.addingChecklistItem = true;
          renderAddArea();
        }));
        return;
      }

      const addForm = createElement("form", "ot-checklist-add-form");
      const addInput = createElement("input", "ot-input");
      addInput.type = "text";
      addInput.placeholder = "Checklist item";
      const addButton = createElement("button", "mod-cta", "Add");
      addButtonIcon(addButton, "plus");
      const cancel = iconButton("x", "Cancel", () => {
        this.addingChecklistItem = false;
        renderAddArea();
      });
      addButton.type = "submit";
      addForm.append(addInput, addButton, cancel);
      addForm.addEventListener("submit", (event) => {
        event.preventDefault();
        const text = textLine(addInput.value);
        if (!text) {
          addInput.focus();
          return;
        }
        this.localChecklist.push({ done: false, text });
        this.addingChecklistItem = false;
        renderChecklist();
        renderAddArea();
        this.saveNow().catch(console.error);
      });
      addInput.addEventListener("keydown", (event) => {
        if (event.key === "Escape") {
          this.addingChecklistItem = false;
          renderAddArea();
        }
      });
      addArea.append(addForm);
      requestAnimationFrame(() => addInput.focus());
    };

    renderChecklist();
    renderAddArea();
    field.append(header, progress, list, addArea);
    return field;
  }

  /**
   * Sanitizes modal state and writes it through the plugin's card updater.
   */
  cardPatch() {
    return {
      title: textLine(this.localTitle) || this.card.title,
      labels: clone(this.localLabels),
      assignees: clone(this.localAssignees || []),
      details: this.localDetails.trim(),
      checklist: this.localChecklist
        .map((item) => ({ done: !!item.done, text: textLine(item.text) }))
        .filter((item) => item.text),
    };
  }

  queueSave() {
    if (this.readOnly) return;
    if (this.saveTimer) window.clearTimeout(this.saveTimer);
    this.saveTimer = window.setTimeout(() => {
      this.saveTimer = null;
      this.saveNow().catch(console.error);
    }, 350);
  }

  async saveNow() {
    if (this.saveTimer) {
      window.clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    if (this.readOnly) return;

    const card = this.card;
    if (!card) return;

    const patch = this.cardPatch();
    const globalLabels = clone(this.localGlobalLabels);
    this.savePromise = this.savePromise
      .then(() => this.plugin.updateCard(card.id, patch, globalLabels))
      .catch((error) => {
        console.error(error);
        new Notice("Could not save card.");
      });

    await this.savePromise;
  }
}

module.exports = {
  TextPromptModal,
  LabelPickerModal,
  ListColorModal,
  CardDatesModal,
  AboutModal,
  CardModal,
};
