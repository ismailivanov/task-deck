const { requestUrl } = require("obsidian");

const { normalizeServerUrl } = require("./nextcloud-auth");

// Thin REST client for the Nextcloud Deck API.
// https://deck.readthedocs.io/en/latest/API/
//
// All traffic goes through Obsidian's `requestUrl`, which bypasses the browser
// CORS layer and works identically on desktop and mobile. Responses carry an
// `ETag` (or `Last-Modified`) header that the sync layer will use for
// incremental refreshes.
//
// The client is intentionally small — it just maps method + path + params to a
// request and normalises errors. Higher-level sync semantics (dirty tracking,
// conflict resolution, retries beyond transient network / 429) live in
// sync-manager.js so the client stays reusable and testable in isolation.

const DECK_API_PREFIX = "/index.php/apps/deck/api/v1.0";
// Attachments live on the OCS API surface, not the /index.php REST one.
// The HAR capture of the Web UI making an attachment upload is what pins
// this down: POST /ocs/v2.php/apps/deck/api/v1.0/cards/{id}/attachment.
// Same-origin cookie session on the Web UI, so we need App Password
// basic auth + OCS-APIRequest header for scripted access.
const OCS_DECK_PREFIX = "/ocs/v2.php/apps/deck/api/v1.0";
const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_BACKOFF_MS = 60000;

class DeckApiError extends Error {
  constructor(message, { status = 0, url = "", body = null } = {}) {
    super(message);
    this.name = "DeckApiError";
    this.status = status;
    this.url = url;
    this.body = body;
  }
}

class DeckClient {
  /**
   * @param {{ serverUrl: string, username: string, appPassword: string,
   *   maxRetries?: number, userAgent?: string, logger?: (event: object) => void }} options
   */
  constructor(options) {
    if (!options || !options.serverUrl || !options.username || !options.appPassword) {
      throw new Error("DeckClient requires serverUrl, username, and appPassword.");
    }
    this.serverUrl = normalizeServerUrl(options.serverUrl);
    this.username = options.username;
    this.appPassword = options.appPassword;
    this.maxRetries = Number.isFinite(options.maxRetries) ? options.maxRetries : 4;
    this.userAgent = options.userAgent || "NextDeck";
    this.logger = typeof options.logger === "function" ? options.logger : null;
  }

  // High-level endpoints ---------------------------------------------------

  getBoards({ etag } = {}) {
    return this.request({ method: "GET", path: "/boards", etag });
  }

  getBoard(boardId, { etag } = {}) {
    return this.request({ method: "GET", path: `/boards/${encodeURIComponent(boardId)}`, etag });
  }

  createBoard({ title, color = "0082c9" }) {
    return this.request({ method: "POST", path: "/boards", body: { title, color } });
  }

  updateBoard(boardId, { title, color, archived }) {
    const body = {};
    if (title !== undefined) body.title = title;
    if (color !== undefined) body.color = color;
    if (archived !== undefined) body.archived = archived;
    return this.request({ method: "PUT", path: `/boards/${encodeURIComponent(boardId)}`, body });
  }

  deleteBoard(boardId) {
    return this.request({ method: "DELETE", path: `/boards/${encodeURIComponent(boardId)}` });
  }

  getStacks(boardId, { etag } = {}) {
    return this.request({ method: "GET", path: `/boards/${encodeURIComponent(boardId)}/stacks`, etag });
  }

  createStack(boardId, { title, order }) {
    const body = { title };
    if (order !== undefined) body.order = order;
    return this.request({ method: "POST", path: `/boards/${encodeURIComponent(boardId)}/stacks`, body });
  }

  updateStack(boardId, stackId, { title, order }) {
    const body = {};
    if (title !== undefined) body.title = title;
    if (order !== undefined) body.order = order;
    return this.request({
      method: "PUT",
      path: `/boards/${encodeURIComponent(boardId)}/stacks/${encodeURIComponent(stackId)}`,
      body,
    });
  }

  deleteStack(boardId, stackId) {
    return this.request({
      method: "DELETE",
      path: `/boards/${encodeURIComponent(boardId)}/stacks/${encodeURIComponent(stackId)}`,
    });
  }

  getCard(boardId, stackId, cardId, { etag } = {}) {
    return this.request({
      method: "GET",
      path: `/boards/${encodeURIComponent(boardId)}/stacks/${encodeURIComponent(stackId)}/cards/${encodeURIComponent(cardId)}`,
      etag,
    });
  }

