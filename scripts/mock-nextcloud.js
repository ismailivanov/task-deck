#!/usr/bin/env node
/* eslint-disable no-console */

/**
 * Local Nextcloud + Deck API mock server for Obsidian Nextcloud Deck.
 * Zero external dependencies — Node built-in http only.
 *
 * Supports:
 *   - Login Flow v2 (POST /index.php/login/v2  &  POST <poll-endpoint>)
 *   - OCS whoami    (GET  /ocs/v2.php/cloud/user)
 *   - App-password revoke (DELETE /ocs/v2.php/core/apppassword)
 *   - Deck v1.0 boards / stacks / cards / labels / acl
 *     under /index.php/apps/deck/api/v1.0/*
 *
 * Enough state is kept in-memory to exercise the sync client end-to-end. All
 * writes mint a bumped `lastModified` and refresh ETag so If-None-Match paths
 * exercise cleanly.
 *
 * Usage:
 *   node scripts/mock-nextcloud.js
 * Env:
 *   MOCK_PORT       default 8765
 *   MOCK_USER       default "alice"
 *   MOCK_PASSWORD   default "secret"       (also the "App Password")
 *   MOCK_AUTO_LOGIN if set, poll returns credentials immediately
 */

const http = require("http");
const crypto = require("crypto");
const url = require("url");

const PORT = Number(process.env.MOCK_PORT || 8765);
const USER = process.env.MOCK_USER || "alice";
const PASSWORD = process.env.MOCK_PASSWORD || "secret";
const AUTO_LOGIN = !!process.env.MOCK_AUTO_LOGIN;
const SERVER_URL = `http://localhost:${PORT}`;

const state = {
  loginFlows: new Map(),
  nextId: 1,
  boards: new Map(),
  stacks: new Map(),
  stacksByBoard: new Map(),
  cards: new Map(),
  cardsByStack: new Map(),
  labels: new Map(),
  labelsByBoard: new Map(),
  lastModified: 0,
};

const nextId = () => state.nextId++;
const bumpModified = () => (state.lastModified = Date.now(), state.lastModified);
const makeEtag = (kind, id) => `"${kind}-${id}-${crypto.randomBytes(4).toString("hex")}"`;

function seed() {
  const boardId = nextId();
  state.boards.set(boardId, {
    id: boardId, title: "Personal roadmap", color: "0082c9", archived: false,
    owner: { uid: USER, displayname: USER },
    lastModified: bumpModified(), ETag: makeEtag("board", boardId),
  });
  state.stacksByBoard.set(boardId, []);
  state.labelsByBoard.set(boardId, []);

  ["Backlog", "In progress", "Done"].forEach((title, order) => {
    const stackId = nextId();
    state.stacks.set(stackId, { id: stackId, boardId, title, order, lastModified: bumpModified() });
    state.stacksByBoard.get(boardId).push(stackId);
    state.cardsByStack.set(stackId, []);
    if (order === 0) {
      const cardId = nextId();
      state.cards.set(cardId, {
        id: cardId, stackId,
        title: "Try Obsidian Nextcloud Deck sync",
        description: "This card comes from the mock Nextcloud server.\n\n- [ ] connect\n- [ ] pull\n- [ ] push",
        type: "plain", order: 0, archived: false, duedate: null,
        labels: [], assignedUsers: [],
        lastModified: bumpModified(), ETag: makeEtag("card", cardId),
      });
      state.cardsByStack.get(stackId).push(cardId);
    }
  });

  ["Priority", "Idea", "Blocked"].forEach((title, i) => {
    const id = nextId();
    const color = ["ff5555", "31CC7C", "888888"][i];
    state.labels.set(id, { id, title, color, boardId });
    state.labelsByBoard.get(boardId).push(id);
  });
}

// ---- HTTP helpers ---------------------------------------------------------

function sendJson(res, status, body, headers = {}) {
  const payload = body == null ? "" : JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ETag: headers.ETag || `"srv-${state.lastModified}"`,
    "Last-Modified": new Date(state.lastModified || Date.now()).toUTCString(),
    "Access-Control-Allow-Origin": "*",
    ...headers,
  });
  res.end(payload);
}
const sendText = (res, status, text, headers = {}) => {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8", "Access-Control-Allow-Origin": "*", ...headers });
  res.end(text);
};
const readBody = (req) => new Promise((resolve) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
});
function checkBasicAuth(req) {
  const h = req.headers.authorization || "";
  if (!h.startsWith("Basic ")) return false;
  const [name, pass] = Buffer.from(h.slice(6), "base64").toString("utf-8").split(":");
  return name === USER && pass === PASSWORD;
}
const safeJson = (text) => { try { return text ? JSON.parse(text) : {}; } catch { return {}; } };

