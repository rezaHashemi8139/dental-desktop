//! Occasions and public holidays of a Solar Hijri month, for the home page's
//! calendar (src/lib/calendar-events.ts). They come from holidayapi.ir, a free
//! public API with Iran's official calendar (the same occasions as time.ir),
//! which answers one day per request. Display only: nothing is stored, and no
//! user data is sent (only the date).
//!
//! The text is Persian, as published by the source: it is data, not interface
//! text, so it does not go through the locale files.

use std::time::Duration;

use serde::{Deserialize, Serialize};

/// `{SOURCE}/{year}/{month}/{day}` answers with that Solar Hijri day.
const SOURCE: &str = "https://holidayapi.ir/jalali";
const TIMEOUT: Duration = Duration::from_secs(10);
/// Days asked at the same time: a whole month at once would be too much for a free service.
const PARALLEL: usize = 10;
/// Tries per day: one failed request should not lose the whole month.
const TRIES: usize = 2;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarDay {
    /// Day of the month, from 1.
    pub day: u8,
    /// A public holiday; Fridays count too.
    pub holiday: bool,
    pub events: Vec<CalendarEvent>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CalendarEvent {
    pub title: String,
    /// The day it is on in its own calendar, e.g. "13 Rajab" for a Lunar Hijri
    /// occasion or "December 25" for a Gregorian one.
    pub date: String,
    /// This occasion makes the day a public holiday.
    pub holiday: bool,
}

/// One day, as holidayapi.ir sends it.
#[derive(Deserialize)]
struct SourceDay {
    is_holiday: bool,
    #[serde(default)]
    events: Vec<SourceEvent>,
}

#[derive(Deserialize)]
struct SourceEvent {
    description: String,
    #[serde(default)]
    additional_description: String,
    #[serde(default)]
    is_holiday: bool,
}

/// The days of month `month` of Solar Hijri year `year`, which has `days` days.
/// None if any day could not be fetched (no internet), so a month is never shown half empty.
pub async fn fetch(year: u16, month: u8, days: u8) -> Option<Vec<CalendarDay>> {
    // The source hangs for a long time, then fails, on a day the month does not have.
    if !valid_month(month, days) {
        eprintln!("Calendar events: month {month} cannot have {days} days");
        return None;
    }
    // HTTP/1.1: over HTTP/2 the source stops answering after the first few requests.
    let http = reqwest::Client::builder().timeout(TIMEOUT).http1_only().build().ok()?;
    let all: Vec<u8> = (1..=days).collect();
    let mut result = Vec::with_capacity(all.len());
    for chunk in all.chunks(PARALLEL) {
        let requests: Vec<_> = chunk
            .iter()
            .map(|&day| {
                let http = http.clone();
                tauri::async_runtime::spawn(async move { fetch_day(&http, year, month, day).await })
            })
            .collect();
        for request in requests {
            match request.await {
                Ok(Ok(day)) => result.push(day),
                Ok(Err(e)) => {
                    eprintln!("Calendar events: {year}/{month}: {e}");
                    return None;
                }
                Err(e) => {
                    eprintln!("Calendar events: {year}/{month}: {e}");
                    return None;
                }
            }
        }
    }
    Some(result)
}

/// Months 1 to 6 have 31 days, 7 to 11 have 30, and the 12th has 29 (30 in a leap year).
fn valid_month(month: u8, days: u8) -> bool {
    match month {
        1..=6 => days == 31,
        7..=11 => days == 30,
        12 => days == 29 || days == 30,
        _ => false,
    }
}

async fn fetch_day(http: &reqwest::Client, year: u16, month: u8, day: u8) -> Result<CalendarDay, String> {
    let url = format!("{SOURCE}/{year}/{month}/{day}");
    let mut error = String::new();
    for _ in 0..TRIES {
        match get_text(http, &url).await {
            Ok(body) => return parse_day(day, &body),
            Err(e) => error = e,
        }
    }
    Err(format!("day {day}: {error}"))
}

async fn get_text(http: &reqwest::Client, url: &str) -> Result<String, String> {
    http.get(url)
        .send()
        .await
        .and_then(|response| response.error_for_status())
        .map_err(|e| format!("{e:?}"))?
        .text()
        .await
        .map_err(|e| e.to_string())
}

fn parse_day(day: u8, body: &str) -> Result<CalendarDay, String> {
    let source: SourceDay = serde_json::from_str(body).map_err(|e| format!("day {day}: invalid answer: {e}"))?;
    Ok(CalendarDay {
        day,
        holiday: source.is_holiday,
        events: source
            .events
            .into_iter()
            .filter(|event| is_occasion(&event.additional_description))
            .map(|event| CalendarEvent {
                title: event.description.trim().to_string(),
                date: event.additional_description.trim().to_string(),
                holiday: event.is_holiday,
            })
            .collect(),
    })
}

/// Whether an event with this date is one of the day's occasions. Left out, as
/// time.ir leaves them out of a month's occasions too: weekday entries such as
/// "Friday" (no date), and birthdays and deaths of famous people, whose date has
/// a year (e.g. "December 25 1642").
fn is_occasion(date: &str) -> bool {
    match date.split_whitespace().collect::<Vec<_>>().as_slice() {
        [] => false,
        [_, _, .., year] => !year.chars().all(char::is_numeric),
        _ => true,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_occasions_are_kept() {
        assert!(is_occasion("December 25"));
        // "13 Rajab" with Persian digits.
        assert!(is_occasion("\u{06F1}\u{06F3} Rajab"));
        assert!(!is_occasion(""), "weekday entry");
        assert!(!is_occasion("December 25 1642"), "a birthday");
        assert!(!is_occasion("\u{06F5} Dey 1386"), "a death, with a Persian-digit day");
    }

    #[test]
    fn parses_a_day() {
        let body = r#"{"is_holiday":true,"events":[
            {"description":"Friday","additional_description":"","is_holiday":true,"is_religious":false},
            {"description":" Christmas ","additional_description":"December 25","is_holiday":false,"is_religious":false},
            {"description":"Someone's birthday","additional_description":"December 25 1642","is_holiday":false,"is_religious":false}
        ]}"#;
        let day = parse_day(4, body).unwrap();
        assert_eq!(day.day, 4);
        assert!(day.holiday);
        assert_eq!(day.events.len(), 1);
        assert_eq!(day.events[0].title, "Christmas");
        assert_eq!(day.events[0].date, "December 25");
        assert!(parse_day(1, "<html>").is_err());
    }

    #[test]
    fn month_lengths() {
        assert!(valid_month(1, 31));
        assert!(!valid_month(7, 31));
        assert!(valid_month(12, 29) && valid_month(12, 30));
        assert!(!valid_month(13, 30));
    }

    /// Needs internet: `cargo test calendar_events -- --ignored`.
    #[test]
    #[ignore]
    fn live_month() {
        let days = tauri::async_runtime::block_on(fetch(1405, 10, 30)).expect("an answer");
        assert_eq!(days.len(), 30);
        // 2 Dey 1405 (13 Rajab) is a public holiday.
        assert!(days[1].holiday);
    }
}
