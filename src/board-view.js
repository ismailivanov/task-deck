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
const { AboutModal, CardDatesModal, CardModal, ListColorModal } = require("./modals");

// Live board presence (SyncDeck cursors) tuning.
// The transport stays plain HTTP polling; smoothness comes from client-side
// interpolation rather than a faster/heavier network loop.
const PRESENCE_SEND_INTERVAL_MS = 110; // min gap between outbound position posts while moving
const PRESENCE_POLL_ACTIVE_MS = 260; // GET poll while other cursors are on the board
const PRESENCE_POLL_IDLE_MS = 1100; // GET poll when nobody else is present
const PRESENCE_HEARTBEAT_MS = 3000; // resend our own point so the server TTL never expires us
const PRESENCE_SMOOTHING_TAU_MS = 70; // interpolation time constant; lower = snappier, higher = smoother
const PRESENCE_SNAP_DISTANCE = 0.0006; // normalized distance under which we snap instead of easing

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

    const toolbar = createElement("div", "ot-toolbar");
    const title = createElement("div", "ot-toolbar-title");
    title.append(iconButton("layout-dashboard", "Boards", () => {
      this.showingBoardHome = true;
      this.render();
    }));
    title.append(createElement("h2", "", board.name));
    if (this.plugin.data.boards.length > 1) title.append(this.renderBoardSelect(board));
    toolbar.append(title);
    const actions = createElement("div", "ot-toolbar-actions");
    actions.append(
      textButton("plus-square", "New board", () => this.plugin.createBoardPrompt()),
      textButton("info", "About", () => new AboutModal(this.app, this.plugin).open()),
      textButton("heart", "Support", () => window.open(DONATION_URL, "_blank")),
      textButton("plus", "Add list", () => this.plugin.addList())
    );
    toolbar.append(actions);

    const scroller = createElement("div", "ot-board-scroll");
    board.lists.forEach((list) => scroller.append(this.renderList(list)));

    this.contentEl.append(toolbar, scroller);
    this.startPresence(board);
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

  renderBoardHome() {
    const welcome = createElement("section", "ot-welcome-panel");
    const welcomeCopy = createElement("div", "ot-welcome-copy");
    welcomeCopy.append(
      createElement("h2", "", this.plugin.data.boards.length ? "Your boards" : "Create your first board"),
      createElement("p", "", "Create focused kanban boards and keep every card as a Markdown note in your vault.")
    );
    const welcomeActions = createElement("div", "ot-welcome-actions");
    welcomeActions.append(
      textButton("plus", "Create board", () => this.plugin.createBoardPrompt()),
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
