use std::path::PathBuf;

/// The API contract lives in the server repository. Override with DENTAL_PROTO_DIR
/// if it is not checked out next to this one (../dental-server).
const DEFAULT_PROTO_DIR: &str = "../../dental-server/proto";

const PROTO_FILES: &[&str] = &[
    "dental/v1/auth.proto",
    "dental/v1/crypto.proto",
    "dental/v1/health.proto",
    "dental/v1/installation.proto",
    "dental/v1/member.proto",
];

fn main() {
    compile_protos();
    tauri_build::build()
}

fn compile_protos() {
    println!("cargo:rerun-if-env-changed=DENTAL_PROTO_DIR");
    let proto_dir = PathBuf::from(std::env::var("DENTAL_PROTO_DIR").unwrap_or_else(|_| DEFAULT_PROTO_DIR.into()));
    println!("cargo:rerun-if-changed={}", proto_dir.display());

    // protox is a pure-Rust protobuf compiler, so no protoc install is needed.
    let descriptors = protox::compile(PROTO_FILES, [&proto_dir]).unwrap_or_else(|e| {
        panic!("compiling protos from {} failed (set DENTAL_PROTO_DIR?): {e:?}", proto_dir.display())
    });
    prost_build::Config::new()
        .compile_fds(descriptors)
        .expect("generating Rust code from protos failed");
}
