//! Client for the dental server.
//!
//! Uses the Connect protocol for unary calls: the request body is the binary
//! protobuf message, POSTed to `/<package>.<Service>/<Method>`. The server
//! (connect-go) speaks it alongside gRPC; it needs no HTTP/2 framing or
//! trailers, so plain reqwest is enough. Data is protected in transit by TLS,
//! and database keys additionally by a SealedBox.

use std::time::Duration;

use serde::Deserialize;

use crate::proto;

// The server address is set in settings.rs.

const TIMEOUT: Duration = Duration::from_secs(15);
/// The connection check should not keep the user waiting long when the server is down.
const HEALTH_TIMEOUT: Duration = Duration::from_secs(5);
/// Logging out is best effort; the server token expires on its own anyway.
const LOGOUT_TIMEOUT: Duration = Duration::from_secs(3);

/// This app's version, sent with every call.
pub const APP_VERSION: &str = env!("CARGO_PKG_VERSION");
const APP_VERSION_HEADER: &str = "Dental-App-Version";
/// The server's reason for refusing an app older than its minimum version.
pub const UPDATE_REQUIRED: &str = "update_required";
/// Pushes and pulls may carry up to 500 records.
const SYNC_TIMEOUT: Duration = Duration::from_secs(60);

#[derive(Debug)]
pub enum ApiError {
    /// The server could not be reached (no internet, server down, timeout).
    Network(String),
    /// The server answered with an error. `reason` is a stable code such as "invalid_credentials".
    Server { code: String, reason: String },
}

impl std::fmt::Display for ApiError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ApiError::Network(e) => write!(f, "network error: {e}"),
            ApiError::Server { code, reason } => write!(f, "server error {code}: {reason}"),
        }
    }
}

impl std::error::Error for ApiError {}

/// Connect error body: {"code": "unauthenticated", "message": "invalid_credentials"}.
#[derive(Deserialize)]
struct ConnectError {
    code: String,
    #[serde(default)]
    message: String,
}

#[derive(Clone)]
pub struct Api {
    base_url: String,
    http: reqwest::Client,
}

impl Api {
    pub fn new(base_url: impl Into<String>) -> Self {
        let http = reqwest::Client::builder()
            .build()
            .expect("HTTP client configuration is valid");
        Self { base_url: base_url.into().trim_end_matches('/').to_owned(), http }
    }

    async fn call<Req: prost::Message, Res: prost::Message + Default>(
        &self,
        service: &str,
        method: &str,
        request: &Req,
        session_token: Option<&str>,
    ) -> Result<Res, ApiError> {
        self.call_with_timeout(service, method, request, session_token, TIMEOUT).await
    }

    async fn call_with_timeout<Req: prost::Message, Res: prost::Message + Default>(
        &self,
        service: &str,
        method: &str,
        request: &Req,
        session_token: Option<&str>,
        timeout: Duration,
    ) -> Result<Res, ApiError> {
        let mut builder = self
            .http
            .post(format!("{}/dental.v1.{service}/{method}", self.base_url))
            .timeout(timeout)
            .header("Content-Type", "application/proto")
            .header("Connect-Protocol-Version", "1")
            // The server refuses apps older than its minimum version (update.rs).
            .header(APP_VERSION_HEADER, APP_VERSION)
            .body(request.encode_to_vec());
        if let Some(token) = session_token {
            builder = builder.bearer_auth(token);
        }

        let response = builder.send().await.map_err(|e| ApiError::Network(e.to_string()))?;
        let status = response.status();
        let body = response.bytes().await.map_err(|e| ApiError::Network(e.to_string()))?;

        if status.is_success() {
            return Res::decode(body.as_ref()).map_err(|e| ApiError::Server {
                code: "internal".into(),
                reason: format!("invalid response: {e}"),
            });
        }
        // Not a Connect error (e.g. a proxy page): treat as unreachable server.
        match serde_json::from_slice::<ConnectError>(&body) {
            Ok(error) => Err(ApiError::Server { code: error.code, reason: error.message }),
            Err(_) => Err(ApiError::Network(format!("unexpected HTTP {status}"))),
        }
    }

    /// Checks that the server is up. Uses a short timeout.
    pub async fn health(&self) -> Result<proto::CheckResponse, ApiError> {
        self.call_with_timeout("HealthService", "Check", &proto::CheckRequest {}, None, HEALTH_TIMEOUT).await
    }

    pub async fn register(&self, request: &proto::RegisterRequest) -> Result<proto::RegisterResponse, ApiError> {
        self.call("InstallationService", "Register", request, None).await
    }

    /// The clinics an account owns or administers. No session: proven with the password.
    pub async fn list_my_clinics(
        &self,
        request: &proto::ListMyClinicsRequest,
    ) -> Result<proto::ListMyClinicsResponse, ApiError> {
        self.call("InstallationService", "ListMyClinics", request, None).await
    }

    /// Iran's provinces and cities, for a new clinic. No session needed.
    pub async fn list_cities(&self) -> Result<proto::ListCitiesResponse, ApiError> {
        self.call("InstallationService", "ListCities", &proto::ListCitiesRequest {}, None).await
    }