  createCard(boardId, stackId, { title, description = "", type = "plain", order }) {
    const body = { title, description, type };
    if (order !== undefined) body.order = order;
    return this.request({
      method: "POST",
      path: `/boards/${encodeURIComponent(boardId)}/stacks/${encodeURIComponent(stackId)}/cards`,
      body,
    });
  }

  updateCard(boardId, stackId, cardId, patch) {
    return this.request({
      method: "PUT",
      path: `/boards/${encodeURIComponent(boardId)}/stacks/${encodeURIComponent(stackId)}/cards/${encodeURIComponent(cardId)}`,
      body: patch,
    });
  }

  deleteCard(boardId, stackId, cardId) {
    return this.request({
      method: "DELETE",
      path: `/boards/${encodeURIComponent(boardId)}/stacks/${encodeURIComponent(stackId)}/cards/${encodeURIComponent(cardId)}`,
    });
  }

  /** Move a card. Deck's endpoint: PUT /cards/{cardId}/reorder. */
  reorderCard(boardId, stackId, cardId, { targetStackId, order }) {
    return this.request({
      method: "PUT",
      path: `/boards/${encodeURIComponent(boardId)}/stacks/${encodeURIComponent(stackId)}/cards/${encodeURIComponent(cardId)}/reorder`,
      body: { stackId: targetStackId, order },
    });
  }

  createLabel(boardId, { title, color = "31CC7C" }) {
    return this.request({
      method: "POST",
      path: `/boards/${encodeURIComponent(boardId)}/labels`,
      body: { title, color },
    });
  }

  updateLabel(boardId, labelId, { title, color }) {
    return this.request({
      method: "PUT",
      path: `/boards/${encodeURIComponent(boardId)}/labels/${encodeURIComponent(labelId)}`,
      body: { title, color },
    });
  }

  deleteLabel(boardId, labelId) {
    return this.request({
      method: "DELETE",
      path: `/boards/${encodeURIComponent(boardId)}/labels/${encodeURIComponent(labelId)}`,
    });
  }

  assignLabel(boardId, stackId, cardId, labelId) {
    return this.request({
      method: "PUT",
      path: `/boards/${encodeURIComponent(boardId)}/stacks/${encodeURIComponent(stackId)}/cards/${encodeURIComponent(cardId)}/assignLabel`,
      body: { labelId },
    });
  }

  removeLabel(boardId, stackId, cardId, labelId) {
    return this.request({
      method: "PUT",
      path: `/boards/${encodeURIComponent(boardId)}/stacks/${encodeURIComponent(stackId)}/cards/${encodeURIComponent(cardId)}/removeLabel`,
      body: { labelId },
    });
  }

  getBoardAcl(boardId) {
    return this.request({ method: "GET", path: `/boards/${encodeURIComponent(boardId)}/acl` });
  }

  // Attachments -------------------------------------------------------------
  //
  // Deck attachments are stored on the Nextcloud instance itself (whatever
  // storage backend the admin configured — local disk, S3, Swift, …). Clients
  // never see that layer; we only talk to the Deck attachment API, which
  // brokers reads and writes on the card's behalf. `type=deck_file` uses
  // Deck's own appdata directory and is the safest default (works on every
  // Deck ≥ 1.0). `type=file` (Deck ≥ 1.9) references arbitrary Nextcloud Files
  // paths; not used here for MVP.

  // Attachments live on Deck's OCS API surface, not the REST /index.php one.
  // The Web UI's own attachment flow (verified against a captured HAR) uses:
  //   GET    /ocs/v2.php/apps/deck/api/v1.0/cards/{cardId}/attachments?boardId={id}
  //   POST   /ocs/v2.php/apps/deck/api/v1.0/cards/{cardId}/attachment?boardId={id}
  //     body: multipart with cardId=<id>, type=file, file=<binary>
  //   DELETE /ocs/v2.php/apps/deck/api/v1.0/cards/{cardId}/attachments/{aid}?boardId={id}
  // `type=file` is Deck ≥ 1.3.0 (files land in the user's Nextcloud Files
  // under /Deck/…, get a real Nextcloud `fileid`, and produce thumbnails
  // that Deck's Markdown renderer can preview via `/f/{fileid}` links).
  // The legacy `type=deck_file` route on /index.php/… is why earlier
  // versions of this plugin uploaded bytes that never showed up in the
  // card's attachment panel: on new Deck deployments that URL silently
  // stores the file in Nextcloud but doesn't register it against the card.
  //
  // Responses wrap the payload in an OCS envelope: {ocs:{meta,data:{…}}}.
  // We unwrap in the wrapper methods below so the sync layer sees a flat
  // { id, cardId, type, data (filename), extendedData:{fileid, path, …} }.

