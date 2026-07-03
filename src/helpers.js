const { setIcon } = require("obsidian");

// Shared constants plus small pure helpers for dates, labels, Markdown, and DOM controls.
const VIEW_TYPE = "task-deck-view";
const CARD_FOLDER = "Kanban Cards";
const BOARD_INDEX_FILE = "Task Deck Board.md";
const TASK_DECK_ICON = "task-deck";
const TASK_DECK_ICON_SVG = `
  <g fill="none" stroke="currentColor" stroke-width="7" stroke-linecap="round" stroke-linejoin="round">
    <rect x="14" y="16" width="20" height="68" rx="6" />
    <rect x="40" y="16" width="20" height="52" rx="6" />
    <rect x="66" y="16" width="20" height="38" rx="6" />
    <path d="M21 31h6" />
    <path d="M47 31h6" />
    <path d="M73 31h6" />
  </g>
`;
const LIST_DRAG_TYPE = "application/x-task-deck-list";
const DONATION_URL = "https://buymeacoffee.com/carbon06";
const DEFAULT_LABEL_COLOR = "#2f6fd6";
const LABEL_COLORS = [
  "#1f6f4a", "#8a6f00", "#a64b00", "#8b2a24", "#6f338f",
  "#247b55", "#9a7600", "#b85f00", "#be332b", "#8a3db0",
  "#54c99b", "#e5bd12", "#ffa51a", "#f46b66", "#c878ee",
  "#1b4078", "#1f7082", "#426226", "#67264f", "#5d6369",
  "#2465c7", "#2b7c8e", "#4f7822", "#a33e78", "#73787f",
  "#68a0ee", "#70c1d8", "#96c949", "#dc6ab5", "#a3a6aa",
];

/**
 * Minimal saved-data shape used when the plugin starts with no existing board.
 *
 * Cards are stored in a top-level map and lists keep card ids. This makes
 * moving cards between lists cheap while still letting each card have one
 * Markdown file on disk.
 */
