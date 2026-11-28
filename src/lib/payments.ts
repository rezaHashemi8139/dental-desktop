import { invoke } from "@tauri-apps/api/core";

/**
 * Money received from patients, and refunds paid back to them
 * (src-tauri/src/payments.rs). Financial data: stored on this computer only,
 * never sent to the server. Anyone can record one; only whoever recorded it, or
 * a manager, can change or delete it.
 *
 * Each call throws a RustMessage (src/i18n/message.ts) on failure.
 */

/** "payment": received from the patient; "refund": paid back to them. */
export const PAYMENT_KINDS = ["payment", "refund"] as const;
export type PaymentKind = (typeof PAYMENT_KINDS)[number];

/** How the money moved (METHODS in src-tauri/src/payments.rs). */
export const PAYMENT_METHODS = [
  "cash",
  "pos",
  "cardToCard",
  "accountTransfer",
  "bankTransfer",
  "online",
  "cheque",
  "other",
] as const;
export type PaymentMethod = (typeof PAYMENT_METHODS)[number];

/** Longest tracking code (MAX_REFERENCE_CHARS in src-tauri/src/payments.rs). */
export const PATIENT_PAYMENT_REFERENCE_MAX = 64;
/** Latin letters, digits, "-", "/" and "." (spaces are dropped first). */
export const PATIENT_PAYMENT_REFERENCE_PATTERN = /^[A-Za-z0-9./-]*$/;

export interface PaymentInput {
  patientId: string;
  kind: PaymentKind;
  /** Stored amount (src/i18n/currency.ts), always positive: `kind` says which way it went. */
  amount: number;
  method: PaymentMethod;
  /** When the money moved, unix milliseconds. */
  paidAt: number;
  /** Tracking code, cheque number...; "" for none. */
  reference: string;
  notes: string;
}

export interface Payment extends PaymentInput {
  id: string;
  /** Local user id of who recorded it. */
  recordedBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface PaymentList {
  /** Payments and refunds together, newest first. */
  payments: Payment[];
  received: number;
  refunded: number;
  /** received - refunded. */
  balance: number;
}

export function listPayments(patientId: string): Promise<PaymentList> {
  return invoke<PaymentList>("list_payments", { patientId });
}

/** Records a payment or refund, or changes one (`id`). */
export function savePayment(payment: PaymentInput, id?: string): Promise<Payment> {
  return invoke<Payment>("save_payment", { id: id ?? null, payment });
}

export function deletePayment(id: string): Promise<void> {
  return invoke("delete_payment", { id });
}
