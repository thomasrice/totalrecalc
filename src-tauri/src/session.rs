//! One open file: its versions, the watcher that produces them, and the
//! payloads the window asks for.
//!
//! A version is immutable once published: it is recorded only after it has
//! been recalculated. The one exception is the very first load, which is shown
//! from the file's saved values while it calculates, because there is nothing
//! else to show.

use crate::book::{Book, Calc, CalcSummary, Cell, SheetMeta, Style, Value};
use crate::diff::{self, Diff, SheetDiff};
use crate::load;
use serde::Serialize;
use std::collections::{HashSet, VecDeque};
use std::hash::{DefaultHasher, Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{RecvTimeoutError, channel};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

const KEEP_VERSIONS: usize = 30;
const KEEP_DIFFS: usize = 12;
const SETTLE: Duration = Duration::from_millis(500);
const POLL: Duration = Duration::from_millis(1000);
const REPORT_FAILURE_AFTER: Duration = Duration::from_secs(5);

/// Version ids are unique for the life of the process, across files, so a
/// late event from a file that was closed can never be mistaken for a new one.
static NEXT_VERSION: AtomicU64 = AtomicU64::new(1);

pub struct Version {
    pub id: u64,
    /// Milliseconds since the epoch when the version was read.
    pub at: u64,
    pub book: Arc<Book>,
}

#[derive(Clone, Debug, Serialize, Default, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct WatchState {
    /// `watching`, `writing`, `error` or `calculating`.
    pub state: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
    /// When the problem started (ms since epoch).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub since: Option<u64>,
}

impl WatchState {
    fn new(state: &str) -> Self {
        WatchState { state: state.into(), ..Default::default() }
    }
}

#[derive(Default)]
pub struct Session {
    pub path: PathBuf,
    pub versions: VecDeque<Version>,
    pub watch: WatchState,
    /// Versions the window still needs (shown, baseline, undo): never evicted.
    pins: HashSet<u64>,
    diffs: VecDeque<((u64, u64), Arc<Diff>)>,
}

pub type Shared = Arc<Mutex<Session>>;

/// Something the session tells the window.
pub enum Notice {
    Version { id: u64, calculated: bool },
    Watch(WatchState),
}

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

impl Session {
    pub fn new(path: PathBuf) -> Self {
        Session { path, ..Default::default() }
    }

    fn push(&mut self, book: Book) -> u64 {
        let id = NEXT_VERSION.fetch_add(1, Ordering::Relaxed);
        self.versions.push_back(Version { id, at: now_ms(), book: Arc::new(book) });
        while self.versions.len() > KEEP_VERSIONS {
            let Some(i) = self.versions.iter().position(|v| !self.pins.contains(&v.id) && v.id != id) else { break };
            self.versions.remove(i);
        }
        let live: HashSet<u64> = self.versions.iter().map(|v| v.id).collect();
        self.diffs.retain(|((a, b), _)| live.contains(a) && live.contains(b));
        id
    }

    /// Replace the provisional first version with its calculated form.
    fn finish_first(&mut self, id: u64, book: Book) {
        if let Some(v) = self.versions.iter_mut().find(|v| v.id == id) {
            v.book = Arc::new(book);
        }
        self.diffs.clear();
    }

    pub fn set_pins(&mut self, ids: &[u64]) {
        self.pins = ids.iter().copied().collect();
    }

    pub fn version(&self, id: u64) -> Option<&Version> {
        self.versions.iter().find(|v| v.id == id)
    }
}

/// The diff between two versions, cached. Computed outside the session lock.
pub fn diff_between(shared: &Shared, from: u64, to: u64) -> Option<Arc<Diff>> {
    if from == to {
        return None;
    }
    let (a, b) = {
        let s = shared.lock().unwrap();
        if let Some((_, d)) = s.diffs.iter().find(|(k, _)| *k == (from, to)) {
            return Some(d.clone());
        }
        (s.version(from)?.book.clone(), s.version(to)?.book.clone())
    };
    let d = Arc::new(diff::diff(&a, &b));
    let mut s = shared.lock().unwrap();
    s.diffs.push_back(((from, to), d.clone()));
    while s.diffs.len() > KEEP_DIFFS {
        s.diffs.pop_front();
    }
    Some(d)
}

