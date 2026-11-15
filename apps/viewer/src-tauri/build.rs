fn main() {
    // App-defined commands are denied to the webview unless a permission
    // allows them: this generates `allow-<command>` / `deny-<command>` for each.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "list_servers",
            "add_server",
            "remove_server",
            "sign_in",
            "cancel_sign_in",
            "sign_out",
            "connect",
            "disconnect",
            "fetch_graph",
            "fetch_run",
            "fetch_infra",
            "fetch_documents",
            "kube_contexts",
            "set_kube_context",
            "kube_connect",
            "kube_disconnect",
            "kube_pod_events",
            "open_url",
        ]),
    ))
    .expect("failed to run tauri-build");
}
