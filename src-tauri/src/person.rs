//! How people (user accounts and patients) are identified, the same way as on the
//! server (PersonIdentity in dental-server/proto/dental/v1/person.proto): by one
//! identification code, e.g. a national ID or any other official code. Nationality
//! is not recorded.

use crate::message::Message;
use crate::proto::PersonIdentity;

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

/// Checks and normalizes an identification code: ASCII digits, uppercase letters,
/// no spaces or dashes, 5 to 20 of them (the server's pattern ^[A-Z0-9]{5,20}$).
pub fn normalize(code: &str) -> Result<String, Message> {
    let code: String = latin_digits(code).chars().filter(|c| !c.is_whitespace() && *c != '-').collect();
    let code = code.to_ascii_uppercase();
    if !(5..=20).contains(&code.len()) || !code.chars().all(|c| c.is_ascii_alphanumeric()) {
        return Err(Message::new("person.errors.invalidIdentityCode"));
    }
    Ok(code)
}

/// A checked identity, as the server takes it.
pub fn to_proto(code: &str) -> Result<PersonIdentity, Message> {
    Ok(PersonIdentity { number: normalize(code)? })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn codes_are_normalized() {
        assert_eq!(to_proto(" ۰۰۱۲۳۴۵۶۷۹ ").unwrap().number, "0012345679");
        assert_eq!(to_proto("ab-12345").unwrap().number, "AB12345");
        assert_eq!(normalize("0012345678").unwrap(), "0012345678", "no check digit");

        let key = |code: &str| normalize(code).unwrap_err().key;
        assert_eq!(key("AB12"), "person.errors.invalidIdentityCode", "too short");
        assert_eq!(key("A".repeat(21).as_str()), "person.errors.invalidIdentityCode", "too long");
        assert_eq!(key("AB12_345"), "person.errors.invalidIdentityCode");
        assert_eq!(key("کد۱۲۳۴۵"), "person.errors.invalidIdentityCode", "only English letters");
    }
}
