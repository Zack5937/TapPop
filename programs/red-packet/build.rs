use std::{env, fs, path::PathBuf};
fn main() {
    println!("cargo:rustc-check-cfg=cfg(target_os, values(\"solana\"))");
    println!("cargo:rerun-if-env-changed=RED_PACKET_PROGRAM_ID");
    // Public build-only identifier, NOT a deployed program or a signing key.
    let id = env::var("RED_PACKET_PROGRAM_ID")
        .unwrap_or_else(|_| "EH8Um52SbBNGdchqXURwAXrjxYTygRGsw37un2UmmeMx".into());
    assert!(
        (32..=44).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric()),
        "Invalid program ID"
    );
    fs::write(
        PathBuf::from(env::var("OUT_DIR").unwrap()).join("program_id.rs"),
        format!("anchor_lang::declare_id!(\"{id}\");"),
    )
    .unwrap();
}
