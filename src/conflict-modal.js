const { Modal } = require("obsidian");

// Modal that walks the user through unresolved field conflicts one card at a
// time. Only opened when the effective conflict policy is `prompt` and the
// automatic 3-way merge left at least one field disputed. The manager awaits
// the promise; the resolved object is merged into the local card before it is
// pushed to Nextcloud.

class ConflictModal extends Modal {
  /**
   * @param {import('obsidian').App} app
   * @param {{
   *   cardTitle: string,
   *   conflicts: Array<{ field: string, base: any, local: any, remote: any }>,
   * }} payload
   */
  constructor(app, payload) {
    super(app);
    this.payload = payload;
    this._resolvePromise = null;
    this._pending = new Map(payload.conflicts.map((entry) => [entry.field, "local"]));
  }

  onOpen() {
    const { contentEl, titleEl } = this;
    titleEl.setText(`Resolve conflicts — ${this.payload.cardTitle || "Untitled card"}`);
    contentEl.empty();

    const intro = contentEl.createEl("p", { cls: "ot-conflict-intro" });
    intro.setText("Both this Obsidian vault and Nextcloud Deck changed the same fields. Pick which value to keep for each row.");

    for (const entry of this.payload.conflicts) {
      this.renderField(contentEl, entry);
    }

    const buttons = contentEl.createEl("div", { cls: "ot-conflict-buttons" });
    const cancel = buttons.createEl("button", { text: "Cancel push" });
    cancel.addEventListener("click", () => this.resolveWith(null));

    const confirm = buttons.createEl("button", { text: "Apply and push", cls: "mod-cta" });
    confirm.addEventListener("click", () => {
      const chosen = {};
      for (const entry of this.payload.conflicts) {
        const side = this._pending.get(entry.field);
        chosen[entry.field] = side === "remote" ? entry.remote : entry.local;
      }
      this.resolveWith(chosen);
    });
  }

  renderField(container, entry) {
    const row = container.createEl("div", { cls: "ot-conflict-row" });
    row.createEl("div", { cls: "ot-conflict-field-name", text: humanFieldName(entry.field) });

    const localBtn = row.createEl("button", { cls: "ot-conflict-choice ot-conflict-choice-local" });
    localBtn.textContent = "Keep local";
    localBtn.appendChild(preview(entry.local));

    const remoteBtn = row.createEl("button", { cls: "ot-conflict-choice ot-conflict-choice-remote" });
    remoteBtn.textContent = "Use Nextcloud";
    remoteBtn.appendChild(preview(entry.remote));

    const setSelection = (side) => {
      this._pending.set(entry.field, side);
      localBtn.classList.toggle("is-active", side === "local");
      remoteBtn.classList.toggle("is-active", side === "remote");
    };
    localBtn.addEventListener("click", () => setSelection("local"));
    remoteBtn.addEventListener("click", () => setSelection("remote"));
    setSelection("local");
  }

  resolveWith(value) {
    if (this._resolvePromise) {
      this._resolvePromise(value);
      this._resolvePromise = null;
    }
    this.close();
  }

  onClose() {
    // Closing without a decision counts as cancelling the push. Callers always
    // treat null as "skip this card and try again later".
    if (this._resolvePromise) {
      this._resolvePromise(null);
      this._resolvePromise = null;
    }
    this.contentEl.empty();
  }

  await() {
    return new Promise((resolve) => {
      this._resolvePromise = resolve;
      this.open();
    });
  }
}

function humanFieldName(field) {
  switch (field) {
    case "title": return "Title";
    case "details": return "Description";
    case "completed": return "Completed";
    case "dueDate": return "Due date";
    case "startDate": return "Start date";
    default: return field;
  }
}

function preview(value) {
  const el = document.createElement("span");
  el.className = "ot-conflict-preview";
  if (value == null || value === "") {
    el.textContent = "(empty)";
    el.classList.add("is-empty");
  } else if (typeof value === "boolean") {
    el.textContent = value ? "Yes" : "No";
  } else {
    const text = String(value);
    // Preview keeps the modal narrow: long descriptions collapse to a snippet.
    el.textContent = text.length > 140 ? `${text.slice(0, 140)}…` : text;
  }
  return el;
}

module.exports = { ConflictModal };
