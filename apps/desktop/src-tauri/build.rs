fn main() {
    #[cfg(target_os = "macos")]
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("macos") {
        println!("cargo:rerun-if-changed=src/local_ai/socket_macos.c");
        cc::Build::new()
            .file("src/local_ai/socket_macos.c")
            .warnings(true)
            .compile("tesina_socket_owner");
    }
    tauri_build::build();
    #[cfg(feature = "local-ai-proof")]
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows")
        && std::env::var("CARGO_CFG_TARGET_ENV").as_deref() == Ok("msvc")
    {
        // Tauri's resource linker targets bins, not these nonshipping examples.
        let resource =
            std::path::PathBuf::from(std::env::var_os("OUT_DIR").expect("Cargo OUT_DIR"))
                .join("resource.lib");
        assert!(
            resource.is_file(),
            "Tauri's generated Windows resource is required"
        );
        println!("cargo:rustc-link-arg-examples={}", resource.display());
    }
}
