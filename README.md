# Task Deck

[![Obsidian](https://img.shields.io/badge/Obsidian-1.5%2B-7c3aed?logo=obsidian&logoColor=white)](https://obsidian.md)
[![Release](https://img.shields.io/github/v/release/ismailivanov/task-deck?label=release)](https://github.com/ismailivanov/task-deck/releases)
[![License: MIT](https://img.shields.io/badge/License-MIT-f1c40f.svg)](LICENSE)
[![Docs](https://img.shields.io/badge/docs-README-0ea5e9.svg)](README.md)
[![Support](https://img.shields.io/badge/support-Buy%20Me%20a%20Coffee-ffdd00.svg)](https://buymeacoffee.com/carbon06)

Task Deck is a small kanban board for Obsidian. It keeps the board simple, but every card is still a real Markdown note in your vault.

I built it for tracking tasks without leaving Obsidian: lists, cards, labels, dates, and checklists in one view.

<img width="1512" height="982" alt="image" src="https://github.com/user-attachments/assets/6bfa709d-2cf8-4900-a274-9e95927541b4" />

<img width="1512" height="982" alt="image" src="https://github.com/user-attachments/assets/bf7a2472-60bd-4ce4-81da-d30f92c2bc57" />

<img width="1512" height="982" alt="image" src="https://github.com/user-attachments/assets/90bdd068-7040-4367-bfa0-58ef921b24bc" />

## Support

If Task Deck is useful for your workflow, you can support the project here:

https://buymeacoffee.com/carbon06

## Features

- Kanban lists with drag-and-drop ordering
- Cards stored as Markdown notes under `Kanban Cards/`
- Inline card creation and renaming
- Global colored labels
- Start and due dates with a compact date picker
- Checklist progress on cards
- Card details rendered as Markdown
- Automatic sync for cards created outside the board

## Usage

- Run `Open Task Deck` from the command palette.
- Use `Add list` to create a new list.
- Use `Add card` under a list, then type the card name inline.
- Click a card to edit labels, details, dates, and checklist items.
- Use `Open note` when you want to work with the card as a normal Markdown file.
- Drag cards between lists and drag list headers to reorder columns.

If you create a Markdown card directly inside `Kanban Cards/`, Task Deck will pick it up and show it on the board.

## Development

Source files live in `src/`. After changing them, run:

```bash
node build.js
```

Obsidian loads the generated `main.js` file.

## Install

Download the release files and place them here:

```text
Your Vault/.obsidian/plugins/obsidian-tasks-kanban/
```

Then enable **Task Deck** from Obsidian's Community plugins settings.
