const { requestUrl } = require("obsidian");

// Nextcloud authentication + credential storage for Obsidian Nextcloud Deck.
//
// Two paths are supported:
//   1. Login Flow v2 (recommended). The user opens Nextcloud in a browser, we
//      poll a token endpoint until Nextcloud returns { loginName, appPassword }.
//      https://docs.nextcloud.com/server/latest/developer_manual/client_apis/LoginFlow/index.html#login-flow-v2
//   2. Manual App Password entry (fallback). The user pastes the username +
//      App Password they generated in Nextcloud themselves.
//
// The App Password is stored encrypted with AES-GCM. The key is derived from a
// device-scoped passphrase (persisted in localStorage) via PBKDF2, so an
// attacker copying just data.json cannot read the password without also
// pulling the device's localStorage. This is not perfect protection — a full
// device compromise reveals the key — but it removes plaintext credentials
// from the vault, which is what actually gets shared / synced / backed up.

const PBKDF2_ITERATIONS = 210000;                       // OWASP 2023 baseline
const KEY_STORAGE_KEY = "obsidian-nextcloud-deck.key.v1";
const CIPHER_PREFIX = "v1:";                             // future-proof format tag

/**
 * Return the persistent device passphrase used to derive the AES key. First
 * run generates a random 256-bit passphrase and stores it in localStorage. All
 * subsequent runs read the same value so previously encrypted ciphertext keeps
 * decrypting. Callers should NEVER surface this to the user.
 */
function getOrCreateDevicePassphrase() {
  let stored = null;
  try {
    stored = window.localStorage.getItem(KEY_STORAGE_KEY);
  } catch (error) {
    stored = null;
  }
  if (stored) return stored;

  const bytes = new Uint8Array(32);
  window.crypto.getRandomValues(bytes);
  const generated = bufferToBase64(bytes);
  try {
    window.localStorage.setItem(KEY_STORAGE_KEY, generated);
  } catch (error) {
    // Falling back to an in-memory passphrase means the ciphertext won't
    // survive a reload — surface that so the caller can force re-login.
    throw new Error("Cannot persist Nextcloud credential key in localStorage.");
  }
  return generated;
}

function bufferToBase64(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i]);
  return window.btoa(binary);
}