// ------------------------------------------------------------------ payloads

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VersionInfo {
    pub id: u64,
    pub at: u64,
    pub calculated: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetSummary {
    pub name: String,
    pub hidden: bool,
    pub edits: usize,
    pub results: usize,
    pub structure: usize,
    pub new_sheet: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BookInfo {
    pub path: String,
    pub file_name: String,
    pub folder: String,
    pub version: u64,
    pub versions: Vec<VersionInfo>,
    pub sheets: Vec<SheetSummary>,
    pub styles: Vec<Style>,
    pub calc: CalcSummary,
    pub watch: WatchState,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compare: Option<u64>,
    /// The requested comparison version is no longer held.
    pub compare_missing: bool,
    pub edits: usize,
    pub results: usize,
    pub rows_added: usize,
    pub rows_removed: usize,
    pub removed_sheets: Vec<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SheetPayload {
    pub meta: SheetMeta,
    /// Compact cells: `[row, col, text, value, style, flags, formula, formatColor, comment]`.
    /// `flags`: bit 0 error; bits 1-2 calculation (0 ok, 1 cached, 2 unavailable).
    pub cells: Vec<WireCell>,
    pub diff: SheetDiff,
}

pub fn book_info(shared: &Shared, version: u64, compare: Option<u64>) -> Option<BookInfo> {
    let compare = compare.filter(|c| *c != version);
    let d = compare.and_then(|c| diff_between(shared, c, version));
    let s = shared.lock().unwrap();
    let book = s.version(version)?.book.clone();
    let path = s.path.clone();
    let sd = |name: &str| d.as_ref().and_then(|d| d.sheets.get(name));
    Some(BookInfo {
        file_name: path.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(),
        folder: path.parent().map(short_folder).unwrap_or_default(),
        path: path.to_string_lossy().into_owned(),
        version,
        versions: s.versions.iter().map(|v| VersionInfo { id: v.id, at: v.at, calculated: v.book.calculated }).collect(),
        sheets: book
            .sheets
            .iter()
            .map(|sh| {
                let x = sd(&sh.meta.name);
                SheetSummary {
                    name: sh.meta.name.clone(),
                    hidden: sh.meta.hidden,
                    edits: x.map(|x| x.edits).unwrap_or(0),
                    results: x.map(|x| x.results).unwrap_or(0),
                    structure: x
                        .map(|x| x.added_rows.len() + x.removed_rows.len() + x.added_cols.len() + x.removed_cols.len())
                        .unwrap_or(0),
                    new_sheet: x.is_some_and(|x| x.new_sheet),
                }
            })
            .collect(),
        styles: book.styles.clone(),
        calc: book.calc_summary(),
        watch: s.watch.clone(),
        compare,
        compare_missing: compare.is_some() && d.is_none(),
        edits: d.as_ref().map(|d| d.edits).unwrap_or(0),
        results: d.as_ref().map(|d| d.results).unwrap_or(0),
        rows_added: d.as_ref().map(|d| d.rows_added).unwrap_or(0),
        rows_removed: d.as_ref().map(|d| d.rows_removed).unwrap_or(0),
        removed_sheets: d.as_ref().map(|d| d.removed_sheets.clone()).unwrap_or_default(),
    })
}

pub fn sheet_payload(shared: &Shared, version: u64, sheet: usize, compare: Option<u64>) -> Option<SheetPayload> {
    let book = shared.lock().unwrap().version(version)?.book.clone();
    let s = book.sheets.get(sheet)?;
    let diff = compare
        .filter(|c| *c != version)
        .and_then(|c| diff_between(shared, c, version))
        .and_then(|d| d.sheets.get(&s.meta.name).cloned())
        .unwrap_or_default();
    Some(SheetPayload { meta: s.meta.clone(), cells: s.cells.iter().map(|((r, c), cell)| wire(*r, *c, cell)).collect(), diff })
}

/// Only the changes between two versions of one sheet (for the update ripple).
pub fn sheet_changes(shared: &Shared, version: u64, sheet: usize, compare: u64) -> Option<SheetDiff> {
    let name = shared.lock().unwrap().version(version)?.book.sheets.get(sheet)?.meta.name.clone();
    diff_between(shared, compare, version)?.sheets.get(&name).cloned()
}

pub type WireCell = (i32, i32, String, Value, u32, u8, Option<String>, Option<String>, Option<String>);

fn wire(r: i32, c: i32, cell: &Cell) -> WireCell {
    let calc = match cell.calc {
        Calc::Ok => 0,
        Calc::Cached => 1,
        Calc::Unavailable => 2,
    };
    (
        r,
        c,
        cell.text.clone(),
        cell.value.clone(),
        cell.style,
        u8::from(cell.error) | (calc << 1),
        cell.formula.clone(),
        cell.format_color.clone(),
        cell.comment.clone(),
    )
}

fn short_folder(p: &Path) -> String {
    let parts: Vec<String> = p.components().rev().take(2).map(|c| c.as_os_str().to_string_lossy().into_owned()).collect();
    parts.into_iter().rev().collect::<Vec<_>>().join("/")
}

// ------------------------------------------------------------------- watcher

#[derive(PartialEq, Clone, Copy)]
struct Stamp {
    len: u64,
    modified: Option<SystemTime>,
}

fn stamp(path: &Path) -> Option<Stamp> {
    let m = std::fs::metadata(path).ok()?;
    Some(Stamp { len: m.len(), modified: m.modified().ok() })
}

fn hash(bytes: &[u8]) -> u64 {
    let mut h = DefaultHasher::new();
    bytes.hash(&mut h);
    h.finish()
}

/// Parse, calculate and publish the workbook in `bytes`. On the first load the
/// saved values are shown while it calculates; afterwards the previous
/// version stays on screen until the new one is complete.
fn ingest(shared: &Shared, bytes: &[u8], notify: &dyn Fn(Notice)) -> Result<(), String> {
    zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|_| "The file is not a complete workbook yet".to_string())?;
    let mut loaded = load::parse(bytes).map_err(|e| format!("Not a readable workbook: {e}"))?;
    let cached = load::snapshot(&loaded, None);
    let first = shared.lock().unwrap().versions.is_empty();
    let provisional = first.then(|| shared.lock().unwrap().push(cached.clone()));
    set_watch(shared, notify, WatchState::new("calculating"));
    if let Some(id) = provisional {
        notify(Notice::Version { id, calculated: false });
    }
    loaded.model.evaluate();
    let calculated = load::snapshot(&loaded, Some(&cached));
    let id = {
        let mut s = shared.lock().unwrap();
        match provisional {
            Some(id) => {
                s.finish_first(id, calculated);
                id
            }
            None => s.push(calculated),
        }
    };
    notify(Notice::Version { id, calculated: true });
    Ok(())
}

/// Watch `path` until `stop` is set, recording each new version.
pub fn watch(shared: Shared, path: PathBuf, stop: Arc<AtomicBool>, notify: impl Fn(Notice) + Send + 'static) {
    std::thread::spawn(move || {
        let (tx, rx) = channel();
        let file_name = path.file_name().map(|n| n.to_os_string());
        let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
            // Only events that could change our file: not reads, and only for its name.
            if let Ok(e) = res
                && !matches!(e.kind, notify::EventKind::Access(_))
                && e.paths.iter().any(|p| p.file_name().map(|n| n.to_os_string()) == file_name)
            {
                let _ = tx.send(());
            }
        })
        .ok();
        if let (Some(w), Some(dir)) = (watcher.as_mut(), path.parent()) {
            use notify::Watcher;
            let _ = w.watch(if dir.as_os_str().is_empty() { Path::new(".") } else { dir }, notify::RecursiveMode::NonRecursive);
        }

        let mut last_hash = None;
        let mut last_stamp = None;
        let mut failing_since: Option<Instant> = None;
        let mut failing_wall: Option<u64> = None;
        let mut pending = true; // load once at start

        while !stop.load(Ordering::Relaxed) {
            if !pending {
                let event = match rx.recv_timeout(POLL) {
                    Ok(()) => true,
                    Err(RecvTimeoutError::Timeout) => false,
                    Err(RecvTimeoutError::Disconnected) => {
                        std::thread::sleep(POLL);
                        false
                    }
                };
                while rx.try_recv().is_ok() {}
                pending = event || stamp(&path) != last_stamp || failing_since.is_some();
                if !pending {
                    continue;
                }
            }
            // Wait for the file to settle: same size and time across the settle window.
            let mut st = stamp(&path);
            loop {
                std::thread::sleep(SETTLE);
                if stop.load(Ordering::Relaxed) {
                    return;
                }
                let again = stamp(&path);
                if again == st {
                    break;
                }
                st = again;
                if failing_since.is_none() {
                    set_watch(&shared, &notify, WatchState::new("writing"));
                }
            }
            last_stamp = st;
            pending = false;
            // std opens files with read, write and delete sharing on Windows, so a
            // writer can always replace the file while we read it.
            let result = match st.map(|_| std::fs::read(&path)) {
                None => Err("The file is missing (it may be being replaced)".to_string()),
                Some(Err(e)) => Err(format!("Cannot read the file: {e}")),
                Some(Ok(bytes)) => {
                    let h = hash(&bytes);
                    if Some(h) == last_hash { Ok(h) } else { ingest(&shared, &bytes, &notify).map(|_| h) }
                }
            };
            if stop.load(Ordering::Relaxed) {
                return;
            }
            match result {
                Ok(h) => {
                    last_hash = Some(h);
                    failing_since = None;
                    failing_wall = None;
                    set_watch(&shared, &notify, WatchState::new("watching"));
                }
                Err(message) => {
                    let started = *failing_since.get_or_insert_with(Instant::now);
                    let wall = *failing_wall.get_or_insert_with(now_ms);
                    let has_version = !shared.lock().unwrap().versions.is_empty();
                    if started.elapsed() >= REPORT_FAILURE_AFTER || !has_version {
                        set_watch(&shared, &notify, WatchState { state: "error".into(), message: Some(message), since: Some(wall) });
                    } else {
                        set_watch(&shared, &notify, WatchState::new("writing"));
                    }
                }
            }
        }
    });
}

fn set_watch(shared: &Shared, notify: &dyn Fn(Notice), w: WatchState) {
    {
        let mut s = shared.lock().unwrap();
        if s.watch == w {
            return;
        }
        s.watch = w.clone();
    }
    notify(Notice::Watch(w));
}

/// Load a file once, synchronously, fully calculated (for `totalrecalc-dump`).
pub fn load_once(shared: &Shared, path: &Path) -> Result<u64, String> {
    shared.lock().unwrap().path = path.to_path_buf();
    let bytes = std::fs::read(path).map_err(|e| format!("Cannot read the file: {e}"))?;
    ingest(shared, &bytes, &|_| {})?;
    Ok(shared.lock().unwrap().versions.back().map(|v| v.id).unwrap_or(0))
}
