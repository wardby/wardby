pub mod api;
pub mod appearance;
pub mod cluster;
pub mod commands;
pub mod error;
pub mod events;
pub mod loopback;
pub mod oauth;
pub mod servers;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_store::Builder::default().build())
        .manage(commands::AppState::default())
        .setup(|app| {
            eprintln!(
                "wardby-viewer: OAuth callback URL is http://127.0.0.1:{}{}",
                loopback::CALLBACK_PORT,
                loopback::CALLBACK_PATH
            );
            let handle = app.handle();
            let current = appearance::load(handle);
            app.set_menu(appearance::build_menu(handle, current)?)?;
            appearance::apply(handle, current);
            Ok(())
        })
        .on_menu_event(|app, event| {
            if let Some(choice) = appearance::Appearance::from_menu_id(event.id().as_ref()) {
                appearance::apply(app, choice);
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::list_servers,
            commands::add_server,
            commands::remove_server,
            commands::sign_in,
            commands::cancel_sign_in,
            commands::sign_out,
            commands::connect,
            commands::disconnect,
            commands::fetch_graph,
            commands::fetch_run,
            commands::fetch_infra,
            commands::kube_contexts,
            commands::set_kube_context,
            commands::kube_connect,
            commands::kube_disconnect,
            commands::kube_pod_events,
            commands::open_url,
        ])
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
