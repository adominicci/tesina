fn main() {
    #[cfg(target_os = "macos")]
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rerun-if-changed=src/local_ai/socket_macos.c");
        cc::Build::new()
            .file("src/local_ai/socket_macos.c")
            .warnings(true)
            .compile("tesina_socket_owner");
    }
    tauri_build::build()
}
