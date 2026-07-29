# Task Deck

[![Obsidian](https://img.shields.io/badge/Obsidian-1.5%2B-7c3aed?logo=obsidian&logoColor=white)](https://obsidian.md)
[![Release](https://img.shields.io/github/v/release/ismailivanov/task-deck?label=release)](https://github.com/ismailivanov/task-deck/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-f1c40f.svg)](LICENSE)
[![Sync Deck](https://img.shields.io/badge/cloud%20sync-Sync%20Deck-7c3aed.svg)](https://github.com/ismailivanov/sync-deck)
[![Support](https://img.shields.io/badge/support-Buy%20Me%20a%20Coffee-ffdd00.svg)](https://buymeacoffee.com/carbon06)

Task Deck is a focused kanban and table view for Obsidian. Every card stays a real Markdown note in your vault, so your tasks remain searchable, linkable, portable, and editable outside the board.

Use it locally with as many boards as you need, or pair it with [**Sync Deck**](https://github.com/ismailivanov/sync-deck) for cross-device sync, shared vaults, member assignment, and live presence.

![Task Deck board view with To do, Doing, and Done lists](docs/images/task-deck-board.png)

### Card details

![Task Deck card editor with labels, Markdown description, and checklist progress](docs/images/task-deck-card.png)

### Table view

![Task Deck table view with status, dates, and labels](docs/images/task-deck-table.png)

<sub>Screenshots were captured from a clean demo vault using Task Deck 0.3.7.</sub>

## Features

- **Board and table views** for the same set of Markdown-backed tasks.
- **Drag-and-drop workflow** for cards and list ordering.
- **Fast editing** with inline card creation, renaming, quick status changes, and undo while the Task Deck view is active.
- **Rich cards** with colored labels, start and due dates, Markdown descriptions, images, and checklists.
- **Multiple boards** with independent folders, lists, colors, and cards.
- **Normal Obsidian notes** that remain searchable, linkable, visible in graph view, and editable from the file explorer.
- **Automatic note discovery** for compatible Markdown cards created or edited outside Task Deck.
- **Optional collaboration** through [Sync Deck](https://github.com/ismailivanov/sync-deck), including shared boards, member assignment, and live presence.

## Quick start

1. Open **Task Deck** from the ribbon or run `Task Deck: Open board` from the command palette.
2. Create a board. New boards start with **To do**, **Doing**, and **Done** lists.
3. Add cards inline, then drag them between lists as work moves forward.
4. Open a card to add labels, dates, a Markdown description, images, and checklist items.
5. Switch to **Table** when you want a compact overview across every list.

Use **Open note** in the card editor whenever you want to work directly in the underlying Markdown file.

## Markdown storage

Each board lives in its own readable folder:

```text
Product Launch/
├── Product Launch.md
├── cards/
│   ├── Prepare onboarding checklist.md
│   └── Write launch announcement.md
└── attachments/
```

The board index keeps list order and graph links connected. Card metadata lives in frontmatter, while the description and checklist remain ordinary Markdown. The plugin folder stores the local UI state; your task content stays in the vault.

## Sync across devices and teams

Task Deck works fully offline and does not require an account. To sync boards, install [**Sync Deck**](https://github.com/ismailivanov/sync-deck), sign in, and open or create a synced vault.

Sync Deck carries the board index, cards, and attachments across your devices. New and upgraded Sync Deck vaults end-to-end encrypt those files, their paths, and the board/card identifiers used for presence and locks; account and activity metadata still remain visible to the service. In shared vaults it also provides member assignment and live presence, so teammates can see who is viewing or editing a card. See Sync Deck's [E2EE threat model](https://github.com/ismailivanov/sync-deck/blob/main/docs/E2EE.md) for the exact boundary. The Free plan syncs one Task Deck board; Pro syncs unlimited boards. Local-only Task Deck usage remains unlimited.

## Install

Until Task Deck is available in the Obsidian community plugin directory:

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/ismailivanov/task-deck/releases/latest).
2. Put the files in:

```text
Your Vault/.obsidian/plugins/task-deck/
```

3. Enable **Task Deck** in Obsidian under **Settings → Community plugins**.

## Development

Source files live in `src/`. After changing them, run:

```bash
node build.js
```

Obsidian loads the generated `main.js` file.

## Support

If Task Deck is useful for your workflow, you can support the project: [Buy me a coffee](https://buymeacoffee.com/carbon06).

## License

[MIT](LICENSE) © Ismail Ivanov
