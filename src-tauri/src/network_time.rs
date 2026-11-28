//! The exact time from the internet, to show a correct clock and to warn when the
//! system clock is wrong (src/lib/network-clock.ts). Display only: nothing here
//! feeds the clock tampering checks in clock.rs or any stored timestamp.
//!
//! Public NTP servers are asked first (SNTP, RFC 4330): NTP is the global time
//! standard, and unlike HTTPS it still works when the system clock is so far off
//! that TLS certificates look expired or not yet valid. If no NTP server answers
//! (UDP blocked), Cloudflare's HTTPS trace endpoint is the fallback.
//!
//! The result is an offset (network time minus system time), so the frontend can
//! keep a ticking clock without asking again every second.

use std::io;
use std::net::{SocketAddr, ToSocketAddrs, UdpSocket};
use std::time::Duration;

use serde::Serialize;

use crate::clock;

/// Asked in this order; the first valid answer wins.
const NTP_SERVERS: &[&str] = &["time.cloudflare.com", "time.google.com", "time.windows.com", "pool.ntp.org"];
const NTP_PORT: u16 = 123;
const NTP_TIMEOUT: Duration = Duration::from_secs(2);
/// Seconds from the NTP epoch (1900) to the Unix epoch (1970).
const NTP_UNIX_OFFSET: i64 = 2_208_988_800;

/// Plain text with a `ts=<unix seconds with fraction>` line.
const HTTPS_SOURCE: &str = "https://www.cloudflare.com/cdn-cgi/trace";
const HTTPS_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NetworkTime {
    /// Network time minus system time, in milliseconds (positive: the system clock is behind).
    pub offset_ms: i64,
    /// Where the time came from, e.g. "time.cloudflare.com".
    pub source: String,
    /// When it was measured, by the system clock (unix milliseconds).
    pub checked_at: i64,
}

/// Asks the internet for the exact time. None if no source answered (no internet).
pub async fn fetch() -> Option<NetworkTime> {
    let from_ntp = tauri::async_runtime::spawn_blocking(|| {
        NTP_SERVERS.iter().find_map(|server| match ntp_offset(server) {
            Ok(offset_ms) => Some((offset_ms, server.to_string())),
            Err(e) => {
                eprintln!("Network time: {server} did not answer: {e}");
                None
            }
        })
    })
    .await
    .ok()
    .flatten();

    let (offset_ms, source) = match from_ntp {
        Some(found) => found,
        None => match https_offset().await {
            Ok(offset_ms) => (offset_ms, "cloudflare.com".to_string()),
            Err(e) => {
                eprintln!("Network time: {HTTPS_SOURCE} did not answer: {e}");
                return None;
            }
        },
    };
    Some(NetworkTime { offset_ms, source, checked_at: clock::now_millis() })
}

/// One SNTP request to `server`; returns the system clock's offset in milliseconds.
fn ntp_offset(server: &str) -> io::Result<i64> {
    let address: SocketAddr = (server, NTP_PORT)
        .to_socket_addrs()?
        .next()
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "no address"))?;
    let local: SocketAddr = if address.is_ipv4() { "0.0.0.0:0" } else { "[::]:0" }.parse().unwrap();
    let socket = UdpSocket::bind(local)?;
    socket.set_read_timeout(Some(NTP_TIMEOUT))?;
    socket.connect(address)?;

    // Version 4, client mode. Our send time goes in the transmit field; the server
    // copies it into the origin field, which tells its answer from a stray packet.
    let mut request = [0u8; 48];
    request[0] = 0b00_100_011;
    let sent = clock::now_millis();
    request[40..48].copy_from_slice(&to_ntp(sent));
    socket.send(&request)?;

    let mut reply = [0u8; 48];
    let length = socket.recv(&mut reply)?;
    let received = clock::now_millis();
    parse_ntp_reply(&reply[..length], &request[40..48], sent, received)
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "invalid NTP reply"))
}

/// The offset from an NTP reply, or None if the reply is not a valid answer to our request.
fn parse_ntp_reply(reply: &[u8], our_transmit: &[u8], sent: i64, received: i64) -> Option<i64> {
    if reply.len() < 48 {
        return None;
    }
    let mode = reply[0] & 0b111;
    let leap = reply[0] >> 6;
    let stratum = reply[1];
    // Mode 4 is a server answer; stratum 0 is a "kiss-o'-death" refusal; leap 3 is an unsynchronized server.
    if mode != 4 || stratum == 0 || stratum > 15 || leap == 3 || &reply[24..32] != our_transmit {
        return None;
    }
    let server_received = from_ntp(&reply[32..40])?;
    let server_sent = from_ntp(&reply[40..48])?;
    // The standard NTP offset: averages out the network delay on both ways.
    Some(((server_received - sent) + (server_sent - received)) / 2)
}

