//! Messages generated from the server's `.proto` files (see build.rs).
// Not every message is used by the app yet (e.g. MemberService).
#![allow(dead_code)]

include!(concat!(env!("OUT_DIR"), "/dental.v1.rs"));
