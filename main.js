const {
  FuzzySuggestModal,
  getIconIds,
  ItemView,
  MarkdownRenderer,
  Menu,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  TFolder,
  setIcon,
  moment,
} = require("obsidian");

const VIEW_TYPE = "chronoboard-view";
const RECOVERY_JOURNAL_VERSION = 2;
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

const STATS_SCOPE_ORDER = ["day", "week", "month", "year", "all"];
const QUICK_ACTION_SWATCH_COLORS = {
  red: "#e05252",
  orange: "#e58a34",
  yellow: "#d7b84b",
  green: "#48a867",
  cyan: "#3aa6a6",
  blue: "#4f8ad9",
  purple: "#8b5cf6",
  pink: "#d45d9e",
  gray: "#858585"
};
const STATS_SCOPE_TITLES = {
  day: "Daily Statistics",
  week: "Weekly Statistics",
  month: "Monthly Statistics",
  year: "Yearly Statistics",
  all: "All-Time Statistics"
};

const STATS_TASK_COLORS = ["#4e9af1", "#2fb859", "#d29119", "#9f63f2", "#e05a47", "#2da7a0", "#d05f9a"];

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
  heatmapLowColor: "#dbeafe",
  heatmapHighColor: "#2563eb",
  heatmapIncludeZeroDays: false,
  forceDarkTextOnColored: false,
  taskPickerSort: "status",
  exportFolder: "Chronoboard Exports",
  compressedCsvExport: false,
  timeLogNewestFirst: true,
  quickActionBarEnabled: false,
  quickActionBarScrollable: true,
  quickActionCurvedButtons: false,
  quickActionBarPadding: 3,
  quickActions: []
};

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

function getIconicCssColor(value) {
  const hexColor = normalizeHexColor(value);
  if (hexColor) {
    return hexColor;
  }
  const colorName = String(value || "").trim().toLowerCase();
  return ["red", "orange", "yellow", "green", "cyan", "blue", "purple", "pink", "gray"].includes(colorName)
    ? `var(--color-${colorName})`
    : "";
}

function getHighlightCssValue(value) {
  return normalizeHexColor(value) || "var(--interactive-accent)";
}