  getAttachments(cardId, boardId) {
    return this.request({
      method: "GET",
      ocs: true,
      path: `/cards/${encodeURIComponent(cardId)}/attachments`,
      query: { boardId, format: "json" },
    }).then(unwrapOcs);
  }

  /**
   * Upload an attachment. `data` may be a Uint8Array or ArrayBuffer.
   * `filename` and `mimeType` should describe the source file (extension +
   * best-effort MIME). Server responds with the attachment metadata
   * (already OCS-unwrapped).
   */
  uploadAttachment(cardId, boardId, { data, filename, mimeType }) {
    return this.multipartRequest({
      method: "POST",
      ocs: true,
      path: `/cards/${encodeURIComponent(cardId)}/attachment`,
      query: { boardId, format: "json" },
      formFields: { cardId: String(cardId), type: "file" },
      file: { field: "file", data, filename, mimeType: mimeType || "application/octet-stream" },
    }).then(unwrapOcs);
  }

  deleteAttachment(cardId, boardId, attachmentId) {
    return this.request({
      method: "DELETE",
      ocs: true,
      path: `/cards/${encodeURIComponent(cardId)}/attachments/${encodeURIComponent(attachmentId)}`,
      query: { boardId, format: "json" },
    }).then(unwrapOcs);
  }

  /**
   * Download the raw bytes of an attachment. Two candidate endpoints work
   * on different Deck versions; we start with the OCS-flavoured one and
   * fall back to the legacy /index.php endpoint if the server returns a
   * 4xx. Both bypass /api/v1.0 and stream the file through PHP.
   */
  /**
   * Download an attachment's raw bytes.
   *
   * For Deck ≥ 1.3.0 (type=file), the underlying content is a regular
   * Nextcloud Files item stored under `/Deck/…` in the user's home
   * directory. The Web UI resolves it via `/f/{fileid}` (which redirects
   * to the Files app view) — but for a headless byte-fetch we need the
   * raw file, so we hit WebDAV directly:
   *
   *   GET /remote.php/dav/files/{username}/{extendedData.path}
   *
   * The legacy `/index.php/apps/deck/cards/{cardId}/attachment/{aid}`
   * route only works for the pre-1.3 `type=deck_file` storage and
   * responds with 403 for `type=file` attachments — which is what we
   * were seeing in production before this rewrite.
   *
   * `attachment` should be the OCS attachment record returned by
   * getAttachments / uploadAttachment; we read `extendedData.path` off
   * it. Falls back to the legacy route if the extendedData is missing
   * so old `deck_file` attachments still work.
   */
  async downloadAttachment(cardId, attachment) {
    const ext = attachment && attachment.extendedData;
    const path = ext && typeof ext.path === "string" ? ext.path : null;
    // Prefer WebDAV when we have a resolvable Files path.
    if (path) {
      const cleanPath = path.startsWith("/") ? path.slice(1) : path;
      const url = `${this.serverUrl}/remote.php/dav/files/${encodeURIComponent(this.username)}/${cleanPath.split("/").map(encodeURIComponent).join("/")}`;
      const headers = this.buildHeaders();
      headers.Accept = "*/*";
      delete headers["Content-Type"];
      delete headers["OCS-APIRequest"];
      const response = await requestUrl({ url, method: "GET", headers, throw: false });
      const status = response.status || 0;
      if (status >= 200 && status < 300) {
        return {
          status,
          data: response.arrayBuffer || null,
          contentType: pickHeader(response, "content-type") || (ext && ext.mimetype) || "application/octet-stream",
          headers: response.headers || {},
        };
      }
      throw new DeckApiError(`Deck attachment download failed (${status}).`, { status, url, body: parseBody(response) });
    }
    // Legacy fallback: pre-1.3 `type=deck_file` route. Kept for very
    // old servers or a corrupted extendedData; new deployments should
    // never reach this branch.
    const attachmentId = attachment && attachment.id != null ? attachment.id : attachment;
    const url = `${this.serverUrl}/index.php/apps/deck/cards/${encodeURIComponent(cardId)}/attachment/${encodeURIComponent(attachmentId)}`;
    const headers = this.buildHeaders();
    headers.Accept = "*/*";
    delete headers["Content-Type"];
    const response = await requestUrl({ url, method: "GET", headers, throw: false });
    const status = response.status || 0;
    if (status < 200 || status >= 300) {
      throw new DeckApiError(`Deck attachment download failed (${status}).`, { status, url, body: parseBody(response) });
    }
    return {
      status,
      data: response.arrayBuffer || null,
      contentType: pickHeader(response, "content-type") || "application/octet-stream",
      headers: response.headers || {},
    };
  }

