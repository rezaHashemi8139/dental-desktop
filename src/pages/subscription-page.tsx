import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  CircleCheckIcon,
  ClockIcon,
  LoaderCircleIcon,
  LogInIcon,
  RefreshCwIcon,
  ShieldAlertIcon,
  TriangleAlertIcon,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { logout, resumeLogin } from "@/auth/session";
import { getSession, setSession, useSession } from "@/auth/store";
import { useFormatDate } from "@/i18n/calendar";
import { toRustMessage, translateMessage, type RustMessage } from "@/i18n/message";
import {
  billingStatus,
  cancelPayment,
  listMyPayments,
  listPlans,
  PENDING_POLL_MS,
  purchaseLimitReached,
  useFormatPrice,
  type BillingStatus,
  type Payment,
  type Plan,
  type Subscription,
} from "@/lib/billing";
import { PurchaseDialog } from "@/components/purchase-dialog";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface BillingData {
  status: BillingStatus;
  plans: Plan[];
  payments: Payment[];
}

/**
 * /subscription: the clinic owner's subscription, the plans for sale and the
 * owner's payments. For a restricted login (no subscription in force) it is the
 * only page: once a payment is approved, the clinic opens by itself (resumeLogin).
 */
export function SubscriptionPage() {
  const { t } = useTranslation();
  const session = useSession();
  const navigate = useNavigate();
  const [data, setData] = useState<BillingData | null>(null);
  const [error, setError] = useState<RustMessage | null>(null);
  const [loading, setLoading] = useState(false);
  const [buying, setBuying] = useState<Plan | null>(null);
  // A payment seen pending here, to tell the owner when it is approved or rejected.
  const watched = useRef<string | null>(null);
  const [decided, setDecided] = useState<Payment | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [status, plans, payments] = await Promise.all([billingStatus(), listPlans(), listMyPayments()]);
      setData({ status, plans, payments });
      setError(null);
      const pendingId = status.pendingPayment?.id ?? null;
      if (watched.current && watched.current !== pendingId) {
        const outcome = payments.find((payment) => payment.id === watched.current);
        if (outcome && outcome.status !== "pending") setDecided(outcome);
      }
      watched.current = pendingId;
    } catch (e) {
      setError(toRustMessage(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (session?.isOwner) load();
  }, [session?.isOwner, load]);

  // A pending payment is checked again every little while, as long as the page is open.
  const pending = data?.status.pendingPayment ?? null;
  useEffect(() => {
    if (!pending) return;
    const timer = setInterval(load, PENDING_POLL_MS);
    return () => clearInterval(timer);
  }, [pending, load]);

  // Approved while restricted: Rust logs in again by itself and the clinic opens.
  // Once per payment (the ref, not a cleanup, also keeps React's double effects in
  // development from starting it twice).
  const [resume, setResume] = useState<"opening" | "stillRestricted" | RustMessage | null>(null);
  const resumedFor = useRef<string | null>(null);
  useEffect(() => {
    if (decided?.status !== "approved" || !getSession()?.billing || resumedFor.current === decided.id) return;
    resumedFor.current = decided.id;
    setResume("opening");
    resumeLogin().then(
      (next) => {
        setSession(next);
        if (next.billing) setResume("stillRestricted");
        else navigate({ to: "/home", replace: true });
      },
      (e) => setResume(toRustMessage(e)),
    );
  }, [decided, navigate]);

  // The app layout leaves for /login when there is no session.
  if (!session) return null;

  async function logInAgain() {
    try {
      await logout();
    } finally {
      // Clear first: the /login guard sends logged-in users back.
      setSession(null);
      navigate({ to: "/login", replace: true });
    }
  }

  if (!session.isOwner) {
    return (
      <Card className="w-full max-w-lg">
        <CardHeader>
          <CardTitle>{t("billing.title")}</CardTitle>
        </CardHeader>
        <CardContent>
          <Alert>
            <ShieldAlertIcon />
            <AlertDescription>{t(session.online ? "billing.errors.ownerOnly" : "billing.errors.needsServer")}</AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    );
  }

  const status = data?.status;
  return (
    <div className="flex w-full max-w-3xl flex-col gap-6">
      {session.billing && (
        <Alert variant="warning">
          <TriangleAlertIcon />
          <AlertTitle>{translateMessage(session.billing)}</AlertTitle>
          <AlertDescription>
            <p>{t("billing.restricted.description")}</p>
            <Button variant="outline" size="sm" className="mt-2" onClick={logInAgain}>
              <LogInIcon />
              {t("billing.restricted.logInAgain")}
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {decided && (
        <Alert variant={decided.status === "approved" ? "info" : "destructive"}>
          {decided.status === "approved" ? <CircleCheckIcon /> : <TriangleAlertIcon />}
          <AlertTitle>
            {t(
              decided.status !== "approved"
                ? "billing.decided.rejected"
                : decided.method === "free"
                  ? "billing.decided.activated"
                  : "billing.decided.approved",
            )}
          </AlertTitle>
          <AlertDescription>
            {decided.status !== "approved" ? (
              decided.rejectionReason || t("billing.decided.noReason")
            ) : !session.billing ? (
              t("billing.decided.approvedActive")
            ) : resume === null || resume === "opening" ? (
              <span className="flex items-center gap-2">
                <LoaderCircleIcon className="size-4 animate-spin" />
                {t("billing.decided.opening")}
              </span>
            ) : resume === "stillRestricted" ? (
              t("billing.decided.stillRestricted")
            ) : (
              `${translateMessage(resume)} ${t("billing.decided.approvedLogIn")}`
            )}
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader className="flex flex-row items-start justify-between gap-4">
          <div className="flex flex-col gap-1.5">
            <CardTitle>{t("billing.title")}</CardTitle>
            <CardDescription>{t("billing.description")}</CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={load} disabled={loading}>
            <RefreshCwIcon className={loading ? "animate-spin" : undefined} />
            {t("billing.refresh")}
          </Button>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{translateMessage(error)}</AlertDescription>
            </Alert>
          )}
          {!status ? (
            !error && (
              <p className="flex items-center gap-2 text-sm text-muted-foreground">
                <LoaderCircleIcon className="size-4 animate-spin" />
                {t("billing.loading")}
              </p>
            )
          ) : (
            <>
              <CurrentSubscription status={status} />
              <ClinicsUsage status={status} />
            </>
          )}
        </CardContent>
      </Card>

      {pending && <PendingPayment payment={pending} onChanged={load} />}

      {data && (
        <Card>
          <CardHeader>
            <CardTitle>{t("billing.plans.title")}</CardTitle>
            <CardDescription>
              {t(pending ? "billing.plans.pendingFirst" : "billing.plans.description")}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {data.plans.length === 0 ? (
              <p className="text-sm text-muted-foreground">{t("billing.plans.none")}</p>
            ) : (
              <div className="grid gap-3 sm:grid-cols-2">
                {data.plans.map((plan) => (
                  <PlanCard key={plan.id} plan={plan} disabled={!!pending} onBuy={() => setBuying(plan)} />
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {data && data.payments.length > 0 && <PaymentHistory payments={data.payments} />}

      <PurchaseDialog
        plan={buying}
        accounts={data?.status.payTo ?? []}
        canUpgradeNow={!!status?.current && status.upcoming.length === 0}
        onClose={() => setBuying(null)}
        onCreated={(payment) => {
          setBuying(null);
          // Nothing to pay: already approved, so say so now rather than wait for a review.
          if (payment.status === "approved") setDecided(payment);
          load();
        }}
      />
    </div>
  );
}

function SubscriptionLine({ subscription }: { subscription: Subscription }) {
  const { t } = useTranslation();
  const formatDate = useFormatDate();
  return (
    <div className="flex flex-col gap-0.5">
      <span className="font-medium">{subscription.planName}</span>
      <span className="text-xs text-muted-foreground">
        {t("billing.limits", { clinics: subscription.maxClinics, devices: subscription.maxDevicesPerClinic })}
        {" · "}
        {t("billing.period", {
          from: formatDate(subscription.startsAt * 1000),
          to: formatDate(subscription.endsAt * 1000),
        })}
      </span>
    </div>
  );
}

function CurrentSubscription({ status }: { status: BillingStatus }) {
  const { t } = useTranslation();
  const formatDate = useFormatDate();
  return (
    <section className="flex flex-col gap-3">
      <h3 className="text-sm font-semibold">{t("billing.current.title")}</h3>
      {status.current ? (
        <SubscriptionLine subscription={status.current} />
      ) : (
        <p className="text-sm text-muted-foreground">{t("billing.current.none")}</p>
      )}
      {status.upcoming.length > 0 && (
        <div className="flex flex-col gap-2">
          <h4 className="text-xs font-medium text-muted-foreground">{t("billing.current.upcoming")}</h4>
          {status.upcoming.map((subscription) => (
            <SubscriptionLine key={subscription.startsAt} subscription={subscription} />
          ))}
        </div>
      )}
      {status.paidUntil > 0 && (
        <p className="text-sm">{t("billing.current.paidUntil", { date: formatDate(status.paidUntil * 1000) })}</p>
      )}
    </section>
  );
}

function ClinicsUsage({ status }: { status: BillingStatus }) {
  const { t } = useTranslation();
  if (status.clinics.length === 0) return null;
  return (
    <section className="flex flex-col gap-2">
      <h3 className="text-sm font-semibold">{t("billing.clinics.title")}</h3>
      <ul className="flex flex-col divide-y rounded-lg border">
        {status.clinics.map((clinic) => (
          <li key={clinic.licenseNumber} className="flex items-center justify-between gap-3 p-3 text-sm">
            <span className="flex min-w-0 flex-col">
              <span className="font-medium">{clinic.name}</span>
              <span className="text-xs text-muted-foreground">
                {clinic.city} · {t("billing.clinics.devices", { devices: clinic.installationCount })}
              </span>
            </span>
            <Badge variant={clinic.covered ? "secondary" : "destructive"}>
              {t(clinic.covered ? "billing.clinics.covered" : "billing.clinics.notCovered")}
            </Badge>
          </li>
        ))}
      </ul>
    </section>
  );
}

function PlanCard({ plan, disabled, onBuy }: { plan: Plan; disabled: boolean; onBuy: () => void }) {
  const { t } = useTranslation();
  const formatPrice = useFormatPrice();
  const limitReached = purchaseLimitReached(plan);
  return (
    <div className="flex flex-col gap-3 rounded-lg border p-4">
      <div className="flex flex-col gap-1">
        <span className="font-semibold">{plan.name}</span>
        <span className="text-lg font-bold">{formatPrice(plan.priceRials)}</span>
      </div>
      <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
        <li>{t("billing.plans.duration", { days: plan.durationDays })}</li>
        <li>{t("billing.plans.clinics", { clinics: plan.maxClinics })}</li>
        <li>{t("billing.plans.devices", { devices: plan.maxDevicesPerClinic })}</li>
        {plan.maxPurchasesPerOwner > 0 && (
          <li>
            {t("billing.plans.purchaseLimit", { used: plan.purchased, max: plan.maxPurchasesPerOwner })}
          </li>
        )}
      </ul>
      <Button className="mt-auto" onClick={onBuy} disabled={disabled || limitReached}>
        {t(limitReached ? "billing.plans.limitReached" : plan.priceRials === 0 ? "billing.plans.activate" : "billing.plans.buy")}
      </Button>
    </div>
  );
}

function PendingPayment({ payment, onChanged }: { payment: Payment; onChanged: () => void }) {
  const { t } = useTranslation();
  const formatPrice = useFormatPrice();
  const formatDate = useFormatDate();
  const [error, setError] = useState<RustMessage | null>(null);
  const [canceling, setCanceling] = useState(false);

  async function cancel() {
    setCanceling(true);
    setError(null);
    try {
      await cancelPayment(payment.id);
      onChanged();
    } catch (e) {
      setError(toRustMessage(e));
    } finally {
      setCanceling(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <ClockIcon className="size-5" />
          {t("billing.pending.title")}
        </CardTitle>
        <CardDescription>{t("billing.pending.description")}</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-muted-foreground">{t("billing.history.plan")}</dt>
          <dd>{payment.planName}</dd>
          <dt className="text-muted-foreground">{t("billing.history.amount")}</dt>
          <dd>{formatPrice(payment.amountRials)}</dd>
          <dt className="text-muted-foreground">{t("billing.fields.reference")}</dt>
          <dd>
            <bdi dir="ltr">{payment.reference}</bdi>
          </dd>
          <dt className="text-muted-foreground">{t("billing.fields.paidOn")}</dt>
          <dd>{formatDate(payment.paidAt * 1000)}</dd>
        </dl>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{translateMessage(error)}</AlertDescription>
          </Alert>
        )}
        <Button variant="outline" className="self-start" onClick={cancel} disabled={canceling}>
          {canceling && <LoaderCircleIcon className="animate-spin" />}
          {t("billing.pending.cancel")}
        </Button>
      </CardContent>
    </Card>
  );
}

const STATUS_BADGE = {
  pending: "outline",
  approved: "secondary",
  rejected: "destructive",
  canceled: "outline",
} as const;

function PaymentHistory({ payments }: { payments: Payment[] }) {
  const { t } = useTranslation();
  const formatPrice = useFormatPrice();
  const formatDate = useFormatDate();
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("billing.history.title")}</CardTitle>
      </CardHeader>
      <CardContent>
        <ul className="flex flex-col divide-y rounded-lg border">
          {payments.map((payment) => (
            <li key={payment.id} className="flex flex-col gap-1 p-3 text-sm">
              <span className="flex items-center justify-between gap-3">
                <span className="font-medium">{payment.planName}</span>
                <Badge variant={STATUS_BADGE[payment.status]}>{t(`billing.statuses.${payment.status}`)}</Badge>
              </span>
              <span className="text-xs text-muted-foreground">
                {formatDate(payment.createdAt * 1000)} · {formatPrice(payment.amountRials)} ·{" "}
                {t(`billing.modes.${payment.mode}`)}
              </span>
              {payment.status === "rejected" && payment.rejectionReason && (
                <span className="text-xs text-destructive">{payment.rejectionReason}</span>
              )}
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}