function mixHexColors(startColor, endColor, ratio) {
  const start = normalizeHexColor(startColor).slice(1);
  const end = normalizeHexColor(endColor).slice(1);
  const amount = Math.max(0, Math.min(1, Number(ratio) || 0));
  if (!start || !end) {
    return normalizeHexColor(endColor) || normalizeHexColor(startColor) || "#2563eb";
  }
  const mixed = [0, 2, 4].map((offset) => {
    const startChannel = parseInt(start.slice(offset, offset + 2), 16);
    const endChannel = parseInt(end.slice(offset, offset + 2), 16);
    return Math.round(startChannel + (endChannel - startChannel) * amount)
      .toString(16)
      .padStart(2, "0");
  });
  return `#${mixed.join("")}`;
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

function fitTextToWidth(element, minimumFontSize = 9) {
  window.requestAnimationFrame(() => {
    if (!element.isConnected) {
      return;
    }
    element.style.removeProperty("font-size");
    let fontSize = Number.parseFloat(window.getComputedStyle(element).fontSize);
    while (element.scrollWidth > element.clientWidth && fontSize > minimumFontSize) {
      fontSize -= 0.5;
      element.style.fontSize = `${fontSize}px`;
    }
  });
}

function sanitizeFileSegment(value) {
  return String(value || "")
    .replace(/[\\/:*?"<>|]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeVaultFolder(value) {
  const parts = String(value || "")
    .replace(/\\/g, "/")
    .split("/")
    .map((part) => part.trim())
    .filter((part) => part && part !== ".");
  if (parts.includes("..")) {
    return null;
  }
  return parts.join("/");
}

function escapeCsvValue(value) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function escapeMarkdownTableCell(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[\r\n]+/g, " ")
    .replace(/\\/g, "\\\\")
    .replace(/\|/g, "\\|")
    .trim();
}

function createEntryId() {
  return `chrono-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

class ChronoboardGuideModal extends Modal {
  constructor(app, plugin) {
    super(app);
    this.plugin = plugin;
  }

  async onOpen() {
    this.modalEl.addClass("chronoboard-guide-modal");
    this.titleEl.setText("Getting Started With Chronoboard");
    const guide = this.contentEl.createDiv({ cls: "chronoboard-guide-content" });
    await MarkdownRenderer.render(
      this.app,
      this.plugin.buildGuideContent(),
      guide,
      "",
      this.plugin
    );
  }

  onClose() {
    this.contentEl.empty();
  }
}

class TaskPickerModal extends FuzzySuggestModal {
  constructor(app, plugin, options) {
    super(app);
    this.plugin = plugin;
    this.onChoose = options.onChoose;
    this.excludePaths = new Set(options.excludePaths || []);
    this.providedItems = options.items || null;
    this.setPlaceholder("Enter a task key or title...");
    this.candidates = null;
  }

  async getItemsAsync() {
    if (!this.candidates) {
      const all = this.providedItems || (await this.plugin.getAvailableTasks());
      const sortMode = this.plugin.settings.taskPickerSort === "alphabetical" ? "alphabetical" : "status";
      const filtered = all.filter((task) => !this.excludePaths.has(task.path));
      this.candidates = filtered.sort((a, b) => {
        if (sortMode === "status") {
          const rankDiff = getStatusSortRank(a.status) - getStatusSortRank(b.status);
          if (rankDiff !== 0) {
            return rankDiff;
          }
        }
        return this.getItemText(a).localeCompare(this.getItemText(b));
      });
      this.groupStartPaths = new Set();
      if (sortMode === "alphabetical") {
        let lastLetter = null;
        this.candidates.forEach((task) => {
          const letter = (task.jiraKey || task.file.basename).charAt(0).toUpperCase();
          if (letter !== lastLetter) {
            this.groupStartPaths.add(task.path);
            lastLetter = letter;
          }
        });
      }
    }
    return this.candidates;
  }

  getItems() {
    return this.candidates || [];
  }

  async onOpen() {
    await this.getItemsAsync();
    super.onOpen();
    this.containerEl.addClass("chronoboard-task-picker-modal");
    this.inputEl.setAttr("aria-label", "Search tasks by key or title");
    const inputContainer = this.inputEl.parentElement;
    if (inputContainer && !inputContainer.querySelector(".chronoboard-task-picker-intro")) {
      inputContainer.addClass("chronoboard-task-picker-search");
      const intro = inputContainer.createDiv({ cls: "chronoboard-task-picker-intro" });
      intro.createDiv({ cls: "chronoboard-task-picker-title", text: "Choose a task" });
      intro.createDiv({
        cls: "chronoboard-task-picker-description",
        text: "Search by task key or title, then select a task."
      });
      this.modalEl.querySelector(".modal-close-button")?.remove();
      const closeButton = intro.createEl("button", { cls: "chronoboard-task-picker-close" });
      setIcon(closeButton, "x");
      closeButton.setAttr("aria-label", "Close task picker");
      closeButton.setAttr("title", "Close task picker");
      closeButton.addEventListener("click", () => this.close());
      inputContainer.insertBefore(intro, this.inputEl);
    }
    if (!this.candidates.length) {
      this.resultContainerEl.empty();
      this.resultContainerEl.createDiv({
        cls: "chronoboard-modal-empty",
        text: "No eligible tasks are available in the configured folder."
      });
    }
  }

  getItemText(task) {
    const key = task.jiraKey || task.file.basename;
    const secondary = this.plugin.getTaskSecondaryText(task) || "";
    return `${key} ${secondary}`;
  }

  renderSuggestion(match, el) {
    const task = match.item;
    if (this.plugin.settings.taskPickerSort === "alphabetical" && !this.inputEl.value.trim() && this.groupStartPaths?.has(task.path)) {
      el.parentElement.createDiv({
        cls: "chronoboard-modal-group-header",
        text: (task.jiraKey || task.file.basename).charAt(0).toUpperCase()
      });
      el.parentElement.appendChild(el);
    }
    el.addClass("chronoboard-modal-card");
    el.createDiv({ cls: "chronoboard-task-key", text: task.jiraKey || task.file.basename });
    const secondaryText = this.plugin.getTaskSecondaryText(task);
    if (secondaryText) {
      el.createDiv({ cls: "chronoboard-task-name", text: secondaryText });
    }
    el.createDiv({
      cls: "chronoboard-task-meta",
      text: `${task.status || "unknown"}`
    });
  }

  onChooseItem(task) {
    this.onChoose(task);
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

class TimeLogModal extends Modal {
  constructor(app, plugin, task) {
    super(app);
    this.plugin = plugin;
    this.task = task;
  }

  async onOpen() {
    this.modalEl.addClass("chronoboard-time-log-modal");
    this.titleEl.setText(`Time log: ${this.plugin.getTaskLabel(this.task)}`);
    const { contentEl } = this;
    contentEl.empty();

    new Setting(contentEl)
      .setName("Newest first")
      .setDesc("Order weeks and days with the most recent at the top.")
      .addToggle((toggle) => {
        toggle.setValue(this.plugin.settings.timeLogNewestFirst);
        toggle.onChange(async (value) => {
          this.plugin.settings.timeLogNewestFirst = value;
          await this.plugin.saveSettings();
          await this.renderLog();
        });
      });

    this.logContainer = contentEl.createDiv({ cls: "chronoboard-time-log-content" });
    await this.renderLog();
  }

  async renderLog() {
    this.logContainer.empty();
    await MarkdownRenderer.render(
      this.app,
      this.plugin.buildTimeLogMarkdown(this.task),
      this.logContainer,
      this.task.file.path,
      this.plugin
    );
  }

  onClose() {
    this.contentEl.empty();
  }
}

class QuickActionNoteSuggest {
  constructor(app, inputEl, onSelect) {
    this.app = app;
    this.inputEl = inputEl;
    this.onSelect = onSelect;
    this.suggestions = [];
    this.selectedIndex = 0;
    this.handleInput = () => this.updateSuggestions();
    this.handleKeydown = (event) => this.onKeydown(event);
    this.handleBlur = () => window.setTimeout(() => this.close(), 120);
    inputEl.addEventListener("input", this.handleInput);
    inputEl.addEventListener("keydown", this.handleKeydown);
    inputEl.addEventListener("blur", this.handleBlur);
  }

  getSuggestions(inputValue = this.inputEl.value) {
    const value = String(inputValue || "").trim();
    if (!value) {
      return [];
    }
    const query = value.replace(/^\[\[/, "").replace(/\]\]$/, "").trim().toLowerCase();
    return this.app.vault.getMarkdownFiles()
      .filter((file) => !query
        || file.basename.toLowerCase().includes(query)
        || file.path.toLowerCase().includes(query))
      .sort((a, b) => a.basename.localeCompare(b.basename))
      .slice(0, 50);
  }

  updateSuggestions() {
    this.suggestions = this.getSuggestions();
    this.selectedIndex = 0;
    this.render();
  }

  render() {
    this.close();
    if (!this.suggestions.length || !this.inputEl.isConnected) {
      return;
    }
    const documentRef = this.inputEl.ownerDocument;
    const windowRef = documentRef.defaultView;
    const inputRect = this.inputEl.getBoundingClientRect();
    const width = Math.min(Math.max(inputRect.width, 420), windowRef.innerWidth - 24);
    const left = Math.min(inputRect.left, windowRef.innerWidth - width - 12);
    this.containerEl = documentRef.body.createDiv({
      cls: "suggestion-container chronoboard-note-suggest-container"
    });
    this.containerEl.style.zIndex = "100000";
    this.containerEl.style.width = `${width}px`;
    this.containerEl.style.left = `${Math.max(12, left)}px`;
    if (windowRef.innerHeight - inputRect.bottom >= 220) {
      this.containerEl.style.top = `${inputRect.bottom + 4}px`;
    } else {
      this.containerEl.style.bottom = `${windowRef.innerHeight - inputRect.top + 4}px`;
    }
    this.suggestions.forEach((file, index) => {
      const item = this.containerEl.createDiv({
        cls: `suggestion-item${index === this.selectedIndex ? " is-selected" : ""}`
      });
      item.createDiv({ cls: "chronoboard-note-suggest-name", text: file.basename });
      item.createDiv({ cls: "chronoboard-note-suggest-path", text: file.path });
      item.addEventListener("mousedown", (event) => {
        event.preventDefault();
        event.stopPropagation();
        this.selectSuggestion(file);
      });
    });
  }

  onKeydown(event) {
    if (!this.containerEl || !this.suggestions.length) {
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      this.selectedIndex = (this.selectedIndex + direction + this.suggestions.length) % this.suggestions.length;
      this.render();
      this.containerEl?.querySelector(".suggestion-item.is-selected")?.scrollIntoView({ block: "nearest" });
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      this.selectSuggestion(this.suggestions[this.selectedIndex]);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      this.close();
    }
  }

  selectSuggestion(file) {
    let linkText = file.path.replace(/\.md$/i, "");
    if (typeof this.app.metadataCache.fileToLinktext === "function") {
      try {
        linkText = this.app.metadataCache.fileToLinktext(file, "", true) || linkText;
      } catch (error) {
        console.error("Chronoboard could not create a short note link.", error);
      }
    }
    const value = linkText;
    this.inputEl.value = value;
    this.onSelect(value);
    this.close();
    this.inputEl.focus();
  }

  close() {
    this.containerEl?.remove();
    this.containerEl = null;
  }

  destroy() {
    this.close();
    this.inputEl.removeEventListener("input", this.handleInput);
    this.inputEl.removeEventListener("keydown", this.handleKeydown);
    this.inputEl.removeEventListener("blur", this.handleBlur);
  }
}

class QuickActionIconPickerModal extends Modal {
  constructor(app, plugin, action, onSave) {
    super(app);
    this.plugin = plugin;
    this.action = action;
    this.onSave = onSave;
    this.selectedIcon = String(action.icon || "");
    this.selectedColor = String(action.iconColor || "");
    this.query = "";
    this.iconIds = typeof getIconIds === "function" ? getIconIds() : [];
  }

  onOpen() {
    this.modalEl.addClass("chronoboard-icon-picker-modal");
    this.titleEl.setText("Choose an icon");
    this.contentEl.empty();

    const previewRow = this.contentEl.createDiv({ cls: "chronoboard-icon-picker-preview-row" });
    this.previewEl = previewRow.createDiv({ cls: "chronoboard-icon-picker-preview" });
    const automaticButton = previewRow.createEl("button", {
      text: this.action.actionType === "url" ? "Use link icon" : "Use note icon"
    });
    automaticButton.addEventListener("click", () => {
      this.selectedIcon = "";
      this.refreshPreview();
      this.renderIcons();
    });
    previewRow.createDiv({
      cls: "chronoboard-icon-picker-automatic-help",
      text: this.action.actionType === "url"
        ? "Uses the standard external-link icon."
        : "Uses the target note's Iconic icon and color when available. Otherwise, it uses the file icon."
    });

    const search = this.contentEl.createEl("input", { cls: "chronoboard-icon-picker-search" });
    search.type = "search";
    search.placeholder = "Search icons";
    search.addEventListener("input", () => {
      this.query = search.value.trim().toLowerCase();
      this.renderIcons();
    });

    const colorSection = this.contentEl.createDiv({ cls: "chronoboard-icon-picker-colors" });
    colorSection.createDiv({ cls: "chronoboard-icon-picker-label", text: "Icon color" });
    const swatches = colorSection.createDiv({ cls: "chronoboard-icon-color-swatches" });
    ["", "red", "orange", "yellow", "green", "cyan", "blue", "purple", "pink", "gray"].forEach((color) => {
      const swatch = swatches.createEl("button", {
        cls: `chronoboard-icon-color-swatch${color ? " has-color" : ""}${this.selectedColor === color ? " is-selected" : ""}`
      });
      swatch.setAttr("aria-label", color ? `${color} icon` : "Automatic icon color");
      swatch.setAttr("title", color ? color[0].toUpperCase() + color.slice(1) : "Automatic");
      if (color) {
        swatch.style.setProperty("--chronoboard-swatch-color", QUICK_ACTION_SWATCH_COLORS[color]);
        swatch.style.backgroundColor = QUICK_ACTION_SWATCH_COLORS[color];
        swatch.style.backgroundImage = "none";
      } else {
        setIcon(swatch, "rotate-ccw");
      }
      swatch.addEventListener("click", () => {
        this.selectedColor = color;
        this.renderColorSelection();
        this.refreshPreview();
        this.renderIcons();
      });
    });
    this.gridEl = this.contentEl.createDiv({ cls: "chronoboard-icon-picker-grid" });
    this.renderIcons();
    this.refreshPreview();

    const footer = this.contentEl.createDiv({ cls: "chronoboard-modal-actions" });
    const cancel = footer.createEl("button", { text: "Cancel" });
    cancel.addEventListener("click", () => this.close());
    const save = footer.createEl("button", { cls: "mod-cta", text: "Use icon" });
    save.addEventListener("click", () => {
      this.onSave(this.selectedIcon, this.selectedColor);
      this.close();
    });
    window.setTimeout(() => search.focus(), 0);
  }

  renderColorSelection() {
    this.contentEl.querySelectorAll(".chronoboard-icon-color-swatch").forEach((swatch, index) => {
      const colors = ["", "red", "orange", "yellow", "green", "cyan", "blue", "purple", "pink", "gray"];
      swatch.toggleClass("is-selected", colors[index] === this.selectedColor);
    });
  }

  refreshPreview() {
    this.previewEl.empty();
    const icon = this.previewEl.createSpan();
    const visual = this.selectedIcon
      ? { icon: this.selectedIcon, color: getIconicCssColor(this.selectedColor) }
      : this.plugin.getQuickActionVisual({
        ...this.action,
        icon: "",
        iconColor: this.selectedColor
      });
    setIcon(icon, visual.icon || (this.action.actionType === "url" ? "external-link" : "file"));
    const color = visual.color;
    if (color) {
      icon.style.color = color;
    }
  }

  renderIcons() {
    if (!this.gridEl) {
      return;
    }
    this.gridEl.empty();
    const matches = this.iconIds
      .filter((iconId) => !this.query || iconId.toLowerCase().includes(this.query))
      .slice(0, 400);
    matches.forEach((iconId) => {
      const button = this.gridEl.createEl("button", {
        cls: `chronoboard-icon-picker-button${this.selectedIcon === iconId ? " is-selected" : ""}`
      });
      button.setAttr("aria-label", iconId);
      button.setAttr("title", iconId.replace(/^lucide-/, ""));
      setIcon(button, iconId);
      const color = getIconicCssColor(this.selectedColor);
      if (color) {
        button.style.color = color;
      }
      button.addEventListener("click", () => {
        this.selectedIcon = iconId;
        this.refreshPreview();
        this.renderIcons();
      });
    });
    if (!matches.length) {
      this.gridEl.createDiv({ cls: "chronoboard-icon-picker-empty", text: "No icons match this search." });
    }
  }

  onClose() {
    this.contentEl.empty();
  }
}

class QuickActionManagerModal extends Modal {
  constructor(app, plugin, options = {}) {
    super(app);
    this.plugin = plugin;
    this.actions = JSON.parse(JSON.stringify(plugin.settings.quickActions || []));
    this.noteSuggests = [];
    this.focusActionId = null;
    if (Number.isInteger(options.addAtIndex)) {
      const action = this.createAction();
      const index = clampNumber(options.addAtIndex, 0, this.actions.length);
      this.actions.splice(index, 0, action);
      this.focusActionId = action.id;
    }
  }

  createAction() {
    return {
      id: `quick-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      displayType: "text",
      label: "New button",
      icon: "",
      iconColor: "",
      actionType: "note",
      target: ""
    };
  }

  addAction(index = this.actions.length) {
    const action = this.createAction();
    this.actions.splice(clampNumber(index, 0, this.actions.length), 0, action);
    this.focusActionId = action.id;
    this.renderActions();
  }

  onOpen() {
    this.modalEl.addClass("chronoboard-quick-action-modal");
    this.titleEl.setText("Manage Linkbar buttons");
    this.contentEl.empty();
    this.contentEl.createDiv({
      cls: "chronoboard-quick-action-intro",
      text: "Add note or web link buttons to the Linkbar. Icon buttons use the target note's Iconic icon when the custom icon field is empty."
    });

    const topActions = this.contentEl.createDiv({ cls: "chronoboard-quick-action-top" });
    const addButton = topActions.createEl("button", { cls: "mod-cta", text: "Add button" });
    addButton.addEventListener("click", () => {
      this.addAction();
    });

    this.listEl = this.contentEl.createDiv({ cls: "chronoboard-quick-action-list" });
    this.renderActions();

    const footer = this.contentEl.createDiv({ cls: "chronoboard-modal-actions chronoboard-quick-action-footer" });
    const cancelButton = footer.createEl("button", { text: "Cancel" });
    cancelButton.addEventListener("click", () => this.close());
    const saveButton = footer.createEl("button", { cls: "mod-cta", text: "Save changes" });
    saveButton.addEventListener("click", async () => {
      const invalidAction = this.actions.find((action) => !String(action.label || "").trim() || !String(action.target || "").trim());
      if (invalidAction) {
        new Notice("Each Linkbar button needs a label and a target.");
        return;
      }
      this.plugin.settings.quickActions = this.actions.map((action) => ({
        id: action.id || `quick-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        displayType: ["icon", "both"].includes(action.displayType) ? action.displayType : "text",
        label: String(action.label || "").trim(),
        icon: String(action.icon || "").trim(),
        iconColor: String(action.iconColor || "").trim(),
        actionType: action.actionType === "url" ? "url" : "note",
        target: action.actionType === "url"
          ? String(action.target || "").trim()
          : this.plugin.normalizeQuickActionNoteTarget(action.target)
      }));
      await this.plugin.saveSettings();
      await this.plugin.refreshAllViews();
      this.close();
    });
  }

  renderActions() {
    this.noteSuggests.forEach((suggest) => suggest.destroy());
    this.noteSuggests = [];
    this.listEl.empty();
    if (!this.actions.length) {
      this.listEl.createDiv({
        cls: "chronoboard-quick-action-empty",
        text: "No Linkbar buttons are configured."
      });
      return;
    }

    this.actions.forEach((action, index) => {
      const card = this.listEl.createDiv({ cls: "chronoboard-quick-action-editor" });
      const header = card.createDiv({ cls: "chronoboard-quick-action-editor-head" });
      header.createDiv({
        cls: "chronoboard-quick-action-editor-title",
        text: action.label || `Button ${index + 1}`
      });
      const controls = header.createDiv({ cls: "chronoboard-quick-action-editor-controls" });
      const moveUp = controls.createEl("button", { cls: "clickable-icon" });
      setIcon(moveUp, "arrow-up");
      moveUp.disabled = index === 0;
      moveUp.setAttr("aria-label", "Move button up");
      moveUp.addEventListener("click", () => this.moveAction(index, -1));
      const moveDown = controls.createEl("button", { cls: "clickable-icon" });
      setIcon(moveDown, "arrow-down");
      moveDown.disabled = index === this.actions.length - 1;
      moveDown.setAttr("aria-label", "Move button down");
      moveDown.addEventListener("click", () => this.moveAction(index, 1));
      const remove = controls.createEl("button", { cls: "clickable-icon chronoboard-quick-action-remove" });
      setIcon(remove, "trash-2");
      remove.setAttr("aria-label", "Remove button");
      remove.addEventListener("click", () => {
        this.actions.splice(index, 1);
        this.renderActions();
      });

      const fields = card.createDiv({ cls: "chronoboard-quick-action-fields" });
      this.addSelectField(fields, "Display", action.displayType || "text", [
        ["text", "Text"],
        ["icon", "Icon"],
        ["both", "Text & icon"]
      ], (value) => {
        action.displayType = value;
        this.renderActions();
      });
      const labelInput = this.addTextField(fields, "Label", action.label || "", "Project notes", (value) => {
        action.label = value;
        header.querySelector(".chronoboard-quick-action-editor-title").setText(value || `Button ${index + 1}`);
      });
      if (action.id === this.focusActionId) {
        window.setTimeout(() => {
          labelInput.focus();
          labelInput.select();
        }, 0);
        this.focusActionId = null;
      }
      this.addSelectField(fields, "Action", action.actionType || "note", [
        ["note", "Open note"],
        ["url", "Open URL"]
      ], (value) => {
        action.actionType = value;
        this.renderActions();
      });
      const targetInput = this.addTextField(
        fields,
        action.actionType === "url" ? "URL" : "Note",
        action.actionType === "url"
          ? action.target || ""
          : this.plugin.cleanQuickActionNoteTarget(action.target),
        action.actionType === "url" ? "https://example.com" : "Find a note",
        (value) => { action.target = value; }
      );
      if (action.actionType === "note") {
        this.noteSuggests.push(new QuickActionNoteSuggest(this.app, targetInput, (value) => {
          action.target = value;
        }));
      }
      if (action.displayType === "icon" || action.displayType === "both") {
        this.addIconField(fields, action, () => this.renderActions());
      }
    });
  }

  addTextField(container, label, value, placeholder, onInput) {
    const field = container.createEl("label", { cls: "chronoboard-quick-action-field" });
    field.createSpan({ text: label });
    const input = field.createEl("input");
    input.type = "text";
    input.value = value;
    input.placeholder = placeholder;
    input.addEventListener("input", () => onInput(input.value));
    return input;
  }

  addSelectField(container, label, value, options, onChange) {
    const field = container.createEl("label", { cls: "chronoboard-quick-action-field" });
    field.createSpan({ text: label });
    const select = field.createEl("select");
    options.forEach(([optionValue, optionLabel]) => {
      const option = select.createEl("option", { text: optionLabel });
      option.value = optionValue;
      option.selected = optionValue === value;
    });
    select.addEventListener("change", () => onChange(select.value));
  }

  addIconField(container, action, onChange) {
    const field = container.createEl("label", { cls: "chronoboard-quick-action-field" });
    field.createSpan({ text: "Icon" });
    const button = field.createEl("button", { cls: "chronoboard-quick-action-icon-select" });
    const preview = button.createSpan({ cls: "chronoboard-quick-action-icon-select-preview" });
    const visual = this.plugin.getQuickActionVisual(action);
    setIcon(preview, visual.icon || (action.actionType === "url" ? "external-link" : "file"));
    const color = visual.color;
    if (color) {
      preview.style.color = color;
    }
    button.createSpan({
      text: action.icon
        ? action.icon.replace(/^lucide-/, "")
        : action.actionType === "url" ? "Link icon" : "Note icon"
    });
    button.addEventListener("click", (event) => {
      event.preventDefault();
      new QuickActionIconPickerModal(this.app, this.plugin, action, (icon, iconColor) => {
        action.icon = icon;
        action.iconColor = iconColor;
        onChange();
      }).open();
    });
  }

  moveAction(index, offset) {
    const nextIndex = index + offset;
    if (nextIndex < 0 || nextIndex >= this.actions.length) {
      return;
    }
    const [action] = this.actions.splice(index, 1);
    this.actions.splice(nextIndex, 0, action);
    this.renderActions();
  }

  onClose() {
    this.noteSuggests.forEach((suggest) => suggest.destroy());
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

class CsvExportModal extends Modal {
  constructor(app, plugin, options = {}) {
    super(app);
    this.plugin = plugin;
    this.startDate = options.startDate || moment().startOf("isoWeek").format("YYYY-MM-DD");
    this.endDate = options.endDate || moment().endOf("isoWeek").format("YYYY-MM-DD");
    this.exportFolder = String(plugin.settings.exportFolder ?? "Chronoboard Exports");
    this.compressedMode = Boolean(plugin.settings.compressedCsvExport);
    this.fileName = this.getDefaultFileName();
    this.exportTasks = [];
    this.selectedTaskPaths = new Set();
    this.refreshToken = 0;
  }

  getDefaultFileName() {
    return `Chronoboard ${this.startDate} to ${this.endDate}.csv`;
  }

  getOutputPath() {
    const folder = normalizeVaultFolder(this.exportFolder);
    if (folder === null) {
      return null;
    }
    const safeName = sanitizeFileSegment(String(this.fileName || "").replace(/\.csv$/i, ""));
    if (!safeName) {
      return null;
    }
    const fileName = `${safeName}.csv`;
    return folder ? `${folder}/${fileName}` : fileName;
  }

  hasValidRange() {
    const start = moment(this.startDate, "YYYY-MM-DD", true);
    const end = moment(this.endDate, "YYYY-MM-DD", true);
    return start.isValid() && end.isValid() && !start.isAfter(end, "day");
  }

  async onOpen() {
    const { contentEl, titleEl } = this;
    this.modalEl.addClass("chronoboard-export-modal");
    titleEl.setText("Export tracked time");
    contentEl.empty();

    const controls = contentEl.createDiv({ cls: "chronoboard-export-controls" });
    new Setting(controls)
      .setName("Start date")
      .setDesc("Include time on and after this date.")
      .addText((text) => {
        text.setValue(this.startDate);
        text.inputEl.type = "date";
        text.inputEl.addEventListener("change", async () => {
          this.startDate = text.inputEl.value;
          this.fileName = this.getDefaultFileName();
          this.fileNameControl?.setValue(this.fileName);
          await this.refreshTaskList();
        });
      });

    new Setting(controls)
      .setName("End date")
      .setDesc("Include time on and before this date.")
      .addText((text) => {
        text.setValue(this.endDate);
        text.inputEl.type = "date";
        text.inputEl.addEventListener("change", async () => {
          this.endDate = text.inputEl.value;
          this.fileName = this.getDefaultFileName();
          this.fileNameControl?.setValue(this.fileName);
          await this.refreshTaskList();
        });
      });

    const taskHeading = contentEl.createDiv({ cls: "chronoboard-export-section-head" });
    taskHeading.createEl("h3", { cls: "chronoboard-export-section-title", text: "Tasks in Range" });
    this.rangeStatusEl = taskHeading.createSpan({ cls: "chronoboard-export-range-count" });
    this.taskListEl = contentEl.createDiv({ cls: "chronoboard-export-task-list" });

    const output = contentEl.createDiv({ cls: "chronoboard-export-output" });
    new Setting(output)
      .setName("Compressed mode")
      .setDesc("Put tasks in columns and dates in rows. The second row contains totals for the full range.")
      .addToggle((toggle) => {
        toggle.setValue(this.compressedMode);
        toggle.onChange((value) => {
          this.compressedMode = value;
        });
      });

    new Setting(output)
      .setName("Export folder")
      .setDesc("Use a vault-relative folder. Leave this field empty to use the vault root.")
      .addText((text) => {
        text.setPlaceholder("Chronoboard Exports").setValue(this.exportFolder);
        text.onChange((value) => {
          this.exportFolder = value;
          this.updateExportState();
        });
      });

    new Setting(output)
      .setName("File name")
      .setDesc("Chronoboard adds the CSV extension.")
      .addText((text) => {
        this.fileNameControl = text;
        text.setValue(this.fileName);
        text.onChange((value) => {
          this.fileName = value;
          this.updateExportState();
        });
      });

    this.pathStatusEl = output.createDiv({ cls: "chronoboard-export-status" });
    const actions = contentEl.createDiv({ cls: "chronoboard-export-actions" });
    const cancelButton = actions.createEl("button", { text: "Cancel" });
    this.exportButton = actions.createEl("button", { cls: "mod-cta", text: "Export CSV" });
    cancelButton.addEventListener("click", () => this.close());
    this.exportButton.addEventListener("click", async () => this.exportCsv());

    await this.refreshTaskList();
  }

  async refreshTaskList() {
    const token = ++this.refreshToken;
    this.taskListEl.empty();
    if (!this.hasValidRange()) {
      this.exportTasks = [];
      this.selectedTaskPaths.clear();
      this.rangeStatusEl.setText("The start date must not be after the end date.");
      this.rangeStatusEl.addClass("is-error");
      this.taskListEl.createDiv({ cls: "chronoboard-modal-empty", text: "Enter a valid date range." });
      this.updateExportState();
      return;
    }

    this.rangeStatusEl.removeClass("is-error");
    this.rangeStatusEl.setText("Loading tasks...");
    const tasks = await this.plugin.getExportTasksInRange(this.startDate, this.endDate);
    if (token !== this.refreshToken) {
      return;
    }
    this.exportTasks = tasks;
    this.selectedTaskPaths = new Set(tasks.map((item) => item.task.path));
    this.rangeStatusEl.setText(`${tasks.length} task${tasks.length === 1 ? "" : "s"} found.`);

    if (!tasks.length) {
      this.taskListEl.createDiv({ cls: "chronoboard-modal-empty", text: "No tracked time was found in this date range." });
      this.updateExportState();
      return;
    }

    tasks.forEach((item) => {
      const row = this.taskListEl.createDiv({ cls: "chronoboard-export-task-row" });
      const checkbox = row.createEl("input", { cls: "chronoboard-export-task-checkbox" });
      checkbox.type = "checkbox";
      checkbox.checked = true;
      checkbox.setAttr("aria-label", `Include ${this.plugin.getTaskLabel(item.task)}`);
      checkbox.addEventListener("change", () => {
        if (checkbox.checked) {
          this.selectedTaskPaths.add(item.task.path);
        } else {
          this.selectedTaskPaths.delete(item.task.path);
        }
        this.updateExportState();
      });
      const label = row.createDiv({ cls: "chronoboard-export-task-label" });
      label.createDiv({ cls: "chronoboard-task-key", text: item.task.jiraKey || item.task.file.basename });
      const secondaryText = this.plugin.getTaskSecondaryText(item.task);
      if (secondaryText) {
        label.createDiv({ cls: "chronoboard-task-name", text: secondaryText });
      }
      row.createDiv({ cls: "chronoboard-export-task-total", text: formatHours(item.minutes) });
    });
    this.updateExportState();
  }

  updateExportState() {
    if (!this.exportButton || !this.pathStatusEl) {
      return;
    }
    const path = this.getOutputPath();
    let message = path || "Enter a valid export folder and file name.";
    let isError = !path;
    if (path && this.app.vault.getAbstractFileByPath(path)) {
      message = `A file already exists at ${path}`;
      isError = true;
    }
    this.pathStatusEl.setText(message);
    this.pathStatusEl.classList.toggle("is-error", isError);
    this.exportButton.disabled = isError || !this.hasValidRange() || !this.selectedTaskPaths.size;
  }

  async exportCsv() {
    const path = this.getOutputPath();
    if (!this.hasValidRange()) {
      new Notice("The start date must not be after the end date.");
      return;
    }
    if (!path) {
      new Notice("Enter a valid export folder and file name.");
      return;
    }
    if (this.app.vault.getAbstractFileByPath(path)) {
      new Notice(`A file already exists at ${path}`);
      this.updateExportState();
      return;
    }
    const selected = this.exportTasks.filter((item) => this.selectedTaskPaths.has(item.task.path));
    if (!selected.length) {
      new Notice("Select at least one task.");
      return;
    }

    try {
      const folder = normalizeVaultFolder(this.exportFolder);
      await this.plugin.ensureVaultFolder(folder || "");
      if (this.app.vault.getAbstractFileByPath(path)) {
        new Notice(`A file already exists at ${path}`);
        this.updateExportState();
        return;
      }
      const csv = this.plugin.buildCsvExport(selected, {
        compressed: this.compressedMode,
        startDate: this.startDate,
        endDate: this.endDate
      });
      await this.app.vault.create(path, csv);
      this.plugin.settings.exportFolder = normalizeVaultFolder(this.exportFolder) || "";
      this.plugin.settings.compressedCsvExport = this.compressedMode;
      await this.plugin.saveSettings();
      new Notice(`CSV export created at ${path}`);
      this.close();
    } catch (error) {
      console.error(error);
      new Notice("Chronoboard could not create the CSV export.");
    }
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

    new Setting(setupSection)
      .setName("Task picker order")
      .setDesc("Choose the order used before you enter a search.")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("status", "Status")
          .addOption("alphabetical", "Alphabetical")
          .setValue(this.plugin.settings.taskPickerSort === "alphabetical" ? "alphabetical" : "status")
          .onChange(async (value) => {
            this.plugin.settings.taskPickerSort = value === "alphabetical" ? "alphabetical" : "status";
            await this.plugin.saveSettings();
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

    const toolbarSection = this.createSection(
      containerEl,
      "Linkbar Settings",
      "Configure the optional Linkbar shown between the task count and the board controls."
    );

    new Setting(toolbarSection)
      .setName("Show Linkbar")
      .setDesc("Show the note and web link bar at the top of Chronoboard.")
      .addToggle((toggle) =>
        toggle
          .setValue(Boolean(this.plugin.settings.quickActionBarEnabled))
          .onChange(async (value) => {
            this.plugin.settings.quickActionBarEnabled = value;
            await this.plugin.saveSettings();
            await this.plugin.refreshAllViews();
          })
      );

    new Setting(toolbarSection)
      .setName("Scrollable Linkbar")
      .setDesc("Keep each button at its natural width and allow horizontal scrolling.")
      .addToggle((toggle) =>
        toggle
          .setValue(Boolean(this.plugin.settings.quickActionBarScrollable))
          .onChange(async (value) => {
            this.plugin.settings.quickActionBarScrollable = value;
            await this.plugin.saveSettings();
            await this.plugin.refreshAllViews();
          })
      );

    new Setting(toolbarSection)
      .setName("Curved inner button corners")
      .setDesc("Round each Linkbar button. Turn this off to use square corners between buttons.")
      .addToggle((toggle) =>
        toggle
          .setValue(Boolean(this.plugin.settings.quickActionCurvedButtons))
          .onChange(async (value) => {
            this.plugin.settings.quickActionCurvedButtons = value;
            await this.plugin.saveSettings();
            await this.plugin.refreshAllViews();
          })
      );

    new Setting(toolbarSection)
      .setName("Linkbar padding")
      .setDesc("Set the space around and between Linkbar buttons.")
      .addSlider((slider) =>
        slider
          .setLimits(0, 5, 1)
          .setDynamicTooltip()
          .setValue(this.plugin.settings.quickActionBarPadding)
          .onChange(async (value) => {
            this.plugin.settings.quickActionBarPadding = value;
            await this.plugin.saveSettings();
            await this.plugin.refreshAllViews();
          })
      );

    new Setting(toolbarSection)
      .setName("Linkbar buttons")
      .setDesc("Add, edit, reorder, or remove Linkbar buttons.")
      .addButton((button) =>
        button
          .setButtonText("Manage buttons")
          .onClick(() => this.plugin.openQuickActionManager())
      );

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

    const addHeatmapColorSetting = (name, description, settingKey) => {
      new Setting(customizationSection)
        .setName(name)
        .setDesc(description)
        .addText((text) => {
          text
            .setPlaceholder(DEFAULT_SETTINGS[settingKey])
            .setValue(this.plugin.settings[settingKey])
            .onChange(async (value) => {
              const color = normalizeHexColor(value);
              if (!color) {
                return;
              }
              this.plugin.settings[settingKey] = color;
              await this.plugin.saveSettings();
              await this.plugin.refreshAllViews();
            });
          const control = text.inputEl.closest(".setting-item-control") || text.inputEl.parentElement;
          const pickerWrap = control.createDiv({ cls: "chronoboard-setting-color-wrap" });
          const picker = pickerWrap.createEl("input", { cls: "chronoboard-setting-color-picker" });
          picker.type = "color";
          picker.value = normalizeHexColor(this.plugin.settings[settingKey]) || DEFAULT_SETTINGS[settingKey];
          picker.addEventListener("pointerdown", (event) => event.stopPropagation());
          picker.addEventListener("click", (event) => event.stopPropagation());
          picker.addEventListener("input", async () => {
            this.plugin.settings[settingKey] = picker.value;
            text.setValue(picker.value);
            await this.plugin.saveSettings();
            await this.plugin.refreshAllViews();
          });
        })
        .addExtraButton((button) => {
          button.setIcon("reset");
          button.setTooltip("Reset color");
          button.onClick(async () => {
            this.plugin.settings[settingKey] = DEFAULT_SETTINGS[settingKey];
            await this.plugin.saveSettings();
            await this.plugin.refreshAllViews();
            this.display();
          });
        });
    };

    addHeatmapColorSetting(
      "Heatmap low color",
      "Color used for the lowest tracked daily total in a heatmap.",
      "heatmapLowColor"
    );
    addHeatmapColorSetting(
      "Heatmap high color",
      "Color used for the highest tracked daily total in a heatmap.",
      "heatmapHighColor"
    );

    new Setting(customizationSection)
      .setName("Color zero-hour heatmap days")
      .setDesc("Use the low heatmap color for days that have no tracked time.")
      .addToggle((toggle) =>
        toggle
          .setValue(Boolean(this.plugin.settings.heatmapIncludeZeroDays))
          .onChange(async (value) => {
            this.plugin.settings.heatmapIncludeZeroDays = value;
            await this.plugin.saveSettings();
            await this.plugin.refreshAllViews();
          })
      );

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
    this.statsScope = "month";
    this.statsTransitionDirection = null;
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

  getSummaryCopy() {
    if (this.currentMode === "stats") {
      return {
        day: { title: "Daily Total", note: "Tracked this day" },
        week: { title: "Weekly Total", note: "Tracked this week" },
        month: { title: "Monthly Total", note: "Tracked this month" },
        year: { title: "Yearly Total", note: "Tracked this year" },
        all: { title: "All-Time Total", note: "Tracked all time" }
      }[this.statsScope] || { title: "Monthly Total", note: "Tracked this month" };
    }
    if (this.currentMode === "day") {
      return { title: "Daily Total", note: "Tracked this day" };
    }
    if (this.currentMode === "month") {
      return { title: "Monthly Total", note: "Tracked this month" };
    }
    return { title: "Weekly Total", note: "Tracked this week" };
  }

  async render() {
    this.contentEl.empty();
    this.contentEl.addClass("chronoboard-view");
    this.contentEl.classList.toggle("is-mobile", this.isMobileLayout());
    const highlightColor = normalizeHexColor(this.plugin.settings.highlightColor);
    this.contentEl.style.setProperty("--chronoboard-highlight", getHighlightCssValue(highlightColor));
    this.contentEl.style.setProperty(
      "--chronoboard-highlight-text",
      highlightColor ? getContrastTextColor(highlightColor) : "var(--text-on-accent)"
    );

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

  getStatsPeriod() {
    if (this.statsScope === "day") {
      return {
        start: this.focusDate.clone().startOf("day"),
        end: this.focusDate.clone().endOf("day"),
        label: this.focusDate.format("MMM Do, YYYY")
      };
    }
    if (this.statsScope === "week") {
      const start = this.focusDate.clone().startOf("isoWeek").startOf("day");
      return {
        start,
        end: start.clone().add(6, "days").endOf("day"),
        label: `Week ${Math.ceil(this.focusDate.date() / 7)} • ${this.focusDate.format("MMM YYYY")}`
      };
    }
    if (this.statsScope === "year") {
      return {
        start: this.focusDate.clone().startOf("year"),
        end: this.focusDate.clone().endOf("year"),
        label: this.focusDate.format("YYYY")
      };
    }
    if (this.statsScope === "all") {
      return { start: null, end: null, label: "All Time" };
    }
    return {
      start: this.focusDate.clone().startOf("month"),
      end: this.focusDate.clone().endOf("month"),
      label: this.focusDate.format("MMMM YYYY")
    };
  }

  getStatsNavigationUnit() {
    if (this.statsScope === "day") {
      return "day";
    }
    if (this.statsScope === "week") {
      return "week";
    }
    if (this.statsScope === "year") {
      return "year";
    }
    if (this.statsScope === "all") {
      return null;
    }
    return "month";
  }

  getStatsMinutes(entries) {
    const period = this.getStatsPeriod();
    return (entries || []).reduce((sum, entry) => {
      const start = parseFrontmatterDate(entry.startTime);
      if (!start) {
        return sum;
      }
      if (period.start && (start.isBefore(period.start) || start.isAfter(period.end))) {
        return sum;
      }
      return sum + this.entryMinutes(entry);
    }, 0);
  }

  getExportRange() {
    if (this.currentMode === "day") {
      const day = this.focusDate.format("YYYY-MM-DD");
      return { startDate: day, endDate: day };
    }
    if (this.currentMode === "stats") {
      const period = this.getStatsPeriod();
      return {
        startDate: period.start ? period.start.format("YYYY-MM-DD") : "1900-01-01",
        endDate: period.end ? period.end.format("YYYY-MM-DD") : "2999-12-31"
      };
    }
    if (this.currentMode === "month") {
      return {
        startDate: this.focusDate.clone().startOf("month").format("YYYY-MM-DD"),
        endDate: this.focusDate.clone().endOf("month").format("YYYY-MM-DD")
      };
    }
    return {
      startDate: this.focusDate.clone().startOf("isoWeek").format("YYYY-MM-DD"),
      endDate: this.focusDate.clone().endOf("isoWeek").format("YYYY-MM-DD")
    };
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

    if (this.plugin.settings.quickActionBarEnabled) {
      this.renderQuickActionBar(toolbar);
    }

    const right = toolbar.createDiv({ cls: "chronoboard-toolbar-group" });

    const exportButton = right.createEl("button", { cls: "chronoboard-toolbar-export-button" });
    setIcon(exportButton, "upload");
    exportButton.setAttr("aria-label", "Export tracked time as CSV");
    exportButton.setAttr("title", "Export tracked time as CSV");
    exportButton.addEventListener("click", () => {
      this.plugin.showCsvExportModal(this.getExportRange());
    });

    const statsButton = right.createEl("button", {
      cls: `chronoboard-toolbar-state-button${this.currentMode === "stats" ? " is-active" : ""}`,
      text: "Stats"
    });
    statsButton.addEventListener("click", async () => {
      this.currentMode = this.currentMode === "stats" ? "week" : "stats";
      await this.render();
    });

    if (!isMobile) {
      const taskToggle = right.createEl("button", {
        cls: `chronoboard-toolbar-state-button${this.leftPanelCollapsed ? "" : " is-active"}`,
        text: "Task"
      });
      taskToggle.addEventListener("click", async () => {
        this.leftPanelCollapsed = !this.leftPanelCollapsed;
        await this.render();
      });

      const totalsToggle = right.createEl("button", {
        cls: `chronoboard-toolbar-state-button${this.rightPanelCollapsed ? "" : " is-active"}`,
        text: "Totals"
      });
      totalsToggle.addEventListener("click", async () => {
        this.rightPanelCollapsed = !this.rightPanelCollapsed;
        await this.render();
      });
    }

    const prevButton = right.createEl("button", { cls: "chronoboard-nav-button", text: "<" });
    prevButton.disabled = this.currentMode === "stats" && this.statsScope === "all";
    prevButton.addEventListener("click", async () => {
      const unit = this.currentMode === "stats"
        ? this.getStatsNavigationUnit()
        : this.currentMode === "day"
          ? "day"
          : this.currentMode === "month"
            ? "month"
            : "week";
      if (!unit) {
        return;
      }
      this.focusDate = this.focusDate.clone().subtract(1, unit);
      await this.render();
    });

    const dateLabel = this.getDateLabel();
    const datePill = right.createDiv({ cls: "chronoboard-pill chronoboard-date-pill", text: dateLabel });
    datePill.setAttr("title", dateLabel);
    fitTextToWidth(datePill);

    const nextButton = right.createEl("button", { cls: "chronoboard-nav-button", text: ">" });
    nextButton.disabled = this.currentMode === "stats" && this.statsScope === "all";
    nextButton.addEventListener("click", async () => {
      const unit = this.currentMode === "stats"
        ? this.getStatsNavigationUnit()
        : this.currentMode === "day"
          ? "day"
          : this.currentMode === "month"
            ? "month"
            : "week";
      if (!unit) {
        return;
      }
      this.focusDate = this.focusDate.clone().add(1, unit);
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

  renderQuickActionBar(toolbar) {
    const actions = Array.isArray(this.plugin.settings.quickActions)
      ? this.plugin.settings.quickActions
      : [];
    const bar = toolbar.createDiv({
      cls: `chronoboard-quick-action-bar${this.plugin.settings.quickActionBarScrollable ? " is-scrollable" : ""}${this.plugin.settings.quickActionCurvedButtons ? " has-curved-buttons" : ""}`
    });
    const padding = clampNumber(Number(this.plugin.settings.quickActionBarPadding) || 0, 0, 5);
    bar.style.setProperty("--chronoboard-quick-bar-padding", `${padding}px`);
    const track = bar.createDiv({ cls: "chronoboard-quick-action-track" });
    bar.addEventListener("contextmenu", (event) => {
      this.openQuickActionContextMenu(event, null, this.getQuickActionInsertIndex(event, track));
    });
    if (!actions.length) {
      const empty = track.createEl("button", {
        cls: "chronoboard-quick-action-empty-button",
        text: "Configure Linkbar"
      });
      empty.addEventListener("click", () => this.plugin.openQuickActionManager());
      return;
    }

    actions.filter((action) => action && typeof action === "object").forEach((action, index) => {
      if (!action.id) {
        action.id = `quick-${Date.now()}-${index}-${Math.random().toString(36).slice(2, 7)}`;
      }
      const label = String(action.label || "Linkbar action");
      const visual = this.plugin.getQuickActionVisual(action);
      const displayType = ["icon", "both"].includes(action.displayType) ? action.displayType : "text";
      const button = track.createEl("button", {
        cls: `chronoboard-quick-action-button is-${displayType}`
      });
      button.dataset.quickActionId = action.id;
      button.setAttr("aria-label", label);
      if (displayType === "icon" || displayType === "both") {
        const icon = button.createSpan({ cls: "chronoboard-quick-action-icon" });
        const fallbackIcon = action.actionType === "url" ? "external-link" : "file";
        try {
          setIcon(icon, visual.icon || fallbackIcon);
        } catch (error) {
          console.error("Chronoboard could not render a Linkbar icon.", error);
          setIcon(icon, fallbackIcon);
        }
        if (visual.color) {
          icon.style.color = visual.color;
        }
      }
      if (displayType === "text" || displayType === "both") {
        button.createSpan({ cls: "chronoboard-quick-action-label", text: label });
      }
      button.addEventListener("pointerdown", (event) => {
        this.startQuickActionHold(event, action.id, button, track);
      });
      button.addEventListener("click", (event) => {
        if (Date.now() < (this.quickActionClickBlockedUntil || 0)) {
          event.preventDefault();
          event.stopPropagation();
          return;
        }
        this.plugin.runQuickAction(action);
      });
      button.addEventListener("contextmenu", (event) => {
        this.openQuickActionContextMenu(event, action, this.getQuickActionInsertIndex(event, track));
      });
    });
  }

  getQuickActionInsertIndex(event, track) {
    const buttons = [...track.querySelectorAll(".chronoboard-quick-action-button")];
    const index = buttons.findIndex((button) => {
      const rect = button.getBoundingClientRect();
      return event.clientX < rect.left + rect.width / 2;
    });
    return index < 0 ? buttons.length : index;
  }

  openQuickActionContextMenu(event, action, insertIndex) {
    event.preventDefault();
    event.stopPropagation();
    this.closeActiveContextMenu();
    const menu = new Menu();
    this.activeContextMenu = menu;
    if (action) {
      menu.addItem((item) =>
        item
          .setTitle("Copy Link")
          .setIcon("copy")
          .onClick(() => this.plugin.copyQuickActionLink(action))
      );
    }
    menu.addItem((item) =>
      item
        .setTitle("Edit Buttons")
        .setIcon("settings-2")
        .onClick(() => this.plugin.openQuickActionManager())
    );
    menu.addItem((item) =>
      item
        .setTitle("Add Button")
        .setIcon("plus")
        .onClick(() => this.plugin.openQuickActionManager({ addAtIndex: insertIndex }))
    );
    if (action) {
      menu.addSeparator();
      menu.addItem((item) =>
        item
          .setTitle("Remove Button")
          .setIcon("trash")
          .onClick(async () => {
            this.plugin.settings.quickActions = this.plugin.settings.quickActions
              .filter((candidate) => candidate.id !== action.id);
            await this.plugin.saveSettings();
            await this.plugin.refreshAllViews();
          })
      );
    }
    menu.showAtMouseEvent(event);
    if (action) {
      this.decorateActiveMenu("Remove Button");
    }
  }

  startQuickActionHold(event, actionId, button, track) {
    if (event.button !== 0) {
      return;
    }
    this.quickActionHoldCleanup?.();
    const pointerId = event.pointerId;
    const startX = event.clientX;
    const startY = event.clientY;
    let previousMoveX = startX;
    let active = false;
    let changed = false;

    const cleanup = () => {
      window.clearTimeout(holdTimer);
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleEnd);
      window.removeEventListener("pointercancel", handleCancel);
      button.removeClass("is-reordering");
      track.removeClass("is-reordering");
      if (this.quickActionHoldCleanup === cleanup) {
        this.quickActionHoldCleanup = null;
      }
    };
    const cancelBeforeActivation = () => {
      this.quickActionClickBlockedUntil = Date.now() + 350;
      cleanup();
    };
    const holdTimer = window.setTimeout(() => {
      active = true;
      this.quickActionClickBlockedUntil = Date.now() + 500;
      button.addClass("is-reordering");
      track.addClass("is-reordering");
    }, 500);
    const handleMove = (moveEvent) => {
      if (moveEvent.pointerId !== pointerId) {
        return;
      }
      if (!active) {
        if (Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) > 6) {
          cancelBeforeActivation();
        }
        return;
      }
      moveEvent.preventDefault();
      const horizontalDelta = moveEvent.clientX - previousMoveX;
      if (Math.abs(horizontalDelta) < 3) {
        return;
      }
      previousMoveX = moveEvent.clientX;
      const targetButton = document.elementFromPoint(moveEvent.clientX, moveEvent.clientY)
        ?.closest(".chronoboard-quick-action-button");
      if (!targetButton || targetButton === button || targetButton.parentElement !== track) {
        return;
      }
      const targetId = targetButton.dataset.quickActionId;
      const buttons = [...track.querySelectorAll(".chronoboard-quick-action-button")];
      const draggedIndex = buttons.indexOf(button);
      const targetIndex = buttons.indexOf(targetButton);
      const movingRight = horizontalDelta > 0;
      if ((movingRight && targetIndex < draggedIndex) || (!movingRight && targetIndex > draggedIndex)) {
        return;
      }
      const placeAfter = movingRight;
      changed = this.reorderQuickActionsLive(actionId, targetId, placeAfter, track, button, targetButton) || changed;
    };
    const handleEnd = async (endEvent) => {
      if (endEvent.pointerId !== pointerId) {
        return;
      }
      if (active) {
        this.quickActionClickBlockedUntil = Date.now() + 350;
      }
      cleanup();
      if (active && changed) {
        await this.plugin.saveSettings();
      }
    };
    const handleCancel = (cancelEvent) => {
      if (cancelEvent.pointerId === pointerId) {
        cancelBeforeActivation();
      }
    };

    this.quickActionHoldCleanup = cleanup;
    window.addEventListener("pointermove", handleMove, { passive: false });
    window.addEventListener("pointerup", handleEnd);
    window.addEventListener("pointercancel", handleCancel);
  }

  reorderQuickActionsLive(draggedId, targetId, placeAfter, track, draggedButton, targetButton) {
    if ((placeAfter && draggedButton.previousElementSibling === targetButton)
      || (!placeAfter && draggedButton.nextElementSibling === targetButton)) {
      return false;
    }
    const actions = [...this.plugin.settings.quickActions];
    const sourceIndex = actions.findIndex((action) => action.id === draggedId);
    if (sourceIndex < 0) {
      return false;
    }
    const [draggedAction] = actions.splice(sourceIndex, 1);
    const targetIndex = actions.findIndex((action) => action.id === targetId);
    if (targetIndex < 0) {
      return false;
    }
    const previousRects = new Map(
      [...track.querySelectorAll(".chronoboard-quick-action-button")]
        .map((element) => [element, element.getBoundingClientRect()])
    );
    actions.splice(targetIndex + (placeAfter ? 1 : 0), 0, draggedAction);
    this.plugin.settings.quickActions = actions;
    if (placeAfter) {
      targetButton.after(draggedButton);
    } else {
      targetButton.before(draggedButton);
    }
    this.animateQuickActionReflow(track, previousRects);
    return true;
  }

  animateQuickActionReflow(track, previousRects) {
    track.querySelectorAll(".chronoboard-quick-action-button").forEach((button) => {
      const previousRect = previousRects.get(button);
      if (!previousRect) {
        return;
      }
      const currentRect = button.getBoundingClientRect();
      const offsetX = previousRect.left - currentRect.left;
      if (Math.abs(offsetX) < 1) {
        return;
      }
      button.animate(
        [{ transform: `translateX(${offsetX}px)` }, { transform: "translateX(0)" }],
        { duration: 110, easing: "cubic-bezier(0.2, 0.9, 0.2, 1)" }
      );
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
      return this.getStatsPeriod().label;
    }
    return this.focusDate.format("MMMM YYYY");
  }

  renderStatsScopeHeader(container) {
    container.addClass("chronoboard-stats-scope-head");
    const scopeIndex = STATS_SCOPE_ORDER.indexOf(this.statsScope);
    const previous = container.createEl("button", {
      cls: "chronoboard-stats-scope-button",
      text: "<"
    });
    previous.disabled = scopeIndex <= 0;
    previous.setAttr("aria-label", "Show a smaller statistics range");
    previous.addEventListener("click", async () => {
      if (scopeIndex <= 0) {
        return;
      }
      this.statsScope = STATS_SCOPE_ORDER[scopeIndex - 1];
      this.statsTransitionDirection = "backward";
      await this.render();
    });

    container.createDiv({
      cls: "chronoboard-center-title chronoboard-stats-scope-title",
      text: STATS_SCOPE_TITLES[this.statsScope] || STATS_SCOPE_TITLES.month
    });

    const next = container.createEl("button", {
      cls: "chronoboard-stats-scope-button",
      text: ">"
    });
    next.disabled = scopeIndex >= STATS_SCOPE_ORDER.length - 1;
    next.setAttr("aria-label", "Show a larger statistics range");
    next.addEventListener("click", async () => {
      if (scopeIndex >= STATS_SCOPE_ORDER.length - 1) {
        return;
      }
      this.statsScope = STATS_SCOPE_ORDER[scopeIndex + 1];
      this.statsTransitionDirection = "forward";
      await this.render();
    });
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
      this.plugin.openGuide();
    });
    helpTrigger.addEventListener("keydown", async (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        this.plugin.openGuide();
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
    if (this.currentMode === "stats") {
      this.renderStatsScopeHeader(timelineHead);
    } else {
      timelineHead.createDiv({
        text:
          this.currentMode === "day"
            ? `Daily Time • ${this.focusDate.format("dddd")}`
            : this.currentMode === "week"
              ? "Weekly Time"
              : "Monthly Time"
      });
    }

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
      this.plugin.openGuide();
    });
    helpTrigger.addEventListener("keydown", async (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        this.plugin.openGuide();
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
    const summaryCopy = this.getSummaryCopy();
    const panel = layout.createDiv({ cls: "chronoboard-panel chronoboard-mobile-panel" });
    const panelHead = panel.createDiv({ cls: "chronoboard-panel-head" });
    panelHead.createDiv({
      text: summaryCopy.title
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
        text: summaryCopy.note
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
    if (this.currentMode === "stats") {
      this.renderStatsScopeHeader(head);
    } else if (this.currentMode === "day") {
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
              : "Monthly Time"
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
      column.addEventListener("contextmenu", (event) => this.handleWeekContextMenu(event, dayMoment, column));
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
    const transitionClass = this.statsTransitionDirection
      ? ` is-slide-${this.statsTransitionDirection}`
      : "";
    this.statsTransitionDirection = null;
    const wrap = panel.createDiv({ cls: `chronoboard-stats-layout${transitionClass}` });
    const period = this.getStatsPeriod();
    const taskStats = selectedTasks
      .map((task) => {
        const entries = (task.timeEntries || []).filter((entry) => {
          const start = parseFrontmatterDate(entry.startTime);
          if (!start) {
            return false;
          }
          const isInPeriod = !period.start || (!start.isBefore(period.start) && !start.isAfter(period.end));
          return isInPeriod && this.entryMinutes(entry) > 0;
        });
        return {
          task,
          entries,
          minutes: entries.reduce((sum, entry) => sum + this.entryMinutes(entry), 0),
          blockCount: entries.length,
          activeDays: new Set(entries.map((entry) => moment(entry.startTime).format("YYYY-MM-DD"))).size
        };
      })
      .filter((item) => item.blockCount > 0)
      .sort((a, b) => b.minutes - a.minutes || this.plugin.getTaskLabel(a.task).localeCompare(this.plugin.getTaskLabel(b.task)));
    const totalMinutes = taskStats.reduce((sum, item) => sum + item.minutes, 0);
    const totalBlocks = taskStats.reduce((sum, item) => sum + item.blockCount, 0);
    const activeDates = new Set(
      taskStats.flatMap((item) => item.entries.map((entry) => moment(entry.startTime).format("YYYY-MM-DD")))
    );
    const averageBlockMinutes = totalBlocks ? Math.round(totalMinutes / totalBlocks) : 0;

    const periodHead = wrap.createDiv({ cls: "chronoboard-stats-period" });
    periodHead.createDiv({ cls: "chronoboard-stats-period-title", text: period.label });
    periodHead.createDiv({
      cls: "chronoboard-stats-period-description",
      text: "Activity from tasks shown on the Chronoboard."
    });

    const periodDescription = this.statsScope === "all"
      ? "All recorded time"
      : `Total for this ${this.statsScope}`;

    const cards = wrap.createDiv({ cls: "chronoboard-stats-cards" });
    [
      { label: "Tracked time", value: formatHours(totalMinutes), detail: periodDescription },
      { label: "Tracked tasks", value: String(taskStats.length), detail: `${selectedTasks.length} tasks on the board` },
      { label: "Time blocks", value: String(totalBlocks), detail: `${activeDates.size} active day${activeDates.size === 1 ? "" : "s"}` },
      { label: "Average block", value: formatHours(averageBlockMinutes), detail: "Average recorded duration" }
    ].forEach((stat) => {
      const card = cards.createDiv({ cls: "chronoboard-stats-card" });
      card.createDiv({ cls: "chronoboard-stats-label", text: stat.label });
      card.createDiv({ cls: "chronoboard-stats-value", text: stat.value });
      card.createDiv({ cls: "chronoboard-stats-detail", text: stat.detail });
    });

    const breakdownSection = wrap.createDiv({ cls: "chronoboard-stats-section chronoboard-stats-breakdown" });
    breakdownSection.createDiv({ cls: "chronoboard-stats-section-title", text: "Time spent by task" });
    breakdownSection.createDiv({
      cls: "chronoboard-stats-section-description",
      text: "Share of tracked time for each task in this range."
    });
    if (!taskStats.length) {
      breakdownSection.createDiv({ cls: "chronoboard-stats-empty", text: "No tracked time is available for this range." });
    } else {
      const visibleBreakdown = taskStats.slice(0, 6).map((item, index) => ({
        label: this.plugin.getTaskLabel(item.task),
        minutes: item.minutes,
        color: normalizeHexColor(item.task.color) || STATS_TASK_COLORS[index % STATS_TASK_COLORS.length]
      }));
      if (taskStats.length > 6) {
        visibleBreakdown.push({
          label: `Other tasks (${taskStats.length - 6})`,
          minutes: taskStats.slice(6).reduce((sum, item) => sum + item.minutes, 0),
          color: "#6b7280"
        });
      }
      let usedShare = 0;
      const gradientParts = visibleBreakdown.map((item) => {
        const startShare = usedShare;
        usedShare += totalMinutes ? (item.minutes / totalMinutes) * 100 : 0;
        return `${item.color} ${startShare}% ${usedShare}%`;
      });
      const breakdownBody = breakdownSection.createDiv({ cls: "chronoboard-stats-breakdown-body" });
      const donut = breakdownBody.createDiv({ cls: "chronoboard-stats-donut" });
      donut.style.background = `conic-gradient(${gradientParts.join(", ")})`;
      donut.setAttr("role", "img");
      donut.setAttr("aria-label", "Time spent by task");
      const donutCenter = donut.createDiv({ cls: "chronoboard-stats-donut-center" });
      donutCenter.createDiv({ cls: "chronoboard-stats-donut-total", text: formatHours(totalMinutes) });
      donutCenter.createDiv({ cls: "chronoboard-stats-donut-label", text: "total" });
      const legend = breakdownBody.createDiv({ cls: "chronoboard-stats-breakdown-legend" });
      visibleBreakdown.forEach((item) => {
        const row = legend.createDiv({ cls: "chronoboard-stats-breakdown-row" });
        const label = row.createDiv({ cls: "chronoboard-stats-breakdown-label" });
        const swatch = label.createSpan({ cls: "chronoboard-stats-breakdown-swatch" });
        swatch.style.background = item.color;
        label.createSpan({ cls: "chronoboard-stats-breakdown-name", text: item.label });
        const share = totalMinutes ? Math.round((item.minutes / totalMinutes) * 100) : 0;
        row.createDiv({
          cls: "chronoboard-stats-breakdown-value",
          text: `${formatHours(item.minutes)} · ${share}%`
        });
      });
    }

    const details = wrap.createDiv({
      cls: `chronoboard-stats-details${this.statsScope === "year" ? " has-year-heatmap" : ""}`
    });
    const activitySection = details.createDiv({ cls: "chronoboard-stats-section" });
    const chartEntries = taskStats.flatMap((item) => item.entries.map((entry) => ({
      start: parseFrontmatterDate(entry.startTime),
      end: parseFrontmatterDate(entry.endTime),
      minutes: this.entryMinutes(entry)
    }))).filter((item) => item.start);
    let chartTitle = "Hours by weekday";
    let chartDescription = "Combined activity for each weekday in this month.";
    let chartItems;
    let heatmapCalendars = null;
    if (this.statsScope === "day") {
      chartTitle = "Hours by time of day";
      chartDescription = "Recorded activity across four parts of the selected day.";
      chartItems = [
        { label: "12-6a", startHour: 0, endHour: 6 },
        { label: "6a-12p", startHour: 6, endHour: 12 },
        { label: "12-6p", startHour: 12, endHour: 18 },
        { label: "6p-12a", startHour: 18, endHour: 24 }
      ].map((bucket) => ({
        label: bucket.label,
        minutes: chartEntries.reduce((sum, item) => {
          const bucketStart = period.start.clone().hour(bucket.startHour).minute(0).second(0).millisecond(0);
          const bucketEnd = bucket.startHour === 18
            ? period.start.clone().add(1, "day").startOf("day")
            : period.start.clone().hour(bucket.endHour).minute(0).second(0).millisecond(0);
          const entryEnd = item.end && item.end.isAfter(item.start)
            ? item.end
            : item.start.clone().add(item.minutes, "minutes");
          const overlapStart = Math.max(item.start.valueOf(), bucketStart.valueOf());
          const overlapEnd = Math.min(entryEnd.valueOf(), bucketEnd.valueOf());
          return sum + Math.max(0, Math.round((overlapEnd - overlapStart) / 60000));
        }, 0)
      }));
    } else if (this.statsScope === "week") {
      chartTitle = period.label;
      chartDescription = "Daily tracked time for the selected week.";
      heatmapCalendars = [{
        label: null,
        start: period.start,
        days: Array.from({ length: 7 }, (_, index) => period.start.clone().add(index, "days"))
      }];
    } else if (this.statsScope === "year") {
      chartTitle = period.label;
      chartDescription = "Daily tracked time for each month in the selected year.";
      heatmapCalendars = Array.from({ length: 12 }, (_, index) => {
        const monthStart = period.start.clone().month(index).startOf("month");
        return {
          label: monthStart.format("MMMM"),
          start: monthStart,
          days: Array.from({ length: monthStart.daysInMonth() }, (unused, dayIndex) =>
            monthStart.clone().add(dayIndex, "days")
          )
        };
      });
    } else if (this.statsScope === "all") {
      chartTitle = "Hours by year";
      chartDescription = "Recorded activity across all available years.";
      const years = new Map();
      chartEntries.forEach((item) => {
        const year = item.start.format("YYYY");
        years.set(year, (years.get(year) || 0) + item.minutes);
      });
      chartItems = [...years.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([label, minutes]) => ({ label, minutes }));
    } else {
      chartTitle = period.label;
      chartDescription = "Daily tracked time. Stronger color means more tracked time.";
      heatmapCalendars = [{
        label: null,
        start: period.start,
        days: Array.from({ length: period.end.date() }, (_, index) => period.start.clone().add(index, "days"))
      }];
    }
    activitySection.createDiv({ cls: "chronoboard-stats-section-title", text: chartTitle });
    activitySection.createDiv({
      cls: "chronoboard-stats-section-description",
      text: chartDescription
    });
    if (heatmapCalendars) {
      const heatmapData = heatmapCalendars.map((calendar) => ({
        ...calendar,
        days: calendar.days.map((day) => ({
          day,
          minutes: chartEntries.reduce(
            (sum, item) => sum + (item.start.isSame(day, "day") ? item.minutes : 0),
            0
          )
        }))
      }));
      const allDayMinutes = heatmapData.flatMap((calendar) => calendar.days.map((item) => item.minutes));
      const includeZeroDays = Boolean(this.plugin.settings.heatmapIncludeZeroDays);
      const scaleMinutes = includeZeroDays ? allDayMinutes : allDayMinutes.filter((minutes) => minutes > 0);
      const minimumMinutes = scaleMinutes.length ? Math.min(...scaleMinutes) : 0;
      const maximumMinutes = scaleMinutes.length ? Math.max(...scaleMinutes) : 0;
      const lowColor = normalizeHexColor(this.plugin.settings.heatmapLowColor) || DEFAULT_SETTINGS.heatmapLowColor;
      const highColor = normalizeHexColor(this.plugin.settings.heatmapHighColor) || DEFAULT_SETTINGS.heatmapHighColor;
      const calendarsWrap = activitySection.createDiv({
        cls: `chronoboard-stats-heatmaps${this.statsScope === "year" ? " is-year" : ""}`
      });
      heatmapData.forEach((calendarData) => {
        const calendarGroup = calendarsWrap.createDiv({ cls: "chronoboard-stats-heatmap-group" });
        if (calendarData.label) {
          calendarGroup.createDiv({ cls: "chronoboard-stats-heatmap-month", text: calendarData.label });
        }
        const calendar = calendarGroup.createDiv({ cls: "chronoboard-stats-heatmap" });
        ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].forEach((dayName) => {
          calendar.createDiv({ cls: "chronoboard-stats-heatmap-weekday", text: dayName });
        });
        const leadingCells = calendarData.start.isoWeekday() - 1;
        for (let index = 0; index < leadingCells; index += 1) {
          calendar.createDiv({ cls: "chronoboard-stats-heatmap-cell is-empty" });
        }
        calendarData.days.forEach((item) => {
          const shouldColor = item.minutes > 0 || includeZeroDays;
          const cell = calendar.createDiv({
            cls: `chronoboard-stats-heatmap-cell${item.minutes ? " has-time" : includeZeroDays ? " is-zero" : ""}`
          });
          if (shouldColor) {
            const ratio = maximumMinutes === minimumMinutes
              ? item.minutes > 0 ? 1 : 0
              : (item.minutes - minimumMinutes) / (maximumMinutes - minimumMinutes);
            const color = mixHexColors(lowColor, highColor, ratio);
            cell.style.background = color;
            cell.style.color = getContrastTextColor(color);
          }
          cell.setAttr("title", `${item.day.format("MMMM D, YYYY")}: ${formatHours(item.minutes)}`);
          cell.createDiv({ cls: "chronoboard-stats-heatmap-day", text: item.day.format("D") });
          cell.createDiv({
            cls: "chronoboard-stats-heatmap-hours",
            text: item.minutes || includeZeroDays ? formatHours(item.minutes) : ""
          });
        });
      });
      const scale = activitySection.createDiv({ cls: "chronoboard-stats-heatmap-scale" });
      scale.createSpan({ text: scaleMinutes.length ? formatHours(minimumMinutes) : "No time" });
      const scaleGradient = scale.createSpan({ cls: "chronoboard-stats-heatmap-gradient" });
      scaleGradient.style.background = `linear-gradient(90deg, ${lowColor}, ${highColor})`;
      scale.createSpan({ text: scaleMinutes.length ? formatHours(maximumMinutes) : "" });
    } else {
      const highestChartMinutes = Math.max(...chartItems.map((item) => item.minutes), 0);
      const chartBars = activitySection.createDiv({ cls: "chronoboard-stats-bars" });
      chartBars.style.gridTemplateColumns = `repeat(${Math.max(chartItems.length, 1)}, minmax(36px, 1fr))`;
      if (!chartItems.length) {
        chartBars.createDiv({ cls: "chronoboard-stats-empty", text: "No chart data is available for this range." });
      }
      chartItems.forEach((item) => {
        const bar = chartBars.createDiv({ cls: "chronoboard-stats-bar-wrap" });
        bar.createDiv({ cls: "chronoboard-stats-bar-value", text: formatHours(item.minutes) });
        bar.createDiv({
          cls: `chronoboard-stats-bar ${getHoursColor(item.minutes)}`,
          attr: {
            style: `height:${highestChartMinutes ? Math.max((item.minutes / highestChartMinutes) * 150, 8) : 8}px`
          }
        });
        bar.createDiv({ cls: "chronoboard-stats-bar-label", text: item.label });
      });
    }

    const taskSection = details.createDiv({ cls: "chronoboard-stats-section chronoboard-stats-task-section" });
    const taskSectionHead = taskSection.createDiv({ cls: "chronoboard-stats-section-head" });
    taskSectionHead.createDiv({ cls: "chronoboard-stats-section-title", text: "Highest-hour tasks" });
    taskSectionHead.createDiv({
      cls: "chronoboard-stats-section-count",
      text: `${taskStats.length} tracked task${taskStats.length === 1 ? "" : "s"}`
    });
    const taskList = taskSection.createDiv({ cls: "chronoboard-stats-task-list" });
    if (!taskStats.length) {
      taskList.createDiv({ cls: "chronoboard-stats-empty", text: "No tracked time is available for this range." });
    } else {
      taskStats.slice(0, 10).forEach((item, index) => {
        const row = taskList.createDiv({ cls: "chronoboard-stats-task-row" });
        row.createDiv({ cls: "chronoboard-stats-task-rank", text: String(index + 1) });
        const content = row.createDiv({ cls: "chronoboard-stats-task-content" });
        const taskHead = content.createDiv({ cls: "chronoboard-stats-task-head" });
        const name = taskHead.createDiv({ cls: "chronoboard-stats-task-name" });
        const taskKey = name.createDiv({
          cls: "chronoboard-task-key chronoboard-stats-task-key",
          text: item.task.jiraKey || item.task.file.basename
        });
        const taskColor = normalizeHexColor(item.task.color);
        if (taskColor) {
          taskKey.addClass("has-task-color");
          taskKey.style.background = taskColor;
          taskKey.style.color = getContrastTextColor(taskColor);
        }
        const secondaryText = this.plugin.getTaskSecondaryText(item.task);
        if (secondaryText) {
          name.createDiv({ cls: "chronoboard-task-name", text: secondaryText });
        }
        taskHead.createDiv({ cls: "chronoboard-stats-task-hours", text: formatHours(item.minutes) });
        const meter = content.createDiv({ cls: "chronoboard-stats-task-meter" });
        const meterFill = meter.createDiv({
          cls: "chronoboard-stats-task-meter-fill",
          attr: { style: `width:${totalMinutes ? Math.max((item.minutes / totalMinutes) * 100, 1) : 0}%` }
        });
        if (taskColor) {
          meterFill.style.background = taskColor;
        }
        const meta = content.createDiv({ cls: "chronoboard-stats-task-meta" });
        const share = totalMinutes ? Math.round((item.minutes / totalMinutes) * 100) : 0;
        meta.createSpan({ text: `${item.blockCount} block${item.blockCount === 1 ? "" : "s"}` });
        meta.createSpan({ text: `${item.activeDays} active day${item.activeDays === 1 ? "" : "s"}` });
        meta.createSpan({ text: `${share}% of tracked time` });
      });
    }
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
    const secondaryText = this.plugin.getTaskSecondaryText(task);
    const durationMinutes = this.entryMinutes(renderedEntry);
    const hideTimeLine = horizontal
      ? position.sizePx < (secondaryText ? 140 : 92)
      : durationMinutes <= (secondaryText ? 60 : 30);
    const showStatus = this.shouldDisplayTaskStatus(task) && (horizontal ? position.sizePx >= 150 : true);
    this.applyTicketSurfaceStyle(block, task, true);
    const titleText = task.jiraKey || task.file.basename;
    const head = block.createDiv({ cls: "chronoboard-block-head" });
    head.createDiv({
      cls: "chronoboard-task-name",
      text: titleText
    });
    if (showStatus) {
      head.createDiv({
        cls: `chronoboard-block-status ${getStatusToneClass(task.status)}`,
        text: task.status
      });
    }
    if (secondaryText) {
      block.createDiv({
        cls: "chronoboard-block-subtitle",
        text: secondaryText
      });
    }
    const timeRangeText = `${moment(renderedEntry.startTime).format("HH:mm")} to ${moment(renderedEntry.endTime).format("HH:mm")}`;
    if (!hideTimeLine) {
      block.createDiv({
        cls: "chronoboard-block-time",
        text: timeRangeText
      });
    } else {
      block.setAttr("title", `${titleText}\n${timeRangeText}`);
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
      if (this.plugin.settings.quickActionBarEnabled) {
        menu.addItem((item) =>
          item
            .setTitle("Add Task to Linkbar")
            .setIcon("panel-top")
            .onClick(() => this.plugin.addTaskToQuickActionBar(task))
        );
      }
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
          .setTitle("Show time log")
          .setIcon("table")
          .onClick(() => new TimeLogModal(this.app, this.plugin, task).open())
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
    const summaryCopy = this.getSummaryCopy();
    const panel = layout.createDiv({ cls: "chronoboard-panel" });
    const panelHead = panel.createDiv({ cls: "chronoboard-panel-head" });
    panelHead.createDiv({
      text: summaryCopy.title
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
        text: "Totals appear here when tasks have tracked time in this range."
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
        text: summaryCopy.note
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
    if (this.plugin.settings.quickActionBarEnabled) {
      menu.addItem((item) =>
        item
          .setTitle("Add Task to Linkbar")
          .setIcon("panel-top")
          .onClick(() => this.plugin.addTaskToQuickActionBar(task))
      );
    }
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
        .setTitle("Show time log")
        .setIcon("table")
        .onClick(() => new TimeLogModal(this.app, this.plugin, task).open())
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

  handleWeekContextMenu(event, dayMoment, column) {
    event.preventDefault();
    const rect = column.getBoundingClientRect();
    const coord = clampNumber(event.clientY - rect.top, 0, rect.height);
    new TaskPickerModal(this.app, this.plugin, {
      onChoose: async (task) => {
        if (!this.plugin.settings.selectedTaskPaths.includes(task.path)) {
          this.plugin.settings.selectedTaskPaths = [...this.plugin.settings.selectedTaskPaths, task.path];
          this.plugin.settings.boardOnlyTaskPaths = (this.plugin.settings.boardOnlyTaskPaths || []).filter((path) => path !== task.path);
          await this.plugin.saveSettings();
        }
        this.selectedTaskPath = task.path;
        const entry = this.entryFromCoord(coord, rect.height, dayMoment.format("YYYY-MM-DD"));
        if (entry) {
          await this.plugin.addTimeEntry(task.file, entry, { pushUndo: true });
        }
        await this.render();
      }
    }).open();
  }

  entryFromCoord(coord, totalPixels, dayKey) {
    const dayMoment = moment(dayKey, "YYYY-MM-DD");
    const totalMinutes = this.getVisibleHourCount() * 60;
    const minutesIntoWindow = (coord / totalPixels) * totalMinutes;
    const roundedStart = clampNumber(Math.floor(minutesIntoWindow / 15) * 15, 0, Math.max(totalMinutes - 30, 0));
    const roundedEnd = Math.min(roundedStart + 30, totalMinutes);
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
    if (this.currentMode === "stats") {
      return this.getStatsMinutes(task.timeEntries || []);
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
    if (this.currentMode === "stats") {
      return this.getStatsMinutes(task.timeEntries) > 0;
    }
    return task.timeEntries.length > 0;
  }
}

module.exports = class ChronoboardPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.undoStack = [];
    this.settingsSaveQueue = Promise.resolve();
    this.frontmatterSaveQueues = new Map();
    this.saveConfirmationTimer = null;
    this.savedIndicatorTimer = null;
    this.savedIndicatorEl = null;

    await this.recoverInterruptedTimeEntrySaves();

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
      id: "export-chronoboard-csv",
      name: "Export tracked time as CSV",
      callback: () => this.showCsvExportModal()
    });

    this.addCommand({
      id: "manage-chronoboard-toolbar",
      name: "Manage Linkbar buttons",
      callback: () => this.openQuickActionManager()
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
      callback: () => this.openGuide()
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
    this.registerEvent(this.app.vault.on("rename", (file, oldPath) => this.handleRename(file, oldPath)));
    this.registerEvent(this.app.vault.on("delete", () => this.refreshAllViews()));
    this.registerDomEvent(document, "keydown", (event) => this.handleUndoKeydown(event));
  }

  async onunload() {
    window.clearTimeout(this.saveConfirmationTimer);
    window.clearTimeout(this.savedIndicatorTimer);
    this.savedIndicatorEl?.remove();
    await Promise.allSettled([this.settingsSaveQueue, ...this.frontmatterSaveQueues.values()]);
    await this.app.workspace.detachLeavesOfType(VIEW_TYPE);
  }

  async loadSettings() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.settings.highlightColor = normalizeHexColor(this.settings.highlightColor);
    this.settings.heatmapLowColor = normalizeHexColor(this.settings.heatmapLowColor) || DEFAULT_SETTINGS.heatmapLowColor;
    this.settings.heatmapHighColor = normalizeHexColor(this.settings.heatmapHighColor) || DEFAULT_SETTINGS.heatmapHighColor;
    this.settings.quickActions = Array.isArray(this.settings.quickActions) ? this.settings.quickActions : [];
    const linkbarPadding = Number(this.settings.quickActionBarPadding);
    this.settings.quickActionBarPadding = clampNumber(
      Number.isFinite(linkbarPadding) ? linkbarPadding : DEFAULT_SETTINGS.quickActionBarPadding,
      0,
      5
    );
  }

  async saveSettings(options = {}) {
    await this.queueSettingsSave();
    if (options.confirm !== false) {
      this.scheduleSaveConfirmation();
    }
  }

  queueSettingsSave() {
    const snapshot = JSON.parse(JSON.stringify(this.settings));
    this.settingsSaveQueue = this.settingsSaveQueue
      .catch((error) => console.error("A previous Chronoboard settings save failed.", error))
      .then(() => this.saveData(snapshot));
    return this.settingsSaveQueue;
  }

  async processTaskFrontMatter(file, update) {
    const key = file.path;
    const previous = this.frontmatterSaveQueues.get(key) || Promise.resolve();
    const pending = previous
      .catch((error) => console.error(`A previous Chronoboard save failed for ${key}.`, error))
      .then(() => this.app.fileManager.processFrontMatter(file, update));
    this.frontmatterSaveQueues.set(key, pending);
    try {
      return await pending;
    } finally {
      if (this.frontmatterSaveQueues.get(key) === pending) {
        this.frontmatterSaveQueues.delete(key);
      }
    }
  }

  getRecoveryJournalKey() {
    return `chronoboard-time-entry-recovery:${RECOVERY_JOURNAL_VERSION}:${this.app.vault.getName()}`;
  }

  readTimeEntryRecoveryJournal() {
    try {
      const journal = JSON.parse(window.localStorage.getItem(this.getRecoveryJournalKey()) || "[]");
      return Array.isArray(journal) ? journal : [];
    } catch (error) {
      console.error("Chronoboard could not read its time-entry recovery journal.", error);
      return [];
    }
  }

  writeTimeEntryRecoveryJournal(journal) {
    try {
      const key = this.getRecoveryJournalKey();
      if (journal.length) {
        window.localStorage.setItem(key, JSON.stringify(journal));
      } else {
        window.localStorage.removeItem(key);
      }
    } catch (error) {
      console.error("Chronoboard could not update its time-entry recovery journal.", error);
    }
  }

  appendTimeEntryRecoveryOperation(path, type, payload) {
    const journal = this.readTimeEntryRecoveryJournal();
    journal.push({
      id: createEntryId(),
      path,
      type,
      payload: JSON.parse(JSON.stringify(payload)),
      updatedAt: Date.now()
    });
    this.writeTimeEntryRecoveryJournal(journal);
  }

  clearTimeEntryRecoveryOperations(operationIds) {
    const completed = new Set(operationIds);
    const journal = this.readTimeEntryRecoveryJournal();
    this.writeTimeEntryRecoveryJournal(journal.filter((operation) => !completed.has(operation.id)));
  }

  async recoverInterruptedTimeEntrySaves() {
    const journal = this.readTimeEntryRecoveryJournal();
    const operationsByPath = new Map();
    journal.forEach((operation) => {
      if (!operation?.path || !operation?.type || !operation?.id) {
        return;
      }
      const operations = operationsByPath.get(operation.path) || [];
      operations.push(operation);
      operationsByPath.set(operation.path, operations);
    });
    let recoveredCount = 0;
    for (const [path, operations] of operationsByPath) {
      let file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) {
        const name = path.split("/").pop();
        const matches = this.app.vault.getMarkdownFiles().filter((candidate) => candidate.name === name);
        file = matches.length === 1 ? matches[0] : null;
      }
      if (!(file instanceof TFile)) {
        continue;
      }
      try {
        let didRecover = false;
        await this.app.fileManager.processFrontMatter(file, (frontmatter) => {
          let entries = Array.isArray(frontmatter.timeEntries) ? [...frontmatter.timeEntries] : [];
          operations.forEach((operation) => {
            const { type, payload } = operation;
            const entry = payload?.entry;
            const findEntryIndex = () => entries.findIndex((candidate, index) => {
              if (entry?.id && candidate.id === entry.id) {
                return true;
              }
              if (type === "update") {
                return index === payload?.entryIndex;
              }
              return index === payload?.entryIndex
                && candidate.startTime === entry?.startTime
                && candidate.endTime === entry?.endTime;
            });
            if (type === "add" && entry) {
              if (findEntryIndex() === -1) {
                entries.push(entry);
                didRecover = true;
              }
            } else if (type === "update" && entry) {
              const index = findEntryIndex();
              if (index === -1) {
                entries.push(entry);
                didRecover = true;
              } else {
                if (JSON.stringify(entries[index]) !== JSON.stringify(entry)) {
                  entries[index] = entry;
                  didRecover = true;
                }
              }
            } else if (type === "remove" && entry) {
              const index = findEntryIndex();
              if (index !== -1) {
                entries.splice(index, 1);
                didRecover = true;
              }
            }
          });
          entries.sort((a, b) => String(a.startTime).localeCompare(String(b.startTime)));
          frontmatter.timeEntries = entries;
        });
        this.clearTimeEntryRecoveryOperations(operations.map((operation) => operation.id));
        if (didRecover) {
          recoveredCount += 1;
        }
      } catch (error) {
        console.error(`Chronoboard could not recover time entries for ${path}.`, error);
      }
    }
    if (recoveredCount > 0) {
      new Notice(`Chronoboard recovered time entries for ${recoveredCount} task${recoveredCount === 1 ? "" : "s"}.`);
    }
  }

  scheduleSaveConfirmation() {
    window.clearTimeout(this.saveConfirmationTimer);
    this.saveConfirmationTimer = window.setTimeout(async () => {
      try {
        await this.queueSettingsSave();
        await Promise.all([...this.frontmatterSaveQueues.values()]);
        this.showSavedIndicator();
      } catch (error) {
        console.error("Chronoboard could not save its settings.", error);
        new Notice("Chronoboard could not save changes.");
      }
    }, 3000);
  }

  showSavedIndicator() {
    window.clearTimeout(this.savedIndicatorTimer);
    this.savedIndicatorEl?.remove();
    const indicator = document.body.createDiv({ cls: "chronoboard-saved-indicator" });
    const icon = indicator.createSpan({ cls: "chronoboard-saved-indicator-icon" });
    setIcon(icon, "check");
    indicator.createSpan({ text: "Saved" });
    this.savedIndicatorEl = indicator;
    this.savedIndicatorTimer = window.setTimeout(() => {
      indicator.remove();
      if (this.savedIndicatorEl === indicator) {
        this.savedIndicatorEl = null;
      }
    }, 2200);
  }

  async remapStoredTaskPaths(remap) {
    let changed = false;
    for (const key of ["selectedTaskPaths", "staticTaskPaths", "boardOnlyTaskPaths"]) {
      const current = Array.isArray(this.settings[key]) ? this.settings[key] : [];
      const updated = [...new Set(current.map(remap).filter(Boolean))];
      if (updated.length !== current.length || updated.some((path, index) => path !== current[index])) {
        this.settings[key] = updated;
        changed = true;
      }
    }
    for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE)) {
      const view = leaf.view;
      if (view?.selectedTaskPath) {
        view.selectedTaskPath = remap(view.selectedTaskPath);
      }
    }
    if (changed) {
      await this.saveSettings({ confirm: false });
    }
    return changed;
  }

  async handleRename(file, oldPath) {
    if (!(file instanceof TFile) && !(file instanceof TFolder)) {
      await this.refreshAllViews();
      return;
    }
    const oldPrefix = `${oldPath}/`;
    const newPrefix = `${file.path}/`;
    const remap = file instanceof TFile
      ? (path) => (path === oldPath ? file.path : path)
      : (path) => (path.startsWith(oldPrefix) ? `${newPrefix}${path.slice(oldPrefix.length)}` : path);
    await this.remapStoredTaskPaths(remap);
    await this.refreshAllViews();
  }

  async repairMissingTaskPath(path) {
    const fileName = String(path || "").split("/").pop();
    if (!fileName) {
      return null;
    }
    const matches = this.app.vault.getMarkdownFiles().filter((candidate) => candidate.name === fileName);
    if (matches.length !== 1) {
      return null;
    }
    const file = matches[0];
    await this.remapStoredTaskPaths((storedPath) => (storedPath === path ? file.path : storedPath));
    return file;
  }

  openGuide() {
    new ChronoboardGuideModal(this.app, this).open();
  }

  openQuickActionManager(options = {}) {
    new QuickActionManagerModal(this.app, this, options).open();
  }

  getQuickActionCopyText(action) {
    if (action.actionType === "url") {
      return String(action.target || "").trim();
    }
    const linkText = this.cleanQuickActionNoteTarget(action.target);
    const hashIndex = linkText.indexOf("#");
    const subpath = hashIndex >= 0 ? linkText.slice(hashIndex) : "";
    const file = this.getQuickActionNoteFile(action.target);
    const noteName = file instanceof TFile
      ? file.basename
      : linkText.slice(0, hashIndex >= 0 ? hashIndex : undefined).split("/").pop();
    return this.normalizeQuickActionNoteTarget(`${noteName || linkText}${subpath}`);
  }

  async copyQuickActionLink(action) {
    const value = this.getQuickActionCopyText(action);
    if (!value) {
      new Notice("This Linkbar button does not have a link to copy.");
      return;
    }
    try {
      await navigator.clipboard.writeText(value);
      new Notice("Link copied.");
    } catch (error) {
      console.error("Chronoboard could not copy the Linkbar address.", error);
      new Notice("Chronoboard could not copy the link.");
    }
  }

  async addTaskToQuickActionBar(task) {
    if (!this.settings.quickActionBarEnabled || !(task?.file instanceof TFile)) {
      return;
    }
    const exists = this.settings.quickActions.some((action) =>
      action.actionType === "note" && this.getQuickActionNoteFile(action.target)?.path === task.file.path
    );
    if (exists) {
      new Notice("This task is already on the Linkbar.");
      return;
    }
    this.settings.quickActions.push({
      id: `quick-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
      displayType: "text",
      label: this.getTaskLabel(task),
      icon: "",
      iconColor: "",
      actionType: "note",
      target: this.normalizeQuickActionNoteTarget(task.file.basename)
    });
    await this.saveSettings();
    await this.refreshAllViews();
    new Notice("Task added to the Linkbar.");
  }

  cleanQuickActionNoteTarget(target) {
    return String(target || "")
      .trim()
      .replace(/^\[\[/, "")
      .replace(/\]\]$/, "")
      .split("|")[0]
      .trim();
  }

  normalizeQuickActionNoteTarget(target) {
    const value = String(target || "").trim();
    if (!value) {
      return "";
    }
    const linkText = value.replace(/^\[\[/, "").replace(/\]\]$/, "").trim();
    return `[[${linkText}]]`;
  }

  getQuickActionNoteFile(target) {
    const linkText = this.cleanQuickActionNoteTarget(target);
    const filePath = linkText.split("#")[0];
    const exactPath = filePath.endsWith(".md") ? filePath : `${filePath}.md`;
    const exactFile = this.app.vault.getAbstractFileByPath(filePath)
      || this.app.vault.getAbstractFileByPath(exactPath);
    if (exactFile instanceof TFile) {
      return exactFile;
    }
    return this.app.metadataCache.getFirstLinkpathDest(filePath, "");
  }

  getQuickActionVisual(action) {
    if (action.icon) {
      return { icon: action.icon, color: getIconicCssColor(action.iconColor) };
    }
    if (action.actionType !== "note") {
      return { icon: "external-link", color: getIconicCssColor(action.iconColor) };
    }
    const file = this.getQuickActionNoteFile(action.target);
    const iconic = this.app.plugins?.plugins?.iconic;
    if (file instanceof TFile && iconic && typeof iconic.getFileItem === "function") {
      try {
        const item = iconic.getFileItem(file.path);
        return {
          icon: item?.icon || item?.iconDefault || "file",
          color: getIconicCssColor(action.iconColor) || getIconicCssColor(item?.color)
        };
      } catch (error) {
        console.error("Chronoboard could not read the Iconic note icon.", error);
      }
    }
    return { icon: "file", color: getIconicCssColor(action.iconColor) };
  }

  getOpenLeafForFile(file) {
    let matchingLeaf = null;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (matchingLeaf) {
        return;
      }
      const openPath = leaf.view?.file?.path || leaf.getViewState?.().state?.file;
      if (openPath === file.path) {
        matchingLeaf = leaf;
      }
    });
    return matchingLeaf;
  }

  async runQuickAction(action) {
    if (action.actionType === "url") {
      const target = String(action.target || "").trim();
      if (!/^https?:\/\//i.test(target)) {
        new Notice("Enter a complete http or https URL for this Linkbar button.");
        return;
      }
      window.open(target, "_blank", "noopener,noreferrer");
      return;
    }

    const file = this.getQuickActionNoteFile(action.target);
    if (!(file instanceof TFile)) {
      new Notice(`Chronoboard could not find ${action.target}.`);
      return;
    }
    const linkText = this.cleanQuickActionNoteTarget(action.target);
    const openLeaf = this.getOpenLeafForFile(file);
    if (openLeaf) {
      await this.app.workspace.revealLeaf(openLeaf);
      if (linkText.includes("#")) {
        await this.app.workspace.openLinkText(linkText, file.path, false);
      }
      return;
    }
    if (linkText.includes("#")) {
      await this.app.workspace.openLinkText(linkText, "", false);
      return;
    }
    const leaf = this.app.workspace.getLeaf("tab");
    await leaf.openFile(file);
  }

  buildGuideContent() {
    return [
      "> [!info] What Chronoboard Is",
      "> Chronoboard is a task-native timeboard for Obsidian. It lets you pull tasks from a configured folder and place time visually in day, week, and month views.",
      "",
      "## Core workflow",
      "",
      "> [!tip] Task setup",
      "> Tasks should usually have your configured status frontmatter, `Status` by default. That is what makes them available in the add-task pool unless they are explicitly included through `Always include tasks`.",
      "- Add tasks into the left task pool with `Add task to Chronoboard` or the `+ Add task` slot.",
      "- Make sure the task file has the configured status frontmatter property before expecting it to appear in the task pool.",
      "- Click a task in the left pool to select it, then click and drag in the board to create a time block.",
      "- Hold and drag an existing time block to move it.",
      "- Double click a time block to remove it.",
      "- Use `Ctrl+Z` or `Cmd+Z` to undo adding or removing a time block.",
      "## Status frontmatter values",
      "- Use these values in the configured `Status` frontmatter property.",
      "",
      "| Value                                                           | Color               | Notes                                                                      |",
      "| --------------------------------------------------------------- | ------------------- | -------------------------------------------------------------------------- |",
      "| <span style=\"color:#4ea0ff;font-weight:700;\">In Progress</span> | `#4ea0ff`           | Highest-priority active work                                               |",
      "| <span style=\"color:#2fb859;font-weight:700;\">Ongoing</span>     | `#2fb859`           | Continuous or recurring work                                               |",
      "| <span style=\"color:#d29119;font-weight:700;\">On Hold</span>     | `#d29119`           | Paused work                                                                |",
      "| <span style=\"color:#9f63f2;font-weight:700;\">Upcoming</span>    | `#9f63f2`           | Planned work not yet started                                               |",
      "| `Finished`                                                      | excluded by default | Hidden from the add-task picker when `Excluded values` contains `finished` |",
      "",
      "## Right click on a time block",
      "",
      "> [!example] Why subtitles help",
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
      "- `Export tracked time as CSV`",
      "- `Manage Linkbar buttons`",
      "- `Open selected Chronoboard task`",
      "- `Open Chronoboard guide`",
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
      "- `Show Linkbar`: shows the configurable note and web link bar.",
      "- `Scrollable Linkbar`: keeps Linkbar buttons at their natural width and enables horizontal scrolling.",
      "- `Curved inner button corners`: rounds each Linkbar button instead of using square corners between buttons.",
      "- `Linkbar padding`: changes the space around and between Linkbar buttons.",
      "- `Hide weekends in week and month views`: hides Saturday and Sunday from those timeline views.",
      "- `Visible start hour` and `Visible end hour`: control the working-day window shown in day and week views.",
      "- `Highlight color`: changes the accent color used by Chronoboard controls.",
      "- `Force dark text on colored cards`: helps readability on custom light-colored task cards and blocks."
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

  showCsvExportModal(range = null) {
    const view = this.getOpenChronoboardView();
    const defaultRange = range || view?.getExportRange() || {
      startDate: moment().startOf("isoWeek").format("YYYY-MM-DD"),
      endDate: moment().endOf("isoWeek").format("YYYY-MM-DD")
    };
    new CsvExportModal(this.app, this, defaultRange).open();
  }

  async getExportTasksInRange(startDate, endDate) {
    const rangeStart = moment(startDate, "YYYY-MM-DD", true).startOf("day");
    const rangeEnd = moment(endDate, "YYYY-MM-DD", true).add(1, "day").startOf("day");
    if (!rangeStart.isValid() || !rangeEnd.isValid() || !rangeStart.isBefore(rangeEnd)) {
      return [];
    }

    const files = new Map();
    const folder = normalizeVaultFolder(this.settings.folder);
    if (folder !== null) {
      const prefix = folder ? `${folder}/` : "";
      this.app.vault.getMarkdownFiles().forEach((file) => {
        if (!folder || file.path.startsWith(prefix)) {
          files.set(file.path, file);
        }
      });
    }
    [
      ...(this.settings.staticTaskPaths || []),
      ...(this.settings.selectedTaskPaths || []),
      ...(this.settings.boardOnlyTaskPaths || [])
    ].forEach((path) => {
      const file = this.resolveVaultMarkdownFile(path);
      if (file instanceof TFile) {
        files.set(file.path, file);
      }
    });

    const results = [];
    files.forEach((file) => {
      const task = this.getTaskFromFile(file);
      if (!task) {
        return;
      }
      const entries = [];
      (task.timeEntries || []).forEach((entry) => {
        const start = parseFrontmatterDate(entry.startTime);
        const end = parseFrontmatterDate(entry.endTime);
        if (!start || !end || !end.isAfter(start) || !end.isAfter(rangeStart) || !start.isBefore(rangeEnd)) {
          return;
        }
        const clippedStart = start.isBefore(rangeStart) ? rangeStart.clone() : start.clone();
        const clippedEnd = end.isAfter(rangeEnd) ? rangeEnd.clone() : end.clone();
        const minutes = Math.max(clippedEnd.diff(clippedStart, "minutes"), 0);
        if (!minutes) {
          return;
        }
        entries.push({ entry, clippedStart, clippedEnd, minutes });
      });
      if (!entries.length) {
        return;
      }
      entries.sort((a, b) => a.clippedStart.valueOf() - b.clippedStart.valueOf());
      results.push({
        task,
        entries,
        minutes: entries.reduce((sum, item) => sum + item.minutes, 0)
      });
    });

    return results.sort((a, b) => {
      if (b.minutes !== a.minutes) {
        return b.minutes - a.minutes;
      }
      return this.getTaskLabel(a.task).localeCompare(this.getTaskLabel(b.task));
    });
  }

  buildCsvExport(taskGroups, options = {}) {
    if (options.compressed) {
      return this.buildCompressedCsvExport(taskGroups, options.startDate, options.endDate);
    }
    const rows = [[
      "Task",
      "Subtitle",
      "Status",
      "Date",
      "Start",
      "End",
      "Duration Minutes",
      "Hours",
      "Block Text",
      "Task Path",
      "Time Entry Note"
    ]];
    const entries = [];
    taskGroups.forEach((group) => {
      group.entries.forEach((item) => entries.push({ task: group.task, ...item }));
    });
    entries.sort((a, b) => a.clippedStart.valueOf() - b.clippedStart.valueOf());
    entries.forEach(({ task, entry, clippedStart, clippedEnd, minutes }) => {
      rows.push([
        task.jiraKey || task.file.basename,
        this.getTaskSecondaryText(task),
        task.status || "",
        clippedStart.format("YYYY-MM-DD"),
        clippedStart.format("HH:mm"),
        clippedEnd.format("HH:mm"),
        String(minutes),
        (minutes / 60).toFixed(2),
        entry.label || "",
        task.path,
        entry.notePath || ""
      ]);
    });
    return `${rows.map((row) => row.map(escapeCsvValue).join(",")).join("\n")}\n`;
  }

  buildCompressedCsvExport(taskGroups, startDate, endDate) {
    const sortedGroups = [...taskGroups].sort((a, b) => {
      if (b.minutes !== a.minutes) {
        return b.minutes - a.minutes;
      }
      return this.getTaskLabel(a.task).localeCompare(this.getTaskLabel(b.task));
    });
    const rows = [[
      "Date",
      ...sortedGroups.map((group) => this.getTaskLabel(group.task)),
      "TOTAL"
    ]];
    const totalMinutes = sortedGroups.reduce((sum, group) => sum + group.minutes, 0);
    rows.push([
      "TOTAL",
      ...sortedGroups.map((group) => (group.minutes / 60).toFixed(2)),
      (totalMinutes / 60).toFixed(2)
    ]);

    const cursor = moment(startDate, "YYYY-MM-DD", true).startOf("day");
    const finalDay = moment(endDate, "YYYY-MM-DD", true).startOf("day");
    while (cursor.isSameOrBefore(finalDay, "day")) {
      const dayStart = cursor.clone().startOf("day");
      const dayEnd = dayStart.clone().add(1, "day");
      const taskMinutes = sortedGroups.map((group) => group.entries.reduce((sum, item) => {
        if (!item.clippedEnd.isAfter(dayStart) || !item.clippedStart.isBefore(dayEnd)) {
          return sum;
        }
        const start = item.clippedStart.isBefore(dayStart) ? dayStart : item.clippedStart;
        const end = item.clippedEnd.isAfter(dayEnd) ? dayEnd : item.clippedEnd;
        return sum + Math.max(end.diff(start, "minutes"), 0);
      }, 0));
      rows.push([
        dayStart.format("YYYY-MM-DD"),
        ...taskMinutes.map((minutes) => (minutes / 60).toFixed(2)),
        (taskMinutes.reduce((sum, minutes) => sum + minutes, 0) / 60).toFixed(2)
      ]);
      cursor.add(1, "day");
    }
    return `${rows.map((row) => row.map(escapeCsvValue).join(",")).join("\n")}\n`;
  }

  async ensureVaultFolder(folderPath) {
    const folder = normalizeVaultFolder(folderPath);
    if (folder === null) {
      throw new Error("Invalid export folder path");
    }
    if (!folder) {
      return;
    }
    let currentPath = "";
    for (const segment of folder.split("/")) {
      currentPath = currentPath ? `${currentPath}/${segment}` : segment;
      const existing = this.app.vault.getAbstractFileByPath(currentPath);
      if (existing instanceof TFolder) {
        continue;
      }
      if (existing) {
        throw new Error(`A file blocks the export folder path: ${currentPath}`);
      }
      await this.app.vault.createFolder(currentPath);
    }
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
      let file = this.app.vault.getAbstractFileByPath(path);
      if (!(file instanceof TFile)) {
        file = await this.repairMissingTaskPath(path);
      }
      if (!(file instanceof TFile)) {
        continue;
      }
      const task = this.getTaskFromFile(file);
      if (task) {
        map.set(path, task);
        map.set(file.path, task);
      }
    }
    return map;
  }

  buildTimeLogMarkdown(task) {
    const entries = (Array.isArray(task.timeEntries) ? task.timeEntries : [])
      .map((entry) => {
        const start = parseFrontmatterDate(entry.startTime);
        const end = parseFrontmatterDate(entry.endTime);
        if (!start || !end || !end.isAfter(start)) {
          return null;
        }
        return {
          entry,
          start,
          end,
          minutes: end.diff(start, "minutes")
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.start.valueOf() - b.start.valueOf());
    if (!entries.length) {
      return "_No valid time entries are available._";
    }
    const weeks = new Map();
    entries.forEach((record) => {
      const { start } = record;
      const weekKey = start.format("GGGG-[W]WW");
      if (!weeks.has(weekKey)) {
        weeks.set(weekKey, { weekStart: start.clone().startOf("isoWeek"), days: new Map() });
      }
      const dayKey = start.format("YYYY-MM-DD");
      const week = weeks.get(weekKey);
      if (!week.days.has(dayKey)) {
        week.days.set(dayKey, []);
      }
      week.days.get(dayKey).push(record);
    });

    const sumMinutes = (list) => list.reduce((sum, record) => sum + record.minutes, 0);

    const newestFirst = this.settings.timeLogNewestFirst;
    const weekKeys = [...weeks.keys()].sort();
    if (newestFirst) {
      weekKeys.reverse();
    }
    const sections = weekKeys.map((weekKey, weekIndex) => {
      const week = weeks.get(weekKey);
      const weekEntries = [...week.days.values()].flat();
      const weekLabel = `Week of ${week.weekStart.format("MMM D")} – ${week.weekStart.clone().endOf("isoWeek").format("MMM D")} (${formatHours(sumMinutes(weekEntries))})`;

      const dayKeys = [...week.days.keys()].sort();
      if (newestFirst) {
        dayKeys.reverse();
      }
      const dayBlocks = dayKeys.map((dayKey) => {
        const dayEntries = week.days.get(dayKey);
        const dayLabel = `${moment(dayKey).format("dddd, MMM D")} (${formatHours(sumMinutes(dayEntries))})`;
        const rows = dayEntries.map((record) => {
          const note = escapeMarkdownTableCell(record.entry.label);
          return `| ${record.start.format("HH:mm")} | ${record.end.format("HH:mm")} | ${formatHours(record.minutes)} | ${note} |`;
        });
        const table = ["| Start | End | Duration | Note |", "|:---|:---|:---|:---|", ...rows].join("\n");
        return `<details class="chronoboard-log-day">\n<summary>${dayLabel}</summary>\n\n${table}\n\n</details>`;
      });

      return `<details class="chronoboard-log-week"${weekIndex === 0 ? " open" : ""}>\n<summary>${weekLabel}</summary>\n\n${dayBlocks.join("\n\n")}\n\n</details>`;
    });
    return sections.join("\n\n");
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
      await this.processTaskFrontMatter(file, (frontmatter) => {
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
    const storedEntry = {
      ...entry,
      id: entry.id || createEntryId()
    };
    let storedIndex = -1;
    this.appendTimeEntryRecoveryOperation(file.path, "add", { entry: storedEntry });
    await this.processTaskFrontMatter(file, (frontmatter) => {
      const existing = Array.isArray(frontmatter.timeEntries) ? [...frontmatter.timeEntries] : [];
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
    this.scheduleSaveConfirmation();
    await this.refreshAllViews();
    return { entry: storedEntry, entryIndex: storedIndex };
  }

  async removeTimeEntry(file, entry, entryIndex, options = {}) {
    let removedEntry = null;
    this.appendTimeEntryRecoveryOperation(file.path, "remove", { entry, entryIndex });
    await this.processTaskFrontMatter(file, (frontmatter) => {
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
    this.scheduleSaveConfirmation();
    await this.refreshAllViews();
    return removedEntry;
  }

  async updateTimeEntry(file, entryIndex, updatedEntry) {
    this.appendTimeEntryRecoveryOperation(file.path, "update", { entry: updatedEntry, entryIndex });
    await this.processTaskFrontMatter(file, (frontmatter) => {
      const existing = Array.isArray(frontmatter.timeEntries) ? [...frontmatter.timeEntries] : [];
      if (entryIndex >= 0 && entryIndex < existing.length) {
        existing[entryIndex] = updatedEntry;
      }
      existing.sort((a, b) => String(a.startTime).localeCompare(String(b.startTime)));
      frontmatter.timeEntries = existing;
    });
    this.scheduleSaveConfirmation();
    await this.refreshAllViews();
  }

  async updateTicketColor(file, color) {
    await this.processTaskFrontMatter(file, (frontmatter) => {
      if (color) {
        frontmatter[this.settings.colorProperty] = color;
      } else {
        delete frontmatter[this.settings.colorProperty];
      }
    });
    this.scheduleSaveConfirmation();
    await this.refreshAllViews();
  }

  async updateTicketSubtitle(file, subtitle) {
    await this.processTaskFrontMatter(file, (frontmatter) => {
      if (subtitle) {
        frontmatter[this.settings.subtitleProperty] = subtitle;
      } else {
        delete frontmatter[this.settings.subtitleProperty];
      }
    });
    this.scheduleSaveConfirmation();
    await this.refreshAllViews();
  }
};
