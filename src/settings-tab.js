const { Notice, PluginSettingTab, Setting } = require("obsidian");

// Settings tab for board access, sync, preferences, support, and version info.
const { DONATION_URL } = require("./helpers");

/**
 * Obsidian settings tab for Task Deck.
 */
class TaskDeckSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.addClass("ot-settings");

    containerEl.createEl("h2", { text: "Task Deck" });
    containerEl.createEl("p", {
      text: "Trello-style boards backed by Markdown card notes — with a table view, labels, dates, checklists, and per-card members.",
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
      .setName("Completion sound")
      .setDesc("Play a short sound when a card is marked complete.")
      .addToggle((toggle) => toggle
        .setValue(this.plugin.data.completionSound !== false)
        .onChange(async (value) => {
          this.plugin.data.completionSound = value;
          await this.plugin.savePluginData();
        }));

    // ---- Sync & collaboration ----
    new Setting(containerEl).setName("Sync & collaboration").setHeading();

    const hasSyncDeck = !!this.plugin.getSyncDeckPlugin();
    new Setting(containerEl)
      .setName("Sync Deck")
      .setDesc(hasSyncDeck
        ? "Installed. Your boards sync across devices and teammates in real time, with live presence and per-card members."
        : "Install Sync Deck to sync boards across your devices, collaborate live with presence, and assign members to cards.")
      .addButton((button) => button
        .setButtonText(hasSyncDeck ? "Open Sync Deck" : "Get Sync Deck")
        .setCta()
        .onClick(() => this.plugin.openSyncDeck()));

    new Setting(containerEl)
      .setName("Re-import card notes")
      .setDesc("Pull in Markdown cards added or edited outside the board (inside a board folder).")
      .addButton((button) => button
        .setButtonText("Sync now")
        .onClick(async () => {
          await this.plugin.syncCardsFromFolder();
          this.plugin.refreshViews();
          new Notice("Task Deck synced.");
        }));

    // ---- About ----
    new Setting(containerEl).setName("About").setHeading();

    new Setting(containerEl)
      .setName("Support development")
      .setDesc("If Task Deck is useful, you can support it here.")
      .addButton((button) => button.setButtonText("Donate").onClick(() => window.open(DONATION_URL, "_blank")));

    new Setting(containerEl)
      .setName("Version")
      .setDesc(this.plugin.manifest.version || "");
  }
}

module.exports = { TaskDeckSettingTab };
