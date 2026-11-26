import { useCallback } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useTranslation } from "react-i18next";
import { useFormatRials } from "@/i18n/currency";

/**
 * The clinic owner's subscription (see src-tauri/src/billing.rs). Payments are
 * manual for now: the owner transfers the amount to one of the listed accounts
 * and reports it; an administrator approves it, which adds the subscription.
 *
 * Amounts are Iranian rials (show them with useFormatRials()); times are unix
 * seconds, 0 meaning none. Each call throws a RustMessage on failure.
 */

export interface Plan {
  id: string;
  name: string;
  maxClinics: number;
  maxDevicesPerClinic: number;
  durationDays: number;
  /** 0 is free: activated at once, without a transfer. */
  priceRials: number;
  /** How many times each owner may buy it; 0 = no limit (e.g. 1 for a free trial). */
  maxPurchasesPerOwner: number;
  /** How many times this owner already has it (a payment waiting for review included). */
  purchased: number;
}

/** The owner may not buy this plan again. */
export function purchaseLimitReached(plan: Plan): boolean {
  return plan.maxPurchasesPerOwner > 0 && plan.purchased >= plan.maxPurchasesPerOwner;
}

export interface Subscription {
  planId: string;
  planName: string;
  maxClinics: number;
  maxDevicesPerClinic: number;
  startsAt: number;
  endsAt: number;
}

export interface ClinicUsage {
  name: string;
  licenseNumber: string;
  city: string;
  installationCount: number;
  /** Within the subscription's clinic limit. */
  covered: boolean;
}

export interface PaymentAccount {
  id: string;
  bankName: string;
  holderName: string;
  /** 16 digits, or empty. */
  cardNumber: string;
  /** "IR" and 24 digits, or empty. */
  iban: string;
}

/**
 * "extend": from the end of the paid time, at full price (renewing, or a bigger
 * plan from the next period on). "upgradeNow": at approval, replacing the
 * subscription in force, whose unused time is credited.
 */
export type PurchaseMode = "extend" | "upgradeNow";
/** "free": nothing to pay (a free plan, or an upgrade the credit covers), approved at once. */
export type PaymentMethod = "cardToCard" | "bankTransfer" | "free";
export type PaymentStatus = "pending" | "approved" | "rejected" | "canceled";

export interface Payment {
  id: string;
  planName: string;
  maxClinics: number;
  maxDevicesPerClinic: number;
  durationDays: number;
  mode: PurchaseMode;
  method: PaymentMethod;
  status: PaymentStatus;
  priceRials: number;
  creditRials: number;
  amountRials: number;
  reference: string;
  paidAt: number;
  payerCardLast4: string;
  /** The administrator's own words, shown as they are. */
  rejectionReason: string;
  createdAt: number;
  reviewedAt: number;
}

export interface BillingStatus {
  current: Subscription | null;
  upcoming: Subscription[];
  /** End of the paid time, renewals included. */
  paidUntil: number;
  clinics: ClinicUsage[];
  payTo: PaymentAccount[];
  /** At most one at a time. */
  pendingPayment: Payment | null;
}

export interface Quote {
  priceRials: number;
  creditRials: number;
  /** What to transfer. */
  amountRials: number;
  startsAt: number;
  endsAt: number;
}

/** A transfer the owner made (see PaymentInput in src-tauri/src/billing.rs). */
export interface PaymentInput {
  planId: string;
  mode: PurchaseMode;
  method: PaymentMethod;
  paymentAccountId: string;
  reference: string;
  /** Unix seconds: in the past, at most 30 days ago. */
  paidAt: number;
  /** Card to card only. */
  payerCardLast4: string;
}

export function billingStatus(): Promise<BillingStatus> {
  return invoke<BillingStatus>("billing_status");
}

/** Plans for sale, cheapest first. */
export function listPlans(): Promise<Plan[]> {
  return invoke<Plan[]>("list_plans");
}

export function quotePayment(planId: string, mode: PurchaseMode): Promise<Quote> {
  return invoke<Quote>("quote_payment", { planId, mode });
}

/** Reports a transfer; it waits for an administrator (status "pending"). */
export function createPayment(payment: PaymentInput): Promise<Payment> {
  return invoke<Payment>("create_payment", { payment });
}

/**
 * Buys when the quote's amount is 0: the subscription is added at once and the
 * payment comes back "approved". A restricted login still has to log in again.
 */
export function activateFree(planId: string, mode: PurchaseMode): Promise<Payment> {
  const payment: Pick<PaymentInput, "planId" | "mode" | "method"> = { planId, mode, method: "free" };
  return invoke<Payment>("create_payment", { payment });
}

/** Newest first. */
export function listMyPayments(): Promise<Payment[]> {
  return invoke<Payment[]>("list_my_payments");
}

/** Only while it is pending. */
export function cancelPayment(id: string): Promise<Payment> {
  return invoke<Payment>("cancel_payment", { id });
}

/** Formats a price or an amount to pay in rials; 0 is shown as "Free". */
export function useFormatPrice() {
  const { t } = useTranslation();
  const formatRials = useFormatRials();
  return useCallback((rials: number) => (rials === 0 ? t("billing.free") : formatRials(rials)), [t, formatRials]);
}

// Same rules as the server (dental-server/proto/dental/v1/subscription.proto).
export const PAYMENT_REFERENCE_PATTERN = /^[A-Za-z0-9-]{4,40}$/;
export const CARD_LAST4_PATTERN = /^[0-9]{4}$/;
/** How long ago a transfer may have been made. */
export const MAX_PAYMENT_AGE_DAYS = 30;
/** How often the page checks a pending payment while it is open. */
export const PENDING_POLL_MS = 30_000;
