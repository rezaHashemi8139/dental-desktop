//! How people (user accounts and patients) are identified, the same way as on the
//! server (PersonIdentity in dental-server/proto/dental/v1/person.proto): Iranian
//! citizens by national ID, foreign nationals by the FIDA code issued to them in
//! Iran, with everyone's nationality recorded.

use serde::{Deserialize, Serialize};

use crate::message::Message;
use crate::proto::{IdentityType, PersonIdentity};

/// Nationality of national IDs (ISO 3166-1 alpha-2).
pub const IRAN: &str = "IR";

/// The kind of identity, as stored locally (e.g. `patients.identity_type`) and sent by the frontend.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub enum Identity {
    /// Iranian national ID.
    #[default]
    National,
    /// Foreign national: their FIDA code.
    Foreign,
}

impl Identity {
    pub fn as_str(self) -> &'static str {
        match self {
            Identity::National => "national",
            Identity::Foreign => "foreign",
        }
    }

    pub fn parse(text: &str) -> Option<Self> {
        match text {
            "national" => Some(Identity::National),
            "foreign" => Some(Identity::Foreign),
            _ => None,
        }
    }

    pub fn to_proto(self) -> IdentityType {
        match self {
            Identity::National => IdentityType::National,
            Identity::Foreign => IdentityType::Foreign,
        }
    }

    pub fn from_proto(value: i32) -> Option<Self> {
        match IdentityType::try_from(value).ok()? {
            IdentityType::National => Some(Identity::National),
            IdentityType::Foreign => Some(Identity::Foreign),
            IdentityType::Unspecified => None,
        }
    }
}

/// Persian and Arabic-Indic digits typed on a Persian keyboard become ASCII digits.
pub fn latin_digits(text: &str) -> String {
    text.chars()
        .map(|c| match c {
            '۰'..='۹' => char::from(b'0' + (c as u32 - '۰' as u32) as u8),
            '٠'..='٩' => char::from(b'0' + (c as u32 - '٠' as u32) as u8),
            _ => c,
        })
        .collect()
}

/// Same check as the server (validNationalID in dental-server/internal/service/installation.go).
pub fn valid_national_id(id: &str) -> bool {
    let digits: Vec<u32> = id.chars().filter_map(|c| c.to_digit(10)).collect();
    if digits.len() != 10 || id.len() != 10 || digits.iter().all(|&d| d == digits[0]) {
        return false;
    }
    let sum: u32 = digits[..9].iter().enumerate().map(|(i, d)| d * (10 - i as u32)).sum();
    match sum % 11 {
        r if r < 2 => digits[9] == r,
        r => digits[9] == 11 - r,
    }
}

/// Checks and normalizes an identity: digits for national IDs, uppercase letters and
/// digits for FIDA codes, and a nationality that matches the type (always "IR" for
/// national IDs, so it need not be given). Returns the number and the nationality.
pub fn normalize(identity: Identity, number: &str, nationality: &str) -> Result<(String, String), Message> {
    let number: String = latin_digits(number).chars().filter(|c| !c.is_whitespace() && *c != '-').collect();
    let number = number.to_ascii_uppercase();
    let nationality = nationality.trim().to_ascii_uppercase();
    match identity {
        Identity::National => {
            if !valid_national_id(&number) {
                return Err(Message::new("person.errors.invalidNationalId"));
            }
            Ok((number, IRAN.to_owned()))
        }
        Identity::Foreign => {
            let format_ok = (5..=20).contains(&number.len()) && number.chars().all(|c| c.is_ascii_alphanumeric());
            if !format_ok {
                return Err(Message::new("person.errors.invalidForeignId"));
            }
            if nationality.len() != 2 || !nationality.chars().all(|c| c.is_ascii_uppercase()) || nationality == IRAN {
                return Err(Message::new("person.errors.invalidNationality"));
            }
            Ok((number, nationality))
        }
    }
}

/// A checked identity, as the server takes it.
pub fn to_proto(identity: Identity, number: &str, nationality: &str) -> Result<PersonIdentity, Message> {
    let (number, nationality) = normalize(identity, number, nationality)?;
    Ok(PersonIdentity { r#type: identity.to_proto() as i32, number, nationality })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn national_id_check_digit() {
        assert!(valid_national_id("0012345679"));
        assert!(valid_national_id("1234567891"));
        assert!(!valid_national_id("0012345678"));
        assert!(!valid_national_id("1111111111"), "repeated digit");
        assert!(!valid_national_id("12345"));
    }

    #[test]
    fn identities_are_normalized() {
        let national = to_proto(Identity::National, " ۰۰۱۲۳۴۵۶۷۹ ", "").unwrap();
        assert_eq!((national.number.as_str(), national.nationality.as_str()), ("0012345679", IRAN));
        assert_eq!(national.r#type, IdentityType::National as i32);

        let foreign = to_proto(Identity::Foreign, "ab-12345", "af").unwrap();
        assert_eq!((foreign.number.as_str(), foreign.nationality.as_str()), ("AB12345", "AF"));

        let key = |identity, number, nationality| normalize(identity, number, nationality).unwrap_err().key;
        assert_eq!(key(Identity::National, "0012345678", ""), "person.errors.invalidNationalId");
        assert_eq!(key(Identity::Foreign, "AB1", "AF"), "person.errors.invalidForeignId");
        assert_eq!(key(Identity::Foreign, "AB12345", ""), "person.errors.invalidNationality");
        assert_eq!(key(Identity::Foreign, "AB12345", "IR"), "person.errors.invalidNationality", "not Iranian");
    }
}