// ---- Login Flow -----------------------------------------------------------

async function handleLoginFlowStart(req, res) {
  const pollToken = crypto.randomBytes(16).toString("hex");
  const loginToken = crypto.randomBytes(16).toString("hex");
  state.loginFlows.set(pollToken, { authorized: AUTO_LOGIN });
  sendJson(res, 200, {
    poll: { token: pollToken, endpoint: `${SERVER_URL}/index.php/login/v2/poll` },
    login: `${SERVER_URL}/mock/login?token=${loginToken}&poll=${pollToken}`,
  });
}
async function handleLoginFlowPoll(req, res) {
  const params = new URLSearchParams(await readBody(req));
  const token = params.get("token");
  const flow = token ? state.loginFlows.get(token) : null;
  if (!flow) return sendText(res, 404, "unknown flow");
  if (!flow.authorized) return sendText(res, 404, "still waiting");
  state.loginFlows.delete(token);
  sendJson(res, 200, { server: SERVER_URL, loginName: USER, appPassword: PASSWORD });
}
function handleMockLoginConfirm(req, res, parsed) {
  const flow = state.loginFlows.get(parsed.query.poll);
  if (!flow) return sendText(res, 404, "unknown login token");
  flow.authorized = true;
  sendText(res, 200, `Mock login OK for ${USER}. Return to Obsidian; the poller will finish shortly.`);
}

// ---- OCS ------------------------------------------------------------------

const handleWhoAmI = (req, res) => {
  if (!checkBasicAuth(req)) return sendJson(res, 401, { message: "auth" });
  sendJson(res, 200, { ocs: { meta: { status: "ok", statuscode: 200 }, data: { id: USER, displayname: USER, email: `${USER}@example.com` } } });
};
const handleRevokeAppPw = (req, res) => {
  if (!checkBasicAuth(req)) return sendJson(res, 401, { message: "auth" });
  sendJson(res, 200, { ocs: { meta: { status: "ok", statuscode: 200 } } });
};

// ---- Deck -----------------------------------------------------------------

const ensureAuth = (req, res) => (checkBasicAuth(req) ? true : (sendJson(res, 401, { message: "auth required" }), false));
const boardShape = (b) => ({ ...b, users: [b.owner], acl: [] });
const stackShape = (s) => ({ ...s, cards: (state.cardsByStack.get(s.id) || []).map((id) => state.cards.get(id)).filter(Boolean) });

