const { normalizePath } = require("obsidian");

// Two-way attachment sync for Nextcloud Deck.
//
// Storage layout in the vault:
//   <boardFolder>/attachments/<cardId>/<filename>
//
// The plugin never mounts anything outside of that per-card directory so a
// card delete cleans up its own files without touching unrelated notes. The
// mapping from remote attachment id → local path lives on the card itself as
// `card.attachments`, so a data.json restore round-trips.
//
// Uploads happen after the card create/update push so a brand-new card always
// has a `remoteId` by the time we attach files. Downloads happen after every
// pull so remote changes propagate. Tombstones are appended when the user
// deletes a linked file locally, then drained on the next tick.

const MIME_BY_EXT = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  bmp: "image/bmp",
  avif: "image/avif",
  ico: "image/x-icon",
  pdf: "application/pdf",
  txt: "text/plain",
  md: "text/markdown",
  json: "application/json",
  csv: "text/csv",
  zip: "application/zip",
  mp4: "video/mp4",
  mp3: "audio/mpeg",
};

function guessMime(filename) {
  const dot = String(filename || "").lastIndexOf(".");
  if (dot < 0) return "application/octet-stream";
  const ext = filename.slice(dot + 1).toLowerCase();
  return MIME_BY_EXT[ext] || "application/octet-stream";
}

function sanitizeFilename(name) {
  return String(name || "attachment")
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim() || "attachment";
}

function joinPath(...parts) {
  return normalizePath(parts.filter(Boolean).join("/"));
}

class AttachmentSyncer {
  constructor(plugin) {
    this.plugin = plugin;
  }

  /**
   * Pull all remote attachments for a card into the vault. Skips downloads
   * whose remote id + updatedAt already match a local entry to avoid
   * re-fetching unchanged files.
   */
  async pullCard(client, card, board, list) {
    if (!this.isEnabled()) return { downloaded: 0 };
    if (card.remoteId == null || board.remoteId == null || list.remoteId == null) return { downloaded: 0 };

    let remoteAttachments = [];
    try {
      const { data } = await client.getAttachments(board.remoteId, list.remoteId, card.remoteId);
      remoteAttachments = Array.isArray(data) ? data : [];
    } catch (error) {
      this.plugin.pushSyncLog({ event: "attachments-list-failed", cardId: card.id, message: (error && error.message) || String(error) });
      return { downloaded: 0 };
    }

    if (!Array.isArray(card.attachments)) card.attachments = [];
    const knownById = new Map(card.attachments.map((entry) => [entry.remoteId, entry]));
    let downloaded = 0;

    for (const remote of remoteAttachments) {
      if (!remote || remote.id == null) continue;
      const existing = knownById.get(remote.id);
      const updatedAt = Number(remote.lastModified || 0);
      if (existing && Number(existing.remoteUpdatedAt || 0) >= updatedAt && existing.filePath) {
        // Already up to date; keep the metadata as-is.
        knownById.delete(remote.id);
        continue;
      }

      try {
        const download = await client.downloadAttachment(board.remoteId, list.remoteId, card.remoteId, remote.id);
        if (!download || !download.data) continue;
        const filename = sanitizeFilename(remote.data || remote.name || `attachment-${remote.id}`);
        const dir = joinPath(board.folderPath || "", "attachments", card.id);
        await this.ensureDir(dir);
        const filePath = await this.uniquePath(joinPath(dir, filename), existing ? existing.filePath : null);
        await this.writeBinary(filePath, download.data);

        const entry = existing || {};
        entry.remoteId = remote.id;
        entry.filePath = filePath;
        entry.filename = filename;
        entry.remoteUpdatedAt = updatedAt;
        entry.contentType = download.contentType || "application/octet-stream";
        if (!existing) card.attachments.push(entry);
        knownById.delete(remote.id);
        downloaded += 1;
      } catch (error) {
        this.plugin.pushSyncLog({
          event: "attachment-download-failed",
          cardId: card.id,
          attachmentId: remote.id,
          message: (error && error.message) || String(error),
        });
      }
    }

    // Anything left in knownById used to exist on Nextcloud but was removed
    // there. Delete the local file and drop the entry.
    for (const orphan of knownById.values()) {
      await this.trashPath(orphan.filePath).catch(() => {});
      card.attachments = card.attachments.filter((entry) => entry !== orphan);
    }

    return { downloaded };
  }

