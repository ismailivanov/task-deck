const { Notice, PluginSettingTab, Setting } = require("obsidian");

// Settings tab for board access, card-note sync, support, and version info.
const { DONATION_URL, RELAY_URL } = require("./helpers");

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
      text: "A Trello-style task board for Obsidian with Markdown-backed cards, global labels, dates, and checklists.",
    });

    new Setting(containerEl)
      .setName("Board folders")
      .setDesc("Each board stores its Markdown cards in a folder named after that board.");

    new Setting(containerEl)
      .setName("Open board")
      .setDesc("Open the Task Deck board view.")
      .addButton((button) => {
        button
          .setButtonText("Open")
          .setCta()
          .onClick(() => this.plugin.activateView());
      });

    new Setting(containerEl)
      .setName("Sync card notes")
      .setDesc("Import Markdown cards created outside the board inside the card folder.")
      .addButton((button) => {
        button
          .setButtonText("Sync now")
          .onClick(async () => {
            await this.plugin.syncCardsFromFolder();
            this.plugin.refreshViews();
            new Notice("Task Deck synced.");
          });
      });

    new Setting(containerEl)
      .setName("Realtime collaboration")
      .setDesc("Use Relay by sharing the Task Deck board folders you want to collaborate on.")
      .addButton((button) => {
        button
          .setButtonText("Open Relay")
          .onClick(() => window.open(RELAY_URL, "_blank"));
      });

    new Setting(containerEl)
      .setName("Completion sound")
      .setDesc("Play a short sound when a card is marked complete.")
      .addToggle((toggle) => {
        toggle
          .setValue(this.plugin.data.completionSound !== false)
          .onChange(async (value) => {
            this.plugin.data.completionSound = value;
            await this.plugin.savePluginData();
          });
      });

    new Setting(containerEl)
      .setName("Support development")
      .setDesc("Open the donation page.")
      .addButton((button) => {
        button
          .setButtonText("Donate")
          .onClick(() => window.open(DONATION_URL, "_blank"));
      });

    new Setting(containerEl)
      .setName("Version")
      .setDesc(this.plugin.manifest.version || "0.1.9");
  }
}

module.exports = { TaskDeckSettingTab };
