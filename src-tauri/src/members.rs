//! Adding a user to the clinic (dental-server MemberService.CreateUser and
//! AddMember). Only the new user's own details go to the server: their account
//! (name, identification code, phone, email, username and a temporary password)
//! and their access to this clinic. Needs an online session of a clinic admin.
//!
//! The new user gets a temporary password, which the server makes them change
//! before their first login (src/pages/change-password-form.tsx).

use serde::{Deserialize, Serialize};

use crate::api::ApiError;
use crate::auth::{server_error, Context};
use crate::message::Message;
use crate::{patients, person, proto};

/// The server's reason when the account can already use this clinic.
const ALREADY_MEMBER: &str = "already_member";

/// A new user, as typed in the form (src/lib/members.ts).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemberInput {
    pub full_name: String,
    /// The identification code (person.rs).
    pub identity: String,
    pub phone: String,
    /// Optional: empty for none.
    pub email: String,
    pub username: String,
    pub temporary_password: String,
}

/// The user who can now log in to the clinic.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreatedMember {
    /// Server user id, 32 hex digits.
    pub id: String,
    pub username: String,
    pub full_name: String,
    /// False when the person already had an account (made by another clinic or
    /// themselves): it keeps its own username and password, and the temporary
    /// password typed was not used.
    pub created: bool,
}

fn api_error(error: ApiError) -> Message {
    match error {
        ApiError::Network(_) => Message::new("auth.errors.serverUnreachable"),
        ApiError::Server { code, reason } => server_error(&code, &reason),
    }
}

/// Creates the account (or finds the person's existing one) and gives it access
/// to the session's clinic. An account that already has access is not an error.
pub async fn create(ctx: &Context, token: &str, input: &MemberInput) -> Result<CreatedMember, Message> {
    let request = proto::CreateUserRequest {
        identity: Some(person::to_proto(&input.identity)?),
        username: input.username.trim().to_owned(),
        temporary_password: input.temporary_password.clone(),
        full_name: input.full_name.trim().to_owned(),
        phone: person::latin_digits(input.phone.trim()),
        email: input.email.trim().to_owned(),
    };
    let response = ctx.api.create_user(token, &request).await.map_err(api_error)?;
    let user = response.user.ok_or_else(|| Message::error("errors.unknown", "create user response without user"))?;

    let request = proto::AddMemberRequest { is_admin: false, user_id: user.id.clone() };
    match ctx.api.add_member(token, &request).await {
        Ok(_) => {}
        Err(ApiError::Server { reason, .. }) if reason == ALREADY_MEMBER => {}
        Err(e) => return Err(api_error(e)),
    }
    Ok(CreatedMember { id: hex::encode(&user.id), username: user.username, full_name: user.full_name, created: response.created })
}

/// Sets a member's birth date on their account (`user_id`: 32 hex digits), for
/// birthdays on the home calendar. Returns the birth date as stored: Gregorian
/// "YYYY-MM-DD", or empty when it was removed.
pub async fn set_birth_date(ctx: &Context, token: &str, user_id: &str, birth_date: &str) -> Result<String, Message> {
    let user_id = hex::decode(user_id).map_err(|e| Message::error("errors.unknown", e))?;
    let request = proto::SetMemberBirthDateRequest { user_id, birth_date: patients::check_date(birth_date)? };
    let response = ctx.api.set_member_birth_date(token, &request).await.map_err(api_error)?;
    let member =
        response.member.ok_or_else(|| Message::error("errors.unknown", "birth date response without member"))?;
    Ok(member.birth_date)
}
