# Changelog

## 0.1.0 (2026-10-29)

First release.

- Live, read-only viewing of `.xlsx` and `.xlsm` workbooks, refreshed whenever the file changes, without ever locking it.
- Edits separated from recalculated results; rows matched by label so inserted rows are seen as such.
- Changes panel with baselines, version timeline and sparklines; Pause; Cell details with inputs and dependents; copy with context.
- Cells a selected formula refers to are outlined in colour, matching the formula's references.
- Forecast boundary drawn where actual periods give way to estimates.
- Recalculation by IronCalc, with Excel's saved values used (and marked) where the engine cannot evaluate a formula faithfully.
- Light (workbook-faithful) and dark themes.
- Builds for Linux (AppImage, `.deb`) and Windows (installer, portable `.exe`), plus an unsigned, not yet tested macOS `.dmg` for Apple Silicon and Intel.
