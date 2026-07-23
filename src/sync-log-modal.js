const { Modal, Notice } = require("obsidian");

// Rolling sync-event log viewer. Reads from `plugin.syncLog` (populated by
// pushSyncLog) so it never runs a request of its own. Copy-to-clipboard emits
// a redacted diagnostic dump the user can paste into a bug report.
//
// Rendering strategy: newest event at the top; each row is a fixed grid of
// (time · event · summary). Errors get an accent border so they're easy to
// spot at a glance.

class SyncLogModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
  }

  onOpen() {
    const { contentEl, titleEl } = this;
    titleEl.setText("Nextcloud Deck sync log");
    contentEl.empty();

    const events = Array.isArray(this.plugin.syncLog) ? this.plugin.syncLog.slice().reverse() : [];

    const header = contentEl.createEl("div", { cls: "ot-sync-log-header" });
    header.createEl("div", {
      cls: "ot-sync-log-summary",
      text: events.length
        ? `${events.length} event${events.length === 1 ? "" : "s"} recorded (newest first).`
        : "No events yet. Trigger Sync now once and reopen to inspect activity.",
    });
    const buttons = header.createEl("div", { cls: "ot-sync-log-buttons" });

    const copyBtn = buttons.createEl("button", { text: "Copy diagnostics" });
    copyBtn.addEventListener("click", () => this.copyDiagnostics(events));
    const clearBtn = buttons.createEl("button", { text: "Clear log" });
    clearBtn.addEventListener("click", () => {
      this.plugin.syncLog = [];
      this.close();
    });

    const list = contentEl.createEl("div", { cls: "ot-sync-log-list" });
    if (!events.length) {
      list.createEl("div", { cls: "ot-sync-log-empty", text: "Empty." });
      return;
    }
    for (const event of events) {
      const row = list.createEl("div", { cls: "ot-sync-log-row" });
      if (isFailure(event)) row.classList.add("is-error");

      row.createEl("span", { cls: "ot-sync-log-time", text: formatTime(event.at) });
      row.createEl("span", { cls: "ot-sync-log-event", text: event.event || "event" });
      row.createEl("span", { cls: "ot-sync-log-summary-cell", text: summarize(event) });
    }
  }

  onClose() {
    this.contentEl.empty();
  }

  copyDiagnostics(events) {
    const nc = (this.plugin.data && this.plugin.data.nextcloud) || {};
    const summary = {
      version: this.plugin.manifest && this.plugin.manifest.version,
      obsidian: (window.electron && window.electron.remote && window.electron.remote.app && window.electron.remote.app.getVersion && window.electron.remote.app.getVersion()) || "n/a",
      // Redact sensitive fields before dumping.
      nextcloud: {
        enabled: !!nc.enabled,
        serverUrl: redactUrl(nc.serverUrl),
        username: nc.username ? "(set)" : "(empty)",
        appPasswordCipher: nc.appPasswordCipher ? "(set)" : "(empty)",
        conflictPolicy: nc.conflictPolicy,
        syncIntervalMs: nc.syncIntervalMs,
        attachmentsEnabled: !!nc.attachmentsEnabled,
        boardBindings: Object.keys(nc.boardBindings || {}).length,
        pendingDeletions: (nc.pendingDeletions || []).length,
        pendingAttachmentDeletions: (nc.pendingAttachmentDeletions || []).length,
        lastSyncAt: nc.lastSyncAt ? new Date(nc.lastSyncAt).toISOString() : "never",
      },
      status: (this.plugin.syncManager && this.plugin.syncManager.getStatus()) || null,
      events: events.map((event) => {
        // Keep every field except a small blacklist so diagnostics stay
        // useful for triage. The plugin never puts App Password or full
        // card bodies into event payloads, so the copy is already safe;
        // we just strip anything we know we don't want on the clipboard.
        const BLACKLIST = new Set([
          "appPassword",
          "password",
          "authorization",
        ]);
        const safe = { at: event.at ? new Date(event.at).toISOString() : null };
        Object.keys(event).forEach((k) => {
          if (k === "at") return;
          if (BLACKLIST.has(k)) return;
          safe[k] = event[k];
        });
        return safe;
      }),
    };

    const text = JSON.stringify(summary, null, 2);
    // navigator.clipboard is unavailable in some webviews; fall back to a
    // document.execCommand path so mobile still works.
    if (navigator && navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        () => new Notice("Diagnostics copied to clipboard."),
        () => this.fallbackCopy(text),
      );
    } else {
      this.fallbackCopy(text);
    }
  }

  fallbackCopy(text) {
    try {
      const holder = document.createElement("textarea");
      holder.value = text;
      holder.setAttribute("readonly", "");
      holder.style.position = "absolute";
      holder.style.left = "-9999px";
      document.body.appendChild(holder);
      holder.select();
      document.execCommand("copy");
      document.body.removeChild(holder);
      new Notice("Diagnostics copied to clipboard.");
    } catch (error) {
      new Notice("Copy failed. Long-press to select the log manually.");
    }
  }
}

function formatTime(ts) {
  if (!ts) return "--:--:--";
  const d = new Date(ts);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
function pad(n) { return n < 10 ? `0${n}` : String(n); }

function summarize(event) {
  const parts = [];
  if (event.message) parts.push(event.message);
  if (event.cardId) parts.push(`card=${event.cardId}`);
  if (event.status !== undefined) parts.push(`status=${event.status}`);
  if (event.url) parts.push(event.url.split("?")[0]);
  return parts.join(" · ") || "(no details)";
}

function isFailure(event) {
  if (!event || !event.event) return false;
  return /fail|error/i.test(event.event);
}

function redactUrl(url) {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.hostname}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  } catch (error) {
    return "(unparseable)";
  }
}

module.exports = { SyncLogModal };