function base64ToBuffer(value) {
  const binary = window.atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

async function deriveKey(passphrase, salt) {
  const encoder = new TextEncoder();
  const baseKey = await window.crypto.subtle.importKey(
    "raw",
    encoder.encode(passphrase),
    { name: "PBKDF2" },
    false,
    ["deriveKey"],
  );
  return window.crypto.subtle.deriveKey(
    { name: "PBKDF2", salt, iterations: PBKDF2_ITERATIONS, hash: "SHA-256" },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/**
 * Encrypt an App Password for storage in data.json.
 * Returns a string of the form "v1:base64(salt)|base64(iv)|base64(ciphertext)".
 */
async function encryptAppPassword(plaintext) {
  if (!plaintext) return "";
  const salt = window.crypto.getRandomValues(new Uint8Array(16));
  const iv = window.crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(getOrCreateDevicePassphrase(), salt);
  const encoded = new TextEncoder().encode(plaintext);
  const cipherBuffer = await window.crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoded);
  return `${CIPHER_PREFIX}${bufferToBase64(salt)}|${bufferToBase64(iv)}|${bufferToBase64(cipherBuffer)}`;
}

/**
 * Decrypt a stored App Password. Returns "" if the ciphertext is empty, and
 * throws on tamper / wrong key so the caller can force the user to re-login.
 */
async function decryptAppPassword(cipher) {
  if (!cipher) return "";
  if (!cipher.startsWith(CIPHER_PREFIX)) {
    throw new Error("Unsupported Nextcloud credential format; please sign in again.");
  }
  const body = cipher.slice(CIPHER_PREFIX.length);
  const parts = body.split("|");
  if (parts.length !== 3) throw new Error("Corrupted Nextcloud credential; please sign in again.");
  const [saltB64, ivB64, cipherB64] = parts;
  const salt = base64ToBuffer(saltB64);
  const iv = base64ToBuffer(ivB64);
  const cipherBytes = base64ToBuffer(cipherB64);
  const key = await deriveKey(getOrCreateDevicePassphrase(), salt);
  const plainBuffer = await window.crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, cipherBytes);
  return new TextDecoder().decode(plainBuffer);
}

/**
 * Normalise a user-entered server URL. Trims whitespace, trailing slashes, and
 * accepts hosts without a scheme (defaults to https, since Login Flow v2
 * requires TLS anyway).
 */
function normalizeServerUrl(input) {
  const trimmed = String(input || "").trim();
  if (!trimmed) return "";
  let value = trimmed;
  if (!/^https?:\/\//i.test(value)) value = `https://${value}`;
  return value.replace(/\/+$/, "");
}

/**
 * Kick off Login Flow v2. Returns { login, poll } where `login` is the URL to
 * open in the browser and `poll` is passed to `pollLoginFlow` below.
 * `poll.endpoint` is a Nextcloud-owned URL and `poll.token` is a one-shot
 * secret we send back to trade for the App Password.
 */
async function startLoginFlow(serverUrl) {
  const base = normalizeServerUrl(serverUrl);
  if (!base) throw new Error("Enter a Nextcloud server URL first.");
  const response = await requestUrl({
    url: `${base}/index.php/login/v2`,
    method: "POST",
    headers: {
      "OCS-APIRequest": "true",
      "User-Agent": "NextDeck",
    },
    throw: false,
  });
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Login Flow init failed (${response.status}). Check the server URL and that HTTPS is reachable.`);
  }
  const json = safeJson(response);
  if (!json || !json.login || !json.poll || !json.poll.endpoint || !json.poll.token) {
    throw new Error("Login Flow response was malformed.");
  }
  return {
    serverUrl: base,
    login: String(json.login),
    poll: { endpoint: String(json.poll.endpoint), token: String(json.poll.token) },
  };
}

/**
 * Poll the Login Flow endpoint until Nextcloud returns credentials, the user
 * aborts, or the timeout elapses. Nextcloud returns HTTP 404 while waiting; we
 * treat any other status as a hard failure.
 *
 * @param {{ endpoint: string, token: string }} poll   Data from startLoginFlow().
 * @param {{ intervalMs?: number, timeoutMs?: number, signal?: AbortSignal }} [opts]
 * @returns {Promise<{ server: string, loginName: string, appPassword: string }>}
 */
async function pollLoginFlow(poll, opts = {}) {
  const intervalMs = opts.intervalMs || 3000;
  const timeoutMs = opts.timeoutMs || 20 * 60 * 1000; // 20 min matches Nextcloud's own TTL
  const started = Date.now();
  const signal = opts.signal;

  while (true) {
    if (signal && signal.aborted) throw new Error("Login was cancelled.");
    if (Date.now() - started > timeoutMs) throw new Error("Login timed out. Try again.");

    let response;
    try {
      response = await requestUrl({
        url: poll.endpoint,
        method: "POST",
        headers: { "OCS-APIRequest": "true" },
        body: `token=${encodeURIComponent(poll.token)}`,
        contentType: "application/x-www-form-urlencoded",
        throw: false,
      });
    } catch (error) {
      // Network hiccup: keep polling, don't fail the whole flow.
      response = { status: 0 };
    }

    if (response.status >= 200 && response.status < 300) {
      const json = safeJson(response);
      if (json && json.appPassword && json.loginName && json.server) {
        return {
          server: normalizeServerUrl(json.server),
          loginName: String(json.loginName),
          appPassword: String(json.appPassword),
        };
      }
      throw new Error("Login Flow completed but returned no credentials.");
    }
    if (response.status && response.status !== 404 && response.status !== 0) {
      throw new Error(`Login Flow polling failed (${response.status}).`);
    }
    await sleep(intervalMs);
  }
}

/** Best-effort remote revocation of the currently-used App Password. */
async function revokeAppPassword(serverUrl, username, appPassword) {
  if (!serverUrl || !username || !appPassword) return false;
  try {
    const response = await requestUrl({
      url: `${normalizeServerUrl(serverUrl)}/ocs/v2.php/core/apppassword`,
      method: "DELETE",
      headers: {
        "OCS-APIRequest": "true",
        "Authorization": `Basic ${window.btoa(`${username}:${appPassword}`)}`,
        "Accept": "application/json",
      },
      throw: false,
    });
    return response.status >= 200 && response.status < 300;
  } catch (error) {
    return false;
  }
}

/** Ping a Nextcloud endpoint that requires auth to confirm the credentials work. */
async function testConnection(serverUrl, username, appPassword) {
  if (!serverUrl || !username || !appPassword) {
    throw new Error("Missing server URL, username, or App Password.");
  }
  const response = await requestUrl({
    url: `${normalizeServerUrl(serverUrl)}/ocs/v2.php/cloud/user`,
    method: "GET",
    headers: {
      "OCS-APIRequest": "true",
      "Accept": "application/json",
      "Authorization": `Basic ${window.btoa(`${username}:${appPassword}`)}`,
    },
    throw: false,
  });
  if (response.status === 401) throw new Error("Nextcloud rejected the credentials (401). Sign in again.");
  if (response.status < 200 || response.status >= 300) {
    throw new Error(`Nextcloud connection test failed (${response.status}).`);
  }
  const json = safeJson(response);
  const displayName = (json && json.ocs && json.ocs.data && (json.ocs.data.displayname || json.ocs.data["display-name"])) || username;
  return { displayName };
}

function safeJson(response) {
  if (!response) return null;
  if (response.json && typeof response.json === "object") return response.json;
  const text = response.text;
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (error) {
    return null;
  }
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

module.exports = {
  CIPHER_PREFIX,
  normalizeServerUrl,
  startLoginFlow,
  pollLoginFlow,
  revokeAppPassword,
  testConnection,
  encryptAppPassword,
  decryptAppPassword,
};