/// Unix milliseconds as an NTP timestamp (seconds since 1900, then a 32-bit fraction).
fn to_ntp(unix_ms: i64) -> [u8; 8] {
    let seconds = (unix_ms.div_euclid(1000) + NTP_UNIX_OFFSET) as u32;
    let fraction = ((unix_ms.rem_euclid(1000) << 32) / 1000) as u32;
    let mut bytes = [0u8; 8];
    bytes[..4].copy_from_slice(&seconds.to_be_bytes());
    bytes[4..].copy_from_slice(&fraction.to_be_bytes());
    bytes
}

/// An NTP timestamp as unix milliseconds; None for the "unknown" zero timestamp.
fn from_ntp(bytes: &[u8]) -> Option<i64> {
    let seconds = u32::from_be_bytes(bytes[..4].try_into().ok()?) as i64;
    let fraction = u32::from_be_bytes(bytes[4..8].try_into().ok()?) as i64;
    if seconds == 0 && fraction == 0 {
        return None;
    }
    // Seconds wrap around in 2036 (NTP era 1): small values belong to the next era.
    let seconds = if seconds < 1 << 31 { seconds + (1 << 32) } else { seconds };
    Some((seconds - NTP_UNIX_OFFSET) * 1000 + ((fraction * 1000 + (1 << 31)) >> 32))
}

/// The offset from Cloudflare's trace endpoint, measured like NTP from the middle of the round trip.
async fn https_offset() -> Result<i64, String> {
    let http = reqwest::Client::builder().timeout(HTTPS_TIMEOUT).build().map_err(|e| e.to_string())?;
    let sent = clock::now_millis();
    let body = http
        .get(HTTPS_SOURCE)
        .send()
        .await
        .and_then(|response| response.error_for_status())
        .map_err(|e| e.to_string())?
        .text()
        .await
        .map_err(|e| e.to_string())?;
    let received = clock::now_millis();
    let server = parse_trace_time(&body).ok_or("no time in the answer")?;
    Ok(server - (sent + received) / 2)
}

/// The `ts=` line of a Cloudflare trace, as unix milliseconds.
fn parse_trace_time(body: &str) -> Option<i64> {
    let seconds: f64 = body.lines().find_map(|line| line.strip_prefix("ts="))?.trim().parse().ok()?;
    Some((seconds * 1000.0).round() as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ntp_timestamps_round_trip() {
        for unix_ms in [0, 1_700_000_000_123, 2_085_978_496_000 + 5_000] {
            assert_eq!(from_ntp(&to_ntp(unix_ms)), Some(unix_ms));
        }
        assert_eq!(from_ntp(&[0; 8]), None);
    }

    fn reply(transmit: &[u8], server_received: i64, server_sent: i64) -> [u8; 48] {
        let mut reply = [0u8; 48];
        reply[0] = 0b00_100_100;
        reply[1] = 2;
        reply[24..32].copy_from_slice(transmit);
        reply[32..40].copy_from_slice(&to_ntp(server_received));
        reply[40..48].copy_from_slice(&to_ntp(server_sent));
        reply
    }

    #[test]
    fn offset_ignores_network_delay() {
        // The system clock is 10 s behind; 100 ms each way on the network.
        let sent = 1_700_000_000_000;
        let transmit = to_ntp(sent);
        let answer = reply(&transmit, sent + 10_100, sent + 10_110);
        assert_eq!(parse_ntp_reply(&answer, &transmit, sent, sent + 210), Some(10_000));
    }

    #[test]
    fn foreign_or_refused_replies_are_rejected() {
        let sent = 1_700_000_000_000;
        let transmit = to_ntp(sent);
        let mut answer = reply(&to_ntp(sent + 1), sent, sent);
        assert_eq!(parse_ntp_reply(&answer, &transmit, sent, sent), None, "not an answer to our request");
        answer = reply(&transmit, sent, sent);
        answer[1] = 0;
        assert_eq!(parse_ntp_reply(&answer, &transmit, sent, sent), None, "kiss-o'-death");
        assert_eq!(parse_ntp_reply(&answer[..40], &transmit, sent, sent), None, "too short");
    }

    /// Needs internet: `cargo test network_time -- --ignored`.
    #[test]
    #[ignore]
    fn live_sources_answer() {
        let ntp = ntp_offset(NTP_SERVERS[0]).expect("NTP answer");
        let https = tauri::async_runtime::block_on(https_offset()).expect("HTTPS answer");
        println!("NTP offset {ntp} ms, HTTPS offset {https} ms");
        assert!((ntp - https).abs() < 2_000, "the two sources agree");
    }

    #[test]
    fn trace_time() {
        let body = "fl=123\nh=www.cloudflare.com\nts=1732800000.456\nvisit_scheme=https\n";
        assert_eq!(parse_trace_time(body), Some(1_732_800_000_456));
        assert_eq!(parse_trace_time("h=x\n"), None);
    }
}
