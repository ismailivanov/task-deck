const { Notice, PluginSettingTab, Setting } = require("obsidian");

// Settings tab for board access, preferences, Nextcloud Deck sync, support, and
// version info.
const { DONATION_URL } = require("./helpers");
const {
  normalizeServerUrl,
  startLoginFlow,
  pollLoginFlow,
  testConnection,
} = require("./nextcloud-auth");
const { SyncLogModal } = require("./sync-log-modal");

const CONFLICT_OPTIONS = [
  { value: "prompt", label: "Ask me (recommended)" },
  { value: "local", label: "Keep local changes" },
  { value: "remote", label: "Keep remote (Nextcloud) changes" },
  { value: "newer-wins", label: "Keep whichever is newer" },
];

/**
 * Obsidian settings tab for Task Deck.
 */
class TaskDeckSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
    // Live scratchpads for the Login Flow UI — kept on the tab instance so the
    // "Sign in with browser" button can cancel an in-flight poll from a second
    // click without losing the abort controller.
    this.pendingLoginController = null;
    this.pendingLoginTimer = null;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("ot-settings");

    containerEl.createEl("h2", { text: "Task Deck" });
    containerEl.createEl("p", {
      text: "Trello-style boards backed by Markdown card notes — with a table view, labels, dates, checklists, and optional two-way Nextcloud Deck sync.",
    });

    // ---- Board ----
    new Setting(containerEl).setName("Board").setHeading();

    new Setting(containerEl)
      .setName("Open Task Deck")
      .setDesc("Open the board / table view.")
      .addButton((button) => button.setButtonText("Open").setCta().onClick(() => this.plugin.activateView()));

    new Setting(containerEl)
      .setName("Start new boards with To do / Doing / Done")
      .setDesc("New boards come with three ready-made lists (grey, blue, green). Turn off to start empty.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.data.seedDefaultLists !== false)
        .onChange(async (value) => {
          this.plugin.data.seedDefaultLists = value;
          await this.plugin.savePluginData();
        }));

    new Setting(containerEl)
      .setName("Compact labels")
      .setDesc("Show labels as small colour bars on cards instead of full pills.")
      .addToggle((toggle) => toggle
        .setValue(!!this.plugin.data.compactLabels)
        .onChange(async (value) => {
          this.plugin.data.compactLabels = value;
          await this.plugin.savePluginData();
          this.plugin.refreshViews();
        }));

    new Setting(containerEl)
      .setName("Show checklist on cards")
      .setDesc("Show each checklist item on the card front, Trello-style, so you can check them off without opening the card.")
      .addToggle((toggle) => toggle
        .setValue(!!this.plugin.data.showChecklistOnCards)
        .onChange(async () => {
          await this.plugin.toggleShowChecklistOnCards();
        }));

    new Setting(containerEl)
      .setName("Board folders")
      .setDesc("Each board stores its Markdown cards in a folder named after that board. New notes you drop into those folders are picked up automatically, and on the next Nextcloud sync if it's connected.");

    new Setting(containerEl)
      .setName("Completion sound")
      .setDesc("Play a short sound when a card is marked complete.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.data.completionSound !== false)
        .onChange(async (value) => {
          this.plugin.data.completionSound = value;
          await this.plugin.savePluginData();
        }));

    // ---- Nextcloud sync ----
    this.renderNextcloudSection(containerEl);

    // ---- About ----
    new Setting(containerEl).setName("About").setHeading();

    new Setting(containerEl)
      .setName("Support development")
      .setDesc("If Task Deck is useful, you can support it here.")
      .addButton((button) => button.setButtonText("Donate").onClick(() => window.open(DONATION_URL, "_blank")));

    new Setting(containerEl)
      .setName("Debug logging")
      .setDesc("Record verbose diagnostics (file paths, sync payloads, error stacks) to the sync log and the developer console. Leave off unless you're troubleshooting a bug.")
      .addToggle((toggle) => {
        toggle
          .setValue(!!this.plugin.data.debugLogging)
          .onChange(async (value) => {
            this.plugin.data.debugLogging = !!value;
            await this.plugin.savePluginData();
          });
      });

    new Setting(containerEl)
      .setName("Version")
      .setDesc(this.plugin.manifest.version || "");
  }

  hide() {
    // Abandon any in-flight browser login when the settings tab closes so a
    // stale poll can't overwrite fresh state next time the tab opens.
    this.cancelPendingLogin("Settings tab closed.");
  }

  // Nextcloud sync section --------------------------------------------------

  renderNextcloudSection(containerEl) {
    containerEl.createEl("h3", { text: "Nextcloud sync" });

    const nextcloud = this.plugin.data.nextcloud || {};
    const enabled = !!nextcloud.enabled;

    if (enabled) {
      this.renderSignedInState(containerEl, nextcloud);
    } else {
      this.renderSignedOutState(containerEl, nextcloud);
    }

    this.renderSyncPreferences(containerEl, nextcloud);
  }

  renderSignedInState(containerEl, nextcloud) {
    const desc = `Signed in as ${nextcloud.username || "(unknown)"} on ${nextcloud.serverUrl || "(no server)"}.`;

    new Setting(containerEl)
      .setName("Connection")
      .setDesc(desc)
      .addButton((button) => {
        button.setButtonText("Test connection").onClick(async () => {
          button.setDisabled(true);
          try {
            const password = await this.plugin.loadNextcloudAppPassword();
            if (!password) {
              new Notice("No stored App Password. Sign in again.");
              return;
            }
            const info = await testConnection(nextcloud.serverUrl, nextcloud.username, password);
            new Notice(`Nextcloud connection OK — ${info.displayName}`);
          } catch (error) {
            new Notice(`Connection failed: ${error.message}`);
          } finally {
            button.setDisabled(false);
          }
        });
      })
      .addButton((button) => {
        button
          .setButtonText("Sign out")
          .setWarning()
          .onClick(async () => {
            const confirmed = window.confirm(
              "Sign out and revoke the App Password on Nextcloud? Local boards and cards are kept.",
            );
            if (!confirmed) return;
            try {
              await this.plugin.signOutNextcloud();
              new Notice("Signed out of Nextcloud.");
            } catch (error) {
              new Notice(`Sign out failed: ${error.message}`);
            }
            this.display();
          });
      });

    // Sync-now + last-sync status. `runNextcloudSync` never rejects; it
    // reports through the sync manager's status object.
    const statusEl = containerEl.createEl("div", { cls: "ot-settings-inline-status" });
    statusEl.setText(this.formatSyncStatus(nextcloud));

    new Setting(containerEl)
      .setName("Sync with Nextcloud")
      .setDesc("Two-way sync: pulls remote changes, pushes local edits, then removes cards deleted locally.")
      .addButton((button) => {
        button
          .setButtonText("Sync now")
          .setCta()
          .onClick(async () => {
            button.setDisabled(true);
            statusEl.setText("Syncing…");
            const result = await this.plugin.runNextcloudSync({ manual: true });
            statusEl.setText(this.formatSyncStatus(this.plugin.data.nextcloud, result));
            button.setDisabled(false);
          });
      });

    // Automatic periodic sync. Off by default — some users prefer manual
    // sync for predictable network use. Minutes-granularity is coarse on
    // purpose: a more aggressive schedule would hammer the Nextcloud
    // instance without meaningful benefit for a task board.
    new Setting(containerEl)
      .setName("Automatic sync")
      .setDesc("Run Sync with Nextcloud in the background on a schedule. Sync is also available from a ribbon icon on the left side.")
      .addToggle((toggle) => {
        toggle
          .setValue(!!nextcloud.autoSyncEnabled)
          .onChange(async (value) => {
            this.plugin.data.nextcloud = Object.assign({}, this.plugin.data.nextcloud, { autoSyncEnabled: value });
            await this.plugin.saveData(this.plugin.data);
            this.plugin.reconfigureAutoSync();
            this.display();
          });
      });

    if (nextcloud.autoSyncEnabled) {
      new Setting(containerEl)
        .setName("Sync interval (minutes)")
        .setDesc("Minimum is 1 minute. Reasonable values: 5-30 for laptops, 60+ for background devices.")
        .addText((text) => {
          text
            .setPlaceholder("15")
            .setValue(String(nextcloud.autoSyncMinutes || 15))
            .onChange(async (raw) => {
              const parsed = Math.max(1, Math.floor(Number(raw) || 15));
              this.plugin.data.nextcloud = Object.assign({}, this.plugin.data.nextcloud, { autoSyncMinutes: parsed });
              await this.plugin.saveData(this.plugin.data);
              this.plugin.reconfigureAutoSync();
            });
        });
    }
  }

  renderSignedOutState(containerEl, nextcloud) {
    // Server URL + login-flow launcher. The URL persists to data.json only
    // AFTER a successful sign-in, but we cache it on the tab so a failed
    // attempt doesn't require re-typing.
    let serverInput = this.draftServerUrl != null ? this.draftServerUrl : (nextcloud.serverUrl || "");
    new Setting(containerEl)
      .setName("Nextcloud server URL")
      .setDesc("Example: https://cloud.example.com")
      .addText((text) => {
        text.setPlaceholder("https://cloud.example.com");
        text.setValue(serverInput);
        text.onChange((value) => {
          this.draftServerUrl = value;
        });
      });

    // Live status line updated by the login flow poller.
    const status = containerEl.createEl("div", { cls: "ot-settings-inline-status" });
    status.setText("Not connected.");
    this.loginStatusEl = status;

    new Setting(containerEl)
      .setName("Sign in with browser")
      .setDesc("Uses Nextcloud Login Flow v2. A browser opens on the server so you can authorise this plugin; the App Password comes back automatically.")
      .addButton((button) => {
        button
          .setButtonText("Sign in with browser")
          .setCta()
          .onClick(() => this.beginBrowserLogin(button, serverInput));
      })
      .addButton((button) => {
        button
          .setButtonText("Cancel")
          .onClick(() => this.cancelPendingLogin("Cancelled by user."));
      });

    // App Password fallback for corporate proxies / users who prefer to paste.
    let manualUsername = "";
    let manualPassword = "";
    new Setting(containerEl)
      .setName("Or paste an App Password")
      .setDesc("Generate one at Nextcloud → Settings → Security → Devices & sessions.");
    new Setting(containerEl)
      .setName("Username")
      .addText((text) => {
        text.setPlaceholder("username");
        text.onChange((value) => { manualUsername = value.trim(); });
      });
    new Setting(containerEl)
      .setName("App Password")
      .addText((text) => {
        text.setPlaceholder("xxxx-xxxx-xxxx-xxxx");
        // Obsidian's TextComponent doesn't support type=password on all
        // versions; we mask via the underlying input element instead.
        try { text.inputEl.type = "password"; } catch (error) { /* older builds */ }
        text.onChange((value) => { manualPassword = value.trim(); });
      })
      .addButton((button) => {
        button
          .setButtonText("Save & test")
          .setCta()
          .onClick(async () => {
            const url = normalizeServerUrl(this.draftServerUrl != null ? this.draftServerUrl : nextcloud.serverUrl);
            if (!url) return new Notice("Enter a Nextcloud server URL first.");
            if (!manualUsername || !manualPassword) return new Notice("Enter both username and App Password.");
            button.setDisabled(true);
            try {
              await testConnection(url, manualUsername, manualPassword);
              await this.plugin.saveNextcloudCredentials({
                serverUrl: url,
                username: manualUsername,
                appPassword: manualPassword,
              });
              new Notice("Nextcloud connected.");
              this.draftServerUrl = undefined;
              this.display();
            } catch (error) {
              new Notice(`Connection failed: ${error.message}`);
            } finally {
              button.setDisabled(false);
            }
          });
      });
  }

  renderSyncPreferences(containerEl, nextcloud) {
    // Vault-relative root folder for every synced board. Made configurable
    // because vaults sometimes have a reserved top-level folder — macOS
    // Notes.app / iCloud sync clients / existing project layouts. Empty
    // means "put boards at the vault root".
    new Setting(containerEl)
      .setName("Board root folder")
      .setDesc('Vault-relative folder that hosts every synced board. Leave empty to place boards at the vault root. Default: "Deck". Changing this only affects newly created / pulled boards; existing boards keep their current path — use "Move existing boards" below to migrate them.')
      .addText((text) => {
        text
          .setPlaceholder("Deck")
          .setValue(String(nextcloud.rootFolder != null ? nextcloud.rootFolder : "Deck"))
          .onChange(async (value) => {
            const cleaned = String(value || "").trim().replace(/^\/+|\/+$/g, "");
            this.plugin.data.nextcloud = Object.assign({}, this.plugin.data.nextcloud, {
              rootFolder: cleaned,
            });
            await this.plugin.saveData(this.plugin.data);
          });
      });

    new Setting(containerEl)
      .setName("Move existing boards")
      .setDesc("Move every synced board (folder, cards, attachments) into the Board root folder above. Cards inside Obsidian and links stay intact.")
      .addButton((button) => {
        button.setButtonText("Move now").onClick(async () => {
          button.setDisabled(true);
          try {
            const moved = await this.plugin.migrateBoardRoots();
            new Notice(moved
              ? `Moved ${moved} board folder${moved === 1 ? "" : "s"} to the new root.`
              : "Nothing to move — every board is already under the current root.");
          } catch (error) {
            new Notice(`Move failed: ${(error && error.message) || error}`);
          } finally {
            button.setDisabled(false);
            this.display();
          }
        });
      });

    new Setting(containerEl)
      .setName("Conflict resolution")
      .setDesc("What to do when both local and remote edited the same field of a card.")
      .addDropdown((dropdown) => {
        CONFLICT_OPTIONS.forEach((option) => dropdown.addOption(option.value, option.label));
        dropdown.setValue(nextcloud.conflictPolicy || "prompt");
        dropdown.onChange(async (value) => {
          this.plugin.data.nextcloud = Object.assign({}, this.plugin.data.nextcloud, {
            conflictPolicy: value,
          });
          await this.plugin.saveData(this.plugin.data);
        });
      });

    new Setting(containerEl)
      .setName("Sync attachments (experimental)")
      .setDesc("Download Deck card attachments into the board folder and upload files you drop into attachments/<cardId>/. Larger files may be slow on mobile.")
      .addToggle((toggle) => {
        toggle
          .setValue(!!nextcloud.attachmentsEnabled)
          .onChange(async (value) => {
            this.plugin.data.nextcloud = Object.assign({}, this.plugin.data.nextcloud, {
              attachmentsEnabled: value,
            });
            await this.plugin.saveData(this.plugin.data);
          });
      });

    new Setting(containerEl)
      .setName("Sync log")
      .setDesc("Inspect the last ~200 sync events. Copy diagnostics to include with bug reports.")
      .addButton((button) => {
        button
          .setButtonText("View sync log")
          .onClick(() => {
            new SyncLogModal(this.app, this.plugin).open();
          });
      });
  }

  formatSyncStatus(nextcloud, override) {
    const status = override || (this.plugin.syncManager && this.plugin.syncManager.getStatus()) || null;
    if (status && status.state === "running") return status.message || "Syncing…";
    if (status && status.state === "error") return `Sync failed: ${status.message}`;
    const last = Number((nextcloud && nextcloud.lastSyncAt) || (status && status.at) || 0);
    if (!last) return "No sync yet.";
    return `Last sync: ${new Date(last).toLocaleString()}`;
  }

  // Login flow orchestration ------------------------------------------------

  async beginBrowserLogin(button, initialServerUrl) {
    this.cancelPendingLogin("Superseded by a new login attempt.");

    const rawUrl = this.draftServerUrl != null ? this.draftServerUrl : initialServerUrl;
    const serverUrl = normalizeServerUrl(rawUrl);
    if (!serverUrl) {
      new Notice("Enter a Nextcloud server URL first.");
      return;
    }

    this.updateLoginStatus("Contacting Nextcloud…");
    button.setDisabled(true);

    let flow;
    try {
      flow = await startLoginFlow(serverUrl);
    } catch (error) {
      this.updateLoginStatus("");
      new Notice(`Login start failed: ${error.message}`);
      button.setDisabled(false);
      return;
    }

    this.updateLoginStatus("Waiting for the browser… complete the login there.");
    try {
      window.open(flow.login, "_blank");
    } catch (error) {
      // window.open can throw inside a mobile / restricted webview; we still
      // return the URL so the status line prompts the user to paste it.
      this.updateLoginStatus(`Open this URL in a browser: ${flow.login}`);
    }

    const controller = new AbortController();
    this.pendingLoginController = controller;

    try {
      const credentials = await pollLoginFlow(flow.poll, { signal: controller.signal });
      await this.plugin.saveNextcloudCredentials({
        serverUrl: credentials.server || flow.serverUrl,
        username: credentials.loginName,
        appPassword: credentials.appPassword,
      });
      new Notice(`Nextcloud connected as ${credentials.loginName}.`);
      this.draftServerUrl = undefined;
      this.display();
    } catch (error) {
      this.updateLoginStatus("");
      if (!controller.signal.aborted) new Notice(`Login failed: ${error.message}`);
    } finally {
      if (this.pendingLoginController === controller) this.pendingLoginController = null;
      button.setDisabled(false);
    }
  }

  cancelPendingLogin(reason) {
    if (this.pendingLoginController) {
      this.pendingLoginController.abort(reason || "Cancelled.");
      this.pendingLoginController = null;
      this.updateLoginStatus("Login cancelled.");
    }
  }

  updateLoginStatus(text) {
    if (this.loginStatusEl) this.loginStatusEl.setText(text || "Not connected.");
  }
}

module.exports = { TaskDeckSettingTab };
