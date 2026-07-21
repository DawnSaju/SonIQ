fn main() {
    #[cfg(target_os = "macos")]
    {
        cc::Build::new()
            .file("src/tray_mac.m")
            .flag("-fobjc-arc")
            .compile("tray_mac");
        println!("cargo:rustc-link-lib=framework=AppKit");
        println!("cargo:rustc-link-lib=framework=Foundation");
    }
    tauri_build::build()
}
