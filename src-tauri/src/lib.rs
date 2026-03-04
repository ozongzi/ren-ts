mod commands;
mod rpa;
mod rpy2rrs;
mod rpy2rrs_command;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            #[cfg(debug_assertions)]
            {
                use tauri::Manager;

                let window = app.get_webview_window("main").unwrap();
                window.set_focus().unwrap(); // 👈 加这一行
                window.open_devtools();
            }
            Ok(())
        })
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .invoke_handler(tauri::generate_handler![
            commands::build_zip,
            rpa::list_rpa,
            rpa::read_rpa_entry,
            rpy2rrs_command::converter,
            rpy2rrs_command::converter_dir,
            rpy2rrs_command::extract_tl,
            rpy2rrs_command::export,
            rpy2rrs_command::export_dir,
            rpy2rrs_command::read_tl_files,
            rpy2rrs_command::list_tl_langs,
        ])
        .run(tauri::generate_context!())
        .expect("error while running Ren'Ts")
}
