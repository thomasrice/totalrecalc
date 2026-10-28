# Total Recalc design

_How Total Recalc should look and behave. Revised after two independent design reviews._

## What the app is for

A person has a spreadsheet open while an LLM rewrites it. They read, point at numbers, talk about them with the agent, and watch the file change under them. The app must do four things better than Excel or LibreOffice:

1. never lock or touch the file;
2. refresh itself when a new version lands without losing your place, and let you hold still while you talk;
3. make it obvious what the agent *edited* and what merely *recalculated* as a consequence;
4. make it effortless to hand a number, with its context, back to the agent.

Everything else (looking like a well-made financial model, fast navigation, formula inspection) serves those four. It is a viewer: no editing, saving or cell input anywhere.

## Design principles

1. **The numbers are the interface.** Chrome is thin and quiet; the grid gets the space, the contrast and the best typography.
2. **Edits first, consequences second.** "3 inputs edited · 240 results changed" is the headline, not an amber carpet of 243 cells.
3. **Never lose your place, never move under you unasked.** Reloads keep sheet, scroll, selection and collapsed groups; Pause holds the view still.
4. **Calm by default, detail one keystroke away**, and every keystroke has a visible button or menu equivalent.
5. **Honest numbers.** If a value could not be recalculated, the app says so, and so do the cells that depend on it.

## Window layout

```
┌─────────────────────────────────────────────────────────────────────────────────────┐
│ model.xlsx  · acme/model     ● Live  ⟳ 14:32:07   3 edits · 240 results   ‹ 1/3 ›  ⏸ ⌕ │ top bar
├─────────────────────────────────────────────────────────────────────────────────────┤
│ Revenue · 3Q27E   71,402.3   was 69,880.1   +1,522.2 (+2.2%)   = U18+U19+U20+U21+U22  │ peek strip
├──────────┬──────────────────────────────────────────────────────────┬───────────────┤
│ Summary  │            2025 ▾                          2026 ▾          │ Changes│Inspect│
│ Assump.●3│ Line item  1Q25A 2Q25A 3Q25A 4Q25A │ 1Q26A 2Q26A 3Q26E …   │               │
│ Income  ●│ Revenue    42,314 47,516 51,242 59,893 │ …                  │ Since baseline│
│ Balance  │   …                                                        │ ▸ Edited (3)  │
│ Cash Fl. │                                                            │ ▸ Results(240)│
│ Valuat. ●│                                                            │               │
│ Checks ✓ │                                                            │               │
├──────────┴──────────────────────────────────────────────────────────┴───────────────┤
│ Income Statement!U5   Sum 412,880 · Avg 68,813 · Count 6     All values calculated    │ status bar
└─────────────────────────────────────────────────────────────────────────────────────┘
```

- **Top bar (one line, 36px).** File name and short folder; the live state (`● Live`, `⏸ Paused · 2 newer versions`, `⚠ Can't read the file · showing v3`, with the reason in its tooltip); the time of the version on screen; the change headline against the current comparison; previous/next edit; Pause; Set baseline; panel toggles; search; theme.
- **Peek strip (one line, always on).** For the selected cell: row label · column header, value, previous value, delta and formula. The most-wanted facts never need a panel.
- **Sheet rail (left; collapses to initials at narrow widths).** Vertical list; a change dot with a count of *edits* per sheet; the current sheet has an accent bar.
- **Right panel (closed by default, tabs: Changes | Inspector).** One panel, not two, so the grid keeps its width.
- **Status bar.** Address, selection sum/average/count, and calculation confidence (`All values calculated`, or `12 values from file cache · 3 unavailable`, clickable).

## The grid

- **Fidelity to the workbook**: number formats (separators, decimals, percentages, bracketed negatives, format colours), alignment, bold, italic, indentation, borders, column widths, row heights, wrapping, merged cells, hidden rows and columns, and cell comments (a small corner mark; hover shows the comment).
- **Frozen panes** come from the workbook. If it has none, the app infers a header row and label column from the layout and says so in the status bar ("Freeze: inferred").
- **Colours.** In the default light theme, fills and text colours appear exactly as the file defines them. In the optional dark theme, a fill and its text colour are mapped together:
  - A strong fill with light text (the navy header rows) stays solid, darkened slightly in dark mode.
  - A light fill with dark text becomes a low-opacity tint of its hue.
  - Input-yellow fills become a muted olive so they never resemble the change colour.
  - Text colours keep their meaning: blue `#7FB2FF`, black → primary text `#E6E8EB`, green `#6FCF97`. The app never infers a cell's type from its colour.
  - Red is reserved for errors and removals; negative numbers follow the file's format (brackets) in normal text.
- **Typography.** Inter (embedded) for chrome, labels and numbers, with `font-variant-numeric: tabular-nums` so columns of digits align; the webview renders text with each platform's native rasteriser. Numbers at 13px on 24px rows, labels 13px, headers 12px semibold.
- **Structure made visible.** The actual/forecast boundary (from the `A`/`E` suffix in headers, or a change in input styling) is a fine vertical accent line, with its column letter marked.
- **Interaction.** Click, Shift-click and drag to select ranges (with auto-scroll); visible scrollbars; mouse-wheel and Shift-wheel scrolling; `Ctrl+G` go to address or label; `Esc` clears selection or closes the panel.


## Changes

### What is compared

Every accepted version is kept in memory (the last 30). The **comparison** is one of:

- **Since baseline** (default). The baseline is the version open when the app started, until you click **Set baseline** (or `F5`), which shows a toast with Undo.
- **Latest update**: the version just before the one on screen.

A switch in the Changes tab and the top-bar headline chooses between them. Counts, highlights, navigation, tooltips, the peek strip and the inspector always use the same comparison. A small timeline in the Changes tab lists the versions (`14:20 · 14:27 · 14:32`, each with its edit count); clicking one sets it as the baseline.

### Edits versus results

Each changed cell is classified:

- **Edited**: its constant value or its formula text changed (the agent touched it).
- **Result**: its formula is unchanged but its value moved (a consequence).
- **Structure**: rows, columns or sheets added or removed.

The headline leads with edits: `3 edits · 240 results · 1 row added`. The app does not claim which edit caused which result; it only separates touched cells from recalculated ones.

### How changes look

- **Edited cells**: a 2px amber bar on the cell's left edge plus an amber tint. Formula-only edits (same value, new formula) use a violet bar and no tint.
- **Results**: a faint amber tint only, no bar. Large contiguous runs read as a band, not confetti.
- **On each accepted update**: the wake, a soft 550ms pulse on each cell changed *by that update*, staggered in reading order across about 600ms (violet for formula-only edits). Reduced motion turns it into a single short fade.
- **Selection and source formatting** draw above change tints.
- **Rounding-only changes** (value moved but displays the same) get the bar or tint plus a `≈` in the peek strip, so they are findable but not alarming. Changes below 1e-9 relative are ignored as numerical noise.
- **Blank ↔ value** counts as a change and is shown as `blank → value`.
- **Deltas**: absolute first; percentage only when the old value is non-zero; percentage-point change for percentage-formatted cells.

### Matching cells across versions

A cell's identity is its sheet, its row key and its column key:

- the **row key** is the row label plus its section ancestry (the nearest bold or less-indented label above it) plus an occurrence number for repeats;
- the **column key** is the column header (period label), falling back to the column letter.

Rows are aligned between versions as a sequence (the same way a text diff aligns lines), using these keys, so inserted and deleted rows are detected rather than shifting every cell below. When a row cannot be matched confidently, the app shows it as removed and added rather than inventing continuity. Selection and scroll keep both the cell's identity and its position on screen.

### Changes tab

Grouped by sheet, then by row: one line per changed row, not per cell, e.g. `Revenue · 3Q26E–FY2040E · 18 cells · +2.1% to +4.8%`, with a small before/after sparkline when the row is a period series. Edited rows come first, then results. Removed rows and sheets appear with their old contents. Clicking a line jumps to its first cell (opening a collapsed year if needed); `n`/`N` step through edits in reading order, across sheets, falling back to results when a version has no edits.

## Pause

`Pause` (`Space`) freezes the version on screen while the app keeps watching. The top bar shows `⏸ Paused · 2 newer versions`. Resume jumps to the newest valid version and reports what changed meanwhile. This lets you discuss a number without it changing mid-sentence.

## Inspector

For the selected cell: title (row label · column header; sheet and address beneath); value large, raw value small, previous value and delta; formula in a monospaced face with each reference clickable (references are coloured by sheet: same sheet, other sheet); the previous formula struck through if it changed; **Inputs** and **Used by** as expandable lists of `label · period  value`, clickable; calculation status (`calculated`, `from file cache: function X unsupported`, `unavailable`). `Backspace`/`Alt+←` goes back along the jump history.

## Copying for the agent

- `Ctrl+C` copies the selection as tab-separated values.
- **Copy with context** (`Ctrl+Shift+C`, also in the right-click menu): for each selected cell, the workbook, sheet, address, row label, column header, displayed value, formula and, when changed, previous value and delta, as compact Markdown ready to paste to the agent.
- **Copy change report** in the Changes tab: the current changes list as Markdown.

## Reload behaviour

- **Read-only and lock-free.** The file is opened with full read, write and delete sharing, read into memory and closed. The app never writes to it or creates files beside it.
- **Detection.** Watch the folder (writers often rename a temp file over the target) and poll the modified time and size every second as a fallback for network and synced drives.
- **Accepting a version.** Wait until size and modified time have been stable for 500ms, confirm the zip's central directory, then parse and recalculate off the UI thread. A newer change during the work supersedes it. Only a fully loaded version is shown.
- **Failures.** The last good version stays on screen. After 5 seconds of failure the top bar says so, with the version still shown and the reason in its tooltip. The app keeps retrying every second; no action is needed.
- The app makes no claim that the agent has *finished*; it shows the latest valid file.

## Recalculation honesty

Every version is recalculated with the built-in engine. Each value is one of: **calculated**; **from file cache** (the engine does not support a function used, so the value saved in the file is shown, with a small grey dot, and cells that depend on it get a hollow dot); or **unavailable** (no cache; shown as `—`). The status bar summarises this; `0 errors` is never shown as if it meant "all verified".

## Starting the app

`totalrecalc path/to/model.xlsx`, a file association, or dragging a file onto the window or the `.exe`. With no file: a quiet window with an Open button and a drop zone. Window title: `model.xlsx — Total Recalc`.

## Keyboard

Every action also has a button or menu entry. `?` opens the full list; the status bar shows `? Shortcuts`.

The canonical list is the Keyboard table in the README.

Vim movement keys (`h j k l`, `g`/`G`) work as well.

## Visual language

- **Light (default)**: workbook-faithful, as in Excel. Fills and font colours appear exactly as the file defines them on a white grid; chrome is off-white `#FBFBFA` with `#E7E7E4` hairlines and `#1C1F24` text; accent blue `#2F6FEB` for selection and focus. Semantic colours darkened for contrast on white: amber `#C98A12` change (tint `#FFF1D6`), violet `#7C4DDB` formula edit, red `#D23B3B` errors and removals.
- **Dark (optional)**: background `#0F1115`, grid surface `#14171C`, hairlines `#232831`, primary text `#E6E8EB`, muted `#8A93A0`, accent `#5B9DFF`, amber `#F2B34B`, violet `#B48CFF`, red `#FF6B6B`. Workbook colours are mapped as pairs as described under The grid. No other saturated colour in the chrome.
- **Motion**: the update pulse only. Panels open instantly.
- **One density**: 24px rows at 100%; zoom covers the rest.

## Delight

Small touches that make the app feel made with care, none of which get in the way:

- **The wake.** When an update lands, its changed cells light up in reading order as a quick ripple (about 600ms in total, each cell a soft pulse), like a wake spreading across the grid. With many changes the ripple is capped and the rest pulse together. Reduced-motion settings turn it into a single fade.
- **Change ticks on the scrollbars.** Both scrollbars carry tiny amber marks where changes sit, so you can see that something moved far below or to the right.
- **The live dot** in the top bar breathes slowly while watching and turns into a crisp pause glyph when paused.
- **Command palette** (`Ctrl+K`): every action, sheet and row label in one searchable list.
- **Copy feedback**: a small toast shows exactly what went to the clipboard.
- **A first-run window** with the Total Recalc mark and a drop zone that glows when a file is dragged over it.
- **Remembered state** per file: last sheet, scroll position per sheet, and the open panel.

## Out of scope for version one

Editing of any kind; saving or exporting; charts and images (an outline marks where one sits); conditional formatting beyond cell styles; formats other than `.xlsx` and `.xlsm`; several files in one window; a pinned watchlist of key cells, named snapshots and agent-supplied change notes (all candidates for version two); accessibility beyond keyboard operation (screen-reader semantics for the painted grid are a known gap).