    pub async fn sign_up(&self, request: &proto::SignUpRequest) -> Result<proto::SignUpResponse, ApiError> {
        self.call("AuthService", "SignUp", request, None).await
    }

    pub async fn login(&self, request: &proto::LoginRequest) -> Result<proto::LoginResponse, ApiError> {
        self.call("AuthService", "Login", request, None).await
    }

    /// No session needed: proven with the current password. Ends the account's sessions.
    pub async fn change_password(
        &self,
        request: &proto::ChangePasswordRequest,
    ) -> Result<proto::ChangePasswordResponse, ApiError> {
        self.call("AuthService", "ChangePassword", request, None).await
    }

    pub async fn confirm_key_rotation(
        &self,
        token: &str,
        new_version: u32,
    ) -> Result<proto::ConfirmKeyRotationResponse, ApiError> {
        let request = proto::ConfirmKeyRotationRequest { new_version };
        self.call("AuthService", "ConfirmKeyRotation", &request, Some(token)).await
    }

    /// Who may log in on the session's installation. Any member may call it.
    pub async fn list_members(&self, token: &str) -> Result<proto::ListMembersResponse, ApiError> {
        self.call("MemberService", "ListMembers", &proto::ListMembersRequest {}, Some(token)).await
    }

    /// Short timeout: it also runs while the app closes, which must not hang when the server is down.
    pub async fn logout(&self, token: &str) -> Result<proto::LogoutResponse, ApiError> {
        self.call_with_timeout("AuthService", "Logout", &proto::LogoutRequest {}, Some(token), LOGOUT_TIMEOUT)
            .await
    }

    /// Downloadable interface languages. No session needed.
    pub async fn list_languages(&self) -> Result<proto::ListLanguagesResponse, ApiError> {
        self.call("LanguageService", "ListLanguages", &proto::ListLanguagesRequest {}, None).await
    }

    /// The server address, e.g. for the updater's endpoint (update.rs).
    pub fn base_url(&self) -> &str {
        &self.base_url
    }

    /// Sends changed patients and treatments (sync.rs).
    pub async fn push(&self, token: &str, request: &proto::PushRequest) -> Result<proto::PushResponse, ApiError> {
        self.call_with_timeout("SyncService", "Push", request, Some(token), SYNC_TIMEOUT).await
    }

    /// Fetches the clinic's records changed after `since_revision` (sync.rs).
    pub async fn pull(&self, token: &str, since_revision: i64) -> Result<proto::PullResponse, ApiError> {
        let request = proto::PullRequest { since_revision };
        self.call_with_timeout("SyncService", "Pull", &request, Some(token), SYNC_TIMEOUT).await
    }

    /// A patient's history in every clinic. The server logs the view.
    pub async fn patient_history(
        &self,
        token: &str,
        identity: proto::PersonIdentity,
    ) -> Result<proto::GetPatientHistoryResponse, ApiError> {
        let request = proto::GetPatientHistoryRequest { identity: Some(identity) };
        self.call("PatientService", "GetPatientHistory", &request, Some(token)).await
    }

    // --- Subscriptions (billing.rs): the clinic owner's session, full or billing-only ---

    pub async fn list_plans(&self, token: &str) -> Result<proto::BillingServiceListPlansResponse, ApiError> {
        self.call("BillingService", "ListPlans", &proto::BillingServiceListPlansRequest {}, Some(token)).await
    }

    pub async fn billing_status(&self, token: &str) -> Result<proto::GetBillingStatusResponse, ApiError> {
        self.call("BillingService", "GetBillingStatus", &proto::GetBillingStatusRequest {}, Some(token)).await
    }

    pub async fn quote_payment(
        &self,
        token: &str,
        request: &proto::QuotePaymentRequest,
    ) -> Result<proto::QuotePaymentResponse, ApiError> {
        self.call("BillingService", "QuotePayment", request, Some(token)).await
    }

    pub async fn create_payment(
        &self,
        token: &str,
        request: &proto::CreatePaymentRequest,
    ) -> Result<proto::CreatePaymentResponse, ApiError> {
        self.call("BillingService", "CreatePayment", request, Some(token)).await
    }

    pub async fn list_my_payments(&self, token: &str) -> Result<proto::ListMyPaymentsResponse, ApiError> {
        self.call("BillingService", "ListMyPayments", &proto::ListMyPaymentsRequest {}, Some(token)).await
    }

    pub async fn cancel_payment(&self, token: &str, id: Vec<u8>) -> Result<proto::CancelPaymentResponse, ApiError> {
        self.call("BillingService", "CancelPayment", &proto::CancelPaymentRequest { id }, Some(token)).await
    }

    pub async fn get_language(&self, code: &str) -> Result<proto::GetLanguageResponse, ApiError> {
        let request = proto::GetLanguageRequest { code: code.to_owned() };
        self.call("LanguageService", "GetLanguage", &request, None).await
    }
}
