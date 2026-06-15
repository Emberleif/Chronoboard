const {
  ItemView,
  Menu,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  setIcon,
  moment,
} = require("obsidian");

const VIEW_TYPE = "chronoboard-view";
const PX_PER_HOUR = 56;
const STATUS_SORT_ORDER = {
  "in progress": 0,
  "in-progress": 0,
  ongoing: 1,
  "on hold": 2,
  "on-hold": 2,
  upcoming: 3
};
const SUMMARY_SORT_OPTIONS = {
  status: "Status",
  alphabetical: "Alphabetical",
  most: "Most Time",
  least: "Least Time"
};

const SUMMARY_SORT_ICONS = {
  status: "arrow-up-down",
  alphabetical: "list-ordered",
  most: "arrow-down-wide-narrow",
  least: "arrow-up-narrow-wide"
};

const DEFAULT_SETTINGS = {
  folder: "Chronoboard Tasks",
  timeEntryNotesFolder: "Chronoboard Time Entry Notes",
  timeEntryNoteTemplate: "",
  selectedTaskPaths: [],
  staticTaskPaths: [],
  boardOnlyTaskPaths: [],
  hideWeekends: true,
  visibleStartHour: 8,
  visibleEndHour: 19,
  jiraTag: "chronoboard",
  taskTag: "task",
  filterProperty: "Status",
  excludedValues: ["finished"],
  colorProperty: "timeboardColor",
  subtitleProperty: "timeboardSubtitle",
  highlightColor: "",
  forceDarkTextOnColored: false,
  lastSeenVersion: ""
};

const GUIDE_NOTE_PATH = "Getting Started With Chronoboard.md";
const CHANGELOG_NOTE_PATH = "Chronoboard - Changelog.md";

function normalizeStatus(value) {
  return String(value || "").trim().toLowerCase();
}

function getStatusSortRank(value) {
  const normalized = normalizeStatus(value);
  return Object.prototype.hasOwnProperty.call(STATUS_SORT_ORDER, normalized)
    ? STATUS_SORT_ORDER[normalized]
    : 99;
}

function normalizeStatusList(value) {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeStatus(item)).filter(Boolean);
  }
  const normalized = normalizeStatus(value);
  return normalized ? [normalized] : [];
}

function extractStatusValuesFromText(text, statusProperty) {
  const lines = String(text || "").split(/\r?\n/);
  const values = [];
  const propertyPattern = new RegExp(`^${statusProperty}:\\s*(.*)$`, "i");

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const match = line.match(propertyPattern);
    if (!match) {
      continue;
    }

    const inlineValue = match[1].trim();
    if (inlineValue) {
      values.push(...normalizeStatusList(inlineValue));
    }

    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j];
      if (!/^\s+-\s+/.test(next)) {
        break;
      }
      values.push(normalizeStatus(next.replace(/^\s+-\s+/, "")));
    }
    break;
  }

  return values.filter(Boolean);
}

function splitFrontmatter(content) {
  const text = String(content || "").replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) {
    return {
      frontmatterLines: [],
      body: text
    };
  }
  const lines = text.split("\n");
  let closingIndex = -1;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === "---") {
      closingIndex = index;
      break;
    }
  }
  if (closingIndex === -1) {
    return {
      frontmatterLines: [],
      body: text
    };
  }
  return {
    frontmatterLines: lines.slice(1, closingIndex),
    body: lines.slice(closingIndex + 1).join("\n")
  };
}

function normalizeFrontmatterKey(line) {
  const match = String(line || "").match(/^\s*([A-Za-z0-9_-]+)\s*:/);
  return match ? match[1].trim().toLowerCase() : "";
}

function rawFrontmatterContainsExcludedValue(text, propertyName, excludedValues) {
  const lines = String(text || "").split(/\r?\n/);
  const propertyPattern = new RegExp(`^${propertyName}:\\s*(.*)$`, "i");
  const excluded = new Set((excludedValues || []).map((value) => normalizeStatus(value)).filter(Boolean));

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const match = line.match(propertyPattern);
    if (!match) {
      continue;
    }

    const inlineValue = match[1].trim();
    if (excluded.has(normalizeStatus(inlineValue))) {
      return true;
    }

    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j];
      if (!/^\s+-\s+/.test(next)) {
        break;
      }
      if (excluded.has(normalizeStatus(next.replace(/^\s+-\s+/, "")))) {
        return true;
      }
    }

    return false;
  }

  return false;
}

function parseFrontmatterDate(value) {
  if (!value) {
    return null;
  }
  const parsed = moment(value);
  return parsed.isValid() ? parsed : null;
}

