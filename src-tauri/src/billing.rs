//! The clinic owner's subscription (dental-server BillingService): plans, the
//! subscription in force, and buying one.
//!
//! Payments are manual for now: the owner transfers the amount to one of the
//! server's accounts and reports it here; an administrator checks it and approves
//! it, which adds the subscription. Works with a full owner session (renewing
//! early) and with a restricted one (`auth::BillingSession`), whose owner logs in
//! again once a payment is approved.
//!
//! Amounts are Iranian rials; times are unix seconds (0 = none).

use serde::{Deserialize, Serialize};

use crate::api::ApiError;
use crate::auth::{server_error, Context};
use crate::message::Message;
use crate::proto;

fn api_error(error: ApiError) -> Message {
    match error {
        ApiError::Network(_) => Message::new("auth.errors.serverUnreachable"),
        // Only the owner buys; in this context the generic wording would be about computers.
        ApiError::Server { reason, .. } if reason == "not_clinic_owner" => Message::new("billing.errors.ownerOnly"),
        ApiError::Server { code, reason } => server_error(&code, &reason),
    }
}

fn seconds(timestamp: &Option<prost_types::Timestamp>) -> i64 {
    timestamp.as_ref().map(|t| t.seconds).unwrap_or(0)
}

fn id_bytes(id: &str) -> Result<Vec<u8>, Message> {
    hex::decode(id).ok().filter(|bytes| bytes.len() == 16).ok_or_else(|| Message::new("auth.errors.invalidInput"))
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    /// Hex.
    pub id: String,
    pub name: String,
    pub max_clinics: u32,
    pub max_devices_per_clinic: u32,
    pub duration_days: u32,
    pub price_rials: i64,
}