async function handleDeckRoute(req, res, pathname) {
  if (!ensureAuth(req, res)) return;
  const parts = pathname.split("/").filter(Boolean);
  const t = parts.slice(5);

  // /boards
  if (t[0] === "boards" && t.length === 1) {
    if (req.method === "GET") return sendJson(res, 200, [...state.boards.values()].map(boardShape));
    if (req.method === "POST") {
      const patch = safeJson(await readBody(req));
      const id = nextId();
      const board = { id, title: patch.title || "New board", color: patch.color || "0082c9",
        archived: false, owner: { uid: USER, displayname: USER },
        lastModified: bumpModified(), ETag: makeEtag("board", id) };
      state.boards.set(id, board);
      state.stacksByBoard.set(id, []);
      state.labelsByBoard.set(id, []);
      return sendJson(res, 200, boardShape(board), { ETag: board.ETag });
    }
  }
  // /boards/{id}
  if (t[0] === "boards" && t.length === 2) {
    const boardId = Number(t[1]);
    const board = state.boards.get(boardId);
    if (!board) return sendJson(res, 404, { message: "not found" });
    if (req.method === "GET") {
      if (req.headers["if-none-match"] === board.ETag) { res.writeHead(304, { ETag: board.ETag }); return res.end(); }
      return sendJson(res, 200, boardShape(board), { ETag: board.ETag });
    }
    if (req.method === "PUT") {
      Object.assign(board, safeJson(await readBody(req)), { lastModified: bumpModified(), ETag: makeEtag("board", boardId) });
      return sendJson(res, 200, boardShape(board), { ETag: board.ETag });
    }
    if (req.method === "DELETE") { state.boards.delete(boardId); return sendJson(res, 200, { id: boardId }); }
  }
  // /boards/{id}/stacks
  if (t[0] === "boards" && t[2] === "stacks" && t.length === 3) {
    const boardId = Number(t[1]);
    if (req.method === "GET") {
      const ids = state.stacksByBoard.get(boardId) || [];
      return sendJson(res, 200, ids.map((id) => stackShape(state.stacks.get(id))).filter(Boolean));
    }
    if (req.method === "POST") {
      const patch = safeJson(await readBody(req));
      const id = nextId();
      const stack = { id, boardId, title: patch.title || "New list", order: patch.order || 0, lastModified: bumpModified() };
      state.stacks.set(id, stack);
      (state.stacksByBoard.get(boardId) || []).push(id);
      state.cardsByStack.set(id, []);
      return sendJson(res, 200, stackShape(stack));
    }
  }
  // /boards/{id}/stacks/{stackId}
  if (t[0] === "boards" && t[2] === "stacks" && t.length === 4) {
    const stackId = Number(t[3]);
    const stack = state.stacks.get(stackId);
    if (!stack) return sendJson(res, 404, { message: "no stack" });
    if (req.method === "PUT") {
      Object.assign(stack, safeJson(await readBody(req)), { lastModified: bumpModified() });
      return sendJson(res, 200, stackShape(stack));
    }
    if (req.method === "DELETE") {
      state.stacks.delete(stackId);
      const list = state.stacksByBoard.get(stack.boardId) || [];
      state.stacksByBoard.set(stack.boardId, list.filter((id) => id !== stackId));
      return sendJson(res, 200, { id: stackId });
    }
  }
  // cards collection
  if (t[0] === "boards" && t[2] === "stacks" && t[4] === "cards" && t.length === 5) {
    const stackId = Number(t[3]);
    if (req.method === "POST") {
      const patch = safeJson(await readBody(req));
      const id = nextId();
      const card = { id, stackId,
        title: patch.title || "Untitled", description: patch.description || "",
        type: patch.type || "plain", order: patch.order || 0,
        archived: false, duedate: patch.duedate || null,
        labels: [], assignedUsers: [],
        lastModified: bumpModified(), ETag: makeEtag("card", id) };
      state.cards.set(id, card);
      (state.cardsByStack.get(stackId) || []).push(id);
      return sendJson(res, 200, card, { ETag: card.ETag });
    }
  }
  // card item / reorder / labels
  if (t[0] === "boards" && t[2] === "stacks" && t[4] === "cards" && t.length >= 6) {
    const cardId = Number(t[5]);
    const card = state.cards.get(cardId);
    if (!card) return sendJson(res, 404, { message: "no card" });
    const action = t[6];
    if (!action) {
      if (req.method === "GET") {
        if (req.headers["if-none-match"] === card.ETag) { res.writeHead(304, { ETag: card.ETag }); return res.end(); }
        return sendJson(res, 200, card, { ETag: card.ETag });
      }
      if (req.method === "PUT") {
        Object.assign(card, safeJson(await readBody(req)), { lastModified: bumpModified(), ETag: makeEtag("card", cardId) });
        return sendJson(res, 200, card, { ETag: card.ETag });
      }
      if (req.method === "DELETE") {
        state.cards.delete(cardId);
        const list = state.cardsByStack.get(card.stackId) || [];
        state.cardsByStack.set(card.stackId, list.filter((id) => id !== cardId));
        return sendJson(res, 200, { id: cardId });
      }
    }
    if (action === "reorder" && req.method === "PUT") {
      const patch = safeJson(await readBody(req));
      const targetStackId = Number(patch.stackId);
      if (targetStackId && targetStackId !== card.stackId) {
        const from = state.cardsByStack.get(card.stackId) || [];
        state.cardsByStack.set(card.stackId, from.filter((id) => id !== cardId));
        const to = state.cardsByStack.get(targetStackId) || [];
        to.splice(patch.order || 0, 0, cardId);
        state.cardsByStack.set(targetStackId, to);
        card.stackId = targetStackId;
      }
      card.order = patch.order || 0;
      card.lastModified = bumpModified();
      card.ETag = makeEtag("card", cardId);
      return sendJson(res, 200, card, { ETag: card.ETag });
    }
    if ((action === "assignLabel" || action === "removeLabel") && req.method === "PUT") {
      const patch = safeJson(await readBody(req));
      const label = state.labels.get(Number(patch.labelId));
      if (!label) return sendJson(res, 404, { message: "no label" });
      if (action === "assignLabel" && !card.labels.some((l) => l.id === label.id)) card.labels.push(label);
      if (action === "removeLabel") card.labels = card.labels.filter((l) => l.id !== label.id);
      card.lastModified = bumpModified();
      card.ETag = makeEtag("card", cardId);
      return sendJson(res, 200, card, { ETag: card.ETag });
    }
  }
  // labels
  if (t[0] === "boards" && t[2] === "labels") {
    const boardId = Number(t[1]);
    if (t.length === 3 && req.method === "POST") {
      const patch = safeJson(await readBody(req));
      const id = nextId();
      const label = { id, title: patch.title || "label", color: patch.color || "31CC7C", boardId };
      state.labels.set(id, label);
      (state.labelsByBoard.get(boardId) || []).push(id);
      return sendJson(res, 200, label);
    }
    if (t.length === 4) {
      const labelId = Number(t[3]);
      const label = state.labels.get(labelId);
      if (req.method === "PUT") {
        if (!label) return sendJson(res, 404, { message: "no label" });
        Object.assign(label, safeJson(await readBody(req)));
        return sendJson(res, 200, label);
      }
      if (req.method === "DELETE") {
        state.labels.delete(labelId);
        const list = state.labelsByBoard.get(boardId) || [];
        state.labelsByBoard.set(boardId, list.filter((id) => id !== labelId));
        return sendJson(res, 200, { id: labelId });
      }
    }
  }
  // acl
  if (t[0] === "boards" && t[2] === "acl" && t.length === 3 && req.method === "GET") {
    const boardId = Number(t[1]);
    if (!state.boards.get(boardId)) return sendJson(res, 404, { message: "no board" });
    return sendJson(res, 200, [{
      id: 1, boardId, type: 0,
      participant: { primaryKey: USER, uid: USER, displayname: USER, type: 0 },
      permissionEdit: true, permissionShare: true, permissionManage: true, owner: true,
    }]);
  }
  return sendJson(res, 404, { message: `no route for ${req.method} ${pathname}` });
}

