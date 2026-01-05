#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use tauri_plugin_shell::ShellExt;

fn main() {
  tauri::Builder::default()
    .plugin(tauri_plugin_opener::init())
    .plugin(tauri_plugin_shell::init())
    .setup(|app| {
      // Spawn Go engine sidecar on app startup (synchronous).
      let _child = app
        .shell()
        .sidecar("bin/engine")
        .expect("failed to create sidecar command")
        .spawn()
        .expect("failed to spawn engine sidecar");

      println!("[engine] sidecar started");

      Ok(())
    })

    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}


