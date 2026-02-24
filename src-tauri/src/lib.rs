// ─── Ren'Py Reader – Tauri v2 application library ────────────────────────────
//
// All Tauri setup lives here so that both main.rs (binary entry point) and
// any integration test harnesses can reuse it.
//
// Plugins registered:
//   • tauri-plugin-dialog  – directory / file pickers  (open, save dialogs)
//   • tauri-plugin-fs      – text file read / write for save-game persistence

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .run(tauri::generate_context!())
        .expect("error while running Ren'Py Reader");
}
