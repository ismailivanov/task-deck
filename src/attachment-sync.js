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
   *
   * NOTE: OCS attachment endpoints only need cardRemoteId + boardRemoteId;
   * the `list` argument is no longer used but kept in the signature for
   * call-site compatibility (all existing callers still pass it).
   */
  async pullCard(client, card, board /* , list */) {
    if (!this.isEnabled()) return { downloaded: 0 };
    if (card.remoteId == null || board.remoteId == null) return { downloaded: 0 };

    let remoteAttachments = [];
    try {
      const { data } = await client.getAttachments(card.remoteId, board.remoteId);
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
      // Fileid may have been added on a re-pull for entries we already
      // knew about — always refresh it since downstream description
      // rewriting depends on it.
      const remoteFileid = remote && remote.extendedData && remote.extendedData.fileid;
      if (existing && Number(existing.remoteUpdatedAt || 0) >= updatedAt && existing.filePath && existing.fileid != null) {
        // Already up to date; keep the metadata as-is.
        knownById.delete(remote.id);
        continue;
      }

      try {
        const download = await client.downloadAttachment(card.remoteId, remote);
        if (!download || !download.data) continue;
        const filename = sanitizeFilename(remote.data || remote.name || (remote.extendedData && remote.extendedData.info && remote.extendedData.info.basename) || `attachment-${remote.id}`);
        const dir = joinPath(board.folderPath || "", "attachments", card.id);
        await this.ensureDir(dir);
        const filePath = await this.uniquePath(joinPath(dir, filename), existing ? existing.filePath : null);
        await this.writeBinary(filePath, download.data);

        const entry = existing || {};
        entry.remoteId = remote.id;
        entry.fileid = remoteFileid != null ? Number(remoteFileid) : (existing && existing.fileid) || null;
        entry.filePath = filePath;
        entry.filename = filename;
        entry.remoteUpdatedAt = updatedAt;
        entry.contentType = download.contentType || (remote.extendedData && remote.extendedData.mimetype) || "application/octet-stream";
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
   * Upload any files referenced by the card that aren't yet on Nextcloud.
   * Files are discovered from two sources so users have a single mental
   * model regardless of how they added the image:
   *
   *   1) The per-card attachment folder `<boardFolder>/attachments/<cardId>/`
   *      — used by insertImageFromFile for pasted/dropped screenshots.
   *   2) `card.details` wikilinks (`![[<path>]]`) — a user might paste an
   *      image at a specific location in the card body; without walking
   *      the wikilinks we'd miss it.
   *
   * Files already present in `card.attachments[]` (matched by filePath)
   * are skipped so a re-sync doesn't spam the server with duplicates.
   *
   * NOTE: `list` argument is no longer used; keep it in the signature so
   * every existing call site (`await this.attachments.pushCard(client,
   * card, board, list)`) stays valid without an audit sweep.
   */
  async pushCard(client, card, board /* , list */) {
    if (!this.isEnabled()) return { uploaded: 0 };
    if (card.remoteId == null || board.remoteId == null) return { uploaded: 0 };
    if (!Array.isArray(card.attachments)) card.attachments = [];

    const knownByPath = new Map(card.attachments.filter((e) => e.filePath).map((entry) => [entry.filePath, entry]));

    // Collect candidate local files:
    //   (a) direct children of <boardFolder>/attachments/<cardId>/
    //   (b) files referenced via `![[…]]` in the card description
    const candidatePaths = new Set();
    const dir = joinPath(board.folderPath || "", "attachments", card.id);
    const dirRef = this.plugin.app.vault.getAbstractFileByPath(dir);
    if (dirRef && dirRef.children) {
      for (const child of dirRef.children) {
        if (!child || child.children) continue; // skip nested directories
        candidatePaths.add(child.path);
      }
    }
    const details = typeof card.details === "string" ? card.details : "";
    for (const match of details.matchAll(/!?\[\[([^\]\n]+)\]\]/g)) {
      const target = match[1].split("|")[0].trim();
      if (!target) continue;
      // Skip absolute URLs — external images, not vault files.
      if (/^https?:\/\//i.test(target)) continue;
      candidatePaths.add(target);
    }

    let uploaded = 0;
    const debug = (payload) => this.plugin.debugLog(Object.assign({ scope: "attachments" }, payload));
    debug({ event: "push.scan", cardId: card.id, dir, candidates: candidatePaths.size });

    for (const path of candidatePaths) {
      if (knownByPath.has(path)) { debug({ event: "push.skip-tracked", path }); continue; }
      const file = this.plugin.app.vault.getAbstractFileByPath(path);
      if (!file || file.children !== undefined) { // not a file (folder or missing)
        debug({ event: "push.skip-missing", path });
        continue;
      }
      try {
        const data = await this.plugin.app.vault.readBinary(file);
        const filename = sanitizeFilename(file.name);
        debug({ event: "push.upload.request", path, filename, bytes: data.byteLength || 0 });
        const { data: response } = await client.uploadAttachment(card.remoteId, board.remoteId, {
          data: new Uint8Array(data),
          filename,
          mimeType: guessMime(filename),
        });
        debug({
          event: "push.upload.response",
          path,
          responseId: response && response.id,
          fileid: response && response.extendedData && response.extendedData.fileid,
          responseKeys: response ? Object.keys(response) : null,
        });
        if (!response || response.id == null) {
          this.plugin.pushSyncLog({
            event: "attachment-upload-empty-response",
            cardId: card.id,
            filename,
          });
          continue;
        }
        const fileid = response.extendedData && response.extendedData.fileid;
        card.attachments.push({
          remoteId: response.id,
          fileid: fileid != null ? Number(fileid) : null,
          filePath: path,
          filename,
          remoteUpdatedAt: Number(response.lastModified || Date.now()),
          contentType: guessMime(filename),
        });
        uploaded += 1;
      } catch (error) {
        this.plugin.pushSyncLog({
          event: "attachment-upload-failed",
          cardId: card.id,
          filename: file.name,
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
        await client.deleteAttachment(entry.cardRemoteId, entry.boardRemoteId, entry.attachmentRemoteId);
        removed += 1;
      } catch (error) {
        // See sync-manager.reapDeletions: 403/404/410 all mean "the server
        // side is already in the terminal state we want" — retrying just
        // wastes cycles and keeps the queue growing.
        if (error && (error.status === 404 || error.status === 403 || error.status === 410)) {
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