  // Low-level plumbing ------------------------------------------------------

  buildUrl(path, query) {
    let url = `${this.serverUrl}${DECK_API_PREFIX}${path}`;
    if (query && Object.keys(query).length) {
      const params = Object.entries(query)
        .filter(([, value]) => value !== undefined && value !== null)
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
      if (params.length) url += `?${params.join("&")}`;
    }
    return url;
  }

  // Attachment endpoints live under a different URL prefix — OCS API on
  // /ocs/v2.php instead of the REST-flavoured /index.php. Keeping this in
  // a separate helper avoids buildUrl having to branch on path shape.
  buildOcsUrl(path, query) {
    let url = `${this.serverUrl}${OCS_DECK_PREFIX}${path}`;
    if (query && Object.keys(query).length) {
      const params = Object.entries(query)
        .filter(([, value]) => value !== undefined && value !== null)
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`);
      if (params.length) url += `?${params.join("&")}`;
    }
    return url;
  }

  buildHeaders({ etag } = {}) {
    const headers = {
      "OCS-APIRequest": "true",
      "Accept": "application/json",
      "Content-Type": "application/json",
      "User-Agent": this.userAgent,
      "Authorization": `Basic ${window.btoa(`${this.username}:${this.appPassword}`)}`,
    };
    if (etag) headers["If-None-Match"] = etag;
    return headers;
  }

  /**
   * Send one request. Retries transient network / retryable HTTP failures with
   * exponential backoff (1s → 2s → 4s → …, capped at 60s). On success returns
   * { status, etag, data, headers }; a 304 is returned as { status: 304 } with
   * `data: null` so callers can keep their cached copy.
   *
   * On non-retryable failures throws a DeckApiError; a 401 flags the caller
   * (settings/sync) to force re-authentication.
   */
  async request({ method, path, body, query, etag, signal, ocs }) {
    // OCS endpoints (attachments) live on a different URL prefix.
    const url = ocs ? this.buildOcsUrl(path, query) : this.buildUrl(path, query);
    const headers = this.buildHeaders({ etag });
    const payload = body === undefined ? undefined : JSON.stringify(body);

    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (signal && signal.aborted) throw new DeckApiError("Request aborted", { url });

      let response;
      let transportError = null;
      try {
        response = await requestUrl({
          url,
          method,
          headers,
          body: payload,
          contentType: "application/json",
          throw: false,
          // requestUrl doesn't expose AbortSignal directly; the signal check
          // above catches cancellation between retries which is sufficient
          // for our sync scheduler.
        });
      } catch (error) {
        transportError = error;
        response = { status: 0 };
      }

      const status = response.status || 0;
      const etagOut = pickHeader(response, "etag") || pickHeader(response, "ETag") || null;

      this.log({ url, method, status, attempt });

      // Success paths.
      if (status === 304) return { status, etag: etagOut, data: null, headers: response.headers || {} };
      if (status >= 200 && status < 300) {
        return {
          status,
          etag: etagOut,
          data: parseBody(response),
          headers: response.headers || {},
        };
      }

      // Non-retryable failures: bail out immediately so the caller sees the
      // exact HTTP status. 401 in particular must not be silently retried —
      // the sync layer needs it to flip the credential state.
      if (status && !RETRYABLE_STATUS.has(status)) {
        throw new DeckApiError(`Deck API ${method} ${path} failed (${status}).`, {
          status,
          url,
          body: parseBody(response),
        });
      }

      attempt += 1;
      if (attempt > this.maxRetries) {
        if (transportError) {
          throw new DeckApiError(`Deck API ${method} ${path} unreachable: ${transportError.message || transportError}.`, {
            status: 0,
            url,
          });
        }
        throw new DeckApiError(`Deck API ${method} ${path} kept failing (${status}).`, {
          status,
          url,
          body: parseBody(response),
        });
      }

      const backoff = Math.min(MAX_BACKOFF_MS, 1000 * (2 ** (attempt - 1)));
      await sleep(backoff);
    }
  }

  log(event) {
    if (this.logger) {
      try { this.logger(event); } catch (error) { /* ignore logger faults */ }
    }
  }

  /**
   * Send a multipart/form-data POST. Used only by the attachment upload; the
   * regular request() path stays JSON-only so its retry logic doesn't have to
   * re-serialise binary bodies.
   *
   * We hand-roll the multipart body because Obsidian's requestUrl doesn't
   * accept a FormData object directly — it wants an ArrayBuffer. This means
   * we must construct the CRLF-delimited envelope ourselves.
   */
  async multipartRequest({ method, path, formFields = {}, file, query, ocs }) {
    const url = ocs ? this.buildOcsUrl(path, query) : this.buildUrl(path, query);
    const boundary = `----ObsidianNextcloudDeck${Math.random().toString(36).slice(2)}`;
    const encoder = new TextEncoder();
    const chunks = [];

    for (const [name, value] of Object.entries(formFields)) {
      chunks.push(encoder.encode(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${name}"\r\n\r\n` +
        `${value}\r\n`,
      ));
    }

    if (file) {
      const safeName = String(file.filename || "file").replace(/"/g, "");
      chunks.push(encoder.encode(
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${file.field || "file"}"; filename="${safeName}"\r\n` +
        `Content-Type: ${file.mimeType || "application/octet-stream"}\r\n\r\n`,
      ));
      const bytes = file.data instanceof Uint8Array
        ? file.data
        : file.data instanceof ArrayBuffer
          ? new Uint8Array(file.data)
          : new Uint8Array(file.data || []);
      chunks.push(bytes);
      chunks.push(encoder.encode("\r\n"));
    }

    chunks.push(encoder.encode(`--${boundary}--\r\n`));

    const body = concatUint8Arrays(chunks);
    const headers = this.buildHeaders();
    delete headers["Content-Type"]; // let contentType option set it
    delete headers.Accept;
    headers.Accept = "application/json";

    let attempt = 0;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      let response;
      let transportError = null;
      try {
        response = await requestUrl({
          url,
          method,
          headers,
          body: body.buffer,
          contentType: `multipart/form-data; boundary=${boundary}`,
          throw: false,
        });
      } catch (error) {
        transportError = error;
        response = { status: 0 };
      }

      const status = response.status || 0;
      this.log({ url, method, status, attempt, multipart: true });

      if (status >= 200 && status < 300) {
        return { status, data: parseBody(response), headers: response.headers || {} };
      }
      if (status && !RETRYABLE_STATUS.has(status)) {
        throw new DeckApiError(`Deck attachment upload failed (${status}).`, {
          status,
          url,
          body: parseBody(response),
        });
      }
      attempt += 1;
      if (attempt > this.maxRetries) {
        if (transportError) {
          throw new DeckApiError(`Deck attachment upload unreachable: ${transportError.message || transportError}.`, { status: 0, url });
        }
        throw new DeckApiError(`Deck attachment upload kept failing (${status}).`, { status, url, body: parseBody(response) });
      }
      await sleep(Math.min(MAX_BACKOFF_MS, 1000 * (2 ** (attempt - 1))));
    }
  }
}

