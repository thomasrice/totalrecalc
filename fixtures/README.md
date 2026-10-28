# Fixtures

The frontend can run in a plain browser, without the Rust side, reading JSON
exported by `totalrecalc-dump`. This is how the UI is iterated on and how the
README screenshots are made.

```sh
pnpm dev                       # then open http://localhost:1420/?fixture=demo
scripts/make-demo-fixture      # rebuild fixtures/demo.json from the demo model
cargo run --manifest-path src-tauri/Cargo.toml --bin totalrecalc-dump -- v1.xlsx v2.xlsx v3.xlsx > fixtures/mine.json
```

A fixture holds every version of one workbook (each file given to
`totalrecalc-dump` is the next version) and the comparisons the window asks
for: each version against the first and against the previous one. The first
version is shown on load and each later one arrives after `?delay=`
milliseconds (default 1600), like a live edit. With `?replay=manual` the
versions advance only when an embedding page asks, via `postMessage`
(`totalrecalc:step`, `totalrecalc:play`, `totalrecalc:pause`); the page hears
`totalrecalc:ready` and `totalrecalc:version` back. `pnpm build:replay` builds
this mode into `dist-replay/` with the demo fixture, for embedding in a website.

`demo.json` is the Northwind demo at its baseline and after each of the demo
agent's three steps. Set `TOTALRECALC_FIXTURES` to serve fixtures from another
folder.
