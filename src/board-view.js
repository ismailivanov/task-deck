const { ItemView, Menu, Notice, setIcon } = require("obsidian");

// Renders the kanban board and handles inline card/list interactions.
const {
  DONATION_URL,
  LIST_DRAG_TYPE,
  TASK_DECK_ICON,
  VIEW_TYPE,
  addButtonIcon,
  checklistStats,
  createElement,
  dateRangeLabel,
  initials,
  hasDragType,
  iconButton,
  textButton,
  textLine,
} = require("./helpers");
const { AboutModal, CardDatesModal, CardModal, LabelPickerModal, ListColorModal } = require("./modals");

// Live board presence (SyncDeck cursors) tuning.
// The transport stays plain HTTP polling; smoothness comes from client-side
// interpolation rather than a faster/heavier network loop.
const PRESENCE_SEND_INTERVAL_MS = 110; // min gap between outbound position posts while moving
const PRESENCE_POLL_ACTIVE_MS = 260; // GET poll while other cursors are on the board
const PRESENCE_POLL_IDLE_MS = 1100; // GET poll when nobody else is present
const PRESENCE_HEARTBEAT_MS = 3000; // resend our own point so the server TTL never expires us
const PRESENCE_SMOOTHING_TAU_MS = 70; // interpolation time constant; lower = snappier, higher = smoother
const PRESENCE_SNAP_DISTANCE = 0.0006; // normalized distance under which we snap instead of easing