impl From<proto::Plan> for Plan {
    fn from(plan: proto::Plan) -> Self {
        Self {
            id: hex::encode(plan.id),
            name: plan.name,
            max_clinics: plan.max_clinics,
            max_devices_per_clinic: plan.max_devices_per_clinic,
            duration_days: plan.duration_days,
            price_rials: plan.price_rials,
        }
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Subscription {
    pub plan_name: String,
    /// As sold, whatever the plan says now.
    pub max_clinics: u32,
    pub max_devices_per_clinic: u32,
    pub starts_at: i64,
    pub ends_at: i64,
}

impl From<proto::Subscription> for Subscription {
    fn from(subscription: proto::Subscription) -> Self {
        Self {
            plan_name: subscription.plan_name,
            max_clinics: subscription.max_clinics,
            max_devices_per_clinic: subscription.max_devices_per_clinic,
            starts_at: seconds(&subscription.starts_at),
            ends_at: seconds(&subscription.ends_at),
        }
    }
}

/// One of the owner's clinics, and whether the subscription in force covers it.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClinicUsage {
    pub name: String,
    pub license_number: String,
    pub city: String,
    pub installation_count: u32,
    pub covered: bool,
}

/// Where to transfer the money.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaymentAccount {
    /// Hex.
    pub id: String,
    pub bank_name: String,
    pub holder_name: String,
    /// 16 digits, or empty.
    pub card_number: String,
    /// "IR" and 24 digits, or empty.
    pub iban: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PurchaseMode {
    /// From the end of the paid time, at full price (renewing, or a bigger plan next period).
    Extend,
    /// At approval, replacing the subscription in force; its unused time is credited.
    UpgradeNow,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PaymentMethod {
    CardToCard,
    BankTransfer,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum PaymentStatus {
    Pending,
    Approved,
    Rejected,
    Canceled,
}

impl PurchaseMode {
    fn to_proto(self) -> i32 {
        match self {
            PurchaseMode::Extend => proto::PurchaseMode::Extend as i32,
            PurchaseMode::UpgradeNow => proto::PurchaseMode::UpgradeNow as i32,
        }
    }

    fn from_proto(value: i32) -> Self {
        match proto::PurchaseMode::try_from(value) {
            Ok(proto::PurchaseMode::UpgradeNow) => PurchaseMode::UpgradeNow,
            _ => PurchaseMode::Extend,
        }
    }
}

impl PaymentMethod {
    fn to_proto(self) -> i32 {
        match self {
            PaymentMethod::CardToCard => proto::PaymentMethod::CardToCard as i32,
            PaymentMethod::BankTransfer => proto::PaymentMethod::BankTransfer as i32,
        }
    }

    fn from_proto(value: i32) -> Self {
        match proto::PaymentMethod::try_from(value) {
            Ok(proto::PaymentMethod::BankTransfer) => PaymentMethod::BankTransfer,
            _ => PaymentMethod::CardToCard,
        }
    }
}

impl PaymentStatus {
    fn from_proto(value: i32) -> Self {
        match proto::PaymentStatus::try_from(value) {
            Ok(proto::PaymentStatus::Approved) => PaymentStatus::Approved,
            Ok(proto::PaymentStatus::Rejected) => PaymentStatus::Rejected,
            Ok(proto::PaymentStatus::Canceled) => PaymentStatus::Canceled,
            _ => PaymentStatus::Pending,
        }
    }
}

/// A reported payment and what it buys.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Payment {
    /// Hex.
    pub id: String,
    pub plan_name: String,
    /// What it buys, as fixed when it was reported.
    pub max_clinics: u32,
    pub max_devices_per_clinic: u32,
    pub duration_days: u32,
    pub mode: PurchaseMode,
    pub method: PaymentMethod,
    pub status: PaymentStatus,
    pub price_rials: i64,
    pub credit_rials: i64,
    pub amount_rials: i64,
    pub reference: String,
    pub paid_at: i64,
    pub payer_card_last4: String,
    /// The administrator's own words, shown as they are.
    pub rejection_reason: String,
    pub created_at: i64,
    pub reviewed_at: i64,
}

impl From<proto::Payment> for Payment {
    fn from(payment: proto::Payment) -> Self {
        let transfer = match payment.details {
            Some(proto::payment::Details::Transfer(transfer)) => transfer,
            None => proto::ManualTransfer::default(),
        };
        Self {
            id: hex::encode(payment.id),
            plan_name: payment.plan_name,
            max_clinics: payment.max_clinics,
            max_devices_per_clinic: payment.max_devices_per_clinic,
            duration_days: payment.duration_days,
            mode: PurchaseMode::from_proto(payment.mode),
            method: PaymentMethod::from_proto(payment.method),
            status: PaymentStatus::from_proto(payment.status),
            price_rials: payment.price_rials,
            credit_rials: payment.credit_rials,
            amount_rials: payment.amount_rials,
            reference: transfer.reference,
            paid_at: seconds(&transfer.paid_at),
            payer_card_last4: transfer.payer_card_last4,
            rejection_reason: payment.rejection_reason,
            created_at: seconds(&payment.created_at),
            reviewed_at: seconds(&payment.reviewed_at),
        }
    }
}

/// Everything the subscription page shows.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BillingStatus {
    /// In force now.
    pub current: Option<Subscription>,
    /// Already bought, starting later.
    pub upcoming: Vec<Subscription>,
    /// End of the paid time, renewals included; 0 if none.
    pub paid_until: i64,
    pub clinics: Vec<ClinicUsage>,
    pub pay_to: Vec<PaymentAccount>,
    /// The reported payment waiting for an administrator, if any (at most one).
    pub pending_payment: Option<Payment>,
}

pub async fn status(ctx: &Context, token: &str) -> Result<BillingStatus, Message> {
    let response = ctx.api.billing_status(token).await.map_err(api_error)?;
    Ok(BillingStatus {
        current: response.current.map(Subscription::from),
        upcoming: response.upcoming.into_iter().map(Subscription::from).collect(),
        paid_until: seconds(&response.paid_until),
        clinics: response
            .clinics
            .into_iter()
            .map(|clinic| ClinicUsage {
                name: clinic.name,
                license_number: clinic.license_number,
                city: clinic.city,
                installation_count: clinic.installation_count,
                covered: clinic.covered,
            })
            .collect(),
        pay_to: response
            .pay_to
            .into_iter()
            .map(|account| PaymentAccount {
                id: hex::encode(account.id),
                bank_name: account.bank_name,
                holder_name: account.holder_name,
                card_number: account.card_number,
                iban: account.iban,
            })
            .collect(),
        pending_payment: response.pending_payment.map(Payment::from),
    })
}

/// Plans for sale, cheapest first.
pub async fn plans(ctx: &Context, token: &str) -> Result<Vec<Plan>, Message> {
    let response = ctx.api.list_plans(token).await.map_err(api_error)?;
    Ok(response.plans.into_iter().map(Plan::from).collect())
}

/// What buying `plan_id` costs and the period it buys, if approved now.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Quote {
    pub price_rials: i64,
    /// The unused value of the subscription in force (upgrading now only).
    pub credit_rials: i64,
    /// What to transfer.
    pub amount_rials: i64,
    pub starts_at: i64,
    pub ends_at: i64,
}

