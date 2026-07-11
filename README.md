# NextDeck (formerly Obsidian Nextcloud Deck)

[![Obsidian](https://img.shields.io/badge/Obsidian-1.5%2B-7c3aed?logo=obsidian&logoColor=white)](https://obsidian.md)
[![License: MIT](https://img.shields.io/badge/License-MIT-f1c40f.svg)](LICENSE)

NextDeck is a Kanban plugin for Obsidian, with every card stored as a real Markdown note in your vault and two-way sync against the [Nextcloud Deck](https://github.com/nextcloud/deck) REST API. You keep full control of the data on your own Nextcloud server — no third-party cloud, no shared telemetry.

Forked from [Task Deck](https://github.com/ismailivanov/task-deck) and refocused on Nextcloud as the sync backend.

## Features

- Kanban lists with drag-and-drop ordering
- Unlimited boards
- Each board stores cards as Markdown notes in its own folder
- Inline card creation and renaming
- Global colored labels, start and due dates with a compact date picker
- Card details rendered as Markdown; checklist progress on cards
- Picks up Markdown cards you create outside the board
- **Two-way Nextcloud Deck sync** with field-level conflict resolution
- **Attachment sync** (opt-in, experimental) — files live inside Nextcloud, not any third-party storage
- Sync log viewer with copy-to-clipboard diagnostics
- App Password stored encrypted (AES-GCM 256 + PBKDF2-SHA256); plaintext never touches disk

## Install

### With BRAT (recommended for pre-releases)

1. Install the community plugin [Obsidian BRAT](https://github.com/TfTHacker/obsidian42-brat).
2. In BRAT settings, **Add beta plugin**: `onlymykazari/obsidian-nextcloud-deck`.
3. Optionally pin a version (e.g. `0.5.0-pre.3`).
4. Enable **NextDeck** in *Community plugins*.

### Manual

Download `main.js`, `manifest.json`, and `styles.css` from a [release](https://github.com/onlymykazari/obsidian-nextcloud-deck/releases) and place them here:

```
Your Vault/.obsidian/plugins/obsidian-nextcloud-deck/
```

Then enable **NextDeck** from *Community plugins*.

## Usage

### Local kanban

- Run `Open board` from the command palette (or click the ribbon icon).
- Create a board with the name you want.
- Switch between boards from the board picker or the boards screen.
- Use `Add list` and `Add card`, then type inline.
- Click a card to edit labels, details, dates, and checklist items.
- `Open note` opens the underlying Markdown file.
- Drag cards between lists; drag list headers to reorder columns.

If you create a Markdown card directly inside a board folder, the plugin picks it up and shows it on that board.

### Sync with Nextcloud

1. Open **Settings → NextDeck → Nextcloud sync**.
2. Enter your Nextcloud server URL (e.g. `https://cloud.example.com`).
3. Click **Sign in with browser** — a Login Flow v2 session opens, and the App Password is returned automatically after you approve it. If your environment blocks the browser flow, use **Paste App Password** instead (generate one at *Nextcloud → Settings → Security → Devices & sessions*).
4. **Test connection** confirms the credentials work.
5. Pick a **Sync interval** (30 s / 1 m / 5 m / 15 m / manual) and a **Conflict resolution** policy (see below).
6. Press **Sync now** — the plugin pulls remote boards, materialises `Nextcloud Deck/<board>/` folders in your vault, pushes any local edits, and reaps deletions.

Every card change you make in Obsidian is marked "dirty" and pushed to Deck on the next sync tick. Boards, lists, and cards you create on Deck (from the web UI or the mobile app) flow into Obsidian on the same tick.

### Commands

Available from the command palette:

- **Open board**
- **Add card to first list**
- **Sync with Nextcloud Deck**
- **View Nextcloud sync log**

### Conflict resolution

When both Obsidian and Nextcloud edit the same field of the same card, the plugin runs a field-level 3-way diff against the last-synced baseline and then applies your policy:

- **prompt** (default) — pops the `ConflictModal` per card so you can pick Keep local / Use Nextcloud per field. Cancelling the modal skips the push and preserves the local edit.
- **local** — always keep the Obsidian version.
- **remote** — always keep the Nextcloud version.
- **newer-wins** — compare `lastModified` timestamps and keep whichever changed more recently.

Fields the plugin considers for conflicts: `title`, `description` (details), `completed`, `dueDate`, `startDate`. Labels are treated as replace-remote-with-local when the card is local-dirty; assignees are hidden from the UI in this release but preserved in `data.json` for a future team-mode.

### Attachment sync (experimental)

Attachments are **off by default** and toggle-controlled: **Settings → Nextcloud sync → Sync attachments (experimental)**.

- Files live at `<boardFolder>/attachments/<cardId>/<filename>` in your vault.
- Uploads use Deck's `type=deck_file` attachment API — the bytes are stored on your Nextcloud instance's storage backend (local disk, S3, Swift, whatever the admin configured). No third-party is involved.
- The plugin uploads any file you drop into `attachments/<cardId>/` that isn't tracked yet.
- Files removed on Nextcloud are removed locally; files removed locally are enqueued for deletion on Nextcloud on the next tick.
- Single-request upload only; very large files can be slow. Chunked upload is planned for a later release.

### Sync log & diagnostics

Every sync writes into a ring buffer (last ~200 events). Open it from:

- **Settings → Sync log → View sync log**, or
- Command palette → **View Nextcloud sync log**.

**Copy diagnostics** puts a redacted JSON summary (server URL host only, no App Password, no card contents) on your clipboard — attach it when filing a bug.

## Privacy & security

- **Credentials**: App Passwords are encrypted with AES-GCM 256 using a PBKDF2-SHA256 key derived from a per-vault passphrase stored in `localStorage`. Ciphertext lives in `data.json`; the plaintext password only ever exists in memory while the plugin is loaded.
- **Sign-out** revokes the App Password on the server via `DELETE /ocs/v2.php/core/apppassword`, then clears the local ciphertext.
- **Network**: all Nextcloud traffic goes through Obsidian's `requestUrl`, which uses the Electron / mobile HTTP stack — no browser CORS restrictions, no third-party proxy.
- **No telemetry**: the plugin does not phone home. All traffic is between your Obsidian instance and your Nextcloud server.
- **Vault contents**: nothing outside the boards you sync is transmitted. Cards without a remote binding stay local-only.

## Compatibility

- Obsidian ≥ 1.5.0 (desktop + mobile).
- Nextcloud ≥ 25 recommended.
- Nextcloud Deck ≥ 1.9 recommended (older builds usually work but may miss some attachment features).
- HTTPS with a trusted certificate strongly recommended for private servers; iOS in particular refuses self-signed certificates.

## Development

Source files live in `src/`. After changing them, run:

```bash
node build.js
```

Obsidian loads the generated `main.js`.

### Local mock server

For end-to-end sync development without a Nextcloud instance:

```bash
node scripts/mock-nextcloud.js
```

The mock implements Login Flow v2, OCS whoami / apppassword revoke, and the Deck v1.0 board/stack/card/label/ACL endpoints. See `scripts/README-mock.md` for env vars and a curl cookbook. Attachments are **not** mocked — test M4 against a real Deck server.

### Unit tests

Pure sync helpers are covered by Node's built-in `assert`:

```bash
node scripts/test-sync-units.js
```

## Credits

- Upstream Kanban implementation by [Ismail Ivanov (Task Deck)](https://github.com/ismailivanov/task-deck) — MIT licensed.
- Nextcloud Deck backend by the Nextcloud community — [nextcloud/deck](https://github.com/nextcloud/deck).

## License

[MIT](LICENSE)
