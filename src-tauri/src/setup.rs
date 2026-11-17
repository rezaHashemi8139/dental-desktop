//! First start: registers this installation with the server, together with the
//! clinic it belongs to and the clinic's owner (a new or an existing account).
//! Until this is done the app shows the setup screen instead of the login screen
//! (see `auth::connection_mode`).

use serde::Deserialize;
use zeroize::Zeroizing;

use crate::api::ApiError;
use crate::auth::{server_error, Context};
use crate::device;
use crate::message::Message;
use crate::proto;
use crate::vault::Installation;

/// The clinic, as typed in the setup form (src/auth/session.ts).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ClinicInput {
    pub name: String,
    pub license_number: String,
    pub phone: String,
    pub city: String,
    pub address: String,
    #[serde(default)]
    pub postal_code: String,
}

/// Who is responsible for the clinic.
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum OwnerInput {
    /// No account yet: the server creates it.
    New(NewOwnerInput),
    /// An existing account, proven with its password.
    Existing(ExistingOwnerInput),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewOwnerInput {
    pub username: String,
    pub password: String,
    pub full_name: String,
    pub national_id: String,
    pub phone: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExistingOwnerInput {
    pub username: String,
    pub password: String,
    pub national_id: String,
}

fn trimmed(s: &str) -> String {
    s.trim().to_owned()
}

impl ClinicInput {
    fn to_proto(&self) -> proto::ClinicInfo {
        proto::ClinicInfo {
            name: trimmed(&self.name),
            license_number: trimmed(&self.license_number),
            phone: trimmed(&self.phone),
            city: trimmed(&self.city),
            address: trimmed(&self.address),
            postal_code: trimmed(&self.postal_code),
        }
    }
}

impl OwnerInput {
    fn to_proto(&self) -> proto::register_request::Owner {
        use proto::register_request::Owner;
        match self {
            OwnerInput::New(o) => Owner::NewOwner(proto::NewOwner {
                username: trimmed(&o.username),
                password: o.password.clone(),
                full_name: trimmed(&o.full_name),
                national_id: trimmed(&o.national_id),
                phone: trimmed(&o.phone),
            }),
            OwnerInput::Existing(o) => Owner::ExistingOwner(proto::ExistingOwner {
                username: trimmed(&o.username),
                password: o.password.clone(),
                national_id: trimmed(&o.national_id),
            }),
        }
    }
}

/// Whether this installation still has to be set up (never registered with the server).
pub fn needed(ctx: &Context) -> bool {
    matches!(Installation::load(&ctx.data_dir), Ok(None))
}

/// Registers the installation, the clinic and its owner. Returns the owner's
/// username (as the server spells it), so the login form can be filled in.
pub async fn setup(ctx: &Context, clinic: &ClinicInput, owner: &OwnerInput) -> Result<String, Message> {
    if !needed(ctx) {
        return Err(Message::new("setup.errors.alreadyDone"));
    }

    let request = proto::RegisterRequest {
        machine: Some(device::machine_info()),
        clinic: Some(clinic.to_proto()),
        owner: Some(owner.to_proto()),
    };
    let response = match ctx.api.register(&request).await {
        Ok(response) => response,
        Err(ApiError::Network(_)) => return Err(Message::new("auth.errors.serverUnreachable")),
        Err(ApiError::Server { code, reason }) => return Err(server_error(&code, &reason)),
    };

    let id = response
        .installation_id
        .as_slice()
        .try_into()
        .map_err(|_| Message::error("errors.unknown", "invalid installation id"))?;
    let installation = Installation { id, secret: Zeroizing::new(response.installation_secret) };
    installation.save(&ctx.data_dir).map_err(|e| Message::error("errors.unknown", e))?;

    Ok(response.owner.map(|owner| owner.username).unwrap_or_default())
}
