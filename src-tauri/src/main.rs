// Prevents an extra console window on Windows in release.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // On NVIDIA under Wayland, WebKitGTK's GPU (DMA-BUF) renderer fails with
    // "Error 71 (Protocol error) dispatching to Wayland display" because of
    // the driver's explicit sync. Turning that off keeps the GPU path, which
    // matters: the software fallback copies the whole window every frame,
    // and on a scaled 4K screen that makes moving the selection crawl. The
    // variable is only read by NVIDIA's driver; an explicit setting wins.
    #[cfg(target_os = "linux")]
    if std::env::var_os("__NV_DISABLE_EXPLICIT_SYNC").is_none() {
        // SAFETY: set before any other thread starts.
        unsafe { std::env::set_var("__NV_DISABLE_EXPLICIT_SYNC", "1") };
    }
    totalrecalc_lib::run()
}