function clampNumber(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function formatHours(minutes) {
  const hours = minutes / 60;
  return `${hours % 1 === 0 ? hours.toFixed(0) : hours.toFixed(1)}h`;
}

function parsePathList(value) {
  return String(value || "")
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function getHoursColor(minutes) {
  if (minutes >= 480) {
    return "is-strong";
  }
  if (minutes >= 240) {
    return "is-medium";
  }
  if (minutes > 0) {
    return "is-light";
  }
  return "";
}

function normalizeHexColor(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }
  const withHash = raw.startsWith("#") ? raw : `#${raw}`;
  return /^#[0-9a-fA-F]{6}$/.test(withHash) ? withHash : "";
}

function getHighlightCssValue(value) {
  return normalizeHexColor(value) || "var(--interactive-accent)";
}

function getStatusToneClass(value) {
  const normalized = normalizeStatus(value);
  if (normalized === "in progress" || normalized === "in-progress") {
    return "is-in-progress";
  }
  if (normalized === "ongoing") {
    return "is-ongoing";
  }
  if (normalized === "on hold" || normalized === "on-hold") {
    return "is-on-hold";
  }
  if (normalized === "upcoming") {
    return "is-upcoming";
  }
  return "";
}

function getContrastTextColor(hexColor) {
  const hex = normalizeHexColor(hexColor).replace("#", "");
  if (!hex) {
    return "#ffffff";
  }
  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.62 ? "#111111" : "#ffffff";
}

function sanitizeFileSegment(value) {
  return String(value || "")
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function createEntryId() {
  return `chrono-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

class TaskPickerModal extends Modal {
  constructor(app, plugin, options) {
    super(app);
    this.plugin = plugin;
    this.onChoose = options.onChoose;
    this.excludePaths = new Set(options.excludePaths || []);
  }

  async onOpen() {
    const { contentEl, titleEl } = this;
    titleEl.setText("Add task");
    contentEl.empty();

    const candidates = await this.plugin.getAvailableTasks();
    const filtered = candidates.filter((task) => !this.excludePaths.has(task.path));

    if (!filtered.length) {
      contentEl.createDiv({
        cls: "chronoboard-modal-empty",
        text: "No eligible tasks are available in the configured folder."
      });
      return;
    }

    const listEl = contentEl.createDiv({ cls: "chronoboard-modal-list" });
    filtered.forEach((task) => {
      const card = listEl.createDiv({ cls: "chronoboard-modal-card" });
      card.createDiv({ cls: "chronoboard-task-key", text: task.jiraKey || task.file.basename });
      const secondaryText = this.plugin.getTaskSecondaryText(task);
      if (secondaryText) {
        card.createDiv({ cls: "chronoboard-task-name", text: secondaryText });
      }
      card.createDiv({
        cls: "chronoboard-task-meta",
        text: `${task.status || "unknown"}`
      });
      card.addEventListener("click", () => {
        this.onChoose(task);
        this.close();
      });
    });
  }

  onClose() {
    this.contentEl.empty();
  }
}

class PreciseTimeEditModal extends Modal {
  constructor(app, options) {
    super(app);
    this.entry = options.entry;
    this.onSave = options.onSave;
    this.dayKey = moment(options.entry.startTime).format("YYYY-MM-DD");
    this.startValue = moment(options.entry.startTime).format("HH:mm");
    this.endValue = moment(options.entry.endTime).format("HH:mm");
  }

  onOpen() {
    const { contentEl, titleEl } = this;
    titleEl.setText("Precise Edit Time");
    contentEl.empty();

    contentEl.createDiv({
      cls: "chronoboard-modal-empty",
      text: `Editing ${this.dayKey}`
    });

    new Setting(contentEl)
      .setName("Start time")
      .addText((text) => {
        text.setPlaceholder("08:00").setValue(this.startValue);
        text.inputEl.type = "time";
        text.onChange((value) => {
          this.startValue = value;
        });
      });

    new Setting(contentEl)
      .setName("End time")
      .addText((text) => {
        text.setPlaceholder("09:30").setValue(this.endValue);
        text.inputEl.type = "time";
        text.onChange((value) => {
          this.endValue = value;
        });
      });

    const actions = contentEl.createDiv({ cls: "chronoboard-modal-actions" });
    const saveButton = actions.createEl("button", { text: "Save" });
    const cancelButton = actions.createEl("button", { text: "Cancel" });

    saveButton.addEventListener("click", async () => {
      if (!this.startValue || !this.endValue) {
        new Notice("Start and end time are required.");
        return;
      }
      const start = moment(`${this.dayKey}T${this.startValue}`);
      const end = moment(`${this.dayKey}T${this.endValue}`);
      if (!start.isValid() || !end.isValid() || !end.isAfter(start)) {
        new Notice("End time must be after start time.");
        return;
      }
      await this.onSave({
        startTime: start.format("YYYY-MM-DDTHH:mm"),
        endTime: end.format("YYYY-MM-DDTHH:mm")
      });
      this.close();
    });

    cancelButton.addEventListener("click", () => this.close());
  }

  onClose() {
    this.contentEl.empty();
  }
}

class TicketColorModal extends Modal {
  constructor(app, options) {
    super(app);
    this.initialColor = normalizeHexColor(options.initialColor) || "#4f8ad9";
    this.onSave = options.onSave;
    this.onClear = options.onClear;
  }

  onOpen() {
    const { contentEl, titleEl } = this;
    titleEl.setText("Change task color");
    contentEl.empty();

    let currentColor = this.initialColor;

    new Setting(contentEl)
      .setName("Color")
      .setDesc("Set the color used for this task in the timeboard.")
      .addText((text) => {
        text.setPlaceholder("#4f8ad9").setValue(currentColor);
        text.onChange((value) => {
          currentColor = value;
        });
      })
      .addExtraButton((button) => {
        button.setIcon("palette");
        button.onClick(() => {});
      });

    const pickerWrap = contentEl.createDiv({ cls: "chronoboard-color-picker-wrap" });
    const picker = pickerWrap.createEl("input");
    picker.type = "color";
    picker.value = currentColor;
    picker.addEventListener("input", () => {
      currentColor = picker.value;
    });

    const actions = contentEl.createDiv({ cls: "chronoboard-modal-actions" });
    const saveButton = actions.createEl("button", { text: "Save" });
    const clearButton = actions.createEl("button", { text: "Clear" });
    const cancelButton = actions.createEl("button", { text: "Cancel" });

    saveButton.addEventListener("click", async () => {
      const normalized = normalizeHexColor(currentColor);
      if (!normalized) {
        new Notice("Enter a valid hex color like #4f8ad9.");
        return;
      }
      await this.onSave(normalized);
      this.close();
    });

    clearButton.addEventListener("click", async () => {
      await this.onClear();
      this.close();
    });

    cancelButton.addEventListener("click", () => this.close());
  }

  onClose() {
    this.contentEl.empty();
  }
}

class TimeBoxTextModal extends Modal {
  constructor(app, options) {
    super(app);
    this.initialText = String(options.initialText || "");
    this.onSave = options.onSave;
  }

  onOpen() {
    const { contentEl, titleEl } = this;
    titleEl.setText("Edit box text");
    contentEl.empty();

    let currentValue = this.initialText;

    new Setting(contentEl)
      .setName("Task block text")
      .setDesc("This text appears below the time inside the task block.")
      .addTextArea((text) => {
        text.setPlaceholder("What you did in this block").setValue(currentValue);
        text.inputEl.rows = 6;
        text.inputEl.addClass("chronoboard-modal-textarea");
        text.onChange((value) => {
          currentValue = value;
        });
      });

    const actions = contentEl.createDiv({ cls: "chronoboard-modal-actions" });
    const saveButton = actions.createEl("button", { text: "Save" });
    const clearButton = actions.createEl("button", { text: "Clear" });
    const cancelButton = actions.createEl("button", { text: "Cancel" });

    saveButton.addEventListener("click", async () => {
      await this.onSave(currentValue.trim());
      this.close();
    });

    clearButton.addEventListener("click", async () => {
      await this.onSave("");
      this.close();
    });

    cancelButton.addEventListener("click", () => this.close());
  }

  onClose() {
    this.contentEl.empty();
  }
}

class TicketSubtitleModal extends Modal {
  constructor(app, options) {
    super(app);
    this.initialText = String(options.initialText || "");
    this.onSave = options.onSave;
  }

  onOpen() {
    const { contentEl, titleEl } = this;
    titleEl.setText("Edit task subtitle");
    contentEl.empty();

    let currentValue = this.initialText;

    new Setting(contentEl)
      .setName("Subtitle")
      .setDesc("Shown below the task key on cards and above the time inside blocks.")
      .addText((text) => {
        text.setPlaceholder("Meeting name or short label").setValue(currentValue);
        text.onChange((value) => {
          currentValue = value;
        });
      });

    const actions = contentEl.createDiv({ cls: "chronoboard-modal-actions" });
    const saveButton = actions.createEl("button", { text: "Save" });
    const clearButton = actions.createEl("button", { text: "Clear" });
    const cancelButton = actions.createEl("button", { text: "Cancel" });

    saveButton.addEventListener("click", async () => {
      await this.onSave(currentValue.trim());
      this.close();
    });

    clearButton.addEventListener("click", async () => {
      await this.onSave("");
      this.close();
    });

    cancelButton.addEventListener("click", () => this.close());
  }

  onClose() {
    this.contentEl.empty();
  }
}

class ManualTimeEntryModal extends Modal {
  constructor(app, plugin, options = {}) {
    super(app);
    this.plugin = plugin;
    this.defaultTaskPath = options.defaultTaskPath || "";
    this.onComplete = options.onComplete;
    this.selectedTaskPath = this.defaultTaskPath;
    this.selectedDate = moment().format("YYYY-MM-DD");
    this.startValue = "09:00";
    this.endValue = "10:00";
    this.blockText = "";
    this.updateTaskColor = false;
    this.colorValue = "#4f8ad9";
    this.tasks = [];
  }

  async onOpen() {
    const { contentEl, titleEl } = this;
    titleEl.setText("Manual time entry");
    contentEl.empty();

    this.tasks = await this.plugin.getAvailableTasks();
    if (!this.tasks.length) {
      contentEl.createDiv({
        cls: "chronoboard-modal-empty",
        text: "No eligible tasks are available in the configured folder."
      });
      return;
    }

    if (!this.tasks.find((task) => task.path === this.selectedTaskPath)) {
      this.selectedTaskPath = this.tasks[0].path;
    }
    const selectedTask = this.tasks.find((task) => task.path === this.selectedTaskPath) || this.tasks[0];
    this.colorValue = normalizeHexColor(selectedTask?.color) || "#4f8ad9";

    new Setting(contentEl)
      .setName("Task")
      .setDesc("Choose which task to log time against.")
      .addDropdown((dropdown) => {
        this.tasks.forEach((task) => {
          const label = this.plugin.getTaskLabel(task);
          dropdown.addOption(task.path, label);
        });
        dropdown.setValue(this.selectedTaskPath);
        dropdown.onChange((value) => {
          this.selectedTaskPath = value;
          const chosen = this.tasks.find((task) => task.path === value);
          this.colorValue = normalizeHexColor(chosen?.color) || "#4f8ad9";
          colorText?.setValue(this.colorValue);
          colorPicker.value = this.colorValue;
        });
      });

    new Setting(contentEl)
      .setName("Date")
      .setDesc("Date for the time entry.")
      .addText((text) => {
        text.setValue(this.selectedDate);
        text.inputEl.type = "date";
        text.onChange((value) => {
          this.selectedDate = value;
        });
      });

    new Setting(contentEl)
      .setName("Start time")
      .setDesc("Start time for the entry.")
      .addText((text) => {
        text.setValue(this.startValue);
        text.inputEl.type = "time";
        text.onChange((value) => {
          this.startValue = value;
        });
      });

    new Setting(contentEl)
      .setName("End time")
      .setDesc("End time for the entry.")
      .addText((text) => {
        text.setValue(this.endValue);
        text.inputEl.type = "time";
        text.onChange((value) => {
          this.endValue = value;
        });
      });

    new Setting(contentEl)
      .setName("Task block text")
      .setDesc("Optional text shown inside the time block.")
      .addTextArea((text) => {
        text.setPlaceholder("What you worked on").setValue(this.blockText);
        text.inputEl.rows = 5;
        text.inputEl.addClass("chronoboard-modal-textarea");
        text.onChange((value) => {
          this.blockText = value;
        });
      });

    let colorText = null;
    let colorPicker = null;
    new Setting(contentEl)
      .setName("Task color")
      .setDesc("Optional. Update the selected task color while creating this entry.")
      .addToggle((toggle) => {
        toggle.setValue(this.updateTaskColor);
        toggle.onChange((value) => {
          this.updateTaskColor = value;
        });
      })
      .addText((text) => {
        colorText = text;
        text.setPlaceholder("#4f8ad9").setValue(this.colorValue);
        text.onChange((value) => {
          const normalized = normalizeHexColor(value);
          if (normalized) {
            this.colorValue = normalized;
            if (colorPicker) {
              colorPicker.value = normalized;
            }
          }
        });
        const control = text.inputEl.closest(".setting-item-control") || text.inputEl.parentElement;
        const pickerWrap = control.createDiv({ cls: "chronoboard-setting-color-wrap" });
        colorPicker = pickerWrap.createEl("input", { cls: "chronoboard-setting-color-picker" });
        colorPicker.type = "color";
        colorPicker.value = this.colorValue;
        colorPicker.addEventListener("input", () => {
          this.colorValue = colorPicker.value;
          colorText.setValue(this.colorValue);
        });
      });

    const actions = contentEl.createDiv({ cls: "chronoboard-modal-actions" });
    const saveButton = actions.createEl("button", { text: "Save" });
    const cancelButton = actions.createEl("button", { text: "Cancel" });

    saveButton.addEventListener("click", async () => {
      const chosenTask = this.tasks.find((task) => task.path === this.selectedTaskPath);
      if (!chosenTask) {
        new Notice("Choose a task first.");
        return;
      }
      if (!this.selectedDate || !this.startValue || !this.endValue) {
        new Notice("Date, start time, and end time are required.");
        return;
      }
      const start = moment(`${this.selectedDate}T${this.startValue}`);
      const end = moment(`${this.selectedDate}T${this.endValue}`);
      if (!start.isValid() || !end.isValid() || !end.isAfter(start)) {
        new Notice("End time must be after start time.");
        return;
      }

      if (this.updateTaskColor) {
        const normalizedColor = normalizeHexColor(this.colorValue);
        if (!normalizedColor) {
          new Notice("Enter a valid task color before saving.");
          return;
        }
        await this.plugin.updateTicketColor(chosenTask.file, normalizedColor);
      }

      await this.plugin.addTimeEntry(chosenTask.file, {
        startTime: start.format("YYYY-MM-DDTHH:mm"),
        endTime: end.format("YYYY-MM-DDTHH:mm"),
        label: this.blockText.trim()
      }, { pushUndo: true });

      if (typeof this.onComplete === "function") {
        await this.onComplete(chosenTask.path);
      }
      this.close();
    });

    cancelButton.addEventListener("click", () => this.close());
  }

  onClose() {
    this.contentEl.empty();
  }
}

class ChronoboardSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  createSection(containerEl, title, description) {
    const section = containerEl.createDiv({ cls: "chronoboard-settings-section" });
    section.createEl("h3", { cls: "chronoboard-settings-section-title", text: title });
    if (description) {
      section.createDiv({ cls: "chronoboard-settings-section-description", text: description });
    }
    return section;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    const folderSection = this.createSection(
      containerEl,
      "Folder Settings",
      "Choose where Chronoboard reads tasks from and where it stores time entry task notes."
    );

    new Setting(folderSection)
      .setName("Folder")
      .setDesc("Folder containing the tasks used by the add-task picker.")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.folder)
          .setValue(this.plugin.settings.folder)
          .onChange(async (value) => {
            this.plugin.settings.folder = value.trim() || DEFAULT_SETTINGS.folder;
            await this.plugin.saveSettings();
            await this.plugin.refreshAllViews();
          })
      );

    new Setting(folderSection)
      .setName("Time entry notes folder")
      .setDesc("Folder used when creating dedicated time entry task notes.")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.timeEntryNotesFolder)
          .setValue(this.plugin.settings.timeEntryNotesFolder)
          .onChange(async (value) => {
            this.plugin.settings.timeEntryNotesFolder = value.trim() || DEFAULT_SETTINGS.timeEntryNotesFolder;
            await this.plugin.saveSettings();
            await this.plugin.refreshAllViews();
          })
      );

    new Setting(folderSection)
      .setName("Time entry note template")
      .setDesc("Optional template note used when creating time entry notes. Chronoboard entry fields are appended after the template frontmatter.")
      .addText((text) =>
        text
          .setPlaceholder("Templates/Chronoboard Time Entry Template.md")
          .setValue(this.plugin.settings.timeEntryNoteTemplate || "")
          .onChange(async (value) => {
            this.plugin.settings.timeEntryNoteTemplate = value.trim();
            await this.plugin.saveSettings();
          })
      );

    new Setting(folderSection)
      .setName("Always include tasks")
      .setDesc("Task paths that should always appear on the task list and totals rail. One path per line or comma-separated.")
      .addTextArea((text) =>
        text
          .setPlaceholder("Chronoboard Tasks/Meetings.md")
          .setValue((this.plugin.settings.staticTaskPaths || []).join("\n"))
          .onChange(async (value) => {
            this.plugin.settings.staticTaskPaths = parsePathList(value);
            await this.plugin.saveSettings();
            await this.plugin.refreshAllViews();
          })
      );

    const metadataSection = this.createSection(
      containerEl,
      "Frontmatter Settings",
      "Control which tasks appear in the picker by filtering against a metadata property."
    );

    new Setting(metadataSection)
      .setName("Metadata property")
      .setDesc("Property name used when deciding what to exclude from the add-task menu.")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.filterProperty)
          .setValue(this.plugin.settings.filterProperty)
          .onChange(async (value) => {
            this.plugin.settings.filterProperty = value.trim() || DEFAULT_SETTINGS.filterProperty;
            await this.plugin.saveSettings();
            await this.plugin.refreshAllViews();
          })
      );

    new Setting(metadataSection)
      .setName("Excluded values")
      .setDesc("Comma-separated values that exclude a task from the add-task menu when found in the metadata property.")
      .addText((text) =>
        text
          .setPlaceholder("Finished")
          .setValue((this.plugin.settings.excludedValues || []).join(", "))
          .onChange(async (value) => {
            this.plugin.settings.excludedValues = value
              .split(",")
              .map((item) => normalizeStatus(item))
              .filter(Boolean);
            await this.plugin.saveSettings();
            await this.plugin.refreshAllViews();
          })
      );

    const setupSection = this.createSection(
      containerEl,
      "Setup Settings",
      "Configure the board timeline and working window."
    );

    new Setting(setupSection)
      .setName("Hide weekends in week and month views")
      .setDesc("Show only Monday through Friday in the week and month timelines.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.hideWeekends)
          .onChange(async (value) => {
            this.plugin.settings.hideWeekends = value;
            await this.plugin.saveSettings();
            await this.plugin.refreshAllViews();
          })
      );

    let visibleStartSlider;
    let visibleStartText;
    let visibleEndSlider;
    let visibleEndText;
    const syncVisibleHourControls = () => {
      visibleStartSlider?.setValue(this.plugin.settings.visibleStartHour, false);
      visibleStartText?.setValue(String(this.plugin.settings.visibleStartHour));
      visibleEndSlider?.setValue(this.plugin.settings.visibleEndHour, false);
      visibleEndText?.setValue(String(this.plugin.settings.visibleEndHour));
    };

    new Setting(setupSection)
      .setName("Visible start hour")
      .setDesc("First hour marker shown in week and day views.")
      .addSlider((slider) => {
        visibleStartSlider = slider;
        slider
          .setLimits(0, 20, 1)
          .setDynamicTooltip()
          .setValue(this.plugin.settings.visibleStartHour)
          .onChange(async (value) => {
            this.plugin.settings.visibleStartHour = value;
            if (this.plugin.settings.visibleEndHour <= value) {
              this.plugin.settings.visibleEndHour = value + 1;
            }
            syncVisibleHourControls();
            await this.plugin.saveSettings();
            await this.plugin.refreshAllViews();
          });
      })
      .addText((text) => {
        visibleStartText = text;
        text
          .setPlaceholder("8")
          .setValue(String(this.plugin.settings.visibleStartHour))
          .onChange(async (value) => {
            const parsed = Number.parseInt(String(value).trim(), 10);
            if (Number.isNaN(parsed)) {
              return;
            }
            this.plugin.settings.visibleStartHour = clampNumber(parsed, 0, 20);
            if (this.plugin.settings.visibleEndHour <= this.plugin.settings.visibleStartHour) {
              this.plugin.settings.visibleEndHour = this.plugin.settings.visibleStartHour + 1;
            }
            syncVisibleHourControls();
            await this.plugin.saveSettings();
            await this.plugin.refreshAllViews();
          });
        text.inputEl.addClass("chronoboard-settings-hour-input");
      });

    new Setting(setupSection)
      .setName("Visible end hour")
      .setDesc("Last hour marker shown in week and day views.")
      .addSlider((slider) => {
        visibleEndSlider = slider;
        slider
          .setLimits(1, 24, 1)
          .setDynamicTooltip()
          .setValue(this.plugin.settings.visibleEndHour)
          .onChange(async (value) => {
            this.plugin.settings.visibleEndHour = Math.max(value, this.plugin.settings.visibleStartHour + 1);
            syncVisibleHourControls();
            await this.plugin.saveSettings();
            await this.plugin.refreshAllViews();
          });
      })
      .addText((text) => {
        visibleEndText = text;
        text
          .setPlaceholder("19")
          .setValue(String(this.plugin.settings.visibleEndHour))
          .onChange(async (value) => {
            const parsed = Number.parseInt(String(value).trim(), 10);
            if (Number.isNaN(parsed)) {
              return;
            }
            this.plugin.settings.visibleEndHour = clampNumber(parsed, this.plugin.settings.visibleStartHour + 1, 24);
            syncVisibleHourControls();
            await this.plugin.saveSettings();
            await this.plugin.refreshAllViews();
          });
        text.inputEl.addClass("chronoboard-settings-hour-input");
      });

    const customizationSection = this.createSection(
      containerEl,
      "Customization Settings",
      "Adjust how Chronoboard looks and how colored task surfaces behave."
    );

    new Setting(customizationSection)
      .setName("Highlight color")
      .setDesc("Accent color used for selected states and active controls.")
      .addText((text) => {
        const getPickerValue = () =>
          normalizeHexColor(this.plugin.settings.highlightColor)
          || normalizeHexColor(getComputedStyle(document.body).getPropertyValue("--interactive-accent"))
          || "#8b5cf6";

        text
          .setPlaceholder("Obsidian default")
          .setValue(this.plugin.settings.highlightColor)
          .onChange(async (value) => {
            this.plugin.settings.highlightColor = normalizeHexColor(value);
            await this.plugin.saveSettings();
            await this.plugin.refreshAllViews();
          });
        const control = text.inputEl.closest(".setting-item-control") || text.inputEl.parentElement;
        const pickerWrap = control.createDiv({ cls: "chronoboard-setting-color-wrap" });
        const picker = pickerWrap.createEl("input", { cls: "chronoboard-setting-color-picker" });
        picker.type = "color";
        picker.value = getPickerValue();
        picker.addEventListener("pointerdown", (event) => event.stopPropagation());
        picker.addEventListener("click", (event) => event.stopPropagation());
        picker.addEventListener("input", async () => {
          this.plugin.settings.highlightColor = picker.value;
          text.setValue(picker.value);
          await this.plugin.saveSettings();
          await this.plugin.refreshAllViews();
        });
      })
      .addExtraButton((button) => {
        button.setIcon("reset");
        button.setTooltip("Reset to Obsidian default");
        button.onClick(async () => {
          this.plugin.settings.highlightColor = DEFAULT_SETTINGS.highlightColor;
          await this.plugin.saveSettings();
          await this.plugin.refreshAllViews();
          this.display();
        });
      });

    new Setting(customizationSection)
      .setName("Force dark text on colored cards")
      .setDesc("Use dark text on colored task cards and time blocks even when the color is light.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.forceDarkTextOnColored)
          .onChange(async (value) => {
            this.plugin.settings.forceDarkTextOnColored = value;
            await this.plugin.saveSettings();
            await this.plugin.refreshAllViews();
          })
      );

  }
}

class ChronoboardView extends ItemView {
  constructor(leaf, plugin) {
    super(leaf);
    this.plugin = plugin;
    this.focusDate = moment();
    this.currentMode = "week";
    this.selectedTaskPath = plugin.settings.selectedTaskPaths[0] || null;
    this.currentSummarySort = "status";
    this.leftPanelCollapsed = false;
    this.rightPanelCollapsed = false;
    this.dragState = null;
    this.pendingMoveHold = null;
    this.activeContextMenu = null;
    this.boundMouseMove = (event) => this.handleMouseMove(event);
    this.boundMouseUp = () => this.handleMouseUp();
  }

  getViewType() {
    return VIEW_TYPE;
  }

  getDisplayText() {
    return "Chronoboard";
  }

  getIcon() {
    return "blocks";
  }

  async onOpen() {
    this.contentEl.addClass("chronoboard-view");
    await this.render();
  }

  async onClose() {
    this.cancelPendingMoveHold();
    this.closeActiveContextMenu();
    this.removeDragListeners();
  }

  async refresh() {
    await this.render();
  }

  getVisibleHourCount() {
    return this.plugin.settings.visibleEndHour - this.plugin.settings.visibleStartHour;
  }

  getTimelineHeight() {
    return this.getVisibleHourCount() * (this.currentHourHeight || PX_PER_HOUR);
  }

  getSelectedPaths() {
    const deduped = [];
    const seen = new Set();
    const combinedPaths = [
      ...(this.plugin.settings.staticTaskPaths || []),
      ...(this.plugin.settings.selectedTaskPaths || [])
    ];
    for (const path of combinedPaths) {
      if (path && !seen.has(path)) {
        seen.add(path);
        deduped.push(path);
      }
    }
    return deduped;
  }

  getBoardPaths() {
    const deduped = [];
    const seen = new Set();
    const combinedPaths = [
      ...(this.plugin.settings.staticTaskPaths || []),
      ...(this.plugin.settings.selectedTaskPaths || []),
      ...(this.plugin.settings.boardOnlyTaskPaths || [])
    ];
    for (const path of combinedPaths) {
      if (path && !seen.has(path)) {
        seen.add(path);
        deduped.push(path);
      }
    }
    return deduped;
  }

  isStaticTask(path) {
    return (this.plugin.settings.staticTaskPaths || []).includes(path);
  }

  shouldDisplayTaskStatus(task) {
    return Boolean(task?.status) && !this.isStaticTask(task.path);
  }

  getWeekDays() {
    const start = this.focusDate.clone().startOf("isoWeek");
    const days = [];
    const endIndex = this.plugin.settings.hideWeekends ? 5 : 7;
    for (let i = 0; i < endIndex; i += 1) {
      days.push(start.clone().add(i, "days"));
    }
    return days;
  }

  getMonthDays(monthStart) {
    const calendarStart = monthStart.clone().startOf("isoWeek");
    const calendarEnd = monthStart.clone().endOf("month").endOf("isoWeek");
    const days = [];
    const cursor = calendarStart.clone();
    while (cursor.isSameOrBefore(calendarEnd, "day")) {
      const isoDay = cursor.isoWeekday();
      if (!this.plugin.settings.hideWeekends || isoDay <= 5) {
        days.push(cursor.clone());
      }
      cursor.add(1, "day");
    }
    return days;
  }

  sortTasks(tasks) {
    return [...tasks].sort((a, b) => {
      const rankDiff = getStatusSortRank(a.status) - getStatusSortRank(b.status);
      if (rankDiff !== 0) {
        return rankDiff;
      }
      return a.displayTitle.localeCompare(b.displayTitle);
    });
  }

  getScopedTasks(tasks, options = {}) {
    const scoped = tasks.filter((task) => this.getSummaryMinutesForTask(task) > 0);
    if (options.includeSelectedIfMissing && this.selectedTaskPath) {
      const selectedTask = tasks.find((task) => task.path === this.selectedTaskPath);
      if (selectedTask && !scoped.find((task) => task.path === selectedTask.path)) {
        scoped.push(selectedTask);
      }
    }
    return this.sortTasks(scoped);
  }

  getSummarySortedTasks(tasks) {
    const scoped = this.getScopedTasks(tasks);
    if (this.currentSummarySort === "alphabetical") {
      return [...scoped].sort((a, b) => this.plugin.getTaskLabel(a).localeCompare(this.plugin.getTaskLabel(b)));
    }
    if (this.currentSummarySort === "most") {
      return [...scoped].sort((a, b) => {
        const minuteDiff = this.getSummaryMinutesForTask(b) - this.getSummaryMinutesForTask(a);
        if (minuteDiff !== 0) {
          return minuteDiff;
        }
        return this.plugin.getTaskLabel(a).localeCompare(this.plugin.getTaskLabel(b));
      });
    }
    if (this.currentSummarySort === "least") {
      return [...scoped].sort((a, b) => {
        const minuteDiff = this.getSummaryMinutesForTask(a) - this.getSummaryMinutesForTask(b);
        if (minuteDiff !== 0) {
          return minuteDiff;
        }
        return this.plugin.getTaskLabel(a).localeCompare(this.plugin.getTaskLabel(b));
      });
    }
    return [...scoped].sort((a, b) => {
      const rankDiff = getStatusSortRank(a.status) - getStatusSortRank(b.status);
      if (rankDiff !== 0) {
        return rankDiff;
      }
      return this.plugin.getTaskLabel(a).localeCompare(this.plugin.getTaskLabel(b));
    });
  }

  async render() {
    this.contentEl.empty();
    this.contentEl.addClass("chronoboard-view");
    this.contentEl.classList.toggle("is-mobile", this.isMobileLayout());
    this.contentEl.style.setProperty("--chronoboard-highlight", getHighlightCssValue(this.plugin.settings.highlightColor));

    const poolPaths = this.getSelectedPaths();
    const boardPaths = this.getBoardPaths();
    const taskMap = await this.plugin.getTaskMap(boardPaths);
    const currentTasks = this.sortTasks(poolPaths.map((path) => taskMap.get(path)).filter(Boolean));
    const visibleTasks = this.sortTasks(boardPaths.map((path) => taskMap.get(path)).filter(Boolean));
    if (!this.selectedTaskPath || !visibleTasks.find((task) => task.path === this.selectedTaskPath)) {
      this.selectedTaskPath = currentTasks[0]?.path || visibleTasks[0]?.path || null;
    }

    this.renderToolbar(currentTasks);
    if (this.isMobileLayout()) {
      this.renderMobileLayout(currentTasks, visibleTasks, poolPaths);
      return;
    }
    const layoutClasses = ["chronoboard-layout"];
    if (this.leftPanelCollapsed) {
      layoutClasses.push("is-left-collapsed");
    }
    if (this.rightPanelCollapsed) {
      layoutClasses.push("is-right-collapsed");
    }
    const layout = this.contentEl.createDiv({ cls: layoutClasses.join(" ") });
    this.renderTaskRail(layout, currentTasks, poolPaths);
    this.renderCenter(layout, visibleTasks);
    this.renderSummary(layout, visibleTasks);
  }

  getDynamicHourHeight(panel) {
    const availableHeight = Math.max((panel.clientHeight || this.contentEl.clientHeight || 0) - 82, 0);
    const stretched = availableHeight > 0 ? availableHeight / this.getVisibleHourCount() : PX_PER_HOUR;
    return Math.max(PX_PER_HOUR, Math.floor(stretched));
  }

  isMobileLayout() {
    return Boolean(this.app.isMobile);
  }

  getDayTimelineWidth(container) {
    const width = container.clientWidth || container.getBoundingClientRect().width || 0;
    return Math.max(width, this.getVisibleHourCount() * 84);
  }

  renderToolbar(selectedTasks) {
    const isMobile = this.isMobileLayout();
    const toolbar = this.contentEl.createDiv({ cls: `chronoboard-toolbar${isMobile ? " is-mobile" : ""}` });
    const left = toolbar.createDiv({ cls: "chronoboard-toolbar-group" });
    left.createDiv({ cls: "chronoboard-title", text: "Chronoboard" });
    left.createDiv({
      cls: "chronoboard-subtle",
      text: `${selectedTasks.length} selected task${selectedTasks.length === 1 ? "" : "s"}`
    });

    const right = toolbar.createDiv({ cls: "chronoboard-toolbar-group" });

    const statsButton = right.createEl("button", {
      cls: `chronoboard-stats-button${this.currentMode === "stats" ? " is-active" : ""}`,
      text: "Stats"
    });
    statsButton.addEventListener("click", async () => {
      this.currentMode = "stats";
      await this.render();
    });

    if (!isMobile) {
      const taskToggle = right.createEl("button", {
        cls: "chronoboard-collapse-button",
        text: this.leftPanelCollapsed ? "Task" : "Hide Task"
      });
      taskToggle.addEventListener("click", async () => {
        this.leftPanelCollapsed = !this.leftPanelCollapsed;
        await this.render();
      });

      const totalsToggle = right.createEl("button", {
        cls: "chronoboard-collapse-button",
        text: this.rightPanelCollapsed ? "Totals" : "Hide Totals"
      });
      totalsToggle.addEventListener("click", async () => {
        this.rightPanelCollapsed = !this.rightPanelCollapsed;
        await this.render();
      });
    }

    const prevButton = right.createEl("button", { cls: "chronoboard-nav-button", text: "<" });
    prevButton.addEventListener("click", async () => {
      this.focusDate = this.focusDate.clone().subtract(1, this.currentMode === "day" ? "day" : this.currentMode === "month" || this.currentMode === "stats" ? "month" : "week");
      await this.render();
    });

    right.createDiv({ cls: "chronoboard-pill", text: this.getDateLabel() });

    const nextButton = right.createEl("button", { cls: "chronoboard-nav-button", text: ">" });
    nextButton.addEventListener("click", async () => {
      this.focusDate = this.focusDate.clone().add(1, this.currentMode === "day" ? "day" : this.currentMode === "month" || this.currentMode === "stats" ? "month" : "week");
      await this.render();
    });

    const todayButton = right.createDiv({ cls: "chronoboard-pill", text: "Today" });
    todayButton.addEventListener("click", async () => {
      this.currentMode = "day";
      this.focusDate = moment();
      await this.render();
    });

    const dayPill = right.createDiv({
      cls: `chronoboard-pill${this.currentMode === "day" ? " is-active" : ""}`,
      text: "Day"
    });
    dayPill.addEventListener("click", async () => {
      this.currentMode = "day";
      await this.render();
    });

    const weekPill = right.createDiv({
      cls: `chronoboard-pill${this.currentMode === "week" ? " is-active" : ""}`,
      text: "Week"
    });
    weekPill.addEventListener("click", async () => {
      this.currentMode = "week";
      await this.render();
    });

    const monthPill = right.createDiv({
      cls: `chronoboard-pill${this.currentMode === "month" ? " is-active" : ""}`,
      text: "Month"
    });
    monthPill.addEventListener("click", async () => {
      this.currentMode = "month";
      await this.render();
    });
  }

  getDateLabel() {
    if (this.currentMode === "day") {
      return this.focusDate.format("MMM D, YYYY");
    }
    if (this.currentMode === "week") {
      const start = this.focusDate.clone().startOf("isoWeek");
      return `${start.format("MMM D")} to ${start.clone().add(6, "days").format("MMM D")}`;
    }
    if (this.currentMode === "stats") {
      return this.focusDate.format("MMMM YYYY");
    }
    return this.focusDate.format("MMMM YYYY");
  }

  renderTaskRail(layout, selectedTasks, selectedPaths) {
    const panel = layout.createDiv({ cls: "chronoboard-panel" });
    const panelHead = panel.createDiv({ cls: "chronoboard-panel-head" });
    panelHead.createDiv({ text: "Task" });
    const helpTrigger = panelHead.createSpan({ cls: "chronoboard-summary-sort-trigger chronoboard-help-trigger" });
    setIcon(helpTrigger, "help-circle");
    helpTrigger.setAttr("role", "button");
    helpTrigger.setAttr("tabindex", "0");
    helpTrigger.setAttr("aria-label", "Open Chronoboard guide");
    helpTrigger.setAttr("title", "Open Chronoboard guide");
    helpTrigger.addEventListener("click", async () => {
      await this.plugin.openManagedNote(GUIDE_NOTE_PATH, true);
    });
    helpTrigger.addEventListener("keydown", async (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        await this.plugin.openManagedNote(GUIDE_NOTE_PATH, true);
      }
    });

    if (this.leftPanelCollapsed) {
      return;
    }

    const list = panel.createDiv({ cls: "chronoboard-task-list" });

    selectedTasks.forEach((task) => {
      const card = list.createDiv({
        cls: `chronoboard-task-card${task.path === this.selectedTaskPath ? " is-selected" : ""}${this.taskHasVisibleTime(task) ? " has-time" : ""}`
      });
      this.applyTicketSurfaceStyle(card, task, this.taskHasVisibleTime(task));
      const main = card.createDiv({ cls: "chronoboard-task-main" });
      main.createDiv({ cls: "chronoboard-task-key", text: task.jiraKey || task.file.basename });
      const secondaryText = this.plugin.getTaskSecondaryText(task);
      if (secondaryText) {
        main.createDiv({ cls: "chronoboard-task-name", text: secondaryText });
      }
      if (this.shouldDisplayTaskStatus(task)) {
        main.createDiv({ cls: `chronoboard-task-meta chronoboard-status ${getStatusToneClass(task.status)}`, text: task.status });
      }

      card.addEventListener("click", async () => {
        this.selectedTaskPath = task.path;
        await this.render();
      });
      card.addEventListener("dblclick", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        await this.openTask(task);
      });
      card.addEventListener("contextmenu", (event) => this.openTicketContextMenu(event, task));
    });

    const add = list.createDiv({ cls: "chronoboard-add-slot" });
    add.createDiv({ cls: "chronoboard-plus", text: "+" });
    add.createSpan({ text: "Add task" });
    add.addEventListener("click", () => {
      new TaskPickerModal(this.app, this.plugin, {
        excludePaths: selectedPaths,
        onChoose: async (task) => {
          this.plugin.settings.selectedTaskPaths = [...this.plugin.settings.selectedTaskPaths, task.path];
          this.plugin.settings.boardOnlyTaskPaths = (this.plugin.settings.boardOnlyTaskPaths || []).filter((path) => path !== task.path);
          this.selectedTaskPath = task.path;
          await this.plugin.saveSettings();
          await this.render();
        }
      }).open();
    });

    if (!selectedTasks.length) {
      list.createDiv({
        cls: "chronoboard-empty",
        text: "Use the plus button to add tasks from the configured folder."
      });
    }
  }

  renderMobileLayout(currentTasks, visibleTasks, selectedPaths) {
    const layout = this.contentEl.createDiv({ cls: "chronoboard-mobile-layout" });
    layout.createDiv({
      cls: "chronoboard-mobile-notice",
      text: "Read-only mobile view. Use desktop for drag, resize, and time editing."
    });

    this.renderMobileTaskPool(layout, currentTasks, selectedPaths);

    const timelinePanel = layout.createDiv({ cls: "chronoboard-panel chronoboard-mobile-panel" });
    const timelineHead = timelinePanel.createDiv({ cls: "chronoboard-panel-head chronoboard-mobile-timeline-head" });
    timelineHead.createDiv({
      text:
        this.currentMode === "day"
          ? `Daily Time • ${this.focusDate.format("dddd")}`
          : this.currentMode === "week"
            ? "Weekly Time"
            : this.currentMode === "month"
              ? "Monthly Time"
              : "Statistics"
    });

    if (this.currentMode === "stats") {
      this.renderStatistics(timelinePanel, visibleTasks);
    } else {
      this.renderMobileTimeline(timelinePanel, visibleTasks);
    }

    this.renderMobileSummary(layout, visibleTasks);
  }

  renderMobileTaskPool(layout, currentTasks, selectedPaths) {
    const panel = layout.createDiv({ cls: "chronoboard-panel chronoboard-mobile-panel" });
    const panelHead = panel.createDiv({ cls: "chronoboard-panel-head" });
    panelHead.createDiv({ text: "Tasks" });
    const helpTrigger = panelHead.createSpan({ cls: "chronoboard-summary-sort-trigger chronoboard-help-trigger" });
    setIcon(helpTrigger, "help-circle");
    helpTrigger.setAttr("role", "button");
    helpTrigger.setAttr("tabindex", "0");
    helpTrigger.setAttr("aria-label", "Open Chronoboard guide");
    helpTrigger.setAttr("title", "Open Chronoboard guide");
    helpTrigger.addEventListener("click", async () => {
      await this.plugin.openManagedNote(GUIDE_NOTE_PATH, true);
    });
    helpTrigger.addEventListener("keydown", async (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        await this.plugin.openManagedNote(GUIDE_NOTE_PATH, true);
      }
    });
    const list = panel.createDiv({ cls: "chronoboard-mobile-task-list" });

    currentTasks.forEach((task) => {
      const card = list.createDiv({
        cls: `chronoboard-task-card chronoboard-mobile-task-card${task.path === this.selectedTaskPath ? " is-selected" : ""}${this.taskHasVisibleTime(task) ? " has-time" : ""}`
      });
      this.applyTicketSurfaceStyle(card, task, this.taskHasVisibleTime(task));
      const main = card.createDiv({ cls: "chronoboard-task-main" });
      main.createDiv({ cls: "chronoboard-task-key", text: task.jiraKey || task.file.basename });
      const secondaryText = this.plugin.getTaskSecondaryText(task);
      if (secondaryText) {
        main.createDiv({ cls: "chronoboard-task-name", text: secondaryText });
      }
      if (this.shouldDisplayTaskStatus(task)) {
        main.createDiv({ cls: `chronoboard-task-meta chronoboard-status ${getStatusToneClass(task.status)}`, text: task.status });
      }
      card.addEventListener("click", async () => {
        this.selectedTaskPath = task.path;
        await this.render();
      });
      card.addEventListener("dblclick", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        await this.openTask(task);
      });
    });

    const add = list.createDiv({ cls: "chronoboard-add-slot chronoboard-mobile-add-slot" });
    add.createDiv({ cls: "chronoboard-plus", text: "+" });
    add.createSpan({ text: "Add task" });
    add.addEventListener("click", () => {
      new TaskPickerModal(this.app, this.plugin, {
        excludePaths: selectedPaths,
        onChoose: async (task) => {
          this.plugin.settings.selectedTaskPaths = [...this.plugin.settings.selectedTaskPaths, task.path];
          this.plugin.settings.boardOnlyTaskPaths = (this.plugin.settings.boardOnlyTaskPaths || []).filter((path) => path !== task.path);
          this.selectedTaskPath = task.path;
          await this.plugin.saveSettings();
          await this.render();
        }
      }).open();
    });
  }

  renderMobileTimeline(panel, visibleTasks) {
    const agenda = panel.createDiv({ cls: "chronoboard-mobile-agenda" });
    if (this.currentMode === "day") {
      this.renderMobileDaySection(agenda, this.focusDate.clone().startOf("day"), visibleTasks);
      return;
    }
    if (this.currentMode === "week") {
      this.getWeekDays().forEach((dayMoment) => {
        this.renderMobileDaySection(agenda, dayMoment, visibleTasks);
      });
      return;
    }

    const monthStart = this.focusDate.clone().startOf("month");
    const monthEnd = this.focusDate.clone().endOf("month");
    const cursor = monthStart.clone();
    let renderedCount = 0;
    while (cursor.isSameOrBefore(monthEnd, "day")) {
      if (!this.plugin.settings.hideWeekends || cursor.isoWeekday() <= 5) {
        const before = agenda.childElementCount;
        this.renderMobileDaySection(agenda, cursor.clone(), visibleTasks, { hideWhenEmpty: true });
        if (agenda.childElementCount > before) {
          renderedCount += 1;
        }
      }
      cursor.add(1, "day");
    }
    if (!renderedCount) {
      agenda.createDiv({
        cls: "chronoboard-empty chronoboard-mobile-empty",
        text: "No tracked time this month."
      });
    }
  }

  renderMobileDaySection(container, dayMoment, visibleTasks, options = {}) {
    const dayKey = dayMoment.format("YYYY-MM-DD");
    const entries = this.getEntriesForDay(visibleTasks, dayKey);
    if (options.hideWhenEmpty && !entries.length) {
      return;
    }

    const totalMinutes = entries.reduce((sum, item) => sum + this.entryMinutes(item.entry), 0);
    const section = container.createDiv({ cls: "chronoboard-mobile-day-section" });
    const head = section.createDiv({ cls: "chronoboard-mobile-day-head" });
    const left = head.createDiv({ cls: "chronoboard-mobile-day-head-left" });
    left.createDiv({ cls: "chronoboard-mobile-day-name", text: dayMoment.format("dddd") });
    left.createDiv({ cls: "chronoboard-mobile-day-date", text: dayMoment.format("MMM D") });
    head.createDiv({
      cls: `chronoboard-mobile-day-total ${getHoursColor(totalMinutes)}`,
      text: totalMinutes ? formatHours(totalMinutes) : "0h"
    });

    if (!entries.length) {
      section.createDiv({
        cls: "chronoboard-empty chronoboard-mobile-empty",
        text: "No tracked time."
      });
      return;
    }

    const list = section.createDiv({ cls: "chronoboard-mobile-entry-list" });
    entries.forEach(({ task, entry }) => {
      const card = list.createDiv({ cls: "chronoboard-mobile-entry-card" });
      this.applyTicketSurfaceStyle(card, task, true);
      const top = card.createDiv({ cls: "chronoboard-mobile-entry-top" });
      top.createDiv({ cls: "chronoboard-task-key", text: task.jiraKey || task.file.basename });
      if (this.shouldDisplayTaskStatus(task)) {
        top.createDiv({
          cls: `chronoboard-block-status ${getStatusToneClass(task.status)}`,
          text: task.status
        });
      }
      const secondaryText = this.plugin.getTaskSecondaryText(task);
      if (secondaryText) {
        card.createDiv({ cls: "chronoboard-task-name", text: secondaryText });
      }
      card.createDiv({
        cls: "chronoboard-block-time",
        text: `${moment(entry.startTime).format("HH:mm")} to ${moment(entry.endTime).format("HH:mm")}`
      });
      if (entry.label) {
        card.createDiv({
          cls: "chronoboard-block-notes",
          text: entry.label
        });
      }
      card.addEventListener("click", async () => {
        await this.app.workspace.getLeaf("tab").openFile(task.file);
      });
    });
  }

  renderMobileSummary(layout, visibleTasks) {
    const scopedTasks = this.getSummarySortedTasks(visibleTasks);
    const panel = layout.createDiv({ cls: "chronoboard-panel chronoboard-mobile-panel" });
    const panelHead = panel.createDiv({ cls: "chronoboard-panel-head" });
    panelHead.createDiv({
      text: this.currentMode === "day" ? "Daily Total" : this.currentMode === "month" ? "Monthly Total" : "Weekly Total"
    });
    const headMeta = panelHead.createDiv({ cls: "chronoboard-summary-head-meta" });
    headMeta.createDiv({
      cls: "chronoboard-summary-head-total",
      text: formatHours(scopedTasks.reduce((sum, task) => sum + this.getSummaryMinutesForTask(task), 0))
    });
    const sortTrigger = headMeta.createSpan({ cls: "chronoboard-summary-sort-trigger" });
    setIcon(sortTrigger, SUMMARY_SORT_ICONS[this.currentSummarySort] || SUMMARY_SORT_ICONS.status);
    sortTrigger.setAttr("role", "button");
    sortTrigger.setAttr("tabindex", "0");
    sortTrigger.setAttr("aria-label", `Sort totals: ${SUMMARY_SORT_OPTIONS[this.currentSummarySort] || SUMMARY_SORT_OPTIONS.status}`);
    sortTrigger.setAttr("title", `Sort totals: ${SUMMARY_SORT_OPTIONS[this.currentSummarySort] || SUMMARY_SORT_OPTIONS.status}`);
    sortTrigger.addEventListener("click", (event) => this.openSummarySortMenu(event));
    sortTrigger.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        this.openSummarySortMenu(event);
      }
    });

    const list = panel.createDiv({ cls: "chronoboard-summary-list chronoboard-mobile-summary-list" });
    if (!scopedTasks.length) {
      list.createDiv({
        cls: "chronoboard-empty",
        text: "Totals will appear once visible tasks have tracked time."
      });
      return;
    }

    scopedTasks.forEach((task) => {
      const card = list.createDiv({
        cls: `chronoboard-summary-card${task.path === this.selectedTaskPath ? " is-selected" : ""}${this.taskHasVisibleTime(task) ? " has-time" : ""}`
      });
      this.applyTicketSurfaceStyle(card, task, this.taskHasVisibleTime(task));
      card.createDiv({ cls: "chronoboard-task-key", text: task.jiraKey || task.file.basename });
      const secondaryText = this.plugin.getTaskSecondaryText(task);
      if (secondaryText) {
        card.createDiv({ cls: "chronoboard-task-name", text: secondaryText });
      }
      card.createDiv({ cls: "chronoboard-summary-hours", text: formatHours(this.getSummaryMinutesForTask(task)) });
      card.createDiv({
        cls: "chronoboard-summary-note",
        text: this.currentMode === "day" ? "Tracked this day" : this.currentMode === "month" ? "Tracked this month" : "Tracked this week"
      });
      card.addEventListener("click", async () => {
        this.selectedTaskPath = task.path;
        await this.render();
      });
      card.addEventListener("dblclick", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        await this.openTask(task);
      });
    });
  }

  getEntriesForDay(tasks, dayKey) {
    const entries = [];
    tasks.forEach((task) => {
      (task.timeEntries || []).forEach((entry, index) => {
        const start = parseFrontmatterDate(entry.startTime);
        if (!start || start.format("YYYY-MM-DD") !== dayKey) {
          return;
        }
        entries.push({ task, entry, index });
      });
    });
    return entries.sort((a, b) => String(a.entry.startTime).localeCompare(String(b.entry.startTime)));
  }

  renderCenter(layout, selectedTasks) {
    const panel = layout.createDiv({ cls: "chronoboard-panel chronoboard-center" });
    const head = panel.createDiv({ cls: "chronoboard-panel-head chronoboard-center-head" });
    if (this.currentMode === "day") {
      head.createDiv({ cls: "chronoboard-center-title chronoboard-center-title-left", text: "Daily Time" });
      head.createDiv({ cls: "chronoboard-center-day-label", text: this.focusDate.format("dddd") });
      head.createDiv({ cls: "chronoboard-center-spacer" });
    } else {
      head.createDiv({
        cls: "chronoboard-center-title",
        text:
          this.currentMode === "week"
            ? "Weekly Time"
            : this.currentMode === "month"
              ? "Monthly Time"
              : "Statistics"
      });
    }

    if (this.currentMode === "week") {
      this.renderWeekTimeline(panel, selectedTasks);
      return;
    }
    if (this.currentMode === "day") {
      this.renderDayTimeline(panel, this.getScopedTasks(selectedTasks, { includeSelectedIfMissing: true }));
      return;
    }
    if (this.currentMode === "month") {
      this.renderMonthTimeline(panel, selectedTasks);
      return;
    }
    this.renderStatistics(panel, selectedTasks);
  }

  renderWeekTimeline(panel, selectedTasks) {
    const selectedTask = selectedTasks.find((task) => task.path === this.selectedTaskPath);
    const weekDays = this.getWeekDays();
    this.currentHourHeight = this.getDynamicHourHeight(panel);
    const wrapper = panel.createDiv({ cls: "chronoboard-week-layout" });
    wrapper.style.setProperty("--chronoboard-hour-height", `${this.currentHourHeight}px`);

    wrapper.createDiv({ cls: "chronoboard-week-corner" });

    const dayHead = wrapper.createDiv({ cls: "chronoboard-week-head" });
    dayHead.style.gridTemplateColumns = `repeat(${weekDays.length}, minmax(0, 1fr))`;
    for (const dayMoment of weekDays) {
      const day = dayHead.createDiv({ cls: "chronoboard-day" });
      const headRow = day.createDiv({ cls: "chronoboard-day-head-row" });
      const left = headRow.createDiv({ cls: "chronoboard-day-head-left" });
      left.createSpan({ cls: "chronoboard-day-name", text: dayMoment.format("ddd") });
      left.createSpan({ cls: "chronoboard-day-date", text: dayMoment.format("MMM D") });
      headRow.createSpan({
        cls: `chronoboard-day-total ${getHoursColor(selectedTasks.reduce((sum, task) => sum + this.getMinutesForDay(task.timeEntries || [], dayMoment.format("YYYY-MM-DD")), 0))}`,
        text: formatHours(selectedTasks.reduce((sum, task) => sum + this.getMinutesForDay(task.timeEntries || [], dayMoment.format("YYYY-MM-DD")), 0))
      });
    }

    const hours = wrapper.createDiv({ cls: "chronoboard-week-hours" });
    const grid = wrapper.createDiv({ cls: "chronoboard-week-grid" });
    grid.style.gridTemplateColumns = `repeat(${weekDays.length}, minmax(0, 1fr))`;
    this.syncScrollPair(hours, grid, "vertical");

    this.renderHourMarkers(hours, false, this.currentHourHeight);

    for (const dayMoment of weekDays) {
      const dayKey = dayMoment.format("YYYY-MM-DD");
      const column = grid.createDiv({ cls: "chronoboard-week-day-column" });
      column.style.height = `${this.getTimelineHeight()}px`;
      column.addEventListener("mousedown", (event) => this.handleWeekMouseDown(event, selectedTask, dayMoment, column));
      if (this.dragState && this.dragState.action !== "resize" && this.dragState.mode === "week" && this.dragState.dayKey === dayKey) {
        column.addClass("is-dragging");
        this.renderDraftBlock(column, this.dragState, false);
      }

      selectedTasks.forEach((task) => {
        (task.timeEntries || []).forEach((entry, index) => {
          const start = parseFrontmatterDate(entry.startTime);
          if (!start || start.format("YYYY-MM-DD") !== dayKey) {
            return;
          }
          this.renderEntryBlock(column, entry, task, index, false);
        });
      });
    }
  }

  renderDayTimeline(panel, selectedTasks) {
    const selectedDay = this.focusDate.clone().startOf("day");
    this.currentHourHeight = this.getDynamicHourHeight(panel);
    const wrapper = panel.createDiv({ cls: "chronoboard-day-layout" });
    wrapper.style.setProperty("--chronoboard-hour-height", `${this.currentHourHeight}px`);

    wrapper.createDiv({ cls: "chronoboard-day-left-head", text: "Task" });
    const hoursHead = wrapper.createDiv({ cls: "chronoboard-day-hours-head" });
    const timelineWidth = Math.max((panel.getBoundingClientRect().width || 0) - 221, this.getVisibleHourCount() * 84);
    const dayHourWidth = timelineWidth / this.getVisibleHourCount();
    const hoursTrack = hoursHead.createDiv({ cls: "chronoboard-day-hours-track" });
    hoursTrack.style.width = `${timelineWidth}px`;
    hoursTrack.style.setProperty("--chronoboard-hour-count", String(this.getVisibleHourCount()));
    hoursTrack.style.setProperty("--chronoboard-day-hour-width", `${dayHourWidth}px`);
    this.renderHourMarkers(hoursTrack, true, null, dayHourWidth);

    const taskColumn = wrapper.createDiv({ cls: "chronoboard-day-task-column" });
    const gridColumn = wrapper.createDiv({ cls: "chronoboard-day-grid-column" });
    const gridContent = gridColumn.createDiv({ cls: "chronoboard-day-grid-content" });
    gridContent.style.width = `${timelineWidth}px`;
    this.syncScrollPair(taskColumn, gridColumn, "vertical");
    this.syncScrollPair(hoursHead, gridColumn, "horizontal");

    if (!selectedTasks.length) {
      gridContent.createDiv({
        cls: "chronoboard-empty",
        text: "Add a task on the left to start logging time."
      });
      return;
    }

    selectedTasks.forEach((task) => {
      const taskCard = taskColumn.createDiv({
        cls: `chronoboard-day-task-card${task.path === this.selectedTaskPath ? " is-selected" : ""}${this.taskHasVisibleTime(task) ? " has-time" : ""}`
      });
      taskCard.createDiv({ cls: "chronoboard-task-key", text: task.jiraKey || task.file.basename });
      const secondaryText = this.plugin.getTaskSecondaryText(task);
      if (secondaryText) {
        taskCard.createDiv({ cls: "chronoboard-task-name", text: secondaryText });
      }
      if (this.shouldDisplayTaskStatus(task)) {
        taskCard.createDiv({ cls: `chronoboard-task-meta chronoboard-status ${getStatusToneClass(task.status)}`, text: task.status });
      }
      this.applyTicketSurfaceStyle(taskCard, task, this.taskHasVisibleTime(task));
      taskCard.addEventListener("click", async () => {
        this.selectedTaskPath = task.path;
        await this.render();
      });
      taskCard.addEventListener("dblclick", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        await this.openTask(task);
      });
      taskCard.addEventListener("contextmenu", (event) => this.openTicketContextMenu(event, task));

      const row = gridContent.createDiv({ cls: "chronoboard-day-row" });
      row.style.setProperty("--chronoboard-day-hour-width", `${dayHourWidth}px`);
      row.addEventListener("mousedown", (event) => this.handleDayMouseDown(event, task, selectedDay, row));

      if (this.dragState && this.dragState.action !== "resize" && this.dragState.mode === "day" && this.dragState.taskPath === task.path) {
        row.addClass("is-dragging");
        this.renderDraftBlock(row, this.dragState, true);
      }

      (task.timeEntries || []).forEach((entry, index) => {
        const start = parseFrontmatterDate(entry.startTime);
        if (!start || start.format("YYYY-MM-DD") !== selectedDay.format("YYYY-MM-DD")) {
          return;
        }
        this.renderEntryBlock(row, entry, task, index, true);
      });
    });
  }

  renderMonthTimeline(panel, selectedTasks) {
    const monthStart = this.focusDate.clone().startOf("month");
    const monthDays = this.getMonthDays(monthStart);
    const wrapper = panel.createDiv({ cls: "chronoboard-month-layout" });
    const head = wrapper.createDiv({ cls: "chronoboard-month-head" });
    const monthLabels = this.plugin.settings.hideWeekends
      ? ["Mon", "Tue", "Wed", "Thu", "Fri"]
      : ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    head.style.gridTemplateColumns = `repeat(${monthLabels.length}, minmax(0, 1fr))`;
    monthLabels.forEach((label) => {
      head.createDiv({ cls: "chronoboard-month-head-cell", text: label });
    });

    const grid = wrapper.createDiv({ cls: "chronoboard-month-grid" });
    grid.style.gridTemplateColumns = `repeat(${monthLabels.length}, minmax(0, 1fr))`;
    for (const dayMoment of monthDays) {
      const dayKey = dayMoment.format("YYYY-MM-DD");
      const isCurrentMonth = dayMoment.month() === monthStart.month();
      const cell = grid.createDiv({
        cls: `chronoboard-month-cell${isCurrentMonth ? "" : " is-outside"}${dayMoment.isSame(moment(), "day") ? " is-today" : ""}`
      });
      const cellHead = cell.createDiv({ cls: "chronoboard-month-cell-head" });
      cellHead.createDiv({
        cls: "chronoboard-month-date",
        text: dayMoment.format("D")
      });

      const dayEntries = [];
      selectedTasks.forEach((task) => {
        (task.timeEntries || []).forEach((entry) => {
          const start = parseFrontmatterDate(entry.startTime);
          if (!start || start.format("YYYY-MM-DD") !== dayKey) {
            return;
          }
          dayEntries.push({ task, entry });
        });
      });

      const totalMinutes = dayEntries.reduce((sum, item) => sum + this.entryMinutes(item.entry), 0);
      cellHead.createDiv({
        cls: `chronoboard-month-total ${getHoursColor(totalMinutes)}`,
        text: totalMinutes ? formatHours(totalMinutes) : "0h"
      });

      const groupedEntries = this.groupMonthEntries(dayEntries);
      const layoutCount = Math.min(groupedEntries.length, 5);
      const list = cell.createDiv({
        cls: `chronoboard-month-entry-list count-${layoutCount || 0}`
      });

      const visibleEntries = groupedEntries.length >= 5 ? groupedEntries.slice(0, 3) : groupedEntries.slice(0, 4);
      visibleEntries.forEach((item, index) => {
        const tileClasses = ["chronoboard-month-entry"];
        if (!item.task.color) {
          tileClasses.push("is-default-color");
        }
        tileClasses.push(`slot-${index + 1}`);
        const pill = list.createDiv({ cls: tileClasses.join(" ") });
        this.applyTicketSurfaceStyle(pill, item.task, true);
        pill.createDiv({
          cls: "chronoboard-month-entry-key",
          text: item.task.jiraKey || item.task.file.basename
        });
        pill.createDiv({
          cls: "chronoboard-month-entry-hours",
          text: formatHours(item.minutes)
        });
      });

      if (groupedEntries.length >= 5) {
        list.createDiv({
          cls: "chronoboard-month-more slot-4",
          text: `+${groupedEntries.length - 3} more`
        });
      }
    }
  }

  groupMonthEntries(dayEntries) {
    const grouped = new Map();
    dayEntries.forEach(({ task, entry }) => {
      const existing = grouped.get(task.path) || {
        task,
        minutes: 0,
        earliestStart: entry.startTime,
        count: 0
      };
      existing.minutes += this.entryMinutes(entry);
      if (String(entry.startTime).localeCompare(String(existing.earliestStart)) < 0) {
        existing.earliestStart = entry.startTime;
      }
      existing.count += 1;
      grouped.set(task.path, existing);
    });

    return [...grouped.values()].sort((a, b) => {
      if (b.minutes !== a.minutes) {
        return b.minutes - a.minutes;
      }
      return String(a.earliestStart).localeCompare(String(b.earliestStart));
    });
  }

  renderStatistics(panel, selectedTasks) {
    const wrap = panel.createDiv({ cls: "chronoboard-stats-layout" });
    const todayKey = moment().format("YYYY-MM-DD");
    const monthStart = this.focusDate.clone().startOf("month");
    const monthEnd = monthStart.clone().endOf("month");
    const totalWeek = selectedTasks.reduce((sum, task) => sum + this.getMinutesForWeek(task.timeEntries || []), 0);
    const totalMonth = selectedTasks.reduce((sum, task) => sum + this.getMinutesForMonth(task.timeEntries || [], monthStart, monthEnd), 0);
    const totalToday = selectedTasks.reduce((sum, task) => sum + this.getMinutesForDay(task.timeEntries || [], todayKey), 0);

    const cards = wrap.createDiv({ cls: "chronoboard-stats-cards" });
    [
      { label: "Today", value: formatHours(totalToday) },
      { label: "This Week", value: formatHours(totalWeek) },
      { label: "This Month", value: formatHours(totalMonth) },
      { label: "Selected Tasks", value: String(selectedTasks.length) }
    ].forEach((stat) => {
      const card = cards.createDiv({ cls: "chronoboard-stats-card" });
      card.createDiv({ cls: "chronoboard-stats-value", text: stat.value });
      card.createDiv({ cls: "chronoboard-stats-label", text: stat.label });
    });

    const weekSection = wrap.createDiv({ cls: "chronoboard-stats-section" });
    weekSection.createDiv({ cls: "chronoboard-stats-section-title", text: "This Week by Day" });
    const weekBars = weekSection.createDiv({ cls: "chronoboard-stats-bars" });
    this.getWeekDays().forEach((dayMoment) => {
      const dayKey = dayMoment.format("YYYY-MM-DD");
      const minutes = selectedTasks.reduce((sum, task) => sum + this.getMinutesForDay(task.timeEntries || [], dayKey), 0);
      const bar = weekBars.createDiv({ cls: "chronoboard-stats-bar-wrap" });
      bar.createDiv({
        cls: `chronoboard-stats-bar ${getHoursColor(minutes)}`,
        attr: { style: `height:${Math.max((minutes / 480) * 160, 10)}px` }
      });
      bar.createDiv({ cls: "chronoboard-stats-bar-label", text: dayMoment.format("ddd") });
      bar.createDiv({ cls: "chronoboard-stats-bar-value", text: formatHours(minutes) });
    });

    const taskSection = wrap.createDiv({ cls: "chronoboard-stats-section" });
    taskSection.createDiv({ cls: "chronoboard-stats-section-title", text: "Top Weekly Tasks" });
    const taskList = taskSection.createDiv({ cls: "chronoboard-stats-task-list" });
    this.sortTasks(selectedTasks)
      .sort((a, b) => this.getMinutesForWeek(b.timeEntries || []) - this.getMinutesForWeek(a.timeEntries || []))
      .slice(0, 8)
      .forEach((task) => {
        const minutes = this.getMinutesForWeek(task.timeEntries || []);
        const row = taskList.createDiv({ cls: "chronoboard-stats-task-row" });
        const name = row.createDiv({ cls: "chronoboard-stats-task-name" });
        name.createDiv({ cls: "chronoboard-task-key", text: task.jiraKey || task.file.basename });
        const secondaryText = this.plugin.getTaskSecondaryText(task);
        if (secondaryText) {
          name.createDiv({ cls: "chronoboard-task-name", text: secondaryText });
        }
        row.createDiv({ cls: "chronoboard-stats-task-hours", text: formatHours(minutes) });
      });
  }

  syncScrollPair(first, second, axis) {
    let syncing = false;
    const property = axis === "horizontal" ? "scrollLeft" : "scrollTop";
    const sync = (source, target) => {
      if (syncing) {
        return;
      }
      syncing = true;
      target[property] = source[property];
      window.requestAnimationFrame(() => {
        syncing = false;
      });
    };
    first.addEventListener("scroll", () => sync(first, second));
    second.addEventListener("scroll", () => sync(second, first));
  }

  renderHourMarkers(container, horizontal, verticalHeight = null, horizontalWidth = null) {
    const start = this.plugin.settings.visibleStartHour;
    const end = this.plugin.settings.visibleEndHour;
    for (let hour = start; hour < end; hour += 1) {
      const marker = container.createDiv({
        cls: horizontal ? "chronoboard-hour-marker-horizontal" : "chronoboard-hour-marker-vertical"
      });
      if (!horizontal && verticalHeight) {
        marker.style.height = `${verticalHeight}px`;
      }
      if (horizontal && horizontalWidth) {
        marker.style.width = `${horizontalWidth}px`;
      }
      marker.setText(moment({ hour }).format("h A").toLowerCase());
    }
  }

  renderEntryBlock(container, entry, task, index, horizontal) {
    const block = container.createDiv({
      cls: `chronoboard-block${task.path === this.selectedTaskPath ? " is-selected-task" : ""}`
    });
    const renderedEntry = this.getRenderedEntryForBlock(task, index, entry);
    const position = horizontal
      ? this.calculateHorizontalBlock(renderedEntry, container.clientWidth || container.getBoundingClientRect().width || this.getVisibleHourCount() * 84)
      : this.calculateVerticalBlock(renderedEntry);
    if (horizontal) {
      block.style.left = `${position.startPx}px`;
      block.style.width = `${position.sizePx}px`;
      block.style.top = "2px";
      block.style.bottom = "2px";
    } else {
      block.style.top = `${position.startPx}px`;
      block.style.height = `${position.sizePx}px`;
    }
    const hideTimeLine = horizontal ? position.sizePx < 92 : false;
    const showStatus = this.shouldDisplayTaskStatus(task) && (horizontal ? position.sizePx >= 150 : true);
    this.applyTicketSurfaceStyle(block, task, true);
    const head = block.createDiv({ cls: "chronoboard-block-head" });
    head.createDiv({
      cls: "chronoboard-task-name",
      text: task.jiraKey || task.file.basename
    });
    if (showStatus) {
      head.createDiv({
        cls: `chronoboard-block-status ${getStatusToneClass(task.status)}`,
        text: task.status
      });
    }
    const secondaryText = this.plugin.getTaskSecondaryText(task);
    if (secondaryText) {
      block.createDiv({
        cls: "chronoboard-block-subtitle",
        text: secondaryText
      });
    }
    if (!hideTimeLine) {
      block.createDiv({
        cls: "chronoboard-block-time",
        text: `${moment(renderedEntry.startTime).format("HH:mm")} to ${moment(renderedEntry.endTime).format("HH:mm")}`
      });
    }
    if (entry.label) {
      block.createDiv({
        cls: "chronoboard-block-notes",
        text: entry.label
      });
    }

    const startHandle = block.createDiv({
      cls: `chronoboard-resize-handle ${horizontal ? "is-horizontal-start" : "is-vertical-start"}`
    });
    const endHandle = block.createDiv({
      cls: `chronoboard-resize-handle ${horizontal ? "is-horizontal-end" : "is-vertical-end"}`
    });

    block.addEventListener("mousedown", (event) => {
      event.stopPropagation();
      if (event.button !== 0) {
        return;
      }
      this.startPendingMoveHold(event, task, entry, index, horizontal, container);
    });
    block.addEventListener("mouseup", () => this.cancelPendingMoveHold());
    block.addEventListener("mouseleave", () => this.cancelPendingMoveHold());
    startHandle.addEventListener("mousedown", (event) => {
      this.cancelPendingMoveHold();
      event.preventDefault();
      event.stopPropagation();
      this.startResizeDrag(event, task, entry, index, horizontal, "start", container);
    });
    endHandle.addEventListener("mousedown", (event) => {
      this.cancelPendingMoveHold();
      event.preventDefault();
      event.stopPropagation();
      this.startResizeDrag(event, task, entry, index, horizontal, "end", container);
    });
    block.addEventListener("click", async (event) => {
      if (event.button !== 0 || event.detail !== 2) {
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      await this.plugin.removeTimeEntry(task.file, entry, index, { pushUndo: true });
      await this.render();
    });
    block.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.closeActiveContextMenu();
      const menu = new Menu();
      this.activeContextMenu = menu;
      menu.addItem((item) =>
        item
          .setTitle("Open task")
          .setIcon("file-text")
          .onClick(async () => {
            await this.app.workspace.getLeaf("tab").openFile(task.file);
          })
      );
      menu.addItem((item) =>
        item
          .setTitle("Change color")
          .setIcon("palette")
          .onClick(() => this.openColorModal(task))
      );
      menu.addItem((item) =>
        item
          .setTitle("Edit task subtitle")
          .setIcon("text")
          .onClick(() => this.openSubtitleModal(task))
      );
      menu.addItem((item) =>
        item
          .setTitle("Edit task block text")
          .setIcon("text-cursor-input")
          .onClick(() => {
            new TimeBoxTextModal(this.app, {
              initialText: entry.label || "",
              onSave: async (label) => {
                await this.plugin.updateTimeEntry(task.file, index, {
                  ...entry,
                  label
                });
                await this.render();
              }
            }).open();
          })
      );
      menu.addItem((item) =>
        item
          .setTitle(this.resolveTimeEntryNote(entry) ? "Open time entry note" : "Create time entry note")
          .setIcon("sticky-note")
          .onClick(async () => {
            await this.openOrCreateTimeEntryNote(task, index, entry);
          })
      );
      menu.addItem((item) =>
        item
          .setTitle("Precise Edit Time")
          .setIcon("pencil")
          .onClick(() => {
            new PreciseTimeEditModal(this.app, {
              entry,
              onSave: async (updatedEntry) => {
                await this.plugin.updateTimeEntry(task.file, index, { ...entry, ...updatedEntry });
                await this.render();
              }
            }).open();
          })
      );
      menu.addItem((item) =>
        item
          .setTitle("Remove time block")
          .setIcon("trash")
          .onClick(async () => {
            await this.plugin.removeTimeEntry(task.file, entry, index, { pushUndo: true });
            await this.render();
          })
      );
      menu.showAtMouseEvent(event);
      this.decorateActiveMenu("Remove time block");
    });
  }

  renderDraftBlock(container, dragState, horizontal) {
    const block = container.createDiv({ cls: "chronoboard-draft-block" });
    const position = this.calculateDraftPosition(dragState, horizontal);
    if (horizontal) {
      block.style.left = `${position.startPx}px`;
      block.style.width = `${position.sizePx}px`;
      block.style.top = "8px";
      block.style.bottom = "8px";
    } else {
      block.style.top = `${position.startPx}px`;
      block.style.height = `${position.sizePx}px`;
    }
  }

  getRenderedEntryForBlock(task, index, entry) {
    if (
      this.dragState &&
      (this.dragState.action === "resize" || this.dragState.action === "move") &&
      this.dragState.taskPath === task.path &&
      this.dragState.entryIndex === index
    ) {
      return (
        this.dragState.action === "resize"
          ? this.entryFromResizeState(this.dragState)
          : this.entryFromMoveState(this.dragState)
      ) || entry;
    }
    return entry;
  }

  startResizeDrag(event, task, entry, entryIndex, horizontal, containerEdge, container) {
    if (event.button !== 0) {
      return;
    }
    const rect = container.getBoundingClientRect();
    this.dragState = {
      action: "resize",
      mode: horizontal ? "day" : "week",
      taskPath: task.path,
      file: task.file,
      dayKey: moment(entry.startTime).format("YYYY-MM-DD"),
      rect,
      entryIndex,
      edge: containerEdge,
      originalEntry: { ...entry },
      currentCoord: clampNumber(horizontal ? event.clientX - rect.left : event.clientY - rect.top, 0, horizontal ? rect.width : rect.height)
    };
    this.selectedTaskPath = task.path;
    this.addDragListeners();
    this.render();
  }

  startPendingMoveHold(event, task, entry, entryIndex, horizontal, container) {
    this.cancelPendingMoveHold();
    this.pendingMoveHold = window.setTimeout(() => {
      const rect = container.getBoundingClientRect();
      this.dragState = {
        action: "move",
        mode: horizontal ? "day" : "week",
        taskPath: task.path,
        file: task.file,
        dayKey: moment(entry.startTime).format("YYYY-MM-DD"),
        rect,
        entryIndex,
        originalEntry: { ...entry },
        startCoord: clampNumber(horizontal ? event.clientX - rect.left : event.clientY - rect.top, 0, horizontal ? rect.width : rect.height),
        currentCoord: clampNumber(horizontal ? event.clientX - rect.left : event.clientY - rect.top, 0, horizontal ? rect.width : rect.height)
      };
      this.selectedTaskPath = task.path;
      this.addDragListeners();
      this.render();
      this.pendingMoveHold = null;
    }, 500);
  }

  cancelPendingMoveHold() {
    if (this.pendingMoveHold) {
      window.clearTimeout(this.pendingMoveHold);
      this.pendingMoveHold = null;
    }
  }

  async openTask(task) {
    await this.app.workspace.getLeaf("tab").openFile(task.file);
  }

  openSummarySortMenu(event) {
    event.preventDefault();
    event.stopPropagation();
    const menu = new Menu();
    Object.entries(SUMMARY_SORT_OPTIONS).forEach(([key, label]) => {
      menu.addItem((item) => {
        item.setTitle(label);
        if (this.currentSummarySort === key) {
          item.setIcon("check");
        }
        item.onClick(async () => {
          this.currentSummarySort = key;
          await this.render();
        });
      });
    });
    menu.showAtMouseEvent(event);
  }

  renderSummary(layout, selectedTasks) {
    const scopedTasks = this.getSummarySortedTasks(selectedTasks);
    const panel = layout.createDiv({ cls: "chronoboard-panel" });
    const panelHead = panel.createDiv({ cls: "chronoboard-panel-head" });
    panelHead.createDiv({
      text: this.currentMode === "day" ? "Daily Total" : this.currentMode === "month" ? "Monthly Total" : "Weekly Total"
    });
    const headMeta = panelHead.createDiv({ cls: "chronoboard-summary-head-meta" });
    headMeta.createDiv({
      cls: "chronoboard-summary-head-total",
      text: formatHours(scopedTasks.reduce((sum, task) => sum + this.getSummaryMinutesForTask(task), 0))
    });
    const sortTrigger = headMeta.createSpan({ cls: "chronoboard-summary-sort-trigger" });
    setIcon(sortTrigger, SUMMARY_SORT_ICONS[this.currentSummarySort] || SUMMARY_SORT_ICONS.status);
    sortTrigger.setAttr("role", "button");
    sortTrigger.setAttr("tabindex", "0");
    sortTrigger.setAttr("aria-label", `Sort totals: ${SUMMARY_SORT_OPTIONS[this.currentSummarySort] || SUMMARY_SORT_OPTIONS.status}`);
    sortTrigger.setAttr("title", `Sort totals: ${SUMMARY_SORT_OPTIONS[this.currentSummarySort] || SUMMARY_SORT_OPTIONS.status}`);
    sortTrigger.addEventListener("click", (event) => this.openSummarySortMenu(event));
    sortTrigger.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        this.openSummarySortMenu(event);
      }
    });

    if (this.rightPanelCollapsed) {
      return;
    }

    const list = panel.createDiv({ cls: "chronoboard-summary-list" });

    if (!scopedTasks.length) {
      list.createDiv({
        cls: "chronoboard-empty",
        text: "Weekly totals appear here once tasks are selected."
      });
      return;
    }

    scopedTasks.forEach((task) => {
      const card = list.createDiv({
        cls: `chronoboard-summary-card${task.path === this.selectedTaskPath ? " is-selected" : ""}${this.taskHasVisibleTime(task) ? " has-time" : ""}`
      });
      this.applyTicketSurfaceStyle(card, task, this.taskHasVisibleTime(task));
      card.createDiv({ cls: "chronoboard-task-key", text: task.jiraKey || task.file.basename });
      const secondaryText = this.plugin.getTaskSecondaryText(task);
      if (secondaryText) {
        card.createDiv({ cls: "chronoboard-task-name", text: secondaryText });
      }
      card.createDiv({ cls: "chronoboard-summary-hours", text: formatHours(this.getSummaryMinutesForTask(task)) });
      card.createDiv({
        cls: "chronoboard-summary-note",
        text: this.currentMode === "day" ? "Tracked this day" : this.currentMode === "month" ? "Tracked this month" : "Tracked this week"
      });
      card.addEventListener("click", async () => {
        this.selectedTaskPath = task.path;
        await this.render();
      });
      card.addEventListener("dblclick", async (event) => {
        event.preventDefault();
        event.stopPropagation();
        await this.openTask(task);
      });
      card.addEventListener("contextmenu", (event) => this.openTicketContextMenu(event, task));
    });
  }

  openTicketContextMenu(event, task) {
    event.preventDefault();
    event.stopPropagation();
    this.closeActiveContextMenu();
    const menu = new Menu();
    this.activeContextMenu = menu;
    menu.addItem((item) =>
      item
        .setTitle("Open task")
        .setIcon("file-text")
        .onClick(async () => {
          await this.app.workspace.getLeaf("tab").openFile(task.file);
        })
    );
    menu.addItem((item) =>
      item
        .setTitle("Change color")
        .setIcon("palette")
        .onClick(() => this.openColorModal(task))
    );
    menu.addItem((item) =>
      item
        .setTitle("Edit task subtitle")
        .setIcon("text")
        .onClick(() => this.openSubtitleModal(task))
    );
    if (!this.isStaticTask(task.path)) {
      menu.addSeparator();
      menu.addItem((item) =>
        item
          .setTitle("Remove Task")
          .setIcon("trash")
          .onClick(async () => {
            this.plugin.settings.selectedTaskPaths = this.plugin.settings.selectedTaskPaths.filter((path) => path !== task.path);
            const hasHistory = Array.isArray(task.timeEntries) && task.timeEntries.length > 0;
            this.plugin.settings.boardOnlyTaskPaths = hasHistory
              ? [...new Set([...(this.plugin.settings.boardOnlyTaskPaths || []), task.path])]
              : (this.plugin.settings.boardOnlyTaskPaths || []).filter((path) => path !== task.path);
            await this.plugin.saveSettings();
            if (this.selectedTaskPath === task.path) {
              this.selectedTaskPath = this.getSelectedPaths()[0] || this.getBoardPaths()[0] || null;
            }
            await this.render();
          })
      );
    }
    menu.showAtMouseEvent(event);
    this.decorateActiveMenu("Remove Task");
  }

  closeActiveContextMenu() {
    if (this.activeContextMenu && typeof this.activeContextMenu.hide === "function") {
      this.activeContextMenu.hide();
    }
    this.activeContextMenu = null;
    document.querySelectorAll(".menu").forEach((element) => element.remove());
  }

  decorateActiveMenu(removeLabel) {
    window.setTimeout(() => {
      const menus = [...document.querySelectorAll(".menu")];
      const menu = menus[menus.length - 1];
      if (!menu) {
        return;
      }
      const items = [...menu.querySelectorAll(".menu-item")];
      const removeItem = items.find((item) => item.textContent && item.textContent.includes(removeLabel));
      if (removeItem) {
        removeItem.classList.add("chronoboard-menu-remove-item");
      }
      const separators = [...menu.querySelectorAll(".menu-separator")];
      const lastSeparator = separators[separators.length - 1];
      if (lastSeparator && removeItem) {
        lastSeparator.classList.add("chronoboard-menu-remove-separator");
      } else if (removeItem) {
        removeItem.classList.add("chronoboard-menu-remove-item-with-divider");
      }
    }, 0);
  }

  openColorModal(task) {
    new TicketColorModal(this.app, {
      initialColor: task.color,
      onSave: async (color) => {
        await this.plugin.updateTicketColor(task.file, color);
        await this.render();
      },
      onClear: async () => {
        await this.plugin.updateTicketColor(task.file, "");
        await this.render();
      }
    }).open();
  }

  openSubtitleModal(task) {
    new TicketSubtitleModal(this.app, {
      initialText: task.subtitle,
      onSave: async (subtitle) => {
        await this.plugin.updateTicketSubtitle(task.file, subtitle);
        await this.render();
      }
    }).open();
  }

  applyTicketSurfaceStyle(element, task, isColoredState) {
    const color = normalizeHexColor(task.color);
    if (!color || !isColoredState) {
      element.style.removeProperty("background");
      element.style.removeProperty("border-color");
      element.style.removeProperty("color");
      return;
    }
    const textColor = this.plugin.settings.forceDarkTextOnColored ? "#111111" : getContrastTextColor(color);
    element.style.background = color;
    element.style.borderColor = color;
    element.style.color = textColor;
    element.style.setProperty("--chronoboard-custom-text", textColor);
  }

  async openOrCreateTimeEntryNote(task, entryIndex, entry) {
    const entryId = entry.id || createEntryId();

    if (entry.notePath) {
      const existing = this.app.vault.getAbstractFileByPath(entry.notePath);
      if (existing instanceof TFile) {
        if (!entry.id) {
          await this.plugin.updateTimeEntry(task.file, entryIndex, {
            ...entry,
            id: entryId
          });
        }
        await this.app.workspace.getLeaf("tab").openFile(existing);
        return;
      }
    }

    const aliasedNote = this.plugin.findTimeEntryNoteById(entryId);
    if (aliasedNote) {
      await this.plugin.updateTimeEntry(task.file, entryIndex, {
        ...entry,
        id: entryId,
        notePath: aliasedNote.path
      });
      await this.app.workspace.getLeaf("tab").openFile(aliasedNote);
      return;
    }

    const folder = this.plugin.settings.timeEntryNotesFolder;
    if (!this.app.vault.getAbstractFileByPath(folder)) {
      await this.app.vault.createFolder(folder);
    }

    const key = task.jiraKey || task.file.basename;
    const start = moment(entry.startTime).format("YYYY-MM-DD HHmm");
    const labelSegment = sanitizeFileSegment(entry.label || "");
    const baseName = sanitizeFileSegment(
      labelSegment ? `${key} ${labelSegment} ${start}` : `${key} ${start}`
    );
    let filePath = `${folder}/${baseName}.md`;
    let counter = 2;
    while (this.app.vault.getAbstractFileByPath(filePath)) {
      filePath = `${folder}/${baseName} ${counter}.md`;
      counter += 1;
    }

    const body = await this.plugin.buildTimeEntryNoteContent(task, entryId, entry);

    const noteFile = await this.app.vault.create(filePath, body);
    await this.plugin.updateTimeEntry(task.file, entryIndex, {
      ...entry,
      id: entryId,
      notePath: noteFile.path
    });
    await this.app.workspace.getLeaf("tab").openFile(noteFile);
  }

  resolveTimeEntryNote(entry) {
    if (entry.notePath) {
      const existing = this.app.vault.getAbstractFileByPath(entry.notePath);
      if (existing instanceof TFile) {
        return existing;
      }
    }
    const entryId = entry?.id;
    return entryId ? this.plugin.findTimeEntryNoteById(entryId) : null;
  }

  handleWeekMouseDown(event, selectedTask, dayMoment, column) {
    if (event.button !== 0 || !selectedTask) {
      return;
    }
    const rect = column.getBoundingClientRect();
    this.dragState = {
      action: "create",
      mode: "week",
      taskPath: selectedTask.path,
      file: selectedTask.file,
      dayKey: dayMoment.format("YYYY-MM-DD"),
      rect,
      startCoord: clampNumber(event.clientY - rect.top, 0, rect.height),
      currentCoord: clampNumber(event.clientY - rect.top, 0, rect.height)
    };
    this.addDragListeners();
    this.render();
  }

  handleDayMouseDown(event, task, dayMoment, row) {
    if (event.button !== 0) {
      return;
    }
    const rect = row.getBoundingClientRect();
    this.dragState = {
      action: "create",
      mode: "day",
      taskPath: task.path,
      file: task.file,
      dayKey: dayMoment.format("YYYY-MM-DD"),
      rect,
      startCoord: clampNumber(event.clientX - rect.left, 0, rect.width),
      currentCoord: clampNumber(event.clientX - rect.left, 0, rect.width)
    };
    this.selectedTaskPath = task.path;
    this.addDragListeners();
    this.render();
  }

  addDragListeners() {
    this.removeDragListeners();
    window.addEventListener("mousemove", this.boundMouseMove);
    window.addEventListener("mouseup", this.boundMouseUp);
  }

  removeDragListeners() {
    window.removeEventListener("mousemove", this.boundMouseMove);
    window.removeEventListener("mouseup", this.boundMouseUp);
  }

  handleMouseMove(event) {
    if (!this.dragState) {
      return;
    }
    if (this.dragState.mode === "week") {
      this.dragState.currentCoord = clampNumber(event.clientY - this.dragState.rect.top, 0, this.dragState.rect.height);
    } else {
      this.dragState.currentCoord = clampNumber(event.clientX - this.dragState.rect.left, 0, this.dragState.rect.width);
    }
    this.render();
  }

  async handleMouseUp() {
    this.cancelPendingMoveHold();
    if (!this.dragState) {
      return;
    }
    const dragState = { ...this.dragState };
    this.dragState = null;
    this.removeDragListeners();

    if (dragState.action === "resize") {
      const updatedEntry = this.entryFromResizeState(dragState);
      if (
        updatedEntry &&
        (updatedEntry.startTime !== dragState.originalEntry.startTime || updatedEntry.endTime !== dragState.originalEntry.endTime)
      ) {
        await this.plugin.updateTimeEntry(dragState.file, dragState.entryIndex, {
          ...dragState.originalEntry,
          ...updatedEntry
        });
      }
    } else if (dragState.action === "move") {
      const updatedEntry = this.entryFromMoveState(dragState);
      if (
        updatedEntry &&
        (updatedEntry.startTime !== dragState.originalEntry.startTime || updatedEntry.endTime !== dragState.originalEntry.endTime)
      ) {
        await this.plugin.updateTimeEntry(dragState.file, dragState.entryIndex, {
          ...dragState.originalEntry,
          ...updatedEntry
        });
      }
    } else {
      const entry = this.entryFromDragState(dragState);
      if (entry) {
        await this.plugin.addTimeEntry(dragState.file, entry, { pushUndo: true });
      }
    }
    await this.render();
  }

  calculateDraftPosition(dragState, horizontal) {
    const start = Math.min(dragState.startCoord, dragState.currentCoord);
    const end = Math.max(dragState.startCoord, dragState.currentCoord);
    return {
      startPx: start,
      sizePx: Math.max(end - start, horizontal ? 8 : 8)
    };
  }

  entryFromDragState(dragState) {
    if (Math.abs(dragState.currentCoord - dragState.startCoord) < 6) {
      return null;
    }
    const dayMoment = moment(dragState.dayKey, "YYYY-MM-DD");
    const startCoord = Math.min(dragState.startCoord, dragState.currentCoord);
    const endCoord = Math.max(dragState.startCoord, dragState.currentCoord);
    const totalMinutes = this.getVisibleHourCount() * 60;

    let startMinutesIntoWindow;
    let endMinutesIntoWindow;

    if (dragState.mode === "week") {
      startMinutesIntoWindow = (startCoord / dragState.rect.height) * totalMinutes;
      endMinutesIntoWindow = (endCoord / dragState.rect.height) * totalMinutes;
    } else {
      startMinutesIntoWindow = (startCoord / dragState.rect.width) * totalMinutes;
      endMinutesIntoWindow = (endCoord / dragState.rect.width) * totalMinutes;
    }

    const roundedStart = Math.floor(startMinutesIntoWindow / 15) * 15;
    const roundedEnd = Math.ceil(endMinutesIntoWindow / 15) * 15;
    if (roundedEnd <= roundedStart) {
      return null;
    }

    const start = dayMoment.clone().startOf("day").add(this.plugin.settings.visibleStartHour * 60 + roundedStart, "minutes");
    const end = dayMoment.clone().startOf("day").add(this.plugin.settings.visibleStartHour * 60 + roundedEnd, "minutes");

    return {
      startTime: start.format("YYYY-MM-DDTHH:mm"),
      endTime: end.format("YYYY-MM-DDTHH:mm")
    };
  }

  entryFromResizeState(dragState) {
    if (!dragState || dragState.action !== "resize") {
      return null;
    }
    const totalMinutes = this.getVisibleHourCount() * 60;
    const totalPixels = dragState.mode === "week" ? dragState.rect.height : dragState.rect.width;
    const originalEntry = dragState.originalEntry;
    const originalStart = parseFrontmatterDate(originalEntry.startTime);
    const originalEnd = parseFrontmatterDate(originalEntry.endTime);
    if (!originalStart || !originalEnd || totalPixels <= 0) {
      return null;
    }
    const visibleStartMinutes = this.plugin.settings.visibleStartHour * 60;
    const startWithinWindow = clampNumber(originalStart.hours() * 60 + originalStart.minutes(), visibleStartMinutes, this.plugin.settings.visibleEndHour * 60);
    const endWithinWindow = clampNumber(originalEnd.hours() * 60 + originalEnd.minutes(), visibleStartMinutes, this.plugin.settings.visibleEndHour * 60);
    let startMinutesIntoWindow = startWithinWindow - visibleStartMinutes;
    let endMinutesIntoWindow = endWithinWindow - visibleStartMinutes;
    const currentMinutes = (dragState.currentCoord / totalPixels) * totalMinutes;

    if (dragState.edge === "start") {
      startMinutesIntoWindow = Math.floor(currentMinutes / 15) * 15;
      startMinutesIntoWindow = clampNumber(startMinutesIntoWindow, 0, Math.max(endMinutesIntoWindow - 15, 0));
    } else {
      endMinutesIntoWindow = Math.ceil(currentMinutes / 15) * 15;
      endMinutesIntoWindow = clampNumber(endMinutesIntoWindow, Math.min(startMinutesIntoWindow + 15, totalMinutes), totalMinutes);
    }

    if (endMinutesIntoWindow <= startMinutesIntoWindow) {
      return null;
    }

    const dayMoment = moment(dragState.dayKey, "YYYY-MM-DD");
    const start = dayMoment.clone().startOf("day").add(visibleStartMinutes + startMinutesIntoWindow, "minutes");
    const end = dayMoment.clone().startOf("day").add(visibleStartMinutes + endMinutesIntoWindow, "minutes");
    return {
      startTime: start.format("YYYY-MM-DDTHH:mm"),
      endTime: end.format("YYYY-MM-DDTHH:mm")
    };
  }

  entryFromMoveState(dragState) {
    if (!dragState || dragState.action !== "move") {
      return null;
    }
    const totalMinutes = this.getVisibleHourCount() * 60;
    const totalPixels = dragState.mode === "week" ? dragState.rect.height : dragState.rect.width;
    const originalEntry = dragState.originalEntry;
    const originalStart = parseFrontmatterDate(originalEntry.startTime);
    const originalEnd = parseFrontmatterDate(originalEntry.endTime);
    if (!originalStart || !originalEnd || totalPixels <= 0) {
      return null;
    }
    const deltaPixels = dragState.currentCoord - dragState.startCoord;
    const deltaMinutes = Math.round(((deltaPixels / totalPixels) * totalMinutes) / 15) * 15;
    const visibleStartMinutes = this.plugin.settings.visibleStartHour * 60;
    const visibleEndMinutes = this.plugin.settings.visibleEndHour * 60;
    const durationMinutes = Math.max(originalEnd.diff(originalStart, "minutes"), 15);
    let movedStartMinutes = originalStart.hours() * 60 + originalStart.minutes() + deltaMinutes;
    movedStartMinutes = clampNumber(movedStartMinutes, visibleStartMinutes, visibleEndMinutes - durationMinutes);
    const dayMoment = moment(dragState.dayKey, "YYYY-MM-DD");
    const start = dayMoment.clone().startOf("day").add(movedStartMinutes, "minutes");
    const end = start.clone().add(durationMinutes, "minutes");
    return {
      startTime: start.format("YYYY-MM-DDTHH:mm"),
      endTime: end.format("YYYY-MM-DDTHH:mm")
    };
  }

  calculateVerticalBlock(entry) {
    const start = parseFrontmatterDate(entry.startTime);
    const end = parseFrontmatterDate(entry.endTime);
    const visibleStartMinutes = this.plugin.settings.visibleStartHour * 60;
    const visibleEndMinutes = this.plugin.settings.visibleEndHour * 60;
    const entryStart = clampNumber(start.hours() * 60 + start.minutes(), visibleStartMinutes, visibleEndMinutes);
    const entryEnd = clampNumber(end.hours() * 60 + end.minutes(), visibleStartMinutes, visibleEndMinutes);
    const hourHeight = this.currentHourHeight || PX_PER_HOUR;
    const startPx = ((entryStart - visibleStartMinutes) / 60) * hourHeight;
    const sizePx = Math.max(((entryEnd - entryStart) / 60) * hourHeight, 12);
    return { startPx, sizePx };
  }

  calculateHorizontalBlock(entry, totalWidth) {
    const start = parseFrontmatterDate(entry.startTime);
    const end = parseFrontmatterDate(entry.endTime);
    const visibleStartMinutes = this.plugin.settings.visibleStartHour * 60;
    const visibleEndMinutes = this.plugin.settings.visibleEndHour * 60;
    const pxPerMinute = (totalWidth / this.getVisibleHourCount()) / 60;
    const entryStart = clampNumber(start.hours() * 60 + start.minutes(), visibleStartMinutes, visibleEndMinutes);
    const entryEnd = clampNumber(end.hours() * 60 + end.minutes(), visibleStartMinutes, visibleEndMinutes);
    const startPx = (entryStart - visibleStartMinutes) * pxPerMinute;
    const sizePx = Math.max((entryEnd - entryStart) * pxPerMinute, 12);
    return { startPx, sizePx };
  }

  entryMinutes(entry) {
    const start = parseFrontmatterDate(entry.startTime);
    const end = parseFrontmatterDate(entry.endTime);
    if (!start || !end) {
      return 0;
    }
    return Math.max(end.diff(start, "minutes"), 0);
  }

  getMinutesForWeek(entries) {
    const weekStart = this.focusDate.clone().startOf("isoWeek").startOf("day");
    const weekEnd = weekStart.clone().add(7, "days");
    return entries.reduce((sum, entry) => {
      const start = parseFrontmatterDate(entry.startTime);
      if (!start || start.isBefore(weekStart) || !start.isBefore(weekEnd)) {
        return sum;
      }
      return sum + this.entryMinutes(entry);
    }, 0);
  }

  getMinutesForDay(entries, dayKey) {
    return entries.reduce((sum, entry) => {
      const start = parseFrontmatterDate(entry.startTime);
      if (!start || start.format("YYYY-MM-DD") !== dayKey) {
        return sum;
      }
      return sum + this.entryMinutes(entry);
    }, 0);
  }

  getMinutesForMonth(entries, monthStart, monthEnd) {
    return entries.reduce((sum, entry) => {
      const start = parseFrontmatterDate(entry.startTime);
      if (!start || start.isBefore(monthStart) || start.isAfter(monthEnd)) {
        return sum;
      }
      return sum + this.entryMinutes(entry);
    }, 0);
  }

  getSummaryMinutesForTask(task) {
    if (this.currentMode === "day") {
      return this.getMinutesForDay(task.timeEntries || [], this.focusDate.clone().startOf("day").format("YYYY-MM-DD"));
    }
    if (this.currentMode === "month") {
      const monthStart = this.focusDate.clone().startOf("month");
      const monthEnd = monthStart.clone().endOf("month");
      return this.getMinutesForMonth(task.timeEntries || [], monthStart, monthEnd);
    }
    return this.getMinutesForWeek(task.timeEntries || []);
  }

  taskHasVisibleTime(task) {
    if (!task || !Array.isArray(task.timeEntries)) {
      return false;
    }
    if (this.currentMode === "week") {
      return this.getMinutesForWeek(task.timeEntries) > 0;
    }
    if (this.currentMode === "day") {
      const dayKey = this.focusDate.clone().startOf("day").format("YYYY-MM-DD");
      return task.timeEntries.some((entry) => {
        const start = parseFrontmatterDate(entry.startTime);
        return start && start.format("YYYY-MM-DD") === dayKey;
      });
    }
    return task.timeEntries.length > 0;
  }
}

module.exports = class ChronoboardPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.undoStack = [];

    this.registerView(VIEW_TYPE, (leaf) => new ChronoboardView(leaf, this));

    this.addRibbonIcon("blocks", "Open Chronoboard", async () => {
      await this.activateView();
    });

    this.addCommand({
      id: "open-chronoboard",
      name: "Open Chronoboard",
      callback: async () => this.activateView()
    });

    this.addCommand({
      id: "open-chronoboard-task-picker",
      name: "Add task to Chronoboard",
      callback: async () => this.showAddTaskModal()
    });

    this.addCommand({
      id: "open-chronoboard-manual-time-entry",
      name: "Open manual time entry",
      callback: async () => this.showManualTimeEntryModal()
    });

    this.addCommand({
      id: "open-selected-chronoboard-task",
      name: "Open selected Chronoboard task",
      checkCallback: (checking) => {
        const path = this.getSelectedViewTaskPath();
        if (!path) {
          return false;
        }
        if (!checking) {
          const file = this.app.vault.getAbstractFileByPath(path);
          if (file instanceof TFile) {
            this.app.workspace.getLeaf("tab").openFile(file);
          }
        }
        return true;
      }
    });

    this.addCommand({
      id: "open-chronoboard-guide",
      name: "Open Chronoboard guide",
      callback: async () => this.openManagedNote(GUIDE_NOTE_PATH, true)
    });

    this.addCommand({
      id: "open-chronoboard-changelog",
      name: "Open Chronoboard changelog",
      callback: async () => this.openManagedNote(CHANGELOG_NOTE_PATH, true)
    });

    this.addCommand({
      id: "make-current-task-tasknotes-compatible",
      name: "Add TaskNotes fields to current task",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!(file instanceof TFile) || file.extension !== "md") {
          return false;
        }
        if (!checking) {
          this.ensureTaskNoteShape(file);
        }
        return true;
      }
    });

    this.addSettingTab(new ChronoboardSettingTab(this.app, this));

    this.registerEvent(this.app.metadataCache.on("changed", () => this.refreshAllViews()));
    this.registerEvent(this.app.vault.on("rename", () => this.refreshAllViews()));
    this.registerEvent(this.app.vault.on("delete", () => this.refreshAllViews()));
    this.registerDomEvent(document, "keydown", (event) => this.handleUndoKeydown(event));
    await this.initializeManagedNotes();
  }

  async onunload() {
    await this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.settings.highlightColor = normalizeHexColor(this.settings.highlightColor);
  }

  async saveSettings() {
    await this.saveData(this.settings);
  }

  async initializeManagedNotes() {
    await this.ensureManagedNote(GUIDE_NOTE_PATH, this.buildGuideNoteContent());
    await this.ensureChangelogNote();

    const currentVersion = this.manifest.version;
    const previousVersion = String(this.settings.lastSeenVersion || "").trim();
    const isFirstRun = !previousVersion;
    const isUpdate = Boolean(previousVersion) && previousVersion !== currentVersion;

    if (this.settings.lastSeenVersion !== currentVersion) {
      this.settings.lastSeenVersion = currentVersion;
      await this.saveSettings();
    }

    if (isFirstRun) {
      await this.openManagedNote(GUIDE_NOTE_PATH, false);
      return;
    }

    if (isUpdate) {
      await this.openManagedNote(CHANGELOG_NOTE_PATH, false);
    }
  }

  async ensureManagedNote(path, content) {
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      const current = await this.app.vault.cachedRead(existing);
      if (current !== content) {
        await this.app.vault.modify(existing, content);
      }
      return existing;
    }
    return this.app.vault.create(path, content);
  }

  async openManagedNote(path, ensureFirst = false) {
    if (ensureFirst) {
      if (path === GUIDE_NOTE_PATH) {
        await this.ensureManagedNote(path, this.buildGuideNoteContent());
      } else if (path === CHANGELOG_NOTE_PATH) {
        await this.ensureChangelogNote();
      }
    }
    const file = this.app.vault.getAbstractFileByPath(path);
    if (file instanceof TFile) {
      await this.app.workspace.getLeaf("tab").openFile(file);
    }
  }

  async ensureChangelogNote() {
    const versionHeading = `## ${this.manifest.version}`;
    const releaseSection = this.buildCurrentReleaseSection();
    const existing = this.app.vault.getAbstractFileByPath(CHANGELOG_NOTE_PATH);
    if (!(existing instanceof TFile)) {
      return this.app.vault.create(CHANGELOG_NOTE_PATH, `${this.buildChangelogHeader()}\n\n${releaseSection}\n`);
    }
    const current = await this.app.vault.cachedRead(existing);
    if (current.includes(versionHeading)) {
      return existing;
    }
    const bodyWithoutHeader = current
      .replace(/^# Chronoboard Changelog\s*/m, "")
      .replace(/^This note is managed by Chronoboard and records release highlights, commands, fixes, and workflow clarifications\.\s*/m, "")
      .trim();
    const updated = `${this.buildChangelogHeader()}\n\n${releaseSection}${bodyWithoutHeader ? `\n\n${bodyWithoutHeader}` : ""}\n`;
    await this.app.vault.modify(existing, updated);
    return existing;
  }

  buildChangelogHeader() {
    return [
      "# Chronoboard Changelog",
      "",
      "This note is managed by Chronoboard and records release highlights, commands, fixes, and workflow clarifications."
    ].join("\n");
  }

  buildGuideNoteContent() {
    return [
      "# Getting Started With Chronoboard",
      "",
      "> [!info] What Chronoboard Is",
      "> Chronoboard is a task-native timeboard for Obsidian. It lets you pull tasks from a configured folder and place time visually in day, week, and month views.",
      "",
      "## Core workflow",
      "",
      "> [!tip] Task setup",
      "> Tasks should usually have your configured status frontmatter, `Status` by default. That is what makes them available in the add-task pool unless they are explicitly included through `Always include tasks`.",
      "",
      "- Add tasks into the left task pool with `Add task to Chronoboard` or the `+ Add task` slot.",
      "- Make sure the task file has the configured status frontmatter property before expecting it to appear in the task pool.",
      "- Click a task in the left pool to select it, then click and drag in the board to create a time block.",
      "- Hold and drag an existing time block to move it.",
      "- Double click a time block to remove it.",
      "- Use `Ctrl+Z` or `Cmd+Z` to undo adding or removing a time block.",
      "",
      "## Right click on a time block",
      "",
      "> [!example] Why this matters",
      "> Task subtitles are useful when your main task name is a short identifier such as `ABC-123` and you still want a readable label on the board.",
      "",
      "- `Open task note`: opens the original task file.",
      "- `Change color`: changes the color for that task everywhere Chronoboard displays it, including side panels.",
      "- `Edit task subtitle`: adds a human-readable subtitle below the task key.",
      "- `Edit task block text`: adds text inside that specific time block only.",
      "- `Create time entry note` or `Open time entry note`: creates or opens a dedicated note for that time block. This note can be renamed because Chronoboard tracks it through the entry alias and ID.",
      "- `Precise Edit Time`: lets you enter exact start and end times.",
      "- `Remove time block`: removes the time block and removes that entry from the task frontmatter.",
      "",
      "## Right click on a task in the side panels",
      "",
      "- `Open task note`: opens the original task file.",
      "- `Change color`: changes the color for all blocks and summary cards for that task.",
      "- `Edit task subtitle`: adds an alternative human-readable name.",
      "- `Remove Task`: removes that task from the left-side pool only. It does not remove any blocks already on the board, and it does not remove the task from totals if tracked time still exists in the current scope.",
      "",
      "## Important behavior",
      "",
      "> [!warning] Removing tasks from the left rail",
      "> Removing a task from the left sidebar does not remove any time already tracked on the board. It only removes that task from the current left-side task pool.",
      "",
      "- Removing a task from the left sidebar does not remove its existing time entries from the board.",
      "- If a task is removed from the sidebar but is not marked with an excluded status value, it can still appear in the add-task picker later.",
      "- Double clicking opens tasks from the left task rail and totals rail.",
      "",
      "## Commands",
      "",
      "- `Open Chronoboard`",
      "- `Add task to Chronoboard`",
      "- `Open manual time entry`",
      "- `Open selected Chronoboard task`",
      "- `Open Chronoboard guide`",
      "- `Open Chronoboard changelog`",
      "- `Add TaskNotes fields to current task`",
      "",
      "## Settings overview",
      "",
      "- `Folder`: sets the folder Chronoboard reads tasks from.",
      "- `Time entry notes folder`: sets where dedicated time entry notes are created.",
      "- `Time entry note template`: optional template note used when creating time entry notes.",
      "- `Metadata property`: changes which frontmatter property Chronoboard uses to filter available tasks.",
      "- `Excluded values`: values that hide tasks from the add-task pool. By default this includes `finished`.",
      "- `Always include tasks`: allows generic or static tasks, such as meetings, to stay available even without the main status property.",
      "- `Hide weekends in week and month views`: hides Saturday and Sunday from those timeline views.",
      "- `Visible start hour` and `Visible end hour`: control the working-day window shown in day and week views.",
      "- `Highlight color`: changes the accent color used by Chronoboard controls.",
      "- `Force dark text on colored cards`: helps readability on custom light-colored task cards and blocks.",
      "",
      "## Status frontmatter values",
      "",
      "Use these values in the configured `Status` frontmatter property.",
      "",
      "| Value | Color | Notes |",
      "| --- | --- | --- |",
      "| <span style=\"color:#4ea0ff;font-weight:700;\">In Progress</span> | `#4ea0ff` | Highest-priority active work |",
      "| <span style=\"color:#2fb859;font-weight:700;\">Ongoing</span> | `#2fb859` | Continuous or recurring work |",
      "| <span style=\"color:#d29119;font-weight:700;\">On Hold</span> | `#d29119` | Paused work |",
      "| <span style=\"color:#9f63f2;font-weight:700;\">Upcoming</span> | `#9f63f2` | Planned work not yet started |",
      "| `Finished` | excluded by default | Hidden from the add-task picker when `Excluded values` contains `finished` |"
    ].join("\n");
  }

  buildCurrentReleaseSection() {
    const version = this.manifest.version;
    return [
      `## ${version}`,
      "",
      "### Highlights",
      "",
      "- Added managed Chronoboard guide and changelog notes inside the vault.",
      "- Added command palette actions for opening the guide and changelog.",
      "- Added toolbar help access to open the Chronoboard guide quickly.",
      "- Added clearer onboarding around status frontmatter, commands, undo, and interaction flow.",
      "- Refined totals sorting controls and per-day header totals presentation.",
      "- Improved time entry note handling so renamed notes reopen correctly through entry IDs and aliases.",
      "- Added template support for time entry notes with Chronoboard-specific fields appended after template frontmatter.",
      "",
      "### Clarifications",
      "",
      "- Double click a time block to remove it.",
      "- Hold and drag a time block to move it.",
      "- Use `Ctrl+Z` or `Cmd+Z` to undo adding or removing a time block.",
      "- Removing a task from the left rail does not remove existing time blocks from the board.",
      "",
      "### Commands",
      "",
      "- `Open Chronoboard`",
      "- `Add task to Chronoboard`",
      "- `Open manual time entry`",
      "- `Open selected Chronoboard task`",
      "- `Open Chronoboard guide`",
      "- `Open Chronoboard changelog`",
      "",
      "### Roadmap",
      "",
      "- Additional mobile-specific usability improvements.",
      "- More documentation and onboarding polish.",
      "- Further manual time entry and totals workflow improvements."
    ].join("\n");
  }

  pushUndoAction(action) {
    this.undoStack.push(action);
    if (this.undoStack.length > 100) {
      this.undoStack.shift();
    }
  }

  async handleUndoKeydown(event) {
    const isUndo = (event.ctrlKey || event.metaKey) && !event.shiftKey && String(event.key).toLowerCase() === "z";
    if (!isUndo || !this.undoStack.length) {
      return;
    }
    event.preventDefault();
    const action = this.undoStack.pop();
    if (!action) {
      return;
    }
    if (action.type === "remove-entry") {
      await this.addTimeEntry(action.file, action.entry, { pushUndo: false });
      return;
    }
    if (action.type === "add-entry") {
      await this.removeTimeEntry(action.file, action.entry, action.entryIndex, { pushUndo: false });
    }
  }

  async activateView() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    if (!leaf) {
      leaf = this.app.workspace.getLeaf("tab");
      await leaf.setViewState({ type: VIEW_TYPE, active: true });
    }
    this.app.workspace.revealLeaf(leaf);
    if (leaf.view && typeof leaf.view.refresh === "function") {
      await leaf.view.refresh();
    }
  }

  async refreshAllViews() {
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      if (leaf.view && typeof leaf.view.refresh === "function") {
        await leaf.view.refresh();
      }
    }
  }

  getOpenChronoboardView() {
    const leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    return leaf?.view || null;
  }

  getSelectedViewTaskPath() {
    const view = this.getOpenChronoboardView();
    return view?.selectedTaskPath || this.settings.selectedTaskPaths?.[0] || null;
  }

  async showAddTaskModal() {
    const excludePaths = [
      ...(this.settings.staticTaskPaths || []),
      ...(this.settings.selectedTaskPaths || [])
    ];
    new TaskPickerModal(this.app, this, {
      excludePaths,
      onChoose: async (task) => {
        this.settings.selectedTaskPaths = [...this.settings.selectedTaskPaths, task.path];
        this.settings.boardOnlyTaskPaths = (this.settings.boardOnlyTaskPaths || []).filter((path) => path !== task.path);
        const view = this.getOpenChronoboardView();
        if (view) {
          view.selectedTaskPath = task.path;
        }
        await this.saveSettings();
        await this.refreshAllViews();
      }
    }).open();
  }

  async showManualTimeEntryModal() {
    const defaultTaskPath = this.getSelectedViewTaskPath();
    new ManualTimeEntryModal(this.app, this, {
      defaultTaskPath,
      onComplete: async (taskPath) => {
        if (taskPath && !this.settings.selectedTaskPaths.includes(taskPath) && !(this.settings.staticTaskPaths || []).includes(taskPath)) {
          this.settings.selectedTaskPaths = [...this.settings.selectedTaskPaths, taskPath];
          this.settings.boardOnlyTaskPaths = (this.settings.boardOnlyTaskPaths || []).filter((path) => path !== taskPath);
          await this.saveSettings();
        }
        const view = this.getOpenChronoboardView();
        if (view && taskPath) {
          view.selectedTaskPath = taskPath;
        }
        await this.refreshAllViews();
      }
    }).open();
  }

  async getAvailableTasks() {
    const files = this.app.vault.getMarkdownFiles().filter((file) => file.path.startsWith(this.settings.folder));
    const tasks = [];
    for (const file of files) {
      const task = this.getTaskFromFile(file);
      if (!task) {
        continue;
      }
      const rawContent = await this.app.vault.cachedRead(file);
      if (rawFrontmatterContainsExcludedValue(rawContent, this.settings.filterProperty, this.settings.excludedValues || [])) {
        continue;
      }
      const rawValues = extractStatusValuesFromText(rawContent, this.settings.filterProperty);
      const allValues = [...new Set([...(task.filterValues || []), ...rawValues])];
      if (allValues.some((value) => (this.settings.excludedValues || []).includes(value))) {
        continue;
      }
      tasks.push(task);
    }
    tasks.sort((a, b) => {
      const rankDiff = getStatusSortRank(a.status) - getStatusSortRank(b.status);
      if (rankDiff !== 0) {
        return rankDiff;
      }
      return a.displayTitle.localeCompare(b.displayTitle);
    });
    return tasks;
  }

  async getTaskMap(paths) {
    const map = new Map();
    for (const path of paths) {
      const file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) {
        continue;
      }
      const task = this.getTaskFromFile(file);
      if (task) {
        map.set(path, task);
      }
    }
    return map;
  }

  getTaskFromFile(file) {
    const cache = this.app.metadataCache.getFileCache(file) || {};
    const frontmatter = cache.frontmatter || {};
    const jiraKey = this.extractJiraKey(file, frontmatter);
    const title = String(frontmatter.title || "").trim();
    const rawFilter = frontmatter[this.settings.filterProperty] ?? frontmatter.status ?? "Ongoing";
    const filterValues = normalizeStatusList(rawFilter);
    const status = filterValues[0] || "ongoing";
    const timeEntries = Array.isArray(frontmatter.timeEntries) ? frontmatter.timeEntries.filter((entry) => entry && entry.startTime && entry.endTime) : [];
    return {
      file,
      path: file.path,
      jiraKey,
      displayTitle: title || file.basename,
      status,
      rawStatus: rawFilter,
      filterValues,
      timeEntries,
      color: normalizeHexColor(frontmatter[this.settings.colorProperty] || ""),
      subtitle: String(frontmatter[this.settings.subtitleProperty] || "").trim()
    };
  }

  getTaskSecondaryText(task) {
    const subtitle = String(task?.subtitle || "").trim();
    if (subtitle) {
      return subtitle;
    }
    const key = String(task?.jiraKey || task?.file?.basename || "").trim();
    const title = String(task?.displayTitle || "").trim();
    if (title && title !== key) {
      return title;
    }
    return "";
  }

  getTaskLabel(task) {
    const key = String(task?.jiraKey || task?.file?.basename || "").trim();
    const secondary = this.getTaskSecondaryText(task);
    return secondary ? `${key} • ${secondary}` : key;
  }

  findTimeEntryNoteById(entryId) {
    const normalizedId = String(entryId || "").trim();
    if (!normalizedId) {
      return null;
    }
    const folderPrefix = `${this.settings.timeEntryNotesFolder}/`;
    for (const file of this.app.vault.getMarkdownFiles()) {
      if (!file.path.startsWith(folderPrefix)) {
        continue;
      }
      const cache = this.app.metadataCache.getFileCache(file) || {};
      const frontmatter = cache.frontmatter || {};
      const aliases = frontmatter.aliases;
      const aliasValues = Array.isArray(aliases)
        ? aliases.map((value) => String(value || "").trim())
        : typeof aliases === "string"
          ? [String(aliases).trim()]
          : [];
      if (aliasValues.includes(normalizedId) || String(frontmatter.ChronoboardEntryId || "").trim() === normalizedId) {
        return file;
      }
    }
    return null;
  }

  resolveVaultMarkdownFile(pathLike) {
    const rawPath = String(pathLike || "").trim();
    if (!rawPath) {
      return null;
    }
    const direct = this.app.vault.getAbstractFileByPath(rawPath);
    if (direct instanceof TFile) {
      return direct;
    }
    const markdownPath = rawPath.endsWith(".md") ? rawPath : `${rawPath}.md`;
    const withExtension = this.app.vault.getAbstractFileByPath(markdownPath);
    if (withExtension instanceof TFile) {
      return withExtension;
    }
    const linked = this.app.metadataCache.getFirstLinkpathDest(rawPath, "");
    if (linked instanceof TFile) {
      return linked;
    }
    const linkedWithExtension = this.app.metadataCache.getFirstLinkpathDest(markdownPath, "");
    if (linkedWithExtension instanceof TFile) {
      return linkedWithExtension;
    }
    return null;
  }

  async buildTimeEntryNoteContent(task, entryId, entry) {
    let templateContent = "";
    const templatePath = String(this.settings.timeEntryNoteTemplate || "").trim();
    if (templatePath) {
      const templateFile = this.resolveVaultMarkdownFile(templatePath);
      if (templateFile instanceof TFile) {
        templateContent = await this.app.vault.cachedRead(templateFile);
      } else {
        new Notice(`Chronoboard template not found: ${templatePath}`);
      }
    }

    const { frontmatterLines } = splitFrontmatter(templateContent);
    const reservedKeys = new Set([
      "aliases",
      "links",
      "chronoboardentryid",
      "chronoboardparent",
      "chronoboardstart",
      "chronoboardend"
    ]);
    const sanitizedTemplateFrontmatter = frontmatterLines.filter((line) => {
      const key = normalizeFrontmatterKey(line);
      return !key || !reservedKeys.has(key);
    });
    const chronoFrontmatterLines = [
      "aliases:",
      `  - ${entryId}`,
      `Links: "[[${task.file.basename}]]"`,
      `ChronoboardEntryId: ${entryId}`,
      `ChronoboardParent: "[[${task.file.basename}]]"`,
      `ChronoboardStart: ${entry.startTime}`,
      `ChronoboardEnd: ${entry.endTime}`
    ];

    const mergedFrontmatter = [
      "---",
      ...sanitizedTemplateFrontmatter,
      ...chronoFrontmatterLines,
      "---"
    ].join("\n");

    return `${mergedFrontmatter}\n`;
  }

  extractTags(frontmatter) {
    const values = [];
    const raw = frontmatter.tags;
    if (Array.isArray(raw)) {
      raw.forEach((value) => values.push(String(value).replace(/^#/, "").trim()));
    } else if (typeof raw === "string") {
      raw.split(/[\s,]+/).forEach((value) => {
        if (value.trim()) {
          values.push(value.replace(/^#/, "").trim());
        }
      });
    }
    return values.filter(Boolean);
  }

  extractJiraKey(file, frontmatter) {
    const direct = String(frontmatter.jira || "").trim();
    if (direct) {
      return direct;
    }
    const match = file.basename.match(/[A-Z][A-Z0-9]+-\d+/);
    return match ? match[0] : file.basename;
  }

  async ensureTaskNoteShape(file) {
    try {
      await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
        const tags = new Set(this.extractTags(frontmatter));
        tags.add(this.settings.taskTag);
        tags.add(this.settings.jiraTag);
        frontmatter.tags = [...tags];
        if (!frontmatter.title) {
          frontmatter.title = file.basename;
        }
        if (!frontmatter[this.settings.filterProperty]) {
          frontmatter[this.settings.filterProperty] = "Ongoing";
        }
        if (!frontmatter.status) {
          frontmatter.status = "in-progress";
        }
        if (!Array.isArray(frontmatter.timeEntries)) {
          frontmatter.timeEntries = [];
        }
        if (frontmatter.timeEstimate === undefined) {
          frontmatter.timeEstimate = 0;
        }
      });
      new Notice(`TaskNotes fields added to ${file.basename}`);
      await this.refreshAllViews();
    } catch (error) {
      console.error(error);
      new Notice("Failed to update task frontmatter");
    }
  }

  async addTimeEntry(file, entry, options = {}) {
    let storedEntry = null;
    let storedIndex = -1;
    await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
      const existing = Array.isArray(frontmatter.timeEntries) ? [...frontmatter.timeEntries] : [];
      storedEntry = {
        ...entry,
        id: entry.id || createEntryId()
      };
      existing.push(storedEntry);
      existing.sort((a, b) => String(a.startTime).localeCompare(String(b.startTime)));
      storedIndex = existing.findIndex((candidate) => candidate.id === storedEntry.id);
      frontmatter.timeEntries = existing;
    });
    if (options.pushUndo && storedEntry) {
      this.pushUndoAction({
        type: "add-entry",
        file,
        entry: storedEntry,
        entryIndex: storedIndex
      });
    }
    await this.refreshAllViews();
    return { entry: storedEntry, entryIndex: storedIndex };
  }

  async removeTimeEntry(file, entry, entryIndex, options = {}) {
    let removedEntry = null;
    await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
      const existing = Array.isArray(frontmatter.timeEntries) ? [...frontmatter.timeEntries] : [];
      frontmatter.timeEntries = existing.filter((candidate, index) => {
        const matchesById = entry.id && candidate.id === entry.id;
        const matchesByIndex = index === entryIndex && candidate.startTime === entry.startTime && candidate.endTime === entry.endTime;
        if (!matchesById && !matchesByIndex) {
          return true;
        }
        removedEntry = candidate;
        return false;
      });
    });
    if (options.pushUndo && removedEntry) {
      this.pushUndoAction({
        type: "remove-entry",
        file,
        entry: removedEntry
      });
    }
    await this.refreshAllViews();
    return removedEntry;
  }

  async updateTimeEntry(file, entryIndex, updatedEntry) {
    await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
      const existing = Array.isArray(frontmatter.timeEntries) ? [...frontmatter.timeEntries] : [];
      if (entryIndex >= 0 && entryIndex < existing.length) {
        existing[entryIndex] = updatedEntry;
      }
      existing.sort((a, b) => String(a.startTime).localeCompare(String(b.startTime)));
      frontmatter.timeEntries = existing;
    });
    await this.refreshAllViews();
  }

  async updateTicketColor(file, color) {
    await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
      if (color) {
        frontmatter[this.settings.colorProperty] = color;
      } else {
        delete frontmatter[this.settings.colorProperty];
      }
    });
    await this.refreshAllViews();
  }

  async updateTicketSubtitle(file, subtitle) {
    await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
      if (subtitle) {
        frontmatter[this.settings.subtitleProperty] = subtitle;
      } else {
        delete frontmatter[this.settings.subtitleProperty];
      }
    });
    await this.refreshAllViews();
  }
};
