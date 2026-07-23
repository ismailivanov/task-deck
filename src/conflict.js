// Pure field-level 3-way merge for Nextcloud Deck sync.
//
// The sync manager pulls fresh remote state before every push. This module
// looks at three snapshots — the last-synced baseline, the current local card,
// and the current remote card — and decides which fields can be applied
// automatically and which need a human decision.
//
// Design goals (see docs/plan §5):
//   - No dependency on Obsidian; unit-testable with node's assert module.
//   - Conservative: whenever a field is ambiguous, mark it a conflict and let
//     the caller apply the configured policy (`prompt` / `local` / `remote` /
//     `newer-wins`).
//   - Fields we cannot 3-way-merge cheaply (labels/assignees) degrade to
//     "local wins" with a sync log entry so the user sees the coarseness.

const FIELDS = ["title", "details", "completed", "dueDate", "startDate"];

/**
 * Compare two primitive-ish values with a tolerance for null/undefined/empty.
 * Booleans and numbers use strict equality; strings are trimmed then compared.
 */
function fieldEquals(a, b) {
  const na = a == null ? "" : a;
  const nb = b == null ? "" : b;
  if (typeof na === "boolean" || typeof nb === "boolean") return !!na === !!nb;
  if (typeof na === "number" || typeof nb === "number") return Number(na || 0) === Number(nb || 0);
  return String(na).trim() === String(nb).trim();
}

/**
 * Given three snapshots, return per-field decisions:
 *   {
 *     autoApplied: { [field]: value }        // fields the caller should copy in unattended,
 *     conflicts:   [{ field, base, local, remote }]  // fields needing user policy input,
 *     unchanged:   [field]                    // no-op fields for logging,
 *   }
 *
 * `baseline` may be null (first-ever push of a card): in that case anything the
 * remote already has wins (this only happens if the card was created on both
 * sides with a name collision — vanishingly rare).
 */
function detectFieldConflicts(baseline, local, remote) {
  const autoApplied = {};
  const conflicts = [];
  const unchanged = [];

  for (const field of FIELDS) {
    const localValue = local ? local[field] : undefined;
    const remoteValue = remote ? remote[field] : undefined;
    const baseValue = baseline ? baseline[field] : undefined;

    if (fieldEquals(localValue, remoteValue)) {
      unchanged.push(field);
      continue;
    }

    const localChanged = !fieldEquals(localValue, baseValue);
    const remoteChanged = !fieldEquals(remoteValue, baseValue);

    if (!localChanged && remoteChanged) {
      autoApplied[field] = remoteValue;
    } else if (localChanged && !remoteChanged) {
      autoApplied[field] = localValue;
    } else {
      // Both sides changed relative to the baseline (or baseline unknown +
      // sides disagree). This is the case we surface to conflict policy.
      conflicts.push({ field, base: baseValue, local: localValue, remote: remoteValue });
    }
  }

  return { autoApplied, conflicts, unchanged };
}

/**
 * Apply the configured conflict policy against a conflict list. Returns an
 * object of chosen values per field, plus a list of fields still needing user
 * input (only ever non-empty when policy === "prompt").
 */
function applyPolicy(policy, conflicts, { localUpdatedAt, remoteUpdatedAt } = {}) {
  const resolved = {};
  const stillOpen = [];
  for (const entry of conflicts) {
    switch (policy) {
      case "local":
        resolved[entry.field] = entry.local;
        break;
      case "remote":
        resolved[entry.field] = entry.remote;
        break;
      case "newer-wins": {
        const localWins = Number(localUpdatedAt || 0) >= Number(remoteUpdatedAt || 0);
        resolved[entry.field] = localWins ? entry.local : entry.remote;
        break;
      }
      case "prompt":
      default:
        stillOpen.push(entry);
    }
  }
  return { resolved, stillOpen };
}

/**
 * Build a hashable baseline snapshot from a card-like object. Only the fields
 * we can conflict-merge are captured; labels and assignees are recorded as a
 * shallow signature so we can still detect that they moved (without having to
 * store the whole array in data.json).
 */
function snapshotBaseline(card) {
  if (!card) return null;
  return {
    title: card.title || "",
    details: card.details || "",
    completed: !!card.completed,
    dueDate: card.dueDate || "",
    startDate: card.startDate || "",
    labelsSignature: signatureOfLabels(card.labels),
  };
}

function signatureOfLabels(labels) {
  if (!Array.isArray(labels)) return "";
  return labels
    .map((label) => `${String(label.name || "").trim().toLowerCase()}|${String(label.color || "").trim().toLowerCase()}`)
    .sort()
    .join(";");
}

module.exports = {
  FIELDS,
  detectFieldConflicts,
  applyPolicy,
  snapshotBaseline,
  signatureOfLabels,
  fieldEquals,
};
