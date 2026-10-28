"""Play an AI agent revising the Northwind model, so you can watch Total Recalc
follow along. Open the model in Total Recalc first, then run:

    uv run --with openpyxl demo/agent.py demo/northwind.xlsx

Each step rewrites the workbook the way an agent's script does (a fresh
openpyxl save, written to a temporary file and renamed over the original).
"""

from __future__ import annotations

import sys
import time
from dataclasses import replace

from northwind import Knobs, build, save_atomically

STEPS: list[tuple[str, Knobs]] = []
k = Knobs()
STEPS.append(("Raising 2026 unit growth from 22% to 26% after the Q3 order book.", k := replace(k, unit_growth=[0.26, 0.18])))
STEPS.append(("Lifting the 2027 gross margin to 48.5% as the new actuator line ramps.", k := replace(k, gross_margin=[0.46, 0.485])))
STEPS.append(("Adding a Services revenue line: attach rates of 6% in 2026 and 7% in 2027.", k := replace(k, services=True)))
STEPS.append(("Cutting the cost of capital from 9.5% to 9.0%.", k := replace(k, wacc=0.09)))


def main() -> None:
    path = sys.argv[1] if len(sys.argv) > 1 else "demo/northwind.xlsx"
    pause = float(sys.argv[2]) if len(sys.argv) > 2 else 6.0
    save_atomically(build(Knobs()), path)
    print(f"Reset {path}. Watching for changes? Open it in Total Recalc now.")
    time.sleep(pause)
    for n, (say, knobs) in enumerate(STEPS, start=1):
        print(f"[{n}/{len(STEPS)}] {say}")
        save_atomically(build(knobs), path)
        time.sleep(pause)
    print("Done.")


if __name__ == "__main__":
    main()