function pickHeader(response, name) {
  if (!response || !response.headers) return null;
  // requestUrl normalises headers to lowercase on some platforms but not
  // others; probe both to be safe.
  const headers = response.headers;
  if (headers[name] !== undefined) return headers[name];
  const lower = name.toLowerCase();
  for (const key of Object.keys(headers)) {
    if (key.toLowerCase() === lower) return headers[key];
  }
  return null;
}

function parseBody(response) {
  if (!response) return null;
  if (response.json && typeof response.json === "object") return response.json;
  const text = response.text;
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    return text;
  }
}

/**
 * OCS endpoints wrap the payload in `{ocs:{meta,data}}`. The rest of the
 * plugin already expects the flat shape from the REST /api/v1.0 endpoints,
 * so we unwrap here at the client boundary. Preserves `{status,headers}`
 * from the underlying request result.
 */
function unwrapOcs(result) {
  if (!result) return result;
  const body = result.data;
  if (body && body.ocs && Object.prototype.hasOwnProperty.call(body.ocs, "data")) {
    return Object.assign({}, result, { data: body.ocs.data });
  }
  return result;
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function concatUint8Arrays(chunks) {
  let total = 0;
  for (const chunk of chunks) total += chunk.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

module.exports = {
  DeckClient,
  DeckApiError,
  RETRYABLE_STATUS,
};
