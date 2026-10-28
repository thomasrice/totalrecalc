# Changelog

## 0.1.0 (unreleased)

First release.

- Live, read-only viewing of `.xlsx` and `.xlsm` workbooks, refreshed whenever the file changes, without ever locking it.
- Edits separated from recalculated results; rows matched by label so inserted rows are seen as such.
- Changes panel with baselines, version timeline and sparklines; Pause; Inspector with inputs and dependents; copy with context.
- Quarters folded under years, with marked derived annual columns; forecast boundary.
- Recalculation by IronCalc, with Excel's saved values used (and marked) where the engine cannot evaluate a formula faithfully.
- Light (workbook-faithful) and dark themes.
