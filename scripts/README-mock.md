# Local Nextcloud + Deck API Mock

`scripts/mock-nextcloud.js` is a zero-dependency Node script that impersonates
just enough of a Nextcloud + Deck server to exercise the plugin's auth and sync
paths end-to-end. It uses only Node's built-in `http`, so `node scripts/mock-nextcloud.js`
is enough.

## Start the server

```bash
node scripts/mock-nextcloud.js
# Optional overrides
MOCK_PORT=8765 MOCK_USER=alice MOCK_PASSWORD=secret \
  MOCK_AUTO_LOGIN=1 \
  node scripts/mock-nextcloud.js
```

Defaults:

| Env                 | Default    | Notes                                                                                              |
| ------------------- | ---------- | -------------------------------------------------------------------------------------------------- |
| `MOCK_PORT`       | `8765`   | HTTP port                                                                                          |
| `MOCK_USER`       | `alice`  | login name and OCS uid                                                                             |
| `MOCK_PASSWORD`   | `secret` | doubles as the App Password                                                                        |
| `MOCK_AUTO_LOGIN` | (unset)    | when set,`/login/v2/poll` returns credentials immediately — useful for the "unattended CI" flow |

The server prints two curl commands you can paste right after boot.

## Use it from the plugin

1. Reload Obsidian (or run **Reload app without saving**).
2. Open **Settings → Obsidian Nextcloud Deck → Nextcloud sync**.
3. Server URL: `http://localhost:8765`.
4. Click **Sign in with browser**.
   - The plugin will `POST /index.php/login/v2`, receive a `login` URL, and open
     it in the system browser.
   - Click the link on the confirmation page — the mock marks the flow
     `authorized`, and the plugin's poller receives `{ server, loginName, appPassword }`
     within a few seconds.
   - Set `MOCK_AUTO_LOGIN=1` to skip the browser step.
5. Once signed in, **Test connection** should say `Nextcloud connection OK — alice`.

## Preloaded state

`seed()` creates on startup:

- 1 board: **Personal roadmap** (`color=0082c9`).
- 3 stacks: Backlog / In progress / Done.
- 1 card in Backlog with a Markdown description containing 3 unchecked items.
- 3 labels on the board: Priority, Idea, Blocked.

Every response carries a bumped `Last-Modified` and a fresh `ETag`, so the
plugin's `If-None-Match` short-circuit is exercised on repeat pulls.

## Supported endpoints

**Nextcloud core**

- `POST /index.php/login/v2` → `{ login, poll: { token, endpoint } }`
- `POST /index.php/login/v2/poll` (form-encoded `token=...`) → 404 while waiting, 200 with credentials once authorized.
- `GET /mock/login?poll=...` → marks a flow authorized (visit in a browser).
- `GET /ocs/v2.php/cloud/user` → basic-auth guard, echoes displayname.
- `DELETE /ocs/v2.php/core/apppassword` → 200 (sign-out revocation).

**Deck API** (prefix `/index.php/apps/deck/api/v1.0`)

- `GET/POST /boards`
- `GET/PUT/DELETE /boards/{id}` (honours `If-None-Match` → 304)
- `GET/POST /boards/{id}/stacks`
- `PUT/DELETE /boards/{id}/stacks/{stackId}`
- `POST /boards/{id}/stacks/{stackId}/cards`
- `GET/PUT/DELETE /boards/{id}/stacks/{stackId}/cards/{cardId}` (ETag-aware)
- `PUT /boards/{id}/stacks/{stackId}/cards/{cardId}/reorder`
- `PUT /boards/{id}/stacks/{stackId}/cards/{cardId}/assignLabel|removeLabel`
- `POST /boards/{id}/labels`, `PUT/DELETE /boards/{id}/labels/{labelId}`
- `GET /boards/{id}/acl`

Attachments are **not** mocked — Phase 4 will build them out together with the
real client wiring.

## Curl cookbook

```bash
# Ping OCS with the built-in credentials
curl -u alice:secret -H 'OCS-APIRequest: true' \
  http://localhost:8765/ocs/v2.php/cloud/user

# List boards
curl -u alice:secret -H 'OCS-APIRequest: true' \
  http://localhost:8765/index.php/apps/deck/api/v1.0/boards

# Fetch board #1 with an ETag test (get, then repeat with If-None-Match)
curl -i -u alice:secret -H 'OCS-APIRequest: true' \
  http://localhost:8765/index.php/apps/deck/api/v1.0/boards/1
# Note the ETag from the response, then:
curl -i -u alice:secret -H 'OCS-APIRequest: true' \
  -H 'If-None-Match: "board-1-abcd1234"' \
  http://localhost:8765/index.php/apps/deck/api/v1.0/boards/1

# Create a new board
curl -u alice:secret -H 'OCS-APIRequest: true' \
  -H 'Content-Type: application/json' \
  -d '{"title":"From curl","color":"ff8800"}' \
  http://localhost:8765/index.php/apps/deck/api/v1.0/boards

# Full Login Flow v2 in one shell
POLL=$(curl -s -X POST -H 'OCS-APIRequest: true' \
  http://localhost:8765/index.php/login/v2 | jq -r .poll.token)
curl "http://localhost:8765/mock/login?poll=$POLL"   # authorize
curl -X POST -d "token=$POLL" \
  http://localhost:8765/index.php/login/v2/poll
```

## Limits & Roadmap

- No `Approve` / rate-limit / 429 behaviour — you can hard-code a `sleep(3000)`
  or an early `sendJson(res, 429, ...)` inside a route while smoke-testing
  retry/backoff paths of `deck-client.js`.
- No attachment endpoints yet (Phase 4).
- No multi-user ACL beyond the seeded owner — for the MVP that's all we need.
- No HTTPS — matches Obsidian desktop's default of allowing localhost HTTP.
  If Obsidian mobile refuses the plaintext connection, tunnel through
  `caddy reverse-proxy --to :8765` (adds automatic self-signed TLS).

## Verify

```bash
node --check scripts/mock-nextcloud.js
node scripts/mock-nextcloud.js &
MOCK_PID=$!
sleep 0.3
curl -sf -u alice:secret -H 'OCS-APIRequest: true' \
  http://localhost:8765/ocs/v2.php/cloud/user | jq .ocs.data.displayname
kill $MOCK_PID
```

Expected output: `"alice"`.
