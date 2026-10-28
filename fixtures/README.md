# Fixtures

The frontend can run in a plain browser, without the Rust side, reading JSON
exported by `totalrecalc-dump`. This is how the UI is iterated on and how the
README screenshots are made.

```sh
pnpm dev                                    # then open http://localhost:1420/?fixture=demo
cargo run --manifest-path src-tauri/Cargo.toml --bin totalrecalc-dump -- old.xlsx new.xlsx > fixtures/mine.json
```

With two files, the older version is shown first and the newer one arrives
after `?delay=` milliseconds (default 1600), like a live edit. `demo.json` is
the Northwind demo at its baseline compared with the version after the
demo agent's third step (unit growth raised, the 2027 margin lifted and a
Services revenue line added).
Set `TOTALRECALC_FIXTURES` to serve fixtures from another folder.
