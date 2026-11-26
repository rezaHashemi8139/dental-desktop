//! First start: connects this installation to the clinic it belongs to. Each
//! installation belongs to exactly one clinic, for good.
//!
//! Until then logging in is refused with "setup.errors.required" (`auth::login`).
//! The login screen then lists the clinics of the account that just tried
//! (`my_clinics`, proven with the same password): with none, the person adds
//! their clinic; otherwise they pick the one this computer belongs to (only its
//! owner can) or add another one (`setup`). Then they log in as usual.

use serde::{Deserialize, Serialize};
use zeroize::Zeroizing;

use crate::api::ApiError;
use crate::auth::{server_error, Context};
use crate::device;
use crate::message::Message;
use crate::person::{self, Identity};
use crate::proto;
use crate::vault::Installation;

/// A new clinic, as typed in the clinic form (src/auth/setup.ts).
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
    /// Picked on the map: WGS 84 degrees.
    pub latitude: f64,
    pub longitude: f64,
}

/// Which clinic this installation is connected to.
#[derive(Deserialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum SetupTarget {
    /// A new clinic, owned by the person setting up.
    New(NewClinicInput),
    /// A clinic the person already owns.
    Existing(ExistingClinicInput),
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NewClinicInput {
    pub clinic: ClinicInput,
    /// Only for accounts without an identity on file (`MyClinics::identity_on_file`);
    /// empty otherwise.
    #[serde(default)]
    pub identity_type: Identity,
    #[serde(default)]
    pub identity: String,
    #[serde(default)]
    pub nationality: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExistingClinicInput {
    pub license_number: String,
}

/// The clinics an account owns or administers (ListMyClinicsResponse), for the clinic step.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MyClinics {
    pub full_name: String,
    /// False only for old accounts: adding a clinic then needs their national ID.
    pub identity_on_file: bool,
    /// Owned ones first, then oldest first.
    pub clinics: Vec<MyClinic>,
    /// When the account's own subscription ends (unix seconds); 0 if none is in force.
    pub subscription_ends_at: i64,
    /// How many clinics that subscription allows (0 if none), and how many the account owns.
    pub max_clinics: u32,
    pub owned_clinic_count: u32,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MyClinic {
    /// Identifies the clinic for `SetupTarget::Existing`.
    pub license_number: String,
    pub name: String,
    pub city: String,
    pub address: String,
    pub is_owner: bool,
    pub owner_full_name: String,
    /// Computers connected to the clinic, and how many the owner's subscription allows (0 if none).
    pub installation_count: u32,
    pub max_installations: u32,
    /// When the owner's subscription ends (unix seconds); 0 if none is in force.
    pub subscription_ends_at: i64,
    /// Why this computer cannot be connected to the clinic now; None if it can.
    pub cannot_add: Option<Message>,
}

fn trimmed(s: &str) -> String {
    s.trim().to_owned()
}

fn seconds(timestamp: &Option<prost_types::Timestamp>) -> i64 {
    timestamp.as_ref().map(|t| t.seconds).unwrap_or(0)
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
            location: Some(proto::GeoLocation { latitude: self.latitude, longitude: self.longitude }),
        }
    }
}

impl MyClinic {
    fn from_proto(clinic: proto::MyClinic) -> Self {
        let cannot_add = match clinic.cannot_add_reason.as_str() {
            "" => None,
            // Named here, since only the owner can do it.
            "not_clinic_owner" => {
                Some(Message::new(NOT_CLINIC_OWNER_ERROR).with("owner", clinic.owner_full_name.clone()))
            }
            reason => Some(server_error("permission_denied", reason)),
        };
        Self {
            license_number: clinic.license_number,
            name: clinic.name,
            city: clinic.city,
            address: clinic.address,
            is_owner: clinic.is_owner,
            owner_full_name: clinic.owner_full_name,
            installation_count: clinic.installation_count,
            max_installations: clinic.max_installations,
            subscription_ends_at: seconds(&clinic.subscription_ends_at),
            cannot_add,
        }
    }
}

/// Why a clinic someone else owns cannot be picked; `{{owner}}` is the owner's name.
const NOT_CLINIC_OWNER_ERROR: &str = "setup.clinics.ownerOnly";

fn api_error(error: ApiError) -> Message {
    match error {
        ApiError::Network(_) => Message::new("auth.errors.serverUnreachable"),
        ApiError::Server { code, reason } => server_error(&code, &reason),
    }
}

/// Whether this installation still has to be set up (never registered with the server).
pub fn needed(ctx: &Context) -> bool {
    matches!(Installation::load(&ctx.data_dir), Ok(None))
}

/// The clinics `username` owns or administers. Proves the account like login does.
pub async fn my_clinics(ctx: &Context, username: &str, password: &str) -> Result<MyClinics, Message> {
    if !needed(ctx) {
        return Err(Message::new("setup.errors.alreadyDone"));
    }
    let request = proto::ListMyClinicsRequest { username: trimmed(username), password: password.to_owned() };
    let response = ctx.api.list_my_clinics(&request).await.map_err(api_error)?;
    Ok(MyClinics {
        full_name: response.user.map(|user| user.full_name).unwrap_or_default(),
        identity_on_file: response.identity_on_file,
        clinics: response.clinics.into_iter().map(MyClinic::from_proto).collect(),
        subscription_ends_at: seconds(&response.subscription_ends_at),
        max_clinics: response.max_clinics,
        owned_clinic_count: response.owned_clinic_count,
    })
}

/// Registers this installation with the clinic `target`, proven with the account's
/// password. Does not log in.
pub async fn setup(ctx: &Context, username: &str, password: &str, target: &SetupTarget) -> Result<(), Message> {
    if !needed(ctx) {
        return Err(Message::new("setup.errors.alreadyDone"));
    }

    use proto::register_request::Target;
    let (target, identity) = match target {
        SetupTarget::New(input) => {
            let identity = if input.identity.trim().is_empty() {
                None
            } else {
                Some(person::to_proto(input.identity_type, &input.identity, &input.nationality)?)
            };
            (Target::Clinic(input.clinic.to_proto()), identity)
        }
        SetupTarget::Existing(input) => (
            Target::ExistingClinic(proto::ExistingClinic { license_number: trimmed(&input.license_number) }),
            None,
        ),
    };
    let request = proto::RegisterRequest {
        machine: Some(device::machine_info()),
        target: Some(target),
        owner: Some(proto::register_request::Owner::ExistingOwner(proto::ExistingOwner {
            username: trimmed(username),
            password: password.to_owned(),
            identity,
        })),
    };
    let response = ctx.api.register(&request).await.map_err(api_error)?;

    let id = response
        .installation_id
        .as_slice()
        .try_into()
        .map_err(|_| Message::error("errors.unknown", "invalid installation id"))?;
    let installation = Installation { id, secret: Zeroizing::new(response.installation_secret) };
    installation.save(&ctx.data_dir).map_err(|e| Message::error("errors.unknown", e))
}
