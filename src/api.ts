// The bridge to the Rust side. In a plain browser (no Tauri), it serves
// fixtures exported by `totalrecalc-dump`, so the UI can be developed and
// photographed without the desktop shell: open `/?fixture=demo`.

import type { BookInfo, Inspection, SheetDiff, SheetPayload, SheetSummary, WatchState } from "./types";

export interface Opened {
  /** Events from earlier files carry an older session number and are ignored. */
  session: number;
  /** The canonical path: the key for remembered per-file state. */
  path: string;
}

export interface Api {
  openFile(path: string): Promise<Opened>;
  bookInfo(version: number, compare?: number): Promise<BookInfo>;
  sheet(version: number, index: number, compare?: number): Promise<SheetPayload>;
  /** Only the changes on one sheet between two versions. */
  sheetChanges(version: number, index: number, compare: number): Promise<SheetDiff | null>;
  /** Versions the window still needs; they are never evicted. */
  pinVersions(ids: number[]): Promise<void>;
  inspect(version: number, index: number, r: number, c: number): Promise<Inspection>;
  initialPath(): Promise<string | null>;
  pickFile(): Promise<string | null>;
  onVersion(cb: (id: number, calculated: boolean) => void): void;
  onWatch(cb: (w: WatchState) => void): void;
  onDrop(cb: (path: string) => void, onHover: (over: boolean) => void): void;
  readonly desktop: boolean;
}

const isTauri = "__TAURI_INTERNALS__" in window;

async function tauriApi(): Promise<Api> {
  const { invoke } = await import("@tauri-apps/api/core");
  const { listen } = await import("@tauri-apps/api/event");
  const { getCurrentWebview } = await import("@tauri-apps/api/webview");
  const dialog = await import("@tauri-apps/plugin-dialog");
  let session = 0;
  return {
    desktop: true,
    async openFile(path) {
      const opened = await invoke<Opened>("open_file", { path });
      session = opened.session;
      return opened;
    },
    bookInfo: (version, compare) => invoke("book_info", { version, compare: compare ?? null }),
    sheet: (version, index, compare) => invoke("sheet", { version, index, compare: compare ?? null }),
    sheetChanges: (version, index, compare) => invoke("sheet_changes", { version, index, compare }),
    pinVersions: (ids) => invoke("pin_versions", { ids }),
    inspect: (version, index, r, c) => invoke("inspect", { version, index, r, c }),
    initialPath: () => invoke("initial_path"),
    async pickFile() {
      const picked = await dialog.open({
        multiple: false,
        filters: [{ name: "Workbooks", extensions: ["xlsx", "xlsm"] }],
      });
      return typeof picked === "string" ? picked : null;
    },
    onVersion(cb) {
      listen<{ session: number; id: number; calculated: boolean }>("version", (e) => {
        if (e.payload.session === session) cb(e.payload.id, e.payload.calculated);
      });
    },
    onWatch(cb) {
      listen<{ session: number; watch: WatchState }>("watch", (e) => {
        if (e.payload.session === session) cb(e.payload.watch);
      });
    },
    onDrop(cb, onHover) {
      getCurrentWebview().onDragDropEvent((e) => {
        const p = e.payload;
        if (p.type === "enter" || p.type === "over") onHover(true);
        else if (p.type === "leave") onHover(false);
        else if (p.type === "drop") {
          onHover(false);
          const path = p.paths.find((x) => /\.xls[xm]$/i.test(x));
          if (path) cb(path);
        }
      });
    },
  };
}

interface Fixture {
  info: BookInfo;
  sheets: SheetPayload[];
}

/**
 * Browser mode. A fixture holds one version, or a version compared with an
 * earlier one; the earlier one is shown first and the newer one arrives
 * shortly after, like a live update.
 */
function fixtureApi(name: string): Api {
  let fixture: Promise<Fixture> | null = null;
  const load = () => (fixture ??= fetch(`/fixtures/${name}.json`).then((r) => r.json() as Promise<Fixture>));
  const versionCbs: ((id: number, calculated: boolean) => void)[] = [];
  const watchCbs: ((w: WatchState) => void)[] = [];
  const noDiff = { changes: [], addedRows: [], removedRows: [], addedCols: [], removedCols: [], newSheet: false, edits: 0, results: 0 };
  const isDiff = (f: Fixture, version: number, compare?: number) => compare !== undefined && compare === f.info.compare && version === f.info.version;
  return {
    desktop: false,
    async openFile() {
      const f = await load();
      const opened = { session: 1, path: f.info.path };
      const ids = f.info.versions.map((v) => v.id);
      const emit = (id: number) => versionCbs.forEach((cb) => cb(id, true));
      setTimeout(() => {
        emit(ids[0]);
        watchCbs.forEach((cb) => cb({ state: "watching" }));
        const delay = Number(new URLSearchParams(location.search).get("delay") ?? 1600);
        if (ids.length > 1) setTimeout(() => emit(ids[ids.length - 1]), delay);
      }, 0);
      return opened;
    },
    async bookInfo(version, compare) {
      const f = await load();
      const info: BookInfo = { ...f.info, version, watch: { state: "watching" } };
      if (version !== f.info.version) info.versions = f.info.versions.filter((v) => v.id <= version);
      if (isDiff(f, version, compare)) return info;
      return {
        ...info,
        compare: undefined,
        edits: 0,
        results: 0,
        rowsAdded: 0,
        rowsRemoved: 0,
        removedSheets: [],
        sheets: info.sheets.map((s: SheetSummary) => ({ ...s, edits: 0, results: 0, structure: 0, newSheet: false })),
      };
    },
    async sheet(version, index, compare) {
      const f = await load();
      const s = f.sheets[index];
      return isDiff(f, version, compare) ? s : { ...s, diff: noDiff };
    },
    async sheetChanges(version, index, compare) {
      const f = await load();
      return isDiff(f, version, compare) ? f.sheets[index].diff : null;
    },
    async pinVersions() {},
    async inspect() {
      return { inputs: [], usedBy: [] };
    },
    initialPath: async () => (name === "none" ? null : name),
    pickFile: async () => null,
    onVersion(cb) {
      versionCbs.push(cb);
    },
    onWatch(cb) {
      watchCbs.push(cb);
    },
    onDrop() {},
  };
}

export async function createApi(): Promise<Api> {
  if (isTauri) return tauriApi();
  const name = new URLSearchParams(location.search).get("fixture") ?? "demo";
  return fixtureApi(name);
}
