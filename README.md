# Task Deck

[![Obsidian](https://img.shields.io/badge/Obsidian-1.5%2B-7c3aed?logo=obsidian&logoColor=white)](https://obsidian.md)
[![License: MIT](https://img.shields.io/badge/License-MIT-f1c40f.svg)](LICENSE)
[![Support](https://img.shields.io/badge/support-Buy%20Me%20a%20Coffee-ffdd00.svg)](https://buymeacoffee.com/carbon06)

Task Deck is a small kanban board for Obsidian. It keeps the board simple, but every card is still a real Markdown note in your vault — with optional two-way sync against a self-hosted [Nextcloud Deck](https://github.com/nextcloud/deck) instance, so you keep full control of your data on your own server.

<img width="1512" height="982" alt="image" src="https://github.com/user-attachments/assets/6bfa709d-2cf8-4900-a274-9e95927541b4" />

<img width="1512" height="982" alt="image" src="https://github.com/user-attachments/assets/bf7a2472-60bd-4ce4-81da-d30f92c2bc57" />

<img width="1512" height="982" alt="image" src="https://github.com/user-attachments/assets/90bdd068-7040-4367-bfa0-58ef921b24bc" />

## Features

- Kanban lists with drag-and-drop ordering
- As many boards as you want (unlimited on its own)
- Each board stores cards as Markdown notes in its own board folder
- Inline card creation and renaming
- Global colored labels
- Start and due dates with a compact date picker
- Checklist progress on cards, with an optional Trello-style itemized view directly on the card front
- Card details rendered as Markdown
- Picks up Markdown cards you create outside the board
- **Two-way Nextcloud Deck sync** with field-level conflict resolution
- **Attachment sync** (opt-in, experimental) — files live inside Nextcloud, not any third-party storage
- Sync log viewer with copy-to-clipboard diagnostics
- App Password stored encrypted (AES-GCM 256 + PBKDF2-SHA256); plaintext never touches disk

## Usage

- Run `Open board` from the command palette.
- Create a board with the name you want to use.
- Switch between boards from the board picker or the boards screen.
- Use `Add list` to create a new list.
- Use `Add card` under a list, then type the card name inline.
- Click a card to edit labels, details, dates, and checklist items.
- Use `Open note` when you want to work with the card as a normal Markdown file.
- Drag cards between lists and drag list headers to reorder columns.

If you create a Markdown card directly inside a board folder, Task Deck will pick it up and show it on that board.

## Sync with Nextcloud

1. Open **Settings → Task Deck → Nextcloud sync**.
2. Enter your Nextcloud server URL (e.g. `https://cloud.example.com`).
3. Click **Sign in with browser** — a Login Flow v2 session opens, and the App Password is returned automatically after you approve it. If your environment blocks the browser flow, use **Paste App Password** instead (generate one at *Nextcloud → Settings → Security → Devices & sessions*).
4. **Test connection** confirms the credentials work.
5. Turn on **Automatic sync** and pick an interval, or leave it off and use **Sync now** / the **Sync with Nextcloud Deck** command whenever you want.
6. Pick a **Conflict resolution** policy (see below).

Every card change you make in Obsidian is marked "dirty" and pushed to Deck on the next sync. Boards, lists, and cards you create on Deck (from the web UI or the mobile app) flow into Obsidian the same way.

### Commands

Available from the command palette:

- **Open board**
- **Add card to first list**
- **Sync with Nextcloud Deck**
- **View Nextcloud sync log**

### Conflict resolution

When both Obsidian and Nextcloud edit the same field of the same card, the plugin runs a field-level 3-way diff against the last-synced baseline and then applies your policy:

- **prompt** (default) — pops up a modal per card so you can pick Keep local / Use Nextcloud per field. Cancelling the modal skips the push and preserves the local edit.
- **local** — always keep the Obsidian version.
- **remote** — always keep the Nextcloud version.
- **newer-wins** — compare `lastModified` timestamps and keep whichever changed more recently.

Fields the plugin considers for conflicts: `title`, `description` (details), `completed`, `dueDate`, `startDate`. Labels are treated as replace-remote-with-local when the card is local-dirty.

### Attachment sync (experimental)

Attachments are **off by default** and toggle-controlled: **Settings → Nextcloud sync → Sync attachments (experimental)**.

- Files live at `<boardFolder>/attachments/<cardId>/<filename>` in your vault.
- Uploads use Deck's `type=deck_file` attachment API — the bytes are stored on your Nextcloud instance's storage backend. No third-party is involved.
- The plugin uploads any file you drop into `attachments/<cardId>/` that isn't tracked yet.
- Files removed on Nextcloud are removed locally; files removed locally are enqueued for deletion on Nextcloud on the next tick.

### Sync log & diagnostics

Every sync writes into a ring buffer (last ~200 events). Open it from **Settings → Nextcloud sync → View sync log**, or the **View Nextcloud sync log** command. **Copy diagnostics** puts a redacted JSON summary (server URL host only, no App Password, no card contents) on your clipboard — attach it when filing a bug.

## Privacy & security

- **Credentials**: App Passwords are encrypted with AES-GCM 256 using a PBKDF2-SHA256 key derived from a per-vault passphrase. Ciphertext lives in `data.json`; the plaintext password only ever exists in memory while the plugin is loaded.
- **Sign-out** revokes the App Password on the server, then clears the local ciphertext.
- **Network**: all Nextcloud traffic goes through Obsidian's `requestUrl` — no third-party proxy.
- **No telemetry**: the plugin does not phone home. All traffic is between your Obsidian instance and your Nextcloud server.
- **Vault contents**: nothing outside the boards you sync is transmitted. Cards without a remote binding stay local-only.

## Compatibility

- Obsidian ≥ 1.5.0 (desktop + mobile).
- Nextcloud ≥ 25 recommended.
- Nextcloud Deck ≥ 1.9 recommended (older builds usually work but may miss some attachment features).
- HTTPS with a trusted certificate strongly recommended for private servers; iOS in particular refuses self-signed certificates.

## Install

Download the release files and place them here:

```text
Your Vault/.obsidian/plugins/task-deck/
```

Then enable **Task Deck** from Obsidian's *Community plugins* settings.

## Development

Source files live in `src/`. After changing them, run:

```bash
node build.js
```

Obsidian loads the generated `main.js` file.

### Local mock server

For end-to-end sync development without a real Nextcloud instance:

```bash
node scripts/mock-nextcloud.js
```

The mock implements Login Flow v2, OCS whoami / apppassword revoke, and the Deck v1.0 board/stack/card/label/ACL endpoints. See `scripts/README-mock.md` for env vars and a curl cookbook. Attachments are not mocked — test against a real Deck server.

### Unit tests

Pure sync helpers are covered by Node's built-in `assert`:

```bash
node scripts/test-sync-units.js
```

## Credits

- Kanban implementation by [Ismail Ivanov](https://github.com/ismailivanov/task-deck) — MIT licensed.
- Nextcloud Deck sync engine adapted from [onlymykazari/obsidian-nextcloud-deck](https://github.com/onlymykazari/obsidian-nextcloud-deck) ("NextDeck") — MIT licensed.
- Nextcloud Deck backend by the Nextcloud community — [nextcloud/deck](https://github.com/nextcloud/deck).

## Support

If Task Deck is useful for your workflow, you can support the project: [Buy me a coffee](https://buymeacoffee.com/carbon06).

## License

[MIT](LICENSE) © Ismail Ivanov
