// The bridge to the Rust side. In a plain browser (no Tauri), it serves
// fixtures exported by `totalrecalc-dump`, so the UI can be developed and
// photographed without the desktop shell: open `/?fixture=demo`.

import type { BookInfo, Inspection, SheetDiff, SheetPayload, WatchState } from "./types";

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

/** What `totalrecalc-dump` prints: every version, and the comparisons the window asks for. */
interface Fixture {
  versions: { id: number; info: BookInfo; sheets: Omit<SheetPayload, "diff">[] }[];
  /** Keyed `"<version>:<compared with>"`. */
  comparisons: Record<string, { info: BookInfo; diffs: (SheetDiff | null)[] }>;
}

/**
 * Browser mode: replays a fixture's versions as if they were arriving from
 * a watched file. By default each version follows the last after `?delay=`
 * milliseconds. With `?replay=manual`, a page embedding this one drives it
 * with `postMessage` (`totalrecalc:step`, `totalrecalc:play`,
 * `totalrecalc:pause`) and hears `totalrecalc:ready` and
 * `totalrecalc:version` back. Messages are accepted only from this origin.
 */
function fixtureApi(name: string): Api {
  let fixture: Promise<Fixture> | null = null;
  const load = () =>
    (fixture ??= fetch(`${import.meta.env.BASE_URL}fixtures/${name}.json`).then((r) => {
      if (!r.ok) throw new Error(`No fixture named ${name}`);
      return r.json() as Promise<Fixture>;
    }));
  const versionCbs: ((id: number, calculated: boolean) => void)[] = [];
  const watchCbs: ((w: WatchState) => void)[] = [];
  const params = new URLSearchParams(location.search);
  const manual = params.get("replay") === "manual";
  const delay = Number(params.get("delay") ?? 1600);
  const noDiff: SheetDiff = { changes: [], addedRows: [], removedRows: [], addedCols: [], removedCols: [], newSheet: false, edits: 0, results: 0 };
  const version = (f: Fixture, id: number) => f.versions.find((v) => v.id === id) ?? f.versions[0];
  const comparison = (f: Fixture, id: number, compare?: number) => (compare === undefined ? undefined : f.comparisons[`${id}:${compare}`]);
  const held = (f: Fixture, id: number) => f.versions.filter((v) => v.id <= id).map((v) => v.info.versions.find((x) => x.id === v.id)!);

  let shown = 0;
  let timer = 0;
  const tell = (msg: object) => window.parent !== window && window.parent.postMessage(msg, location.origin);
  const emit = async (n: number) => {
    const f = await load();
    if (n >= f.versions.length) return;
    shown = n;
    versionCbs.forEach((cb) => cb(f.versions[n].id, true));
    tell({ type: "totalrecalc:version", index: n, total: f.versions.length });
  };
  const play = () => {
    clearInterval(timer);
    timer = window.setInterval(async () => {
      const f = await load();
      if (shown + 1 >= f.versions.length) return clearInterval(timer);
      void emit(shown + 1);
    }, delay);
  };
  if (manual) {
    window.addEventListener("message", (e) => {
      if (e.origin !== location.origin || e.source !== window.parent) return;
      const type = (e.data as { type?: unknown })?.type;
      if (type === "totalrecalc:step") void emit(shown + 1);
      if (type === "totalrecalc:play") play();
      if (type === "totalrecalc:pause") clearInterval(timer);
    });
  }

  return {
    desktop: false,
    async openFile() {
      const f = await load();
      setTimeout(() => {
        void emit(0);
        watchCbs.forEach((cb) => cb({ state: "watching" }));
        tell({ type: "totalrecalc:ready", total: f.versions.length });
        if (!manual) play();
      }, 0);
      return { session: 1, path: f.versions[0].info.path };
    },
    async bookInfo(id, compare) {
      const f = await load();
      const c = comparison(f, id, compare);
      const info = c?.info ?? { ...version(f, id).info, compare: undefined, compareMissing: false };
      return { ...info, version: id, versions: held(f, id), watch: { state: "watching" } };
    },
    async sheet(id, index, compare) {
      const f = await load();
      return { ...version(f, id).sheets[index], diff: comparison(f, id, compare)?.diffs[index] ?? noDiff };
    },
    async sheetChanges(id, index, compare) {
      const f = await load();
      return comparison(f, id, compare)?.diffs[index] ?? null;
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
