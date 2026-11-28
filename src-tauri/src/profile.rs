//! The logged-in user's own account (dental-server AuthService.GetProfile and
//! UpdateProfile): the full name, mobile number, email and birth date can be changed;
//! the username and identification code cannot. Needs the server; works with a full
//! online session and with a restricted one (`auth::BillingSession`).

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use crate::api::ApiError;
use crate::auth::{server_error, Context};
use crate::message::Message;
use crate::{patients, proto};

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub username: String,
    pub full_name: String,
    /// The identification code (person.rs); empty if the account has none.
    pub identity: String,
    pub phone: String,
    /// Empty when none was given.
    pub email: String,
    /// Gregorian "YYYY-MM-DD"; empty when none was given.
    pub birth_date: String,
}

impl Profile {
    fn from_proto(profile: Option<proto::Profile>) -> Result<Self, Message> {
        let profile = profile.ok_or_else(|| Message::error("errors.unknown", "profile response without profile"))?;
        let user = profile.user.unwrap_or_default();
        Ok(Self {
            username: user.username,
            full_name: user.full_name,
            identity: profile.identity.map(|identity| identity.number).unwrap_or_default(),
            phone: profile.phone,
            email: profile.email,
            birth_date: profile.birth_date,
        })
    }
}

/// What can be changed, as typed in the profile form (src/auth/session.ts).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileInput {
    pub full_name: String,
    pub phone: String,
    /// Optional: empty removes the email on file.
    pub email: String,
    /// Optional, Gregorian "YYYY-MM-DD": empty removes the birth date on file.
    pub birth_date: String,
}

fn api_error(error: ApiError) -> Message {
    match error {
        ApiError::Network(_) => Message::new("auth.errors.serverUnreachable"),
        ApiError::Server { code, reason } => server_error(&code, &reason),
    }
}

pub async fn get(ctx: &Context, token: &str) -> Result<Profile, Message> {
    let response = ctx.api.get_profile(token).await.map_err(api_error)?;
    Profile::from_proto(response.profile)
}

pub async fn update(ctx: &Context, token: &str, input: &ProfileInput) -> Result<Profile, Message> {
    let request = proto::UpdateProfileRequest {
        full_name: input.full_name.trim().to_owned(),
        phone: input.phone.trim().to_owned(),
        email: input.email.trim().to_owned(),
        birth_date: Some(patients::check_date(&input.birth_date)?),
    };
    let response = ctx.api.update_profile(token, &request).await.map_err(api_error)?;
    Profile::from_proto(response.profile)
}

/// Keeps the local list of users (localdb.rs) in step with a changed full name and
/// birth date; the next login would write them anyway.
pub fn record_profile(db: &Connection, user_id: &str, full_name: &str, birth_date: &str) -> rusqlite::Result<()> {
    let Ok(id) = hex::decode(user_id) else {
        return Ok(());
    };
    db.execute("UPDATE users SET full_name = ?2, birth_date = ?3 WHERE id = ?1", params![id, full_name, birth_date])?;
    Ok(())
}