  /**
   * Upload any files in the card's attachments directory that don't yet have
   * a `remoteId`. Called after a card push so the card definitely exists on
   * Nextcloud.
   */
  async pushCard(client, card, board, list) {
    if (!this.isEnabled()) return { uploaded: 0 };
    if (card.remoteId == null || board.remoteId == null || list.remoteId == null) return { uploaded: 0 };

    const dir = joinPath(board.folderPath || "", "attachments", card.id);
    const dirRef = this.plugin.app.vault.getAbstractFileByPath(dir);
    if (!dirRef || !dirRef.children) return { uploaded: 0 };

    if (!Array.isArray(card.attachments)) card.attachments = [];
    const knownByPath = new Map(card.attachments.filter((e) => e.filePath).map((entry) => [entry.filePath, entry]));

    let uploaded = 0;
    const debug = (payload) => this.plugin.debugLog(Object.assign({ scope: "attachments" }, payload));
    debug({ event: "push.scan", cardId: card.id, dir, children: dirRef.children.length });
    for (const child of dirRef.children) {
      if (!child || child.children) continue; // skip nested directories
      if (knownByPath.has(child.path)) { debug({ event: "push.skip-tracked", path: child.path }); continue; }
      try {
        const data = await this.plugin.app.vault.readBinary(child);
        const filename = sanitizeFilename(child.name);
        debug({ event: "push.upload.request", path: child.path, filename, bytes: data.byteLength || 0 });
        const { data: response } = await client.uploadAttachment(board.remoteId, list.remoteId, card.remoteId, {
          data: new Uint8Array(data),
          filename,
          mimeType: guessMime(filename),
        });
        debug({ event: "push.upload.response", path: child.path, responseId: response && response.id, responseKeys: response ? Object.keys(response) : null });
        if (!response || response.id == null) {
          // Log this specifically — the older singular-endpoint bug made
          // the response empty even though the file uploaded, which we
          // want to be able to identify at a glance in diagnostics.
          this.plugin.pushSyncLog({
            event: "attachment-upload-empty-response",
            cardId: card.id,
            filename,
          });
          continue;
        }
        card.attachments.push({
          remoteId: response.id,
          filePath: child.path,
          filename,
          remoteUpdatedAt: Number(response.lastModified || Date.now()),
          contentType: guessMime(filename),
        });
        uploaded += 1;
      } catch (error) {
        this.plugin.pushSyncLog({
          event: "attachment-upload-failed",
          cardId: card.id,
          filename: child.name,
          status: error && error.status,
          message: (error && error.message) || String(error),
        });
      }
    }
    return { uploaded };
  }

  /**
   * Drain the attachment tombstone queue. Best-effort: 404 counts as success
   * so a race with a remote deletion doesn't leave stale entries.
   */
  async reap(client) {
    if (!this.isEnabled()) return 0;
    const nc = this.plugin.data.nextcloud;
    if (!Array.isArray(nc.pendingAttachmentDeletions) || !nc.pendingAttachmentDeletions.length) return 0;
    const remaining = [];
    let removed = 0;
    for (const entry of nc.pendingAttachmentDeletions) {
      try {
        await client.deleteAttachment(entry.boardRemoteId, entry.stackRemoteId, entry.cardRemoteId, entry.attachmentRemoteId);
        removed += 1;
      } catch (error) {
        if (error && error.status === 404) {
          removed += 1;
          continue;
        }
        this.plugin.pushSyncLog({ event: "attachment-reap-failed", entry, message: (error && error.message) || String(error) });
        remaining.push(entry);
      }
    }
    nc.pendingAttachmentDeletions = remaining;
    return removed;
  }

  // ---- Local filesystem helpers ------------------------------------------

  isEnabled() {
    return !!(this.plugin.data.nextcloud && this.plugin.data.nextcloud.attachmentsEnabled);
  }

  async ensureDir(path) {
    if (!path) return;
    const existing = this.plugin.app.vault.getAbstractFileByPath(path);
    if (existing) return;
    // createFolder throws if any ancestor is missing; walk the path.
    const parts = path.split("/");
    let running = "";
    for (const part of parts) {
      running = running ? `${running}/${part}` : part;
      if (this.plugin.app.vault.getAbstractFileByPath(running)) continue;
      try { await this.plugin.app.vault.createFolder(running); }
      catch (error) { /* concurrent create is fine */ }
    }
  }

  async writeBinary(path, data) {
    const existing = this.plugin.app.vault.getAbstractFileByPath(path);
    const bytes = data instanceof ArrayBuffer ? data : (data && data.buffer) || data;
    if (existing && existing.extension !== undefined) {
      await this.plugin.app.vault.modifyBinary(existing, bytes);
    } else {
      await this.plugin.app.vault.createBinary(path, bytes);
    }
  }

  async trashPath(path) {
    if (!path) return;
    const file = this.plugin.app.vault.getAbstractFileByPath(path);
    if (!file) return;
    await this.plugin.app.vault.trash(file, true);
  }

  async uniquePath(desiredPath, allowedExisting) {
    if (desiredPath === allowedExisting) return desiredPath;
    if (!this.plugin.app.vault.getAbstractFileByPath(desiredPath)) return desiredPath;
    // Append " (n)" before the extension until we find a free slot.
    const dot = desiredPath.lastIndexOf(".");
    const base = dot > 0 ? desiredPath.slice(0, dot) : desiredPath;
    const ext = dot > 0 ? desiredPath.slice(dot) : "";
    for (let n = 2; n < 999; n += 1) {
      const candidate = `${base} (${n})${ext}`;
      if (!this.plugin.app.vault.getAbstractFileByPath(candidate) || candidate === allowedExisting) return candidate;
    }
    return `${base} (${Date.now()})${ext}`;
  }
}

module.exports = {
  AttachmentSyncer,
  guessMime,
  sanitizeFilename,
};
