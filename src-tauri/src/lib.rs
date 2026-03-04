// ─── Ren'Ts – Tauri v2 application library ────────────────────────────────────
//
// Plugins registered:
//   • tauri-plugin-dialog  – directory / file pickers
//   • tauri-plugin-fs      – text file read / write for save-game persistence
//
// Tauri commands exposed to the JS frontend:
//   • build_zip        – stream-write a ZIP archive entirely in Rust;
//                        never sends file bytes across the IPC boundary.
//   • list_rpa         – parse an RPA-2/3 archive and return the list of
//                        file paths stored inside it.
//   • read_rpa_entry   – read the raw bytes of one entry from an RPA archive;
//                        returned as Vec<u8> (base64-encoded by Tauri's IPC).

mod commands;
mod rpa;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            commands::build_zip,
            rpa::list_rpa,
            rpa::read_rpa_entry,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Ren'Ts");
}
