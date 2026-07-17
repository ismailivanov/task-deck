const { MarkdownRenderer, Menu, Modal, Notice, arrayBufferToBase64, setIcon } = require("obsidian");

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
  dateRangeLabel,
  fieldDateLabel,
  hasDragType,
  iconButton,
  imageRefsFromMarkdown,
  imageSizeFromMarkup,
  imageMarkupWithSize,
  isoFromDate,
  labelKey,
  stripImageEmbeds,
  textButton,
  textLine,
  initials,
} = require("./helpers");

// ---- Markdown <-> HTML for the WYSIWYG description blocks ----
// A deliberately SMALL, symmetric subset (paragraphs, line breaks, #-headings,
// -/1. lists, > quotes, ---, **bold**, *italic*, `code`, [link](url)) so that
// md -> html -> md round-trips bytes for everything these converters produce.
// Unrecognized markdown stays literal text and survives untouched.
function escapeDetailsHtml(text) {
  return String(text).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function inlineMdToHtml(text) {
  let out = escapeDetailsHtml(text);
  out = out.replace(/`([^`]+)`/g, "<code>$1</code>");
  out = out.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  out = out.replace(/(^|[^*])\*([^*]+)\*(?!\*)/g, "$1<em>$2</em>");
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>');
  return out;
}

function detailsMdToHtml(markdown) {
  const lines = String(markdown || "").split("\n");
  const html = [];
  let para = [];
  const flushPara = () => {
    if (para.length) html.push(`<p>${para.map(inlineMdToHtml).join("<br>")}</p>`);
    para = [];
  };
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) { flushPara(); i += 1; continue; }
    if (/^-{3,}\s*$/.test(line)) { flushPara(); html.push("<hr>"); i += 1; continue; }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    if (heading) {
      flushPara();
      const level = Math.min(heading[1].length, 6);
      html.push(`<h${level}>${inlineMdToHtml(heading[2])}</h${level}>`);
      i += 1;
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      flushPara();
      const items = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) {
        items.push(`<li>${inlineMdToHtml(lines[i].replace(/^[-*]\s+/, ""))}</li>`);
        i += 1;
      }
      html.push(`<ul>${items.join("")}</ul>`);
      continue;
    }
    if (/^\d+[.)]\s+/.test(line)) {
      flushPara();
      const items = [];
      while (i < lines.length && /^\d+[.)]\s+/.test(lines[i])) {
        items.push(`<li>${inlineMdToHtml(lines[i].replace(/^\d+[.)]\s+/, ""))}</li>`);
        i += 1;
      }
      html.push(`<ol>${items.join("")}</ol>`);
      continue;
    }
    if (/^>\s?/.test(line)) {
      flushPara();
      const quoted = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) {
        quoted.push(inlineMdToHtml(lines[i].replace(/^>\s?/, "")));
        i += 1;
      }
      // One <p> per quoted line (empty lines keep a <br> so they hold a caret):
      // per-line wrappers are what lets the editor's Enter-on-empty-line escape
      // detect the current line inside the quote.
      html.push(`<blockquote>${quoted.map((q) => `<p>${q || "<br>"}</p>`).join("")}</blockquote>`);
      continue;
    }
    para.push(line);
    i += 1;
  }
  flushPara();
  return html.join("");
}

// Serialize a contenteditable's DOM back to the same markdown subset. Unknown
// wrappers (span/font/...) are flattened to their text, so pasted styling can't
// leak HTML into the note.
function detailsHtmlToMd(root) {
  const BLOCK_TAGS = /^(P|DIV|UL|OL|BLOCKQUOTE|HR|H[1-6])$/;
  const inline = (node) => {
    let out = "";
    node.childNodes.forEach((child) => {
      if (child.nodeType === 3) { out += child.textContent; return; }
      if (child.nodeType !== 1) return;
      const tag = child.tagName;
      if (tag === "BR") { out += "\n"; return; }
      const inner = inline(child);
      if (tag === "B" || tag === "STRONG") out += inner.trim() ? `**${inner}**` : inner;
      else if (tag === "I" || tag === "EM") out += inner.trim() ? `*${inner}*` : inner;
      else if (tag === "CODE") out += inner.trim() ? `\`${inner}\`` : inner;
      else if (tag === "A") out += `[${inner || child.getAttribute("href") || "link"}](${child.getAttribute("href") || ""})`;
      else out += inner;
    });
    return out;
  };
  // Chromium freely nests blocks (a <ul> inside the caret's <p>, a quote inside
  // a <div>...), so serialization must RECURSE into containers — flattening a
  // wrapped list through inline() used to glue every item into one word.
  const serializeChildren = (node, parts) => {
    node.childNodes.forEach((child) => {
      if (child.nodeType === 3) {
        if (child.textContent.trim()) parts.push(child.textContent);
        return;
      }
      if (child.nodeType !== 1) return;
      if (BLOCK_TAGS.test(child.tagName)) serializeBlock(child, parts);
      else {
        const text = inline({ childNodes: [child] });
        if (text.trim()) parts.push(text);
      }
    });
  };
  const serializeBlock = (el, parts) => {
    const tag = el.tagName;
    if (/^H[1-6]$/.test(tag)) {
      parts.push(`${"#".repeat(Number(tag[1]))} ${inline(el)}`);
      return;
    }
    if (tag === "UL" || tag === "OL") {
      const lines = [];
      let n = 1;
      el.querySelectorAll(":scope > li").forEach((li) => {
        const nestedBlocks = Array.from(li.children).filter((c) => BLOCK_TAGS.test(c.tagName));
        const inlineOnly = { childNodes: Array.from(li.childNodes).filter((c) => !(c.nodeType === 1 && BLOCK_TAGS.test(c.tagName))) };
        lines.push(tag === "UL" ? `- ${inline(inlineOnly)}` : `${n++}. ${inline(inlineOnly)}`);
        // Nested lists/blocks inside an item flatten to sibling lines.
        nestedBlocks.forEach((nested) => {
          const sub = [];
          serializeBlock(nested, sub);
          sub.forEach((line) => lines.push(line));
        });
      });
      parts.push(lines.join("\n"));
      return;
    }
    if (tag === "BLOCKQUOTE") {
      const sub = [];
      serializeChildren(el, sub);
      const flat = sub.length ? sub.join("\n") : inline(el);
      parts.push(flat.split("\n").map((l) => `> ${l}`).join("\n"));
      return;
    }
    if (tag === "HR") { parts.push("---"); return; }
    // P/DIV: a real paragraph when it only holds inline content; a transparent
    // container when Chromium nested block elements inside it.
    const hasBlockChild = Array.from(el.children || []).some((c) => BLOCK_TAGS.test(c.tagName));
    if (hasBlockChild) { serializeChildren(el, parts); return; }
    const text = inline(el);
    if (text.trim()) parts.push(text);
  };
  const parts = [];
  serializeChildren(root, parts);
  return parts.join("\n\n").replace(/\u00a0/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

// Drag payload type for reordering image blocks inside the description editor.
const IMG_BLOCK_DRAG_TYPE = "application/x-task-deck-image-block";

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
  constructor(app, plugin, cardId, options = {}) {
    super(app);
    this.plugin = plugin;
    this.cardId = cardId;
    // notesOnly: show just the title + Description + Checklist (used by the table
    // view, where labels / members / dates / status are edited inline in the cells).
    this.notesOnly = !!options.notesOnly;
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

  // Single-member picker for one checklist item (leftmost circle).
  showChecklistMemberMenu(event, item, rerender) {
    const members = this.plugin.getVaultMembers();
    const menu = new Menu();
    menu.addItem((mi) => mi
      .setTitle("Unassigned")
      .setChecked(!(item.assignee && item.assignee.email))
      .onClick(() => {
        item.assignee = null;
        rerender();
        this.saveNow().catch(console.error);
      }));
    if (!members.length) {
      menu.addItem((mi) => mi.setTitle("No members — sign in to Sync Deck").setDisabled(true));
    } else {
      members.forEach((member) => {
        const current = !!(item.assignee && item.assignee.email === member.email);
        menu.addItem((mi) => mi
          .setTitle(member.name || member.email)
          .setChecked(current)
          .onClick(() => {
            item.assignee = { email: member.email, name: member.name, color: member.color };
            rerender();
            this.saveNow().catch(console.error);
          }));
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

    const labelsField = this.notesOnly ? null : this.renderLabelsField();
    const assigneesField = this.notesOnly ? null : this.renderAssigneesField();
    const detailsField = this.renderDetailsField();
    const checklistField = this.renderChecklistField();

    const actions = createElement("div", "ot-modal-actions");
    const deleteButton = createElement("button", "mod-warning", "Delete");
    const openNote = createElement("button", "", "Open note");
    const exportPdf = createElement("button", "", "PDF");
    const close = createElement("button", "mod-cta", "Close");
    addButtonIcon(deleteButton, "trash");
    addButtonIcon(openNote, "file-text");
    addButtonIcon(exportPdf, "download");
    addButtonIcon(close, "x");

    [deleteButton, openNote, exportPdf, close].forEach((button) => {
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

    // Works in read-only too — exporting doesn't modify the card.
    exportPdf.addEventListener("click", () => this.exportCardPdf().catch(console.error));

    close.addEventListener("click", async () => {
      await this.saveNow();
      this.close();
    });

    actions.append(deleteButton, openNote, exportPdf, close);

    const editableFields = this.notesOnly ? [detailsField, checklistField] : [labelsField, assigneesField, detailsField, checklistField];
    const children = [title, ...editableFields, actions];
    if (this.readOnly) {
      this.contentEl.addClass("ot-card-readonly");
      const holderName = (this.lockHolder && this.lockHolder.name) || "Someone";
      children.unshift(createElement("div", "ot-card-lock-banner", `🔒 ${holderName} is editing this card — read only`));
    }
    this.contentEl.append(...children);

    if (this.readOnly) {
      title.disabled = true;
      deleteButton.disabled = true;
      this.disableEditing(editableFields);
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
      // Keep the exact original markup so an editor rebuilding the markdown from
      // segments round-trips wiki AND ![](url) embeds byte-identically. start/end
      // let callers splice a resized embed back into the source string safely.
      segments.push({ type: "img", target, markup: match[0], start: match.index, end: match.index + match[0].length });
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
    // Reset the block-editor caret hook; the edit branch below re-installs it.
    this.insertDetailAtCaret = null;
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
      const segs = this.splitDetailSegments(markdown);
      // Grid layout for the run of images around segIndex: writes an even column
      // width into every embed of the run (descending offsets, so earlier
      // splices can't shift later ones), saves, and re-renders.
      const applyGridToSegRun = async (segIndex, columns) => {
        const run = this.imageSegRun(segs, segIndex);
        if (!run.length) return;
        const width = columns ? this.gridColumnWidth(preview.clientWidth || 640, columns) : 0;
        let source = this.localDetails;
        [...run].sort((a, b) => b.start - a.start).forEach((s) => {
          source = source.slice(0, s.start) + imageMarkupWithSize(s.markup, width) + source.slice(s.end);
        });
        this.localDetails = source;
        await this.saveNow();
        renderPreview();
      };
      segs.forEach((seg, segIndex) => {
        if (seg.type === "img") {
          const resolved = this.plugin.resolveCardImage(this.card, seg.target);
          const wrap = createElement("div", "ot-inline-image");
          if (resolved && resolved.src) {
            const img = createElement("img", "");
            img.src = resolved.src;
            img.alt = resolved.name || "";
            img.loading = "lazy";
            // No click action on the image itself — opening the underlying note
            // on every stray click was irritating. The preview's click-to-edit
            // guard already ignores images, so a click here simply does nothing;
            // copying is the hover chip's job.
            wrap.append(img);
            // Hover chip: copy the image to the clipboard without entering edit
            // mode (and without opening the file).
            const copyButton = iconButton("copy", "Copy image", async (event) => {
              event.preventDefault();
              event.stopPropagation();
              try {
                await this.copyImageToClipboard(img);
                new Notice("Image copied");
              } catch (error) {
                new Notice("Could not copy the image on this platform.");
              }
            });
            copyButton.classList.add("ot-image-copy");
            wrap.append(copyButton);
            this.applyStoredImageWidth(img, seg.markup);
            // Resize straight from the read view — the width is stored in the
            // note's embed markup (Obsidian's |300 syntax), so it renders the
            // same when the card note opens in Obsidian.
            if (!this.readOnly) {
              this.enableImageResize(wrap, img, {
                getMarkup: () => seg.markup,
                onCommit: async (width) => {
                  const next = imageMarkupWithSize(seg.markup, width);
                  if (next === seg.markup) return;
                  // Splice at the segment's own offsets — replacing by string
                  // would hit the wrong copy when the same image (and size)
                  // appears twice in one note.
                  const source = this.localDetails;
                  this.localDetails = source.slice(0, seg.start) + next + source.slice(seg.end);
                  seg.markup = next;
                  await this.saveNow();
                  renderPreview();
                },
              });
              // Grid chip: lay the surrounding image run out as 2/3/4 columns.
              const gridChip = iconButton("layout-grid", "Arrange images side by side", (event) => {
                event.preventDefault();
                event.stopPropagation();
                const menu = new Menu();
                [2, 3, 4].forEach((columns) => {
                  menu.addItem((item) => item.setTitle(`${columns} side by side`).onClick(() => {
                    applyGridToSegRun(segIndex, columns).catch(console.error);
                  }));
                });
                menu.addItem((item) => item.setTitle("Full width").onClick(() => {
                  applyGridToSegRun(segIndex, 0).catch(console.error);
                }));
                menu.showAtMouseEvent(event);
              });
              gridChip.classList.add("ot-image-grid-chip");
              wrap.append(gridChip);
            }
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

    // Toolbar buttons must not steal focus from the contenteditable on mousedown,
    // or the user's selection collapses before the command can format it.
    const keepEditorSelection = (button) => {
      button.addEventListener("mousedown", (event) => event.preventDefault());
      return button;
    };

    const makeTool = (icon, label, onClick) => {
      const button = iconButton(icon, label, (event) => {
        event.preventDefault();
        event.stopPropagation();
        onClick();
      });
      button.classList.add("ot-details-tool");
      return keepEditorSelection(button);
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
      return keepEditorSelection(button);
    };

    // ---- Block editor (Notion/Trello-style WYSIWYG) ----
    // Editing splits the markdown into TEXT blocks (contenteditable surfaces
    // where bold/italic/lists render LIVE) and IMAGE blocks (real thumbnails
    // with a remove chip) — the user never sees raw markdown markers. `blocks`
    // is the source of truth while editing; each input serializes its block back
    // to markdown (detailsHtmlToMd) and syncDraft() re-joins the whole note into
    // the hidden master textarea (`editor`) that saveDetails/saveNow already read.
    const blocksHost = createElement("div", "ot-block-editor");
    let blocks = [];
    let activeText = null; // { block, ce } of the focused text block

    const buildBlocks = (markdown) => {
      const built = [];
      this.splitDetailSegments(String(markdown || "")).forEach((seg) => {
        if (seg.type === "img") {
          // Guarantee a text slot before an image so there's always somewhere
          // to type between/around pictures.
          if (!built.length || built[built.length - 1].type === "img") built.push({ type: "text", value: "" });
          built.push({ type: "img", target: seg.target, markup: seg.markup || `![[${seg.target}]]` });
          return;
        }
        const value = seg.text.replace(/^\n+/, "").replace(/\n+$/, "");
        if (built.length && built[built.length - 1].type === "text") {
          const prev = built[built.length - 1];
          prev.value = prev.value && value ? `${prev.value}\n${value}` : (prev.value || value);
        } else {
          built.push({ type: "text", value });
        }
      });
      if (!built.length || built[0].type === "img") built.unshift({ type: "text", value: "" });
      if (built[built.length - 1].type === "img") built.push({ type: "text", value: "" });
      return built;
    };

    const joinBlocks = () => {
      const parts = [];
      blocks.forEach((block) => {
        if (block.type === "img") parts.push(block.markup);
        else if (block.value.trim()) parts.push(block.value.replace(/\n{3,}/g, "\n\n"));
      });
      return parts.join("\n\n");
    };

    const syncDraft = () => {
      this.detailsDraft = joinBlocks();
      editor.value = this.detailsDraft;
    };

    const placeCaret = (ce, atStart) => {
      ce.focus();
      const range = document.createRange();
      range.selectNodeContents(ce);
      range.collapse(!!atStart);
      const selection = window.getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
    };

    const focusedText = () => {
      if (activeText && blocks.includes(activeText.block) && activeText.ce && activeText.ce.isConnected) return activeText;
      for (let i = blocks.length - 1; i >= 0; i -= 1) {
        if (blocks[i].type === "text" && blocks[i]._ce) return { block: blocks[i], ce: blocks[i]._ce };
      }
      return null;
    };

    const syncBlockFromDom = (t) => {
      t.block.value = detailsHtmlToMd(t.ce);
      syncDraft();
    };

    // Toolbar commands run against the focused contenteditable via execCommand,
    // so bold/italic/lists render LIVE in the editor (and Enter continues a
    // list natively) instead of inserting raw markdown markers.
    const runCommand = (mutate) => {
      const t = focusedText();
      if (!t) return;
      t.ce.focus();
      mutate(t);
      syncBlockFromDom(t);
    };
    const execCmd = (command, value) => runCommand(() => document.execCommand(command, false, value || null));
    const toggleBlockFormat = (tag) => runCommand(() => {
      const current = String(document.queryCommandValue("formatBlock") || "").toLowerCase();
      document.execCommand("formatBlock", false, current === tag ? "p" : tag);
    });
    const wrapCode = () => runCommand(() => {
      const selection = window.getSelection();
      if (!selection || !selection.rangeCount || selection.isCollapsed) {
        document.execCommand("insertText", false, "`code`");
        return;
      }
      const range = selection.getRangeAt(0);
      try {
        range.surroundContents(document.createElement("code"));
      } catch (error) {
        document.execCommand("insertText", false, `\`${selection.toString()}\``);
      }
    });
    const insertLink = () => {
      const t = focusedText();
      if (!t) return;
      const selection = window.getSelection();
      const hasSelection = !!(selection && selection.rangeCount && !selection.isCollapsed && t.ce.contains(selection.anchorNode));
      const savedRange = hasSelection ? selection.getRangeAt(0).cloneRange() : null;
      new TextPromptModal(this.app, "Link", "https://...", "https://", (url) => {
        const target = textLine(url);
        if (!target || target === "https://") return;
        t.ce.focus();
        if (savedRange) {
          const restore = window.getSelection();
          restore.removeAllRanges();
          restore.addRange(savedRange);
          document.execCommand("createLink", false, target);
        } else {
          document.execCommand("insertHTML", false, `<a href="${escapeDetailsHtml(target)}">${escapeDetailsHtml(target)}</a>`);
        }
        syncBlockFromDom(t);
      }).open();
    };

    // The run of consecutive image blocks around `index` (empty text slots
    // between images don't break the run) — the group a grid layout applies to.
    const imageRunAround = (index) => {
      if (!blocks[index] || blocks[index].type !== "img") return [];
      const isGap = (b) => b && b.type === "text" && !b.value.trim();
      let start = index;
      while (start - 1 >= 0) {
        if (blocks[start - 1].type === "img") { start -= 1; continue; }
        if (isGap(blocks[start - 1]) && start - 2 >= 0 && blocks[start - 2].type === "img") { start -= 2; continue; }
        break;
      }
      const run = [];
      for (let i = start; i < blocks.length; i += 1) {
        if (blocks[i].type === "img") { run.push(blocks[i]); continue; }
        if (isGap(blocks[i]) && blocks[i + 1] && blocks[i + 1].type === "img") continue;
        break;
      }
      return run;
    };

    const applyGridToBlockRun = (index, columns) => {
      const run = imageRunAround(index);
      if (!run.length) return;
      const width = columns ? this.gridColumnWidth(blocksHost.clientWidth || 640, columns) : 0;
      run.forEach((b) => { b.markup = imageMarkupWithSize(b.markup, width); });
      syncDraft();
      renderBlocks();
    };

    const renderBlocks = () => {
      blocksHost.replaceChildren();
      blocks.forEach((block, index) => {
        if (block.type === "text") {
          // A real WYSIWYG surface: markdown renders as formatted content and
          // serializes back on every input — the user never sees the markers.
          const ce = createElement("div", "ot-block-text");
          ce.contentEditable = "true";
          ce.spellcheck = true;
          ce.innerHTML = detailsMdToHtml(block.value);
          if (index === 0 && blocks.length === 1) ce.dataset.placeholder = "Write a description...";
          const refreshEmpty = () => { ce.dataset.empty = ce.textContent.trim() ? "false" : "true"; };
          refreshEmpty();
          // An empty text slot wedged between two images collapses to a slim
          // clickable strip so consecutive images sit side by side like a grid;
          // typing in it expands it back to a full row — matching the read
          // view, where text between two embeds breaks the image flow.
          const betweenImages = !!(blocks[index - 1] && blocks[index - 1].type === "img" && blocks[index + 1] && blocks[index + 1].type === "img");
          const refreshSlim = () => { ce.classList.toggle("ot-block-text--slim", betweenImages && !ce.textContent.trim()); };
          refreshSlim();
          ce.addEventListener("input", () => {
            block.value = detailsHtmlToMd(ce);
            syncDraft();
            refreshEmpty();
            refreshSlim();
          });
          ce.addEventListener("focus", () => { activeText = { block, ce }; });
          // Escape hatch for quotes and lists (Notion behavior): pressing Enter
          // on an EMPTY line inside a blockquote or list item exits it and drops
          // the caret into a normal paragraph below — otherwise contenteditable
          // keeps every new line trapped inside the quote forever.
          ce.addEventListener("keydown", (event) => {
            if (event.key !== "Enter" || event.shiftKey) return;
            const selection = window.getSelection();
            if (!selection || !selection.rangeCount || !selection.isCollapsed) return;
            const anchor = selection.anchorNode;
            if (!anchor || !ce.contains(anchor)) return;
            const el = anchor.nodeType === 1 ? anchor : anchor.parentElement;
            if (!el) return;
            const listItem = el.closest("li");
            const quote = el.closest("blockquote");
            if (!listItem && !quote) return;
            // The "current line" must be a wrapper INSIDE the quote - closest()
            // can walk past a structureless quote up to the editor root, whose
            // textContent is the whole block (the escape would never fire there).
            let line = listItem;
            if (!line) {
              const candidate = el.closest("p, div");
              line = candidate && quote.contains(candidate) && candidate !== quote ? candidate : quote;
            }
            if ((line.textContent || "").replace(/\u00a0/g, " ").trim()) return; // line has content — normal Enter
            event.preventDefault();
            document.execCommand("outdent");
            block.value = detailsHtmlToMd(ce);
            syncDraft();
            refreshEmpty();
          });
          ce.addEventListener("paste", (event) => {
            const images = imageFilesFromTransfer(event.clipboardData);
            if (images.length) {
              event.preventDefault();
              insertImagesSequentially(images).catch(console.error);
              return;
            }
            // Paste as plain text so foreign HTML styling can't leak into the note.
            const text = event.clipboardData ? event.clipboardData.getData("text/plain") : "";
            event.preventDefault();
            if (text) document.execCommand("insertText", false, text);
          });
          block._ce = ce;
          blocksHost.append(ce);
          return;
        }
        const wrap = createElement("div", "ot-block-image");
        const resolved = this.plugin.resolveCardImage(this.card, block.target);
        if (resolved && resolved.src) {
          const img = createElement("img", "");
          img.src = resolved.src;
          img.alt = resolved.name || "";
          img.loading = "lazy";
          wrap.append(img);
          this.applyStoredImageWidth(img, block.markup);
          // Drag-resize rewrites the block's markup in place; joinBlocks picks
          // it up on the next keystroke, and Save persists it like any edit.
          this.enableImageResize(wrap, img, {
            getMarkup: () => block.markup,
            onCommit: (width) => {
              block.markup = imageMarkupWithSize(block.markup, width);
              syncDraft();
            },
          });
        } else {
          wrap.append(createElement("span", "ot-image-missing", block.target.split("/").pop() || "image"));
        }
        const remove = iconButton("trash", "Remove image", (event) => {
          event.preventDefault();
          event.stopPropagation();
          const at = blocks.indexOf(block);
          if (at === -1) return;
          blocks.splice(at, 1);
          // Merge the text blocks the image used to separate.
          if (at > 0 && at < blocks.length && blocks[at - 1].type === "text" && blocks[at].type === "text") {
            const merged = [blocks[at - 1].value, blocks[at].value].filter((part) => part.trim());
            blocks[at - 1].value = merged.join("\n\n");
            blocks.splice(at, 1);
          }
          syncDraft();
          renderBlocks();
        });
        remove.classList.add("ot-block-image-remove");
        wrap.append(remove);

        // Grid chip: lay the surrounding image run out as 2/3/4 columns.
        const gridChip = iconButton("layout-grid", "Arrange images side by side", (event) => {
          event.preventDefault();
          event.stopPropagation();
          const menu = new Menu();
          [2, 3, 4].forEach((columns) => {
            menu.addItem((item) => item.setTitle(`${columns} side by side`).onClick(() => {
              applyGridToBlockRun(blocks.indexOf(block), columns);
            }));
          });
          menu.addItem((item) => item.setTitle("Full width").onClick(() => {
            applyGridToBlockRun(blocks.indexOf(block), 0);
          }));
          menu.showAtMouseEvent(event);
        });
        gridChip.classList.add("ot-image-grid-chip");
        wrap.append(gridChip);

        // Move an image by dragging it: drop on another image's left/right half
        // to land before/after it. Structure re-normalizes from the markdown so
        // the text slots around images stay consistent after any move.
        wrap.draggable = true;
        wrap.addEventListener("dragstart", (event) => {
          if (event.target.closest(".ot-img-resize, .ot-block-image-remove, .ot-image-grid-chip")) {
            event.preventDefault();
            return;
          }
          event.dataTransfer.setData(IMG_BLOCK_DRAG_TYPE, String(blocks.indexOf(block)));
          event.dataTransfer.effectAllowed = "move";
          wrap.classList.add("is-dragging");
        });
        wrap.addEventListener("dragend", () => wrap.classList.remove("is-dragging"));
        wrap.addEventListener("dragover", (event) => {
          if (!hasDragType(event, IMG_BLOCK_DRAG_TYPE)) return;
          event.preventDefault();
          const rect = wrap.getBoundingClientRect();
          const before = event.clientX < rect.left + rect.width / 2;
          wrap.classList.toggle("is-img-drop-before", before);
          wrap.classList.toggle("is-img-drop-after", !before);
        });
        wrap.addEventListener("dragleave", () => wrap.classList.remove("is-img-drop-before", "is-img-drop-after"));
        wrap.addEventListener("drop", (event) => {
          if (!hasDragType(event, IMG_BLOCK_DRAG_TYPE)) return;
          event.preventDefault();
          event.stopPropagation();
          const before = wrap.classList.contains("is-img-drop-before");
          wrap.classList.remove("is-img-drop-before", "is-img-drop-after");
          const fromIndex = parseInt(event.dataTransfer.getData(IMG_BLOCK_DRAG_TYPE), 10);
          const dragged = blocks[fromIndex];
          if (!dragged || dragged === block || dragged.type !== "img") return;
          blocks.splice(fromIndex, 1);
          let to = blocks.indexOf(block);
          if (to === -1) return;
          if (!before) to += 1;
          blocks.splice(to, 0, dragged);
          blocks = buildBlocks(joinBlocks());
          syncDraft();
          renderBlocks();
        });

        blocksHost.append(wrap);
      });
    };

    // Clicking the frame's empty space puts the caret in the nearest text block.
    blocksHost.addEventListener("click", (event) => {
      if (event.target !== blocksHost) return;
      const t = focusedText();
      if (t && t.ce) placeCaret(t.ce, false);
    });

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
        makeTextTool("Tt", "Heading", () => toggleBlockFormat("h3")),
        makeTextTool("B", "Bold", () => execCmd("bold")),
        makeTextTool("I", "Italic", () => execCmd("italic")),
        makeTool("ellipsis", "Quote", () => toggleBlockFormat("blockquote")),
        makeTool("list", "Bulleted list", () => execCmd("insertUnorderedList")),
        makeTool("link", "Link", insertLink),
        makeTool("image", "Add image", () => imageInput.click()),
        makeTool("plus", "Divider", () => execCmd("insertHorizontalRule"))
      );

      const rightTools = createElement("div", "ot-details-toolbar-group");
      rightTools.append(
        makeTool("paperclip", "Attach image", () => imageInput.click()),
        makeTextTool("M", "Code", wrapCode),
        makeTool("help-circle", "Formatting help", () => new Notice("Select text, then use the toolbar — formatting shows live in the editor."))
      );
      toolbar.append(leftTools, rightTools);

      const editorFrame = createElement("div", "ot-trello-editor ot-block-frame");
      // The master textarea stays hidden: it only mirrors the joined markdown so
      // saveDetails / insertImageFromFile keep reading the same place as before.
      blocks = buildBlocks(this.detailsDraft);
      syncDraft();
      renderBlocks();

      // An image pasted/attached while editing lands at the active block's caret,
      // splitting the text so the picture renders inline immediately — the user
      // never sees ![[...]] markup.
      this.insertDetailAtCaret = (markup) => {
        const t = focusedText();
        if (!t) return false;
        const at = blocks.indexOf(t.block);
        if (at === -1) return false;
        // Split the focused contenteditable at the caret: serialize what's
        // before and after it, so the image lands exactly where you're typing.
        let beforeText = t.block.value;
        let afterText = "";
        const selection = window.getSelection();
        if (selection && selection.rangeCount && t.ce.contains(selection.anchorNode)) {
          const range = selection.getRangeAt(0);
          const beforeRange = document.createRange();
          beforeRange.selectNodeContents(t.ce);
          beforeRange.setEnd(range.startContainer, range.startOffset);
          const afterRange = document.createRange();
          afterRange.selectNodeContents(t.ce);
          afterRange.setStart(range.endContainer, range.endOffset);
          const beforeHost = document.createElement("div");
          beforeHost.append(beforeRange.cloneContents());
          const afterHost = document.createElement("div");
          afterHost.append(afterRange.cloneContents());
          beforeText = detailsHtmlToMd(beforeHost);
          afterText = detailsHtmlToMd(afterHost);
        }
        const seg = this.splitDetailSegments(markup).find((s) => s.type === "img");
        blocks.splice(
          at,
          1,
          { type: "text", value: beforeText },
          { type: "img", target: (seg && seg.target) || markup, markup },
          { type: "text", value: afterText }
        );
        syncDraft();
        renderBlocks();
        const nextBlock = blocks[at + 2];
        requestAnimationFrame(() => {
          if (nextBlock && nextBlock._ce) placeCaret(nextBlock._ce, true);
        });
        return true;
      };

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
      editorFrame.append(toolbar, blocksHost);
      field.append(header, editorFrame, actions, imageInput, editor);
      requestAnimationFrame(() => {
        // Enter should produce clean <p> paragraphs (matches the serializer).
        try { document.execCommand("defaultParagraphSeparator", false, "p"); } catch (error) { /* older engines */ }
        const t = focusedText();
        if (t && t.ce) placeCaret(t.ce, false);
      });
      return field;
    }

    header.append(heading);
    if (!this.readOnly) header.append(textButton("pencil", "Edit", showEditor, "ot-details-edit-button"));
    // Click-to-edit: clicking the description opens the editor directly — no
    // trip to the Edit button. Guards keep the read view copy-friendly:
    // - a click that ends a TEXT SELECTION (drag-select, double-click a word)
    //   must select/copy, not switch to the editor;
    // - images, links, and buttons (Copy image, Show more) keep their own click
    //   behavior and never flip to edit.
    preview.addEventListener("click", (event) => {
      if (this.readOnly) return;
      if (event.target.closest("img, a, button, .ot-inline-image")) return;
      const selection = window.getSelection();
      if (selection && selection.toString()) return;
      showEditor();
    });
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

  // Copy a rendered <img> to the system clipboard as PNG. Draws through a canvas
  // because the source is a vault resource URL (same-origin in Obsidian, so the
  // canvas is not tainted). ClipboardItem exists on desktop (Electron); on a
  // platform without it this throws and the caller shows a notice.
  async copyImageToClipboard(img) {
    if (!img.complete || !(img.naturalWidth > 0)) throw new Error("image not loaded");
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth;
    canvas.height = img.naturalHeight;
    canvas.getContext("2d").drawImage(img, 0, 0);
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/png"));
    if (!blob || typeof ClipboardItem === "undefined" || !navigator.clipboard || !navigator.clipboard.write) {
      throw new Error("clipboard image write unsupported");
    }
    await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
  }

  // Applies the width stored in an embed's markup (Obsidian's |300 syntax) to a
  // rendered <img>. An explicit width lifts the height cap: the size is the
  // user's choice, so tall images must not be letterboxed by max-height.
  applyStoredImageWidth(img, markup) {
    const width = imageSizeFromMarkup(markup);
    if (width) {
      img.style.width = `${width}px`;
      img.style.maxHeight = "none";
    }
  }

  // The run of consecutive image segments around `index` (whitespace-only text
  // between images doesn't break the run) — the group a grid layout applies to.
  imageSegRun(segs, index) {
    if (!segs[index] || segs[index].type !== "img") return [];
    const isGap = (s) => s && s.type === "md" && !s.text.trim();
    let start = index;
    while (start - 1 >= 0) {
      if (segs[start - 1].type === "img") { start -= 1; continue; }
      if (isGap(segs[start - 1]) && start - 2 >= 0 && segs[start - 2].type === "img") { start -= 2; continue; }
      break;
    }
    const run = [];
    for (let i = start; i < segs.length; i += 1) {
      if (segs[i].type === "img") { run.push(segs[i]); continue; }
      if (isGap(segs[i]) && segs[i + 1] && segs[i + 1].type === "img") continue;
      break;
    }
    return run;
  }

  // Even column width for a K-across image grid inside a container.
  gridColumnWidth(containerWidth, columns) {
    const width = Math.floor((Math.max(320, containerWidth) - 28 - columns * 10) / columns);
    return Math.max(100, width);
  }

  /**
   * Notion-style image resize: a grip on the image's right edge. Dragging
   * resizes the live <img> (with a px chip); on release the width is committed
   * through onCommit(width) — 0 meaning "clear the size" when dragged to full
   * width — which rewrites the embed markup via imageMarkupWithSize, so the
   * size persists in the note and renders identically in Obsidian. Consecutive
   * images flow side by side, so sizing two down makes an instant grid.
   */
  enableImageResize(wrap, img, options) {
    const { getMarkup, onCommit } = options;
    const handle = createElement("div", "ot-img-resize");
    handle.title = "Drag to resize";
    handle.setAttribute("aria-label", "Resize image");
    const chip = createElement("div", "ot-img-size-chip is-hidden");
    wrap.append(handle, chip);

    let drag = null;
    const finishDrag = (commit) => {
      if (!drag) return;
      const { width, maxWidth } = drag;
      drag = null;
      handle.classList.remove("is-dragging");
      chip.classList.add("is-hidden");
      if (!commit) {
        // Interrupted drag — fall back to whatever the markup still says.
        img.style.width = "";
        img.style.maxHeight = "";
        this.applyStoredImageWidth(img, getMarkup());
        return;
      }
      // At (practically) the container's width, storing no size renders the
      // same — and keeps big future layouts full-width.
      const finalWidth = width >= maxWidth - 2 ? 0 : width;
      if (!finalWidth) {
        img.style.width = "";
        img.style.maxHeight = "";
      }
      Promise.resolve(onCommit(finalWidth)).catch(console.error);
    };

    handle.addEventListener("pointerdown", (event) => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      event.preventDefault();
      event.stopPropagation();
      const container = wrap.parentElement;
      const maxWidth = Math.max(160, (container ? container.clientWidth : 1200) - 4);
      const startWidth = img.getBoundingClientRect().width;
      drag = { startX: event.clientX, startWidth, maxWidth, width: Math.round(startWidth) };
      handle.classList.add("is-dragging");
      chip.classList.remove("is-hidden");
      chip.textContent = `${drag.width}px`;
      try { handle.setPointerCapture(event.pointerId); } catch (error) { /* older engines */ }
    });
    handle.addEventListener("pointermove", (event) => {
      if (!drag) return;
      event.preventDefault();
      const width = Math.min(drag.maxWidth, Math.max(100, Math.round(drag.startWidth + event.clientX - drag.startX)));
      if (width === drag.width) return;
      drag.width = width;
      img.style.width = `${width}px`;
      img.style.maxHeight = "none";
      chip.textContent = `${width}px`;
    });
    handle.addEventListener("pointerup", (event) => {
      try { handle.releasePointerCapture(event.pointerId); } catch (error) { /* not captured */ }
      finishDrag(true);
    });
    handle.addEventListener("pointercancel", () => finishDrag(false));
  }

  // Export this card as a clean, print-styled PDF (title, board/list, labels,
  // members, dates, description with embedded images, checklist). Desktop only:
  // renders self-contained HTML in a hidden BrowserWindow and uses Electron's
  // printToPDF — no dependence on the current window or Obsidian's note export.
  async exportCardPdf() {
    let remote = null;
    try { remote = window.require && window.require("@electron/remote"); } catch (error) { remote = null; }
    if (!remote) {
      try { remote = window.require && window.require("electron").remote; } catch (error) { remote = null; }
    }
    if (!remote || !remote.BrowserWindow || !remote.dialog) {
      new Notice("PDF export needs the Obsidian desktop app.");
      return;
    }
    try {
      if (!this.readOnly) await this.saveNow();
      const card = this.card;
      const board = this.plugin.findBoardForCard(card);
      const list = board && board.lists.find((item) => item.id === card.listId);
      const esc = escapeDetailsHtml;

      // Description: markdown via the shared converter; images inlined as data
      // URLs so the hidden window needs no access to the vault's app:// protocol.
      // Consecutive images form a RUN (whitespace between embeds doesn't break
      // it) and print as a flex row with PERCENTAGE widths derived from the
      // stored px sizes (relative to the ~800px modal they were sized in). Raw
      // px would overflow the narrower A4 content box and wrap the grid into a
      // single column — percentages keep 2-across as 2-across on any page.
      const descriptionParts = [];
      let imageRun = [];
      const flushImageRun = () => {
        if (!imageRun.length) return;
        if (imageRun.length === 1) {
          const only = imageRun[0];
          const sizing = only.width ? ` style="width:${Math.min(only.width, 660)}px"` : "";
          descriptionParts.push(`<img src="${only.src}"${sizing}>`);
        } else {
          const cells = imageRun.map((item) => {
            const percent = Math.min(100, Math.max(12, Math.round(((item.width || 380) / 8) * 10) / 10));
            return `<img src="${item.src}" style="width: calc(${percent}% - 8px)">`;
          }).join("");
          descriptionParts.push(`<div class="imgrow">${cells}</div>`);
        }
        imageRun = [];
      };
      for (const seg of this.splitDetailSegments(this.currentDetailsText())) {
        if (seg.type === "img") {
          const resolved = this.plugin.resolveCardImage(card, seg.target);
          if (resolved && resolved.file) {
            try {
              const bin = await this.app.vault.readBinary(resolved.file);
              const ext = (resolved.file.extension || "png").toLowerCase();
              const mime = ext === "svg" ? "image/svg+xml" : (ext === "jpg" ? "image/jpeg" : `image/${ext}`);
              imageRun.push({
                src: `data:${mime};base64,${arrayBufferToBase64(bin)}`,
                width: imageSizeFromMarkup(seg.markup),
              });
            } catch (error) {
              // unreadable image — skip it rather than fail the export
            }
          }
          continue;
        }
        if (!seg.text.trim()) continue; // whitespace gap — keep the image run going
        flushImageRun();
        descriptionParts.push(detailsMdToHtml(seg.text));
      }
      flushImageRun();

      const labelsHtml = (this.localLabels || [])
        .map((label) => `<span class="pill" style="background:${esc(label.color || "#2f6fd6")}">${esc(label.name)}</span>`)
        .join("");
      const membersText = (this.localAssignees || []).map((a) => a.name || a.email).filter(Boolean).join(", ");
      const datesText = dateRangeLabel(card.startDate, card.dueDate) || "";
      const checklistHtml = (this.localChecklist || [])
        .map((item) => `<div class="chk"><span class="box">${item.done ? "☑" : "☐"}</span><span class="${item.done ? "done" : ""}">${esc(item.text || "")}</span>${item.assignee && (item.assignee.name || item.assignee.email) ? `<span class="who"> — ${esc(item.assignee.name || item.assignee.email)}</span>` : ""}</div>`)
        .join("");
      const metaBits = [
        board ? esc(board.name) : "",
        list ? esc(list.title) : "",
        card.completed ? "Completed" : "",
        datesText ? esc(datesText) : "",
      ].filter(Boolean).join(" • ");

      const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(this.localTitle || "Card")}</title><style>
        body { font-family: -apple-system, "Segoe UI", Roboto, sans-serif; color: #1f2328; margin: 42px; line-height: 1.5; }
        h1 { font-size: 24px; margin: 0 0 6px; }
        .meta { color: #667085; font-size: 13px; margin-bottom: 12px; }
        .pill { display: inline-block; color: #fff; border-radius: 4px; padding: 2px 10px; font-size: 12px; font-weight: 700; margin: 0 6px 6px 0; }
        .section { margin-top: 22px; }
        .section h2 { font-size: 15px; margin: 0 0 8px; border-bottom: 1px solid #e5e7eb; padding-bottom: 6px; }
        img { max-width: 100%; border-radius: 8px; margin: 10px 0; }
        .imgrow { display: flex; flex-wrap: wrap; gap: 8px; align-items: flex-start; margin: 10px 0; }
        .imgrow img { margin: 0; }
        .chk { margin: 4px 0; }
        .box { margin-right: 7px; }
        .done { text-decoration: line-through; color: #98a2b3; }
        .who { color: #667085; font-size: 12px; }
        blockquote { border-left: 3px solid #e5e7eb; margin: 8px 0; padding: 2px 12px; color: #667085; }
        code { background: #f2f4f7; padding: 1px 5px; border-radius: 4px; }
        ul, ol { padding-left: 22px; }
        p { margin: 0 0 0.6em; }
      </style></head><body>
        <h1>${esc(this.localTitle || "Card")}</h1>
        ${metaBits ? `<div class="meta">${metaBits}</div>` : ""}
        ${labelsHtml ? `<div>${labelsHtml}</div>` : ""}
        ${membersText ? `<div class="meta" style="margin-top:8px">Members: ${esc(membersText)}</div>` : ""}
        ${descriptionParts.length ? `<div class="section"><h2>Description</h2>${descriptionParts.join("")}</div>` : ""}
        ${checklistHtml ? `<div class="section"><h2>Checklist</h2>${checklistHtml}</div>` : ""}
      </body></html>`;

      const chosen = await remote.dialog.showSaveDialog({
        defaultPath: `${String(this.localTitle || "card").replace(/[\\/:*?"<>|]/g, "-").trim() || "card"}.pdf`,
        filters: [{ name: "PDF", extensions: ["pdf"] }],
      });
      if (!chosen || chosen.canceled || !chosen.filePath) return;

      const fs = window.require("fs");
      const os = window.require("os");
      const pathMod = window.require("path");
      const tmpPath = pathMod.join(os.tmpdir(), `task-deck-card-${Date.now()}.html`);
      fs.writeFileSync(tmpPath, html, "utf8");
      const win = new remote.BrowserWindow({ show: false, webPreferences: { sandbox: true } });
      try {
        await win.loadFile(tmpPath);
        // Give layout a beat to settle (data-URI images decode synchronously,
        // but pagination measures after first paint).
        await new Promise((resolve) => setTimeout(resolve, 150));
        const pdf = await win.webContents.printToPDF({ printBackground: true, pageSize: "A4" });
        fs.writeFileSync(chosen.filePath, pdf);
        new Notice("PDF saved.");
      } finally {
        win.destroy();
        try { fs.unlinkSync(tmpPath); } catch (error) { /* temp cleanup is best-effort */ }
      }
    } catch (error) {
      console.error(error);
      new Notice("Could not export the PDF.");
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
    // Block editor open: let it place the embed at the active block's caret and
    // render it as a real image immediately.
    if (this.editingDetails && this.insertDetailAtCaret) return this.insertDetailAtCaret(text);
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

        // Per-item member circle (leftmost): click to assign this item to a member.
        const assigneeBtn = createElement("button", "ot-checklist-assignee");
        assigneeBtn.type = "button";
        const paintAssignee = () => {
          assigneeBtn.replaceChildren();
          const a = item.assignee;
          if (a && a.email) {
            assigneeBtn.classList.add("is-assigned");
            assigneeBtn.title = a.name || a.email;
            const avatar = createElement("span", "ot-card-avatar");
            avatar.style.setProperty("--ot-avatar-color", a.color || "#8b5cf6");
            const picture = this.plugin.getMemberPicture(a.email);
            if (picture) {
              const img = createElement("img", "");
              img.src = picture;
              img.alt = "";
              avatar.append(img);
            } else {
              avatar.textContent = initials(a.name || a.email);
              avatar.classList.add("is-initials");
            }
            assigneeBtn.append(avatar);
          } else {
            assigneeBtn.classList.remove("is-assigned");
            assigneeBtn.title = "Assign member";
            assigneeBtn.append(createElement("span", "ot-checklist-assignee-empty"));
          }
        };
        paintAssignee();
        assigneeBtn.addEventListener("click", (event) => {
          event.preventDefault();
          event.stopPropagation();
          this.showChecklistMemberMenu(event, item, paintAssignee);
        });

        row.append(assigneeBtn, checkbox, input, remove);
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
        .map((item) => ({
          done: !!item.done,
          text: textLine(item.text),
          assignee: item.assignee && item.assignee.email
            ? { email: item.assignee.email, name: item.assignee.name || "", color: item.assignee.color || "" }
            : null,
        }))
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
