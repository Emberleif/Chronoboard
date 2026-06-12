const {
  ItemView,
  Menu,
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
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

const DEFAULT_SETTINGS = {
  folder: "Chronoboard Tasks",
  timeEntryNotesFolder: "Chronoboard Time Entry Notes",
  selectedTaskPaths: [],
  staticTaskPaths: [],
  boardOnlyTaskPaths: [],
  hideWeekends: true,
  visibleStartHour: 8,
  visibleEndHour: 19,
  activeProperty: "active",
  jiraTag: "chronoboard",
  taskTag: "task",
  filterProperty: "Status",
  excludedValues: ["finished"],
  colorProperty: "timeboardColor",
  subtitleProperty: "timeboardSubtitle",
  highlightColor: "",
  forceDarkTextOnColored: false
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
        text: "No eligible notes are available in the configured folder."
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
        text: `${task.status || "unknown"}${task.active ? " • active" : ""}`
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
    titleEl.setText("Change ticket color");
    contentEl.empty();

    let currentColor = this.initialColor;

    new Setting(contentEl)
      .setName("Color")
      .setDesc("Set the color used for this ticket in the timeboard.")
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
      .setName("Box notes")
      .setDesc("This text appears below the time inside the time box.")
      .addText((text) => {
        text.setPlaceholder("What you did in this block").setValue(currentValue);
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
    titleEl.setText("Edit ticket subtitle");
    contentEl.empty();

    let currentValue = this.initialText;

    new Setting(contentEl)
      .setName("Subtitle")
      .setDesc("Shown below the ticket key on cards and above the time inside blocks.")
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

class ChronoboardSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl)
      .setName("Folder")
      .setDesc("Folder containing the notes used by the add-task picker.")
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

    new Setting(containerEl)
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

    new Setting(containerEl)
      .setName("Excluded values")
      .setDesc("Comma-separated values that exclude a note from the add-task menu when found in the metadata property.")
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

    new Setting(containerEl)
      .setName("Always include notes")
      .setDesc("Note paths that should always appear on the task list and totals rail. One path per line or comma-separated.")
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

    new Setting(containerEl)
      .setName("Hide weekends in week view")
      .setDesc("Show only Monday through Friday in the week timeline.")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.hideWeekends)
          .onChange(async (value) => {
            this.plugin.settings.hideWeekends = value;
            await this.plugin.saveSettings();
            await this.plugin.refreshAllViews();
          })
      );

    new Setting(containerEl)
      .setName("Visible start hour")
      .setDesc("First hour marker shown in week and day views.")
      .addSlider((slider) =>
        slider
          .setLimits(0, 20, 1)
          .setDynamicTooltip()
          .setValue(this.plugin.settings.visibleStartHour)
          .onChange(async (value) => {
            this.plugin.settings.visibleStartHour = value;
            if (this.plugin.settings.visibleEndHour <= value) {
              this.plugin.settings.visibleEndHour = value + 1;
            }
            await this.plugin.saveSettings();
            await this.plugin.refreshAllViews();
          })
      );

    new Setting(containerEl)
      .setName("Visible end hour")
      .setDesc("Last hour marker shown in week and day views.")
      .addSlider((slider) =>
        slider
          .setLimits(1, 24, 1)
          .setDynamicTooltip()
          .setValue(this.plugin.settings.visibleEndHour)
          .onChange(async (value) => {
            this.plugin.settings.visibleEndHour = Math.max(value, this.plugin.settings.visibleStartHour + 1);
            await this.plugin.saveSettings();
            await this.plugin.refreshAllViews();
          })
      );

    new Setting(containerEl)
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

    new Setting(containerEl)
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

  async render() {
    this.contentEl.empty();
    this.contentEl.addClass("chronoboard-view");
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

  getDayTimelineWidth(container) {
    const width = container.clientWidth || container.getBoundingClientRect().width || 0;
    return Math.max(width, this.getVisibleHourCount() * 84);
  }

  renderToolbar(selectedTasks) {
    const toolbar = this.contentEl.createDiv({ cls: "chronoboard-toolbar" });
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
    panel.createDiv({ cls: "chronoboard-panel-head", text: "Task" });

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
      card.addEventListener("contextmenu", (event) => this.openTicketContextMenu(event, task));
    });

    const add = list.createDiv({ cls: "chronoboard-add-slot" });
    add.createDiv({ cls: "chronoboard-plus", text: "+" });
    add.createSpan({ text: "Add task slot" });
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
        text: "Use the plus button to add notes from the configured folder."
      });
    }
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
    wrapper.style.setProperty("--chronoboard-grid-bottom", `${this.getTimelineHeight()}px`);

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
    grid.style.height = `${this.getTimelineHeight()}px`;
    grid.style.gridTemplateColumns = `repeat(${weekDays.length}, minmax(0, 1fr))`;

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
    hoursHead.style.setProperty("--chronoboard-hour-count", String(this.getVisibleHourCount()));
    const timelineWidth = Math.max((panel.getBoundingClientRect().width || 0) - 221, this.getVisibleHourCount() * 84);
    const dayHourWidth = timelineWidth / this.getVisibleHourCount();
    hoursHead.style.width = `${timelineWidth}px`;
    hoursHead.style.setProperty("--chronoboard-day-hour-width", `${dayHourWidth}px`);
    this.renderHourMarkers(hoursHead, true, null, dayHourWidth);

    const taskColumn = wrapper.createDiv({ cls: "chronoboard-day-task-column" });
    const gridColumn = wrapper.createDiv({ cls: "chronoboard-day-grid-column" });

    if (!selectedTasks.length) {
      gridColumn.createDiv({
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
      taskCard.addEventListener("contextmenu", (event) => this.openTicketContextMenu(event, task));

      const row = gridColumn.createDiv({ cls: "chronoboard-day-row" });
      row.style.width = `${timelineWidth}px`;
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
      if (event.button !== 0 || event.detail !== 4) {
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
          .setTitle("Open ticket note")
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
          .setTitle("Edit ticket subtitle")
          .setIcon("text")
          .onClick(() => this.openSubtitleModal(task))
      );
      menu.addItem((item) =>
        item
          .setTitle("Edit box notes")
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
          .setTitle(entry.notePath ? "Open time subnote" : "Create time subnote")
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

  renderSummary(layout, selectedTasks) {
    const scopedTasks = this.getScopedTasks(selectedTasks);
    const panel = layout.createDiv({ cls: "chronoboard-panel" });
    const panelHead = panel.createDiv({ cls: "chronoboard-panel-head" });
    panelHead.createDiv({
      text: this.currentMode === "day" ? "Daily Total" : this.currentMode === "month" ? "Monthly Total" : "Weekly Total"
    });
    panelHead.createDiv({
      cls: "chronoboard-summary-head-total",
      text: formatHours(scopedTasks.reduce((sum, task) => sum + this.getSummaryMinutesForTask(task), 0))
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
        .setTitle("Open ticket note")
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
        .setTitle("Edit ticket subtitle")
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
    this.decorateActiveMenu();
  }

  closeActiveContextMenu() {
    if (this.activeContextMenu && typeof this.activeContextMenu.hide === "function") {
      this.activeContextMenu.hide();
    }
    this.activeContextMenu = null;
    document.querySelectorAll(".menu").forEach((element) => element.remove());
  }

  decorateActiveMenu() {
    window.setTimeout(() => {
      const menus = [...document.querySelectorAll(".menu")];
      const menu = menus[menus.length - 1];
      if (!menu) {
        return;
      }
      const items = [...menu.querySelectorAll(".menu-item")];
      const removeItem = items.find((item) => item.textContent && item.textContent.includes("Remove Task"));
      if (removeItem) {
        removeItem.classList.add("chronoboard-menu-remove-item");
      }
      const separators = [...menu.querySelectorAll(".menu-separator")];
      const lastSeparator = separators[separators.length - 1];
      if (lastSeparator && removeItem) {
        lastSeparator.classList.add("chronoboard-menu-remove-separator");
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

    const body = [
      "---",
      `Date: ${moment().format("YYYY-MM-DD HH:mm")}`,
      `Updated: ${moment().format("YYYY-MM-DD HH:mm")}`,
      "aliases:",
      `  - ${entryId}`,
      "tags:",
      "  - chronoboard",
      `Links: "[[${task.file.basename}]]"`,
      `ChronoboardEntryId: ${entryId}`,
      `ChronoboardParent: "[[${task.file.basename}]]"`,
      `ChronoboardStart: ${entry.startTime}`,
      `ChronoboardEnd: ${entry.endTime}`,
      "---",
      ""
    ].join("\n");

    const noteFile = await this.app.vault.create(filePath, body);
    await this.plugin.updateTimeEntry(task.file, entryIndex, {
      ...entry,
      id: entryId,
      notePath: noteFile.path
    });
    await this.app.workspace.getLeaf("tab").openFile(noteFile);
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
      id: "make-current-note-tasknotes-compatible",
      name: "Add TaskNotes fields to current note",
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
    const activeValue = frontmatter[this.settings.activeProperty];
    return {
      file,
      path: file.path,
      jiraKey,
      displayTitle: title || file.basename,
      status,
      rawStatus: rawFilter,
      filterValues,
      timeEntries,
      active: activeValue === true || activeValue === "true",
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
        if (frontmatter[this.settings.activeProperty] === undefined) {
          frontmatter[this.settings.activeProperty] = true;
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
      new Notice("Failed to update note frontmatter");
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
      if (frontmatter[this.settings.activeProperty] === undefined) {
        frontmatter[this.settings.activeProperty] = true;
      }
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