// ---- Router ---------------------------------------------------------------

const server = http.createServer(async (req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname || "/";
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE",
      "Access-Control-Allow-Headers": "content-type,authorization,ocs-apirequest,if-none-match",
    });
    return res.end();
  }
  try {
    if (req.method === "POST" && pathname === "/index.php/login/v2") return handleLoginFlowStart(req, res);
    if (req.method === "POST" && pathname === "/index.php/login/v2/poll") return handleLoginFlowPoll(req, res);
    if (req.method === "GET"  && pathname === "/mock/login") return handleMockLoginConfirm(req, res, parsed);
    if (req.method === "GET"  && pathname === "/ocs/v2.php/cloud/user") return handleWhoAmI(req, res);
    if (req.method === "DELETE" && pathname === "/ocs/v2.php/core/apppassword") return handleRevokeAppPw(req, res);
    if (pathname.startsWith("/index.php/apps/deck/api/v1.0/")) return handleDeckRoute(req, res, pathname);
    sendJson(res, 404, { message: `no route ${req.method} ${pathname}` });
  } catch (error) {
    console.error("mock server error", error);
    sendJson(res, 500, { message: String(error.message || error) });
  }
});

seed();
server.listen(PORT, () => {
  console.log(`Mock Nextcloud running at ${SERVER_URL}`);
  console.log(`  user:         ${USER}`);
  console.log(`  password:     ${PASSWORD}`);
  console.log(`  auto-login:   ${AUTO_LOGIN ? "yes (poll returns immediately)" : "no (open the /mock/login URL that appears in Obsidian)"}`);
  console.log("");
  console.log("Quick checks:");
  console.log(`  curl -u ${USER}:${PASSWORD} -H 'OCS-APIRequest: true' ${SERVER_URL}/ocs/v2.php/cloud/user`);
  console.log(`  curl -u ${USER}:${PASSWORD} -H 'OCS-APIRequest: true' ${SERVER_URL}/index.php/apps/deck/api/v1.0/boards`);
});