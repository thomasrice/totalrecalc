<p align="center">
  <img src="docs/social-preview.png" alt="Total Recalc: open your mind, not your file" width="100%" />
</p>

<p align="center"><b>Open your mind. Not your file.</b><br/>
A fast, read-only viewer for Excel workbooks that refreshes itself the moment the file changes, keeps your place, and shows exactly what the agent edited and what recalculated as a result.</p>

<p align="center">
  <a href="https://www.totalrecalc.com/"><b>totalrecalc.com</b></a> ·
  <a href="https://github.com/thomasrice/totalrecalc/releases/latest">Download</a> ·
  <a href="CHANGELOG.md">Changelog</a>
</p>

<p align="center">
  <img src="docs/demo.gif" alt="Claude Code rolls in a quarter's actuals, cuts a growth rate and lifts a margin in a demo model; beside it Total Recalc shows each change as it lands, down to the value per share" width="100%" />
</p>

---

## Why

More and more spreadsheet work happens by asking an agent to change a model: "raise next year's unit growth", "add a services line", "rebuild the balance sheet". The agent rewrites the `.xlsx`; you want to look at it, talk about it, and watch it change.

Excel and LibreOffice are the wrong tools for that loop. They lock the file, so the agent cannot save. They do not reload when the file changes underneath them. And when they do reopen, nothing tells you which of ten thousand cells just moved.

Total Recalc is built for that loop:

- **It never touches the file.** It reads the workbook into memory and lets go, so an agent can overwrite, replace or delete it at any time.
- **It follows along.** When a new version lands it refreshes within about a second, on the same sheet, scrolled to the same place, with the same cell selected, even if rows were inserted above it.
- **It shows exactly what changed.** Cells the agent *edited* are separated from cells that merely *recalculated*, so "3 edits · 240 results" is the headline rather than a carpet of highlights.
- **It hands numbers back.** *Copy with context* puts the sheet, row label, period, value, formula and previous value on your clipboard as Markdown, ready to paste to the agent.

## Features

