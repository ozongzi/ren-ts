// ─── Ren'Ts – Tauri application entry point ───────────────────────────
//
// Prevents an extra console window from appearing on Windows in release builds.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    ren_ts_lib::run();
}