// Drag payload type for reordering table columns (kept distinct from card/list drags).
const TABLE_COL_DRAG_TYPE = "application/x-task-deck-column";

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
    this.showingBoardHome = false;
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

  async onClose() {
    this.stopPresence();
    this.closeTablePopover();
  }

  render() {
    const board = this.plugin.getBoard();
    this.stopPresence();
    this.contentEl.replaceChildren();
    this.contentEl.addClass("ot-board-root");
    this.contentEl.classList.toggle("is-compact-labels", !!this.plugin.data.compactLabels);

    if (!board || this.showingBoardHome) {
      this.renderBoardHome();
      return;
    }

    const mode = this.getViewMode(board);
    const toolbar = createElement("div", "ot-toolbar");
    const title = createElement("div", "ot-toolbar-title");
    title.append(iconButton("layout-dashboard", "Boards", () => {
      this.showingBoardHome = true;
      this.render();
    }));
    title.append(createElement("h2", "", board.name));
    if (this.plugin.data.boards.length > 1) title.append(this.renderBoardSelect(board));
    title.append(this.renderViewSwitch(board, mode));
    toolbar.append(title);
    const actions = createElement("div", "ot-toolbar-actions");
    actions.append(textButton("plus-square", "New board", () => this.plugin.createBoardPrompt()));
    // Cross-sell only for users who don't have Sync Deck yet; hide once installed.
    if (!this.plugin.getSyncDeckPlugin()) {
      actions.append(textButton("cloud", "Sync Boards", () => this.plugin.openSyncDeck(), "ot-cloud-cta"));
    }
    actions.append(
      textButton("info", "About", () => new AboutModal(this.app, this.plugin).open()),
      textButton("heart", "Support", () => window.open(DONATION_URL, "_blank")),
      textButton("plus", "Add list", () => this.plugin.addList())
    );
    toolbar.append(actions);

    // Table view is a second lens over the SAME card data (each Kanban list is a
    // Status value). No card data changes, so nothing new syncs — the chosen view
    // is a per-device UI preference kept in data.json. Presence cursors are a
    // board-layout concept, so they only run in board mode.
    if (mode === "table") {
      this.contentEl.append(toolbar, this.renderTable(board));
      return;
    }

    const scroller = createElement("div", "ot-board-scroll");
    board.lists.forEach((list) => scroller.append(this.renderList(list)));

    this.contentEl.append(toolbar, scroller);
    this.startPresence(board);
  }

  // Per-board, per-device view preference ("board" | "table"). Stored in data.json
  // (never in the synced index files), so switching lenses can't touch card data.
  getViewMode(board) {
    const modes = this.plugin.data.viewModes;
    return (modes && board && modes[board.id]) || "board";
  }

  setViewMode(board, mode) {
    if (!board) return;
    this.plugin.data.viewModes = this.plugin.data.viewModes || {};
    if (this.plugin.data.viewModes[board.id] === mode) return;
    this.plugin.data.viewModes[board.id] = mode;
    // Light persistence only — a view toggle must NOT rewrite board index files.
    // Fire-and-forget: the re-render below doesn't depend on the write, and a rare
    // data.json write failure shouldn't surface as an unhandled rejection.
    Promise.resolve(this.plugin.saveData(this.plugin.data)).catch(() => {});
    this.render();
  }

  renderViewSwitch(board, mode) {
    const wrap = createElement("div", "ot-view-switch");
    const tab = (key, icon, label) => {
      const button = createElement("button", "ot-view-tab" + (mode === key ? " is-active" : ""));
      button.type = "button";
      const glyph = createElement("span", "ot-view-tab-icon");
      try { setIcon(glyph, icon); } catch (error) { glyph.textContent = ""; }
      button.append(glyph, createElement("span", "", label));
      button.addEventListener("click", () => this.setViewMode(board, key));
      return button;
    };
    wrap.append(tab("board", "columns", "Board"), tab("table", "table", "Table"));
    return wrap;
  }

  // The optional (Status = list), reorderable/resizable/hideable columns. "Task"
  // is always the fixed first column. Definitions live here; per-board layout
  // (order / hidden / widths) is a per-device preference in data.json.
  tableColumnDefs() {
    return [
      { key: "status", label: "Status" },
      { key: "assignee", label: "Assignee" },
      { key: "dates", label: "Dates" },
      { key: "labels", label: "Labels" },
    ];
  }

  defaultColWidth(key) {
    return { status: 150, assignee: 175, dates: 155, labels: 190 }[key] || 150;
  }

  getTableConfig(board) {
    const validKeys = this.tableColumnDefs().map((def) => def.key);
    const raw = (this.plugin.data.tableConfigs && this.plugin.data.tableConfigs[board.id]) || {};
    const order = (Array.isArray(raw.order) ? raw.order : []).filter((key) => validKeys.includes(key));
    validKeys.forEach((key) => { if (!order.includes(key)) order.push(key); });
    const hidden = new Set((Array.isArray(raw.hidden) ? raw.hidden : []).filter((key) => validKeys.includes(key)));
    const widths = {};
    order.forEach((key) => { widths[key] = (raw.widths && raw.widths[key]) || this.defaultColWidth(key); });
    return { nameWidth: raw.nameWidth || 260, order, hidden, widths };
  }

  persistTableConfig(board, cfg) {
    this.plugin.data.tableConfigs = this.plugin.data.tableConfigs || {};
    this.plugin.data.tableConfigs[board.id] = {
      nameWidth: cfg.nameWidth,
      order: cfg.order.slice(),
      hidden: Array.from(cfg.hidden),
      widths: Object.assign({}, cfg.widths),
    };
    // Per-device UI layout only — never rewrite the synced board files.
    Promise.resolve(this.plugin.saveData(this.plugin.data)).catch(() => {});
  }

  reorderColumn(board, cfg, draggedKey, targetKey) {
    if (draggedKey === targetKey) return;
    cfg.order = cfg.order.filter((key) => key !== draggedKey);
    const targetIndex = cfg.order.indexOf(targetKey);
    cfg.order.splice(targetIndex < 0 ? cfg.order.length : targetIndex, 0, draggedKey);
    this.persistTableConfig(board, cfg);
    this.render();
  }

  moveColumn(board, cfg, key, direction) {
    const visible = cfg.order.filter((k) => !cfg.hidden.has(k));
    const neighbour = visible[visible.indexOf(key) + direction];
    if (!neighbour) return;
    const from = cfg.order.indexOf(key);
    const to = cfg.order.indexOf(neighbour);
    cfg.order[from] = neighbour;
    cfg.order[to] = key;
    this.persistTableConfig(board, cfg);
    this.render();
  }

  // Notion-style table: one row per card across every list, Status = the card's
  // list. Row click opens a Description + Checklist card view; every other field
  // (status, members, dates, labels) is edited inline from its cell.
  renderTable(board) {
    const cfg = this.getTableConfig(board);
    const defs = this.tableColumnDefs();
    const labelOf = (key) => (defs.find((def) => def.key === key) || {}).label || key;
    const visible = cfg.order.filter((key) => !cfg.hidden.has(key));

    const wrap = createElement("div", "ot-table-wrap");
    const table = createElement("table", "ot-table");

    // Fixed layout + a <colgroup> gives each column an exact, drag-resizable width.
    const colgroup = createElement("colgroup");
    const nameCol = createElement("col");
    nameCol.style.width = `${cfg.nameWidth}px`;
    colgroup.append(nameCol);
    const colByKey = {};
    visible.forEach((key) => {
      const col = createElement("col");
      col.style.width = `${cfg.widths[key]}px`;
      colByKey[key] = col;
      colgroup.append(col);
    });
    const addCol = createElement("col");
    addCol.style.width = "40px";
    colgroup.append(addCol);
    table.append(colgroup);

    const thead = createElement("thead");
    const headRow = createElement("tr");
    const nameTh = createElement("th", "ot-th ot-th-name");
    const nameThInner = createElement("div", "ot-th-inner");
    nameThInner.append(createElement("span", "ot-th-label", "Task"));
    nameTh.append(nameThInner);
    nameTh.append(this.buildColResize(nameCol, () => {
      cfg.nameWidth = parseInt(nameCol.style.width, 10) || cfg.nameWidth;
      this.persistTableConfig(board, cfg);
    }, 140));
    headRow.append(nameTh);
    visible.forEach((key) => headRow.append(this.renderColumnHeader(board, cfg, key, labelOf(key), colByKey[key])));
    headRow.append(this.renderAddColumnHeader(board, cfg, defs));
    thead.append(headRow);
    table.append(thead);

    const tbody = createElement("tbody");
    let count = 0;
    board.lists.forEach((list) => {
      (list.cardIds || []).forEach((cardId) => {
        const card = this.plugin.data.cards[cardId];
        if (!card) return;
        tbody.append(this.renderTableRow(card, list, board, visible));
        count += 1;
      });
    });
    table.append(tbody);

    wrap.append(table);
    if (!count) wrap.append(createElement("div", "ot-table-empty", "No tasks yet."));
    wrap.append(this.renderTableComposer(board));
    return wrap;
  }

  // A drag handle on a column's right edge. Resizes the <col> live, persists on
  // release. Stops propagation so it never triggers header reorder / sort.
  buildColResize(col, onEnd, min = 80) {
    const handle = createElement("div", "ot-col-resize");
    handle.draggable = false;
    handle.addEventListener("click", (event) => event.stopPropagation());
    handle.addEventListener("mousedown", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const startX = event.clientX;
      const startWidth = parseInt(col.style.width, 10) || col.offsetWidth || min;
      document.body.classList.add("ot-col-resizing");
      const onMove = (moveEvent) => {
        col.style.width = `${Math.max(min, startWidth + (moveEvent.clientX - startX))}px`;
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        document.body.classList.remove("ot-col-resizing");
        onEnd();
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
    return handle;
  }

  renderColumnHeader(board, cfg, key, label, col) {
    const th = createElement("th", "ot-th");
    th.dataset.colKey = key;
    th.draggable = true;
    const inner = createElement("div", "ot-th-inner");
    inner.append(createElement("span", "ot-th-label", label));

    const menuButton = createElement("button", "ot-th-menu");
    menuButton.type = "button";
    menuButton.title = "Column options";
    try { setIcon(menuButton, "chevron-down"); } catch (error) { menuButton.textContent = "▾"; }
    menuButton.draggable = false;
    menuButton.addEventListener("click", (event) => {
      event.stopPropagation();
      const menu = new Menu();
      menu.addItem((item) => item.setTitle("Move left").setIcon("arrow-left").onClick(() => this.moveColumn(board, cfg, key, -1)));
      menu.addItem((item) => item.setTitle("Move right").setIcon("arrow-right").onClick(() => this.moveColumn(board, cfg, key, 1)));
      menu.addItem((item) => item.setTitle("Hide column").setIcon("eye-off").onClick(() => {
        cfg.hidden.add(key);
        this.persistTableConfig(board, cfg);
        this.render();
      }));
      menu.showAtMouseEvent(event);
    });
    inner.append(menuButton);
    th.append(inner);

    th.addEventListener("dragstart", (event) => {
      // A drag that begins on the menu caret or the resize handle must not turn
      // into a column reorder — cancel it so a click/resize there stays intact.
      if (event.target.closest && event.target.closest(".ot-th-menu, .ot-col-resize")) {
        event.preventDefault();
        return;
      }
      event.dataTransfer.setData(TABLE_COL_DRAG_TYPE, key);
      event.dataTransfer.effectAllowed = "move";
      th.classList.add("is-col-dragging");
    });
    th.addEventListener("dragend", () => th.classList.remove("is-col-dragging"));
    th.addEventListener("dragover", (event) => {
      if (!hasDragType(event, TABLE_COL_DRAG_TYPE)) return;
      event.preventDefault();
      th.classList.add("is-col-drop");
    });
    th.addEventListener("dragleave", () => th.classList.remove("is-col-drop"));
    th.addEventListener("drop", (event) => {
      th.classList.remove("is-col-drop");
      if (!hasDragType(event, TABLE_COL_DRAG_TYPE)) return;
      event.preventDefault();
      const dragged = event.dataTransfer.getData(TABLE_COL_DRAG_TYPE);
      if (dragged) this.reorderColumn(board, cfg, dragged, key);
    });

    th.append(this.buildColResize(col, () => {
      cfg.widths[key] = parseInt(col.style.width, 10) || cfg.widths[key];
      this.persistTableConfig(board, cfg);
    }));
    return th;
  }

  renderAddColumnHeader(board, cfg, defs) {
    const th = createElement("th", "ot-th ot-th-add");
    const button = createElement("button", "ot-th-add-btn");
    button.type = "button";
    button.title = "Add a column";
    try { setIcon(button, "plus"); } catch (error) { button.textContent = "+"; }
    button.addEventListener("click", (event) => {
      event.stopPropagation();
      const hidden = cfg.order.filter((key) => cfg.hidden.has(key));
      const menu = new Menu();
      if (!hidden.length) {
        menu.addItem((item) => item.setTitle("All columns shown").setDisabled(true));
      } else {
        hidden.forEach((key) => {
          const label = (defs.find((def) => def.key === key) || {}).label || key;
          menu.addItem((item) => item.setTitle(label).setIcon("plus").onClick(() => {
            cfg.hidden.delete(key);
            this.persistTableConfig(board, cfg);
            this.render();
          }));
        });
      }
      menu.showAtMouseEvent(event);
    });
    th.append(button);
    return th;
  }

  renderTableRow(card, list, board, visible) {
    const lockHolder = this.plugin.getCardLockHolder(card.id);
    const lockedByOther = !!lockHolder;
    const row = createElement("tr", "ot-table-row");
    row.dataset.cardId = card.id;
    if (card.completed) row.classList.add("is-completed");
    if (lockedByOther) row.classList.add("is-locked");
    // Opening a task from the table shows ONLY Description + Checklist — every
    // other field is edited inline from its cell, so no full editor is needed.
    row.addEventListener("click", () => new CardModal(this.app, this.plugin, card.id, { notesOnly: true }).open());

    const nameCell = createElement("td", "ot-td ot-td-name");
    const nameInner = createElement("div", "ot-td-name-inner");
    // A plain <div> checkbox (not a button) so no theme button box appears.
    const complete = createElement("div", "ot-table-check");
    complete.setAttribute("role", "checkbox");
    complete.setAttribute("aria-checked", card.completed ? "true" : "false");
    complete.setAttribute("aria-label", card.completed ? "Mark as incomplete" : "Mark as complete");
    complete.addEventListener("click", async (event) => {
      event.stopPropagation();
      if (lockedByOther) return this.notifyCardLocked(lockHolder);
      await this.plugin.toggleCardCompleted(card.id);
    });
    if (card.completed) complete.append(createElement("span", "ot-card-complete-mark", "✓"));
    nameInner.append(complete, createElement("span", "ot-td-title", card.title));
    const hints = createElement("span", "ot-td-hints");
    if ((card.checklist || []).length) {
      const stats = checklistStats(card.checklist);
      hints.append(createElement("span", "ot-td-hint", `☑ ${stats.done}/${stats.total}`));
    }
    if (card.details) hints.append(createElement("span", "ot-td-hint", "☰"));
    if (hints.childElementCount) nameInner.append(hints);
    if (lockedByOther) nameInner.append(this.buildLockBadge(lockHolder));
    nameCell.append(nameInner);
    row.append(nameCell);

    visible.forEach((key) => row.append(this.renderTableCell(key, card, list, board, lockHolder)));
    // Trailing empty cell under the "+" add-column header, so every body row has
    // the same cell count as the header (keeps the fixed-layout grid aligned).
    row.append(createElement("td", "ot-td ot-td-addcell"));
    return row;
  }

  renderTableCell(key, card, list, board, lockHolder) {
    if (key === "status") return this.renderStatusCell(card, list, board, lockHolder);
    if (key === "assignee") return this.renderAssigneeCell(card, lockHolder);
    if (key === "dates") return this.renderDatesCell(card, lockHolder);
    if (key === "labels") return this.renderLabelsCell(card, lockHolder);
    return createElement("td", "ot-td");
  }

  renderStatusCell(card, list, board, lockHolder) {
    const cell = createElement("td", "ot-td ot-td-status");
    const pill = createElement("div", "ot-status-pill");
    const dot = createElement("span", "ot-status-dot");
    dot.style.setProperty("--ot-status-color", list.color || "#8b8b8b");
    pill.append(dot, createElement("span", "", list.title));
    pill.title = "Change status";
    pill.addEventListener("click", (event) => {
      event.stopPropagation();
      if (lockHolder) return this.notifyCardLocked(lockHolder);
      this.showStatusMenu(event, card, board, list);
    });
    cell.append(pill);
    return cell;
  }

  renderAssigneeCell(card, lockHolder) {
    const cell = createElement("td", "ot-td ot-td-assignee");
    const trigger = createElement("div", "ot-cell-edit");
    trigger.title = "Assign members";
    const avatars = this.renderCardAssignees(card);
    if (avatars.childElementCount) trigger.append(avatars);
    else trigger.append(createElement("span", "ot-td-empty", "＋"));
    trigger.addEventListener("click", (event) => {
      event.stopPropagation();
      if (lockHolder) return this.notifyCardLocked(lockHolder);
      this.showAssigneeMenu(event, card);
    });
    cell.append(trigger);
    return cell;
  }

  renderDatesCell(card, lockHolder) {
    const cell = createElement("td", "ot-td ot-td-dates");
    const dates = dateRangeLabel(card.startDate, card.dueDate);
    const trigger = createElement("div", "ot-cell-edit");
    trigger.title = "Edit dates";
    if (dates) trigger.append(createElement("span", "", dates));
    else trigger.append(createElement("span", "ot-td-empty", "＋"));
    trigger.addEventListener("click", (event) => {
      event.stopPropagation();
      if (lockHolder) return this.notifyCardLocked(lockHolder);
      new CardDatesModal(this.app, this.plugin, card.id).open();
    });
    cell.append(trigger);
    return cell;
  }

  renderLabelsCell(card, lockHolder) {
    const cell = createElement("td", "ot-td ot-td-labels");
    const trigger = createElement("div", "ot-cell-edit ot-cell-labels");
    trigger.title = "Edit labels";
    (card.labels || []).forEach((label) => {
      const pill = createElement("span", "ot-card-label", label.name);
      pill.style.backgroundColor = label.color;
      pill.title = label.name;
      trigger.append(pill);
    });
    if (!(card.labels || []).length) trigger.append(createElement("span", "ot-td-empty", "＋"));
    trigger.addEventListener("click", (event) => {
      event.stopPropagation();
      if (lockHolder) return this.notifyCardLocked(lockHolder);
      this.openLabelPicker(card);
    });
    cell.append(trigger);
    return cell;
  }

  // A small custom dropdown anchored under `anchor`. Obsidian's Menu can only show
  // text + a lucide icon, but the status picker needs a colored dot and the member
  // picker needs profile pictures — so those use this instead. `build(pop, close)`
  // fills the rows. It survives a board re-render (it lives on document.body), so
  // the assignee picker can stay open across multi-select toggles.
  openTablePopover(anchor, build) {
    this.closeTablePopover();
    const pop = createElement("div", "ot-popover");
    const rect = anchor.getBoundingClientRect();
    pop.style.top = `${Math.round(rect.bottom + 4)}px`;
    pop.style.left = `${Math.round(rect.left)}px`;
    pop.style.minWidth = `${Math.max(190, Math.round(rect.width))}px`;
    document.body.append(pop);
    const close = () => this.closeTablePopover();
    build(pop, close);
    const onDown = (event) => { if (!pop.contains(event.target)) close(); };
    const onKey = (event) => { if (event.key === "Escape") close(); };
    // Attach synchronously: the picker opens on a `click`, so THIS gesture's
    // mousedown already fired before we get here — the outside-close handler can't
    // self-trigger on it, and there's no deferred-add window that could leak.
    document.addEventListener("mousedown", onDown, true);
    document.addEventListener("keydown", onKey, true);
    pop._cleanup = () => {
      document.removeEventListener("mousedown", onDown, true);
      document.removeEventListener("keydown", onKey, true);
    };
    this._tablePopover = pop;
  }

  closeTablePopover() {
    if (!this._tablePopover) return;
    if (this._tablePopover._cleanup) this._tablePopover._cleanup();
    this._tablePopover.remove();
    this._tablePopover = null;
  }

  popoverRow(leading, label, checked) {
    const row = createElement("button", "ot-popover-row");
    row.type = "button";
    if (leading) row.append(leading);
    row.append(createElement("span", "ot-popover-label", label));
    if (checked) {
      const check = createElement("span", "ot-popover-check");
      try { setIcon(check, "check"); } catch (error) { check.textContent = "✓"; }
      row.append(check);
    }
    return row;
  }

  showStatusMenu(event, card, board, currentList) {
    this.openTablePopover(event.currentTarget, (pop, close) => {
      board.lists.forEach((list) => {
        const dot = createElement("span", "ot-status-dot");
        dot.style.setProperty("--ot-status-color", list.color || "#8b8b8b");
        const row = this.popoverRow(dot, list.title, list.id === currentList.id);
        row.addEventListener("click", async () => {
          close();
          if (list.id !== currentList.id) await this.plugin.moveCard(card.id, list.id);
        });
        pop.append(row);
      });
    });
  }

  showAssigneeMenu(event, card) {
    const members = this.plugin.getVaultMembers();
    this.openTablePopover(event.currentTarget, (pop) => {
      if (!members.length) {
        pop.append(createElement("div", "ot-popover-empty", "No members — sign in to Sync Deck"));
        return;
      }
      const paint = () => {
        pop.replaceChildren();
        const current = ((this.plugin.data.cards[card.id] || card).assignees) || [];
        members.forEach((member) => {
          const assigned = current.some((a) => a && a.email === member.email);
          const row = this.popoverRow(this.buildAvatar(member), member.name || member.email, assigned);
          row.addEventListener("click", async () => {
            const now = ((this.plugin.data.cards[card.id] || card).assignees) || [];
            const on = now.some((a) => a && a.email === member.email);
            const next = on
              ? now.filter((a) => a && a.email !== member.email)
              : [...now, { email: member.email, name: member.name, color: member.color }];
            await this.plugin.updateCard(card.id, { assignees: next });
            paint(); // keep the picker open and refresh the checks for multi-select
          });
          pop.append(row);
        });
      };
      paint();
    });
  }

  openLabelPicker(card) {
    new LabelPickerModal(this.app, this.plugin.data.labels || [], card.labels || [], async (labels, selectedLabels) => {
      await this.plugin.updateCard(card.id, { labels: selectedLabels }, labels);
    }).open();
  }

  renderTableComposer(board) {
    const form = createElement("form", "ot-table-composer");
    const list = board.lists[0];
    if (!list) {
      form.append(createElement("span", "ot-td-empty", "Add a list first to create tasks."));
      return form;
    }
    form.append(createElement("span", "ot-table-composer-plus", "+"));
    const input = createElement("input", "ot-table-composer-input");
    input.type = "text";
    input.placeholder = "New task";
    form.append(input);
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      const title = textLine(input.value);
      if (!title) { input.focus(); return; }
      input.value = "";
      await this.plugin.createCard(list.id, title);
    });
    return form;
  }

  startPresence(board) {
    if (!this.plugin.getSyncDeckBridge()) return;

    this.presenceBoard = board;
    this.presencePoint = { x: 0.5, y: 0.08 };
    this.presenceUsers = new Map();
    this.presenceSendInFlight = false;
    this.presenceDirty = false;
    this.lastPresenceSendAt = 0;
    this.presenceRafId = null;
    this.presenceLastFrame = null;
    this.presenceTrailTimer = null;
    // Monotonic session id. render() calls stopPresence()+startPresence() on every
    // board re-render, so responses from an in-flight request can land after a new
    // session started. Every async callback carries the gen it was issued under and
    // no-ops if it no longer matches, so a stale response can never touch live state.
    this.presenceGen = (this.presenceGen || 0) + 1;
    const gen = this.presenceGen;
    // Board-owned copy of the lock roster used purely as the badge-diff baseline.
    // It must NOT be plugin.cardLocks, which an open card modal rewrites out of
    // band (acquire/release/heartbeat) and would desync the diff into ghost badges.
    this.lockUiState = new Map(this.plugin.cardLocks || []);
    if (!this.presenceTickBound) this.presenceTickBound = (now) => this.presenceTick(now);

    this.presenceLayer = createElement("div", "ot-presence-layer");
    this.contentEl.append(this.presenceLayer);

    this.presenceMouseHandler = (event) => {
      const rect = this.presenceLayer.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const x = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
      const y = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
      this.presencePoint = { x, y };
      this.sendPresence();
    };
    this.contentEl.addEventListener("pointermove", this.presenceMouseHandler);

    this.presenceHeartbeatTimer = window.setInterval(() => this.sendPresence(true), PRESENCE_HEARTBEAT_MS);
    this.sendPresence(true);
    this.pollPresence(gen);
  }

  stopPresence() {
    // Invalidate the current session so any request still in flight becomes a no-op
    // when it resolves, even if no new session starts afterwards (e.g. onClose).
    this.presenceGen = (this.presenceGen || 0) + 1;
    if (this.presenceMouseHandler && this.contentEl) {
      this.contentEl.removeEventListener("pointermove", this.presenceMouseHandler);
    }
    if (this.presencePollTimer) window.clearTimeout(this.presencePollTimer);
    if (this.presenceHeartbeatTimer) window.clearInterval(this.presenceHeartbeatTimer);
    if (this.presenceTrailTimer) window.clearTimeout(this.presenceTrailTimer);
    if (this.presenceRafId != null) cancelAnimationFrame(this.presenceRafId);
    if (this.presenceLayer && this.presenceLayer.parentElement) this.presenceLayer.remove();
    this.presenceMouseHandler = null;
    this.presencePollTimer = null;
    this.presenceHeartbeatTimer = null;
    this.presenceTrailTimer = null;
    this.presenceRafId = null;
    this.presenceLayer = null;
    this.presenceBoard = null;
    this.presencePoint = null;
    this.presenceUsers = null;
    this.lockUiState = null;
    this.presenceSendInFlight = false;
    this.presenceDirty = false;
  }

  // Post our own cursor position. Sends are coalesced: while a request is in
  // flight or we are inside the throttle window, we only mark the state dirty
  // and flush the latest point afterwards so the resting position always lands.
  sendPresence(force = false) {
    if (!this.presenceBoard || !this.presencePoint) return;
    this.presenceDirty = true;
    this.flushPresence(force);
  }

  flushPresence(force = false) {
    if (!this.presenceBoard || !this.presenceDirty || this.presenceSendInFlight) return;

    const now = Date.now();
    const sinceLast = now - (this.lastPresenceSendAt || 0);
    if (!force && sinceLast < PRESENCE_SEND_INTERVAL_MS) {
      if (!this.presenceTrailTimer) {
        this.presenceTrailTimer = window.setTimeout(() => {
          this.presenceTrailTimer = null;
          this.flushPresence();
        }, PRESENCE_SEND_INTERVAL_MS - sinceLast);
      }
      return;
    }

    if (this.presenceTrailTimer) {
      window.clearTimeout(this.presenceTrailTimer);
      this.presenceTrailTimer = null;
    }
    const gen = this.presenceGen;
    this.lastPresenceSendAt = now;
    this.presenceDirty = false;
    this.presenceSendInFlight = true;
    this.plugin.sendBoardPresence(this.presenceBoard, this.presencePoint)
      .then((result) => this.applyPresenceResult(result, gen))
      .catch(() => {})
      .finally(() => {
        if (gen !== this.presenceGen) return; // superseded session: leave the new one untouched
        this.presenceSendInFlight = false;
        if (this.presenceDirty) this.flushPresence();
      });
  }

  // Self-scheduling receive loop. It polls fast while other cursors are present
  // and backs off when alone. GETs are skipped while our own POSTs are already
  // refreshing the roster, to avoid doubling the request rate while moving.
  schedulePresencePoll(gen) {
    if (gen !== this.presenceGen || !this.presenceBoard) return;
    const hasOthers = this.presenceUsers && this.presenceUsers.size > 0;
    const delay = hasOthers ? PRESENCE_POLL_ACTIVE_MS : PRESENCE_POLL_IDLE_MS;
    this.presencePollTimer = window.setTimeout(() => this.pollPresence(gen), delay);
  }

  pollPresence(gen) {
    if (gen !== this.presenceGen || !this.presenceBoard) return;
    const now = Date.now();
    if (now - (this.lastPresenceSendAt || 0) < PRESENCE_POLL_ACTIVE_MS) {
      this.schedulePresencePoll(gen);
      return;
    }
    this.plugin.fetchBoardPresence(this.presenceBoard.id)
      .then((result) => this.applyPresenceResult(result, gen))
      .catch(() => {})
      .finally(() => this.schedulePresencePoll(gen));
  }

  // Split a presence response into its cursor roster and card-lock roster. A
  // null result means a transient error: keep both rosters as-is (no flicker).
  applyPresenceResult(result, gen) {
    if (gen !== this.presenceGen) return;
    if (!result || !Array.isArray(result.users)) return;
    this.applyPresenceSnapshot(result.users, gen);
    this.applyLockSnapshot(Array.isArray(result.locks) ? result.locks : [], gen);
  }

  // Reconcile the card-lock roster into the plugin's lock map, then patch only
  // the cards whose lock state changed so the board is not fully re-rendered.
  applyLockSnapshot(locks, gen) {
    if (gen !== this.presenceGen) return;
    // Keep the plugin's map fresh for the card modal, but diff against our own
    // board-owned baseline so out-of-band modal writes cannot create ghost badges.
    this.plugin.setCardLocks(locks);
    const before = this.lockUiState || new Map();
    const after = new Map();
    (locks || []).forEach((lock) => {
      if (lock && lock.cardId) after.set(lock.cardId, lock);
    });

    const touched = new Set(before.keys());
    after.forEach((_value, cardId) => touched.add(cardId));
    touched.forEach((cardId) => {
      const beforeHolder = before.get(cardId) || null;
      const afterHolder = after.get(cardId) || null;
      const beforeEmail = beforeHolder && beforeHolder.email;
      const afterEmail = afterHolder && afterHolder.email;
      if (beforeEmail !== afterEmail || (beforeHolder && beforeHolder.name) !== (afterHolder && afterHolder.name)) {
        this.applyCardLockUi(cardId, afterHolder);
      }
    });
    this.lockUiState = after;
  }

  // Add/update/remove the lock overlay on a single card element in place.
  applyCardLockUi(cardId, holder) {
    if (!this.contentEl) return;
    const card = this.contentEl.querySelector(`.ot-card[data-card-id="${CSS.escape(cardId)}"]`);
    if (!card) return;
    card.classList.toggle("is-locked", !!holder);
    card.draggable = !holder && this.editingCardId !== cardId;
    const badge = card.querySelector(".ot-card-lock");
    if (badge) badge.remove();
    if (holder) card.append(this.buildLockBadge(holder));
  }

  // Reconcile the incoming roster against the live cursor elements: update
  // targets on existing cursors, create ones that just joined, remove ones that
  // left. Elements are never rebuilt wholesale, so the interpolation survives.
  applyPresenceSnapshot(users, gen) {
    if (gen !== this.presenceGen) return; // response from a superseded session
    if (!this.presenceLayer || !this.presenceUsers) return;
    // A failed request yields null (see plugin.sendBoardPresence/fetchBoardPresence).
    // Only an actual array is an authoritative roster; null means "keep what we have"
    // so a transient network error does not flicker every cursor off and back on.
    if (!Array.isArray(users)) return;
    const list = users;
    const seen = new Set();

    list.forEach((user) => {
      if (!user || !Number.isFinite(user.x) || !Number.isFinite(user.y)) return;
      const key = user.email || user.name;
      if (!key) return;
      seen.add(key);
      const x = Math.max(0, Math.min(1, user.x));
      const y = Math.max(0, Math.min(1, user.y));

      let entry = this.presenceUsers.get(key);
      if (!entry) {
        entry = this.createPresenceCursor();
        entry.cur.x = x;
        entry.cur.y = y;
        this.presenceLayer.append(entry.el);
        this.presenceUsers.set(key, entry);
      }
      entry.target.x = x;
      entry.target.y = y;
      this.updatePresenceCursorMeta(entry, user);
    });

    this.presenceUsers.forEach((entry, key) => {
      if (seen.has(key)) return;
      if (entry.el.parentElement) entry.el.remove();
      this.presenceUsers.delete(key);
    });

    this.ensurePresenceLoop();
  }

  createPresenceCursor() {
    const el = createElement("div", "ot-presence-cursor");
    const arrow = createElement("span", "ot-presence-arrow");
    const label = createElement("span", "ot-presence-name");
    const avatar = createElement("img", "ot-presence-avatar");
    avatar.alt = "";
    avatar.style.display = "none";
    const nameText = createElement("span", "", "");
    label.append(avatar, nameText);
    el.append(arrow, label);
    return {
      el,
      avatarEl: avatar,
      nameTextEl: nameText,
      color: null,
      name: null,
      picture: null,
      cur: { x: 0.5, y: 0.5 },
      target: { x: 0.5, y: 0.5 },
    };
  }

  updatePresenceCursorMeta(entry, user) {
    const color = user.color || "#8b5cf6";
    if (color !== entry.color) {
      entry.color = color;
      entry.el.style.setProperty("--ot-presence-color", color);
    }
    const name = user.name || user.email || "User";
    if (name !== entry.name) {
      entry.name = name;
      entry.nameTextEl.textContent = name;
    }
    const picture = user.picture || "";
    if (picture !== entry.picture) {
      entry.picture = picture;
      if (picture) {
        entry.avatarEl.src = picture;
        entry.avatarEl.style.display = "";
      } else {
        entry.avatarEl.removeAttribute("src");
        entry.avatarEl.style.display = "none";
      }
    }
  }

  ensurePresenceLoop() {
    if (this.presenceRafId != null) return;
    if (!this.presenceUsers || this.presenceUsers.size === 0) return;
    this.presenceLastFrame = null;
    this.presenceRafId = requestAnimationFrame(this.presenceTickBound);
  }

  // Ease every cursor toward its latest network target. Frame-rate independent
  // exponential smoothing keeps motion identical at 60/120Hz; the dt clamp stops
  // a big jump after the tab was backgrounded.
  presenceTick(now) {
    this.presenceRafId = null;
    if (!this.presenceLayer || !this.presenceUsers || this.presenceUsers.size === 0) return;

    let dt = now - (this.presenceLastFrame || now);
    this.presenceLastFrame = now;
    if (!(dt > 0)) dt = 16;
    if (dt > 100) dt = 100;
    const alpha = 1 - Math.exp(-dt / PRESENCE_SMOOTHING_TAU_MS);

    const rect = this.presenceLayer.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    const drawable = w > 0 && h > 0;
    let anyMoving = false;

    this.presenceUsers.forEach((entry) => {
      const dx = entry.target.x - entry.cur.x;
      const dy = entry.target.y - entry.cur.y;
      if (Math.abs(dx) < PRESENCE_SNAP_DISTANCE && Math.abs(dy) < PRESENCE_SNAP_DISTANCE) {
        entry.cur.x = entry.target.x;
        entry.cur.y = entry.target.y;
      } else {
        entry.cur.x += dx * alpha;
        entry.cur.y += dy * alpha;
        anyMoving = true;
      }
      if (drawable) {
        entry.el.style.transform = `translate(${(entry.cur.x * w).toFixed(1)}px, ${(entry.cur.y * h).toFixed(1)}px)`;
      }
    });

    // Idle when everything has settled. A new target restarts the loop via
    // ensurePresenceLoop(); until then a motionless board costs zero rAF work.
    // Keep spinning while not yet drawable so cursors still get placed once the
    // view has a size.
    if (anyMoving || !drawable) {
      this.presenceRafId = requestAnimationFrame(this.presenceTickBound);
    }
  }

  async syncNotes() {
    // Same action as the About modal's "Sync notes": re-import every card from
    // its Markdown note so changes synced by SyncDeck show up on the boards.
    try {
      new Notice("Syncing Task Deck notes...");
      await this.plugin.syncCardsFromFolder();
      this.plugin.refreshViews();
      new Notice("Task Deck synced.");
    } catch (error) {
      new Notice(`Sync failed: ${error.message}`);
    }
  }

  renderBoardHome() {
    const welcome = createElement("section", "ot-welcome-panel");
    const welcomeCopy = createElement("div", "ot-welcome-copy");
    welcomeCopy.append(
      createElement("h2", "", this.plugin.data.boards.length ? "Your boards" : "Create your first board"),
      createElement("p", "", "Create focused kanban boards and keep every card as a Markdown note in your vault.")
    );
    const welcomeActions = createElement("div", "ot-welcome-actions");
    welcomeActions.append(textButton("plus", "Create board", () => this.plugin.createBoardPrompt()));
    if (!this.plugin.getSyncDeckPlugin()) {
      welcomeActions.append(textButton("cloud", "Sync your boards & vaults", () => this.plugin.openSyncDeck(), "ot-cloud-cta"));
    }
    welcomeActions.append(
      textButton("refresh-cw", "Sync", () => this.syncNotes()),
      textButton("info", "About", () => new AboutModal(this.app, this.plugin).open()),
      textButton("heart", "Support developer", () => window.open(DONATION_URL, "_blank"))
    );
    welcome.append(welcomeCopy, welcomeActions);

    const boards = createElement("div", "ot-board-home");
    if (!this.plugin.data.boards.length) {
      const empty = createElement("div", "ot-empty-board-home");
      empty.append(
        createElement("h3", "", "No boards yet"),
        createElement("p", "", "Start with a project, sprint, content plan, or anything else you want to track.")
      );
      boards.append(empty);
    } else {
      this.plugin.data.boards.forEach((board) => boards.append(this.renderBoardTile(board)));
    }

    this.contentEl.append(welcome, boards);
  }

  renderBoardSelect(activeBoard) {
    const select = createElement("select", "ot-board-select");
    this.plugin.data.boards.forEach((board) => {
      const option = createElement("option", "", board.name);
      option.value = board.id;
      option.selected = board.id === activeBoard.id;
      select.append(option);
    });
    select.addEventListener("change", async () => {
      this.showingBoardHome = false;
      await this.plugin.setActiveBoard(select.value);
    });
    return select;
  }

  renderBoardTile(board) {
    const tile = createElement("button", "ot-board-tile");
    tile.type = "button";
    const cardCount = board.lists.reduce((total, list) => total + list.cardIds.length, 0);
    tile.append(createElement("span", "ot-board-tile-title", board.name));
    tile.append(createElement("span", "ot-board-tile-meta", `${board.lists.length} lists / ${cardCount} cards`));
    tile.addEventListener("click", async () => {
      this.showingBoardHome = false;
      await this.plugin.setActiveBoard(board.id);
    });

    const menuButton = iconButton("ellipsis", "Board menu", (event) => this.showBoardMenu(event, board));
    menuButton.classList.add("ot-board-tile-menu");
    tile.append(menuButton);
    return tile;
  }

  /**
   * Renders one column and wires list-level drag/drop targets.
   */
  renderList(list) {
    const column = createElement("section", "ot-list");
    column.dataset.listId = list.id;
    if (list.color) column.style.setProperty("--ot-list-color", list.color);
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

    const colorDot = createElement("span", "ot-list-color-dot");
    if (list.color) colorDot.style.backgroundColor = list.color;
    header.append(dragHandle, colorDot, createElement("h3", "", list.title));
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
      if (card) cards.append(this.renderCard(card, list));
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
    addButtonIcon(add, "plus");
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
  renderCard(card, list) {
    const element = createElement("article", "ot-card");
    const isRenaming = this.editingCardId === card.id;
    const lockHolder = this.plugin.getCardLockHolder(card.id);
    const lockedByOther = !!lockHolder;
    element.draggable = !isRenaming && !lockedByOther;
    element.dataset.cardId = card.id;
    if (lockedByOther) element.classList.add("is-locked");
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
      await this.plugin.moveCard(draggedId, list.id, card.id);
    });
    element.addEventListener("click", () => new CardModal(this.app, this.plugin, card.id).open());

    const labels = createElement("div", "ot-card-labels");
    (card.labels || []).forEach((label) => {
      const pill = createElement("span", "ot-card-label", label.name);
      pill.style.backgroundColor = label.color;
      pill.title = label.name;
      pill.addEventListener("click", async (event) => {
        event.stopPropagation();
        await this.plugin.toggleCompactLabels();
      });
      labels.append(pill);
    });

    const completeButton = iconButton(card.completed ? "check" : "circle", card.completed ? "Mark as incomplete" : "Mark as complete", async (event) => {
      event.stopPropagation();
      if (lockedByOther) return this.notifyCardLocked(lockHolder);
      await this.plugin.toggleCardCompleted(card.id);
    });
    completeButton.classList.add("ot-card-complete-toggle");
    completeButton.draggable = false;
    completeButton.replaceChildren();
    if (card.completed) completeButton.append(createElement("span", "ot-card-complete-mark", "✓"));

    const title = isRenaming ? this.renderCardTitleEditor(card) : createElement("div", "ot-card-title", card.title);
    const editButton = iconButton("pencil", "Edit card", (event) => {
      event.stopPropagation();
      if (lockedByOther) return this.notifyCardLocked(lockHolder);
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
    const assignees = this.renderCardAssignees(card);
    if (meta.childElementCount || assignees.childElementCount) {
      const footer = createElement("div", "ot-card-footer");
      footer.append(meta, assignees);
      element.append(footer);
    }

    if (lockedByOther) element.append(this.buildLockBadge(lockHolder));

    return element;
  }

  renderCardAssignees(card) {
    const wrap = createElement("div", "ot-card-assignees");
    const assignees = (card.assignees || []).filter((a) => a && a.email);
    const max = 3;
    assignees.slice(0, max).forEach((assignee) => wrap.append(this.buildAvatar(assignee)));
    if (assignees.length > max) {
      const more = createElement("span", "ot-card-avatar is-initials", `+${assignees.length - max}`);
      wrap.append(more);
    }
    return wrap;
  }

  buildAvatar(assignee) {
    const el = createElement("span", "ot-card-avatar");
    el.style.setProperty("--ot-avatar-color", assignee.color || "#8b5cf6");
    el.title = assignee.name || assignee.email;
    const picture = this.plugin.getMemberPicture(assignee.email);
    if (picture) {
      const img = createElement("img", "");
      img.src = picture;
      img.alt = "";
      el.append(img);
    } else {
      el.textContent = initials(assignee.name || assignee.email);
      el.classList.add("is-initials");
    }
    return el;
  }

  buildLockBadge(holder) {
    const badge = createElement("span", "ot-card-lock");
    badge.style.setProperty("--ot-lock-color", (holder && holder.color) || "#f59e0b");
    badge.append(createElement("span", "", `🔒 ${(holder && holder.name) || "Someone"}`));
    badge.title = `${(holder && holder.name) || "Someone"} is editing this card`;
    return badge;
  }

  notifyCardLocked(holder) {
    new Notice(`🔒 ${(holder && holder.name) || "Someone"} is editing this card`);
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
        .setTitle("Change list color")
        .setIcon("palette")
        .onClick(() => {
          new ListColorModal(this.app, list.title, list.color, (color) => this.plugin.setListColor(list.id, color)).open();
        });
    });
    menu.addItem((item) => {
      item
        .setTitle("Delete list")
        .setIcon("trash")
        .onClick(() => this.plugin.deleteList(list.id));
    });
    menu.showAtMouseEvent(event);
  }

  showBoardMenu(event, board) {
    event.stopPropagation();
    const menu = new Menu();
    menu.addItem((item) => {
      item
        .setTitle("Rename board")
        .setIcon("pencil")
        .onClick(() => this.plugin.renameBoard(board.id));
    });
    menu.showAtMouseEvent(event);
  }
}

module.exports = { BoardView };
