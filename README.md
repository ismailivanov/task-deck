# Task Deck

[![Obsidian](https://img.shields.io/badge/Obsidian-1.5%2B-7c3aed?logo=obsidian&logoColor=white)](https://obsidian.md)
[![Release](https://img.shields.io/github/v/release/ismailivanov/task-deck?label=release)](https://github.com/ismailivanov/task-deck/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-f1c40f.svg)](LICENSE)
[![Sync Deck](https://img.shields.io/badge/cloud%20sync-Sync%20Deck-7c3aed.svg)](https://github.com/ismailivanov/sync-deck)
[![Support](https://img.shields.io/badge/support-Buy%20Me%20a%20Coffee-ffdd00.svg)](https://buymeacoffee.com/carbon06)

Task Deck is a small kanban board for Obsidian. It keeps the board simple, but every card is still a real Markdown note in your vault.

I built it for tracking tasks without leaving Obsidian: lists, cards, labels, dates, and checklists in one view. Want it on all your devices, or shared with a team? Pair it with [**Sync Deck**](https://github.com/ismailivanov/sync-deck) for cloud sync and live presence.

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
- Checklist progress on cards
- Card details rendered as Markdown
- Picks up Markdown cards you create outside the board
- Plays nicely with any sync tool — [Sync Deck](https://github.com/ismailivanov/sync-deck) or Relay

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

## Sync across devices and teams

Task Deck stores every board and card as plain Markdown in your vault, so it syncs with whatever you already use — it doesn't run its own sync server.

**With [Sync Deck](https://github.com/ismailivanov/sync-deck) (recommended).** Install both plugins and sign in to Sync Deck. Your boards then sync across your devices and teammates, with **live presence** so you can see who's on which card in real time. There's a **Sync your boards & vaults** button in Task Deck's board view that opens Sync Deck. On the Free plan you can sync one board; Pro syncs unlimited (Task Deck stays unlimited locally either way).

**With [Relay](https://community.obsidian.md/plugins/system3-relay).** Because boards are Markdown files, Relay's folder sharing works too — share a board folder and Task Deck keeps it readable on the other side.

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

## Support

If Task Deck is useful for your workflow, you can support the project: [Buy me a coffee](https://buymeacoffee.com/carbon06).

## License

[MIT](LICENSE) © Ismail Ivanov
