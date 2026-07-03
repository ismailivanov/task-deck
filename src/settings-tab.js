const { Notice, PluginSettingTab, Setting } = require("obsidian");

// Settings tab for board access, card-note sync, support, and version info.
const { CARD_FOLDER, DONATION_URL } = require("./helpers");

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
      .setName("Card folder")
      .setDesc(`Cards are stored as Markdown notes in ${CARD_FOLDER}/.`);

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
      .setName("Support development")
      .setDesc("Open the donation page.")
      .addButton((button) => {
        button
          .setButtonText("Donate")
          .onClick(() => window.open(DONATION_URL, "_blank"));
      });

    new Setting(containerEl)
      .setName("Version")
      .setDesc(this.plugin.manifest.version || "0.1.2");
  }
}

module.exports = { TaskDeckSettingTab };