const DEFAULT_DATA = {
  version: 1,
  activeBoardId: "default",
  boards: [
    {
      id: "default",
      name: "Task Deck",
      lists: [],
    },
  ],
  cards: {},
  labels: [],
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function uid(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function textLine(value) {
  return String(value || "").replace(/\r?\n/g, " ").trim();
}

/**
 * Accepts only the storage format used in card frontmatter: YYYY-MM-DD.
 */
function cleanDate(value) {
  const date = textLine(value);
  return /^\d{4}-\d{2}-\d{2}$/.test(date) ? date : "";
}

function dateFromISO(value) {
  const date = cleanDate(value);
  if (!date) return null;

  const [year, month, day] = date.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function isoFromDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function addMonths(date, amount) {
  return new Date(date.getFullYear(), date.getMonth() + amount, 1);
}

function shortDateLabel(value) {
  const date = dateFromISO(value);
  if (!date) return "";

  return new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" })
    .format(date)
    .replace(/\.$/, "");
}

function fieldDateLabel(value) {
  const date = dateFromISO(value);
  if (!date) return "D.M.YYYY";

  const day = String(date.getDate()).padStart(2, "0");
  const month = String(date.getMonth() + 1).padStart(2, "0");
  return `${day}.${month}.${date.getFullYear()}`;
}

function dateRangeLabel(startDate, dueDate) {
  const start = cleanDate(startDate);
  const due = cleanDate(dueDate);
  if (start && due && start !== due) return `${shortDateLabel(start)} - ${shortDateLabel(due)}`;
  return shortDateLabel(due || start);
}

function parseBoolean(value) {
  const normalized = textLine(value).toLowerCase();
  return ["true", "yes", "1", "x", "done"].includes(normalized);
}

function labelKey(label) {
  return textLine(typeof label === "string" ? label : label && label.name).toLowerCase();
}

function cleanLabelName(label) {
  const name = textLine(typeof label === "string" ? label : label && label.name);
  if (name === "---" || /^(kanban-card-id|kanban-board-id|kanban-list-id|completed|start|due):/i.test(name)) return "";
  return name;
}

/**
 * Builds a readable vault-safe card filename from a title.
 */
function cardFileBaseName(value) {
  const name = textLine(value || "Card")
    .replace(/[\\/:*?"<>|#^[\]]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/^\.+|\.+$/g, "")
    .trim()
    .slice(0, 80);

  return name || "Card";
}

function createElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function hasDragType(event, type) {
  const types = event.dataTransfer && event.dataTransfer.types;
  return !!types && (Array.from(types).includes(type) || (types.contains && types.contains(type)));
}

function iconButton(icon, label, onClick) {
  const button = createElement("button", "ot-icon-button");
  button.type = "button";
  button.title = label;
  button.setAttribute("aria-label", label);
  try {
    setIcon(button, icon);
  } catch (error) {
    button.textContent = label;
  }
  button.addEventListener("click", onClick);
  return button;
}

function textButton(icon, label, onClick) {
  const button = createElement("button", "ot-text-button");
  button.type = "button";

  const iconSlot = createElement("span", "ot-button-icon");
  try {
    setIcon(iconSlot, icon);
  } catch (error) {
    iconSlot.textContent = "+";
  }

  button.append(iconSlot, createElement("span", "", label));
  button.addEventListener("click", onClick);
  return button;
}

/**
 * Reads a second-level Markdown section body, stopping before the next H2.
 */
function getSection(markdown, heading) {
  const marker = `## ${heading}`;
  const start = markdown.indexOf(marker);
  if (start === -1) return "";

  const body = markdown.slice(start + marker.length);
  const nextHeading = body.search(/\n## /);
  return (nextHeading === -1 ? body : body.slice(0, nextHeading)).trim();
}

function getSectionAny(markdown, headings) {
  for (const heading of headings) {
    const section = getSection(markdown, heading);
    if (section) return section;
  }
  return "";
}

/**
 * Converts Markdown checklist lines into the card checklist model.
 *
 * Non-checkbox lines are kept as unchecked items so notes written by hand do
 * not silently lose useful text.
 */
function parseChecklist(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(?:-\s*)?\[([ xX])\]\s*(.*)$/);
      if (!match) {
        return { done: false, text: line.replace(/^- /, "").trim() };
      }

      return {
        done: match[1].toLowerCase() === "x",
        text: match[2].trim(),
      };
    })
    .filter((item) => item.text);
}

function checklistToText(items) {
  return (items || [])
    .map((item) => `[${item.done ? "x" : " "}] ${item.text}`)
    .join("\n");
}

function checklistToMarkdown(items) {
  return (items || [])
    .map((item) => `- [${item.done ? "x" : " "}] ${textLine(item.text)}`)
    .join("\n");
}

function checklistStats(items) {
  const total = (items || []).length;
  const done = (items || []).filter((item) => item.done).length;
  return {
    done,
    total,
    percent: total ? Math.round((done / total) * 100) : 0,
  };
}

/**
 * Reads the compact label frontmatter format: "Name|#color, Name 2|#color".
 */
function parseLabels(raw) {
  return String(raw || "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const [name, color] = part.split("|").map((item) => item.trim());
      return { name, color: color || "#d43c35" };
    })
    .filter((label) => label.name);
}

/**
 * Writes labels back to the same compact frontmatter format parseLabels reads.
 */
function labelsToFrontmatter(labels) {
  return (labels || [])
    .map((label) => `${textLine(label.name)}|${textLine(label.color || "#d43c35")}`)
    .join(", ");
}

function frontmatterValue(markdown, key) {
  const match = markdown.match(new RegExp(`^${key}:[ \\t]*(.*)$`, "m"));
  return match ? textLine(match[1]) : null;
}

/**
 * Parses a Task Deck card note into the in-memory card fields.
 *
 * The parser is intentionally forgiving because users may edit these files by
 * hand. Missing frontmatter fields return empty strings or nulls so callers can
 * keep existing saved values when appropriate.
 */
function parseCardMarkdown(markdown) {
  const titleMatch = markdown.match(/^#\s+(.+)$/m);
  const labels = frontmatterValue(markdown, "labels");
  const completed = frontmatterValue(markdown, "completed");
  const start = frontmatterValue(markdown, "start");
  const due = frontmatterValue(markdown, "due");

  return {
    id: frontmatterValue(markdown, "kanban-card-id") || "",
    boardId: frontmatterValue(markdown, "kanban-board-id") || "",
    listId: frontmatterValue(markdown, "kanban-list-id") || "",
    title: titleMatch ? titleMatch[1].trim() : "",
    labels: labels !== null ? parseLabels(labels) : [],
    completed: completed !== null ? parseBoolean(completed) : null,
    startDate: start !== null ? cleanDate(start) : null,
    dueDate: due !== null ? cleanDate(due) : null,
    details: getSectionAny(markdown, ["Details", "Detaylar"]),
    checklist: parseChecklist(getSectionAny(markdown, ["Checklist", "Yapılacaklar", "Kontrol listesi"])),
  };
}

module.exports = {
  VIEW_TYPE,
  CARD_FOLDER,
  BOARD_INDEX_FILE,
  TASK_DECK_ICON,
  TASK_DECK_ICON_SVG,
  LIST_DRAG_TYPE,
  DONATION_URL,
  DEFAULT_LABEL_COLOR,
  LABEL_COLORS,
  DEFAULT_DATA,
  clone,
  uid,
  textLine,
  cleanDate,
  dateFromISO,
  isoFromDate,
  addMonths,
  shortDateLabel,
  fieldDateLabel,
  dateRangeLabel,
  parseBoolean,
  labelKey,
  cleanLabelName,
  cardFileBaseName,
  createElement,
  hasDragType,
  iconButton,
  textButton,
  getSection,
  getSectionAny,
  parseChecklist,
  checklistToText,
  checklistToMarkdown,
  checklistStats,
  parseLabels,
  labelsToFrontmatter,
  parseCardMarkdown,
};