| | |
|---|---|
| **Live reload** | Watches the folder (agents usually write a temporary file and rename it over the original) and polls as a fallback. A half-written file is never shown. |
| **The wake** | Each update ripples across the changed cells in reading order, then settles into a tint. Edited cells carry an amber bar; formula-only edits a violet one; recalculated results a faint tint. Tick marks on the scrollbars show where changes sit off-screen. |
| **Edits versus results** | Rows are matched between versions by their labels and aligned like lines in a text diff, and old formulas are rewritten through that alignment before comparison. An inserted row is one new row, not a shift of everything below it. |
| **Changes panel** | Every change since your baseline, grouped by row, with the period span, the range of moves and a before/after sparkline. Switch between *since baseline* and *latest update*; set a new baseline at any time (with Undo). |
| **Pause** | Hold the version on screen while you talk about it. Total Recalc keeps watching and tells you how many newer versions are waiting. |
| **Cell details** | The selected cell's value, previous value, formula (with clickable references), its inputs and everything that uses it. Follow a chain with Enter, come back with Backspace. |
| **Formula references** | Select a formula and the cells it refers to are outlined in colour, each matching its reference in the formula, as in Excel. |
| **Faithful rendering** | Number formats, fonts, fills, borders, merged cells, frozen panes, hidden rows and columns, comments and Excel-style text overflow. Light mode looks like Excel; dark mode remaps workbook colours so dark header fills and blue inputs stay legible. |
| **Numbers you can trace** | Every version is recalculated by a built-in engine ([IronCalc](https://github.com/ironcalc/IronCalc)). Where the engine cannot evaluate a formula faithfully (it errors, or the formula uses `INDIRECT`, `OFFSET`, `CELL`, `INFO` or another workbook) and the file carries Excel's saved result, that result is shown and marked, and so are the formulas that depend on it. |
| **Command palette** | `Ctrl+K` for every action, sheet and row label. `Ctrl+G` goes to a cell or label, `Ctrl+F` searches the sheet. |

<p align="center">
  <img src="docs/screenshots/hero.png" alt="The Changes panel after an agent edit: edited rows, an added row and recalculated results with before/after sparklines" width="100%" />
</p>

<p align="center">
  <img src="docs/screenshots/dark.png" alt="Dark theme with cell details open" width="100%" />
</p>

## Try it

Download the latest build from the [releases page](https://github.com/thomasrice/totalrecalc/releases/latest): an installer or a portable `.exe` for Windows, or an `.AppImage` or `.deb` for Linux (macOS is untested). Then open a workbook:

```sh
totalrecalc path/to/model.xlsx
```

Or drag a file onto the window. To see it follow an agent, open the bundled demo model and run the demo agent, which revises it every few seconds:

```sh
totalrecalc demo/northwind.xlsx &
uv run --with openpyxl demo/agent.py demo/northwind.xlsx
```

On Linux, Total Recalc draws through the GPU. If the window stays blank or exits with "Error 71 (Protocol error)", start it with `WEBKIT_DISABLE_DMABUF_RENDERER=1 totalrecalc model.xlsx`; it works everywhere but is slower on large, high-resolution screens.

## Keyboard

| Keys | Action |
|---|---|
| Arrows · `Ctrl`+arrows · `PgUp`/`PgDn` · `Home`/`End` · `Tab` | Move · jump to the edge of data · page · row start/end · next cell |
| `Shift` + movement | Extend the selection |
| `Ctrl+PgUp` / `Ctrl+PgDn` | Previous / next sheet |
| `N` / `Shift+N` | Next / previous edit, across sheets |
| `Space` | Pause or resume live updates |
| `F5` | Set the baseline to the version on screen |
| `D` · `I` (or `F2`) | Changes panel · Cell details |
| `Enter` / `Backspace` (or `Alt+←`) | Follow the first input / go back |
| `Ctrl+C` · `Ctrl+Shift+C` | Copy · copy with context |
| `Ctrl+K` · `Ctrl+G` · `Ctrl+F` | Command palette · go to a cell or label · find on this sheet |
| `Ctrl+O` | Open a workbook |
| `Ctrl` + scroll · `Ctrl` `+`/`-` · `Ctrl+0` | Zoom · reset zoom |
| `T` | Light or dark |
| `?` · `Esc` | Keyboard help · close a panel or overlay |

Vim keys (`h` `j` `k` `l`, `g`, `G`) work too.

## How it works

Total Recalc is a [Tauri 2](https://tauri.app) app. The Rust side does the work: it reads the workbook with IronCalc (plus a little direct XML for indents, cells without values and the odd package quirk), recalculates it on a background thread, keeps the last 30 versions in memory, diffs them, and answers the window's requests one sheet at a time. The window is TypeScript with no framework: a virtualised grid that only puts visible cells in the DOM, split into frozen and scrolling panes driven by native scrollbars.

A version is accepted only once the file's size and timestamp have been stable for half a second and it parses as a complete workbook. If reading fails, the last good version stays on screen and the top bar says what is wrong.

The app makes no network requests. Its webview loads only the bundled interface under a restrictive content security policy, and workbook text is always escaped before it is shown.

## Building from source

You need Rust (stable), Node 22, pnpm 10 and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your platform. On Debian or Ubuntu:

```sh
sudo apt install build-essential curl wget file libwebkit2gtk-4.1-dev \
  libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev patchelf
```

On Arch: `webkit2gtk-4.1`, `librsvg` and `patchelf`.

```sh
pnpm install
pnpm tauri dev            # run with hot reload
pnpm tauri build          # release build and installers
scripts/install-local     # Linux: put the build on your PATH, with a launcher entry
```

The UI also runs in a plain browser against JSON fixtures, which is handy for working on the interface: `pnpm dev` and open `http://localhost:1420/?fixture=demo`. The fixtures are made by `totalrecalc-dump`, a small developer command (a Cargo example, not shipped with the app) that loads one or more versions of a workbook and prints exactly what the window would receive; see [fixtures/README.md](fixtures/README.md).

The demo model is generated by `demo/northwind.py`; rebuild it with `uv run --with openpyxl demo/northwind.py demo/northwind.xlsx`.

## Limitations

- Viewing only, by design: no editing, saving or exporting.
- `.xlsx` and `.xlsm` only. Charts and images are not drawn.
- Calculation uses IronCalc, which covers most of Excel but not all of it. Excel's saved results are used only for formulas the engine cannot evaluate faithfully (and their dependents, through references of up to 4,096 cells); elsewhere the engine's value is shown. A workbook written by a script without saved results relies on the engine alone, and an engine error with no saved value is marked unavailable.
- Change detection compares values and formulas, not formatting.

## Status

Early, and used daily on Linux. Windows builds come from CI. See [CHANGELOG.md](CHANGELOG.md).

## Licence

[MIT](LICENSE) © [Thomas Rice](https://www.thomasrice.com/). Free, with no account and no paid tier. Issues and pull requests are welcome.