pub async fn quote(ctx: &Context, token: &str, plan_id: &str, mode: PurchaseMode) -> Result<Quote, Message> {
    let request = proto::QuotePaymentRequest { plan_id: id_bytes(plan_id)?, mode: mode.to_proto() };
    let quote = ctx.api.quote_payment(token, &request).await.map_err(api_error)?.quote.unwrap_or_default();
    Ok(Quote {
        price_rials: quote.price_rials,
        credit_rials: quote.credit_rials,
        amount_rials: quote.amount_rials,
        starts_at: seconds(&quote.starts_at),
        ends_at: seconds(&quote.ends_at),
    })
}

/// A transfer the owner made, as typed in the purchase form (src/lib/billing.ts).
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaymentInput {
    pub plan_id: String,
    pub mode: PurchaseMode,
    pub method: PaymentMethod,
    pub payment_account_id: String,
    pub reference: String,
    /// When the money was sent (unix seconds).
    pub paid_at: i64,
    /// Card to card only.
    #[serde(default)]
    pub payer_card_last4: String,
}

/// Reports a transfer; it waits for an administrator.
pub async fn create_payment(ctx: &Context, token: &str, input: &PaymentInput) -> Result<Payment, Message> {
    let card_last4 = match input.method {
        PaymentMethod::CardToCard => input.payer_card_last4.trim().to_owned(),
        PaymentMethod::BankTransfer => String::new(),
    };
    let request = proto::CreatePaymentRequest {
        plan_id: id_bytes(&input.plan_id)?,
        mode: input.mode.to_proto(),
        method: input.method.to_proto(),
        details: Some(proto::create_payment_request::Details::Transfer(proto::ManualTransfer {
            payment_account_id: id_bytes(&input.payment_account_id)?,
            reference: input.reference.trim().to_owned(),
            paid_at: Some(prost_types::Timestamp { seconds: input.paid_at, nanos: 0 }),
            payer_card_last4: card_last4,
        })),
    };
    let response = ctx.api.create_payment(token, &request).await.map_err(api_error)?;
    response.payment.map(Payment::from).ok_or_else(|| Message::error("errors.unknown", "payment missing"))
}

/// The owner's payments, newest first.
pub async fn payments(ctx: &Context, token: &str) -> Result<Vec<Payment>, Message> {
    let response = ctx.api.list_my_payments(token).await.map_err(api_error)?;
    Ok(response.payments.into_iter().map(Payment::from).collect())
}

/// Withdraws a payment still waiting for an administrator.
pub async fn cancel_payment(ctx: &Context, token: &str, id: &str) -> Result<Payment, Message> {
    let response = ctx.api.cancel_payment(token, id_bytes(id)?).await.map_err(api_error)?;
    response.payment.map(Payment::from).ok_or_else(|| Message::error("errors.unknown", "payment missing"))
}
