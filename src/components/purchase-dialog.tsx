import { useEffect, useState, type MouseEvent } from "react";
import { Controller, useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { CheckIcon, CopyIcon, LoaderCircleIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { paymentSchema, type PaymentValues } from "@/auth/schemas";
import { useFormatDate } from "@/i18n/calendar";
import { useFormatRials } from "@/i18n/currency";
import { toRustMessage, translateMessage, type RustMessage } from "@/i18n/message";
import {
  createPayment,
  MAX_PAYMENT_AGE_DAYS,
  quotePayment,
  type Payment,
  type PaymentAccount,
  type Plan,
  type Quote,
} from "@/lib/billing";
import { fieldError } from "@/lib/form";
import { cn } from "@/lib/utils";
import { FormField } from "@/components/form-field";
import { SelectField } from "@/components/select-field";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";

interface PurchaseDialogProps {
  /** The plan being bought; the dialog is open while it is set. */
  plan: Plan | null;
  accounts: PaymentAccount[];
  /** Upgrading at once is possible: a subscription is in force and none is queued after it. */
  canUpgradeNow: boolean;
  onClose: () => void;
  onCreated: (payment: Payment) => void;
}

/**
 * Buying a plan: the owner sees what to pay and where, transfers the money
 * themselves, then reports the transfer here; an administrator approves it.
 * Opened from the subscription page (src/pages/subscription-page.tsx).
 */
export function PurchaseDialog({ plan, accounts, canUpgradeNow, onClose, onCreated }: PurchaseDialogProps) {
  const { t } = useTranslation();
  return (
    <Dialog open={!!plan} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="max-h-[calc(100svh-2rem)] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{t("billing.purchase.title", { plan: plan?.name ?? "" })}</DialogTitle>
          <DialogDescription>{t("billing.purchase.description")}</DialogDescription>
        </DialogHeader>
        {/* A new form for each plan. */}
        {plan && (
          <PurchaseForm
            key={plan.id}
            plan={plan}
            accounts={accounts}
            canUpgradeNow={canUpgradeNow}
            onCreated={onCreated}
            onCancel={onClose}
          />
        )}
      </DialogContent>
    </Dialog>
  );
}

interface PurchaseFormProps {
  plan: Plan;
  accounts: PaymentAccount[];
  canUpgradeNow: boolean;
  onCreated: (payment: Payment) => void;
  onCancel: () => void;
}

function PurchaseForm({ plan, accounts, canUpgradeNow, onCreated, onCancel }: PurchaseFormProps) {
  const { t } = useTranslation();
  const formatDate = useFormatDate();
  const [error, setError] = useState<RustMessage | null>(null);
  const {
    register,
    handleSubmit,
    control,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<PaymentValues>({
    resolver: zodResolver(paymentSchema),
    defaultValues: {
      mode: "extend",
      accountId: accounts.length === 1 ? accounts[0].id : "",
      method: "cardToCard",
      reference: "",
      daysAgo: "0",
      payerCardLast4: "",
    },
  });
  const mode = useWatch({ control, name: "mode" });
  const method = useWatch({ control, name: "method" });
  const accountId = useWatch({ control, name: "accountId" });
  const account = accounts.find((a) => a.id === accountId);

  // An account with only an IBAN takes bank transfers only, and one with only a card number card to card only.
  useEffect(() => {
    if (!account) return;
    if (!account.cardNumber && method === "cardToCard") setValue("method", "bankTransfer");
    if (!account.iban && method === "bankTransfer") setValue("method", "cardToCard");
  }, [account, method, setValue]);

  const now = Date.now();
  const days = Array.from({ length: MAX_PAYMENT_AGE_DAYS }, (_, n) => ({
    value: String(n),
    label:
      n === 0
        ? t("billing.purchase.today")
        : n === 1
          ? t("billing.purchase.yesterday")
          : formatDate(now - n * 86_400_000, { dateStyle: "full" }),
  }));

  async function submit(values: PaymentValues) {
    setError(null);
    const daysAgo = Number(values.daysAgo);
    // The day is what matters; today's transfer is dated a minute ago, since the server wants the past.
    const paidAt = Math.floor(Date.now() / 1000) - 60 - daysAgo * 86_400;
    try {
      onCreated(
        await createPayment({
          planId: plan.id,
          mode: values.mode,
          method: values.method,
          paymentAccountId: values.accountId,
          reference: values.reference,
          paidAt,
          payerCardLast4: values.method === "cardToCard" ? values.payerCardLast4 : "",
        }),
      );
    } catch (e) {
      setError(toRustMessage(e));
    }
  }

  return (
    <form className="flex flex-col gap-5" onSubmit={handleSubmit(submit)} noValidate>
      {canUpgradeNow && (
        <div className="flex flex-col gap-2">
          <p className="text-sm font-medium">{t("billing.purchase.when")}</p>
          <Tabs
            value={mode}
            onValueChange={(value) => value === "extend" || value === "upgradeNow" ? setValue("mode", value) : undefined}
          >
            <TabsList className="w-full">
              <TabsTrigger value="extend">{t("billing.modes.extend")}</TabsTrigger>
              <TabsTrigger value="upgradeNow">{t("billing.modes.upgradeNow")}</TabsTrigger>
            </TabsList>
          </Tabs>
          <p className="text-xs text-muted-foreground">
            {t(mode === "upgradeNow" ? "billing.modes.upgradeNowHint" : "billing.modes.extendHint")}
          </p>
        </div>
      )}

      <QuoteSummary planId={plan.id} mode={mode} />

      <div className="flex flex-col gap-2">
        <p className="text-sm font-medium">{t("billing.purchase.payTo")}</p>
        {accounts.length === 0 ? (
          <Alert variant="destructive">
            <AlertDescription>{t("billing.purchase.noAccounts")}</AlertDescription>
          </Alert>
        ) : (
          <div role="radiogroup" aria-label={t("billing.purchase.payTo")} className="flex flex-col gap-2">
            {accounts.map((option) => (
              <AccountOption
                key={option.id}
                account={option}
                checked={option.id === accountId}
                onSelect={() => setValue("accountId", option.id, { shouldValidate: !!errors.accountId })}
              />
            ))}
          </div>
        )}
        {errors.accountId && <p className="text-xs text-destructive">{fieldError(errors.accountId)}</p>}
      </div>

      <div className="flex flex-col gap-2">
        <p className="text-sm font-medium">{t("billing.purchase.method")}</p>
        <Tabs
          value={method}
          onValueChange={(value) =>
            value === "cardToCard" || value === "bankTransfer" ? setValue("method", value) : undefined
          }
        >
          <TabsList className="w-full">
            <TabsTrigger value="cardToCard" disabled={!!account && !account.cardNumber}>
              {t("billing.methods.cardToCard")}
            </TabsTrigger>
            <TabsTrigger value="bankTransfer" disabled={!!account && !account.iban}>
              {t("billing.methods.bankTransfer")}
            </TabsTrigger>
          </TabsList>
        </Tabs>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <FormField
          id="payment-reference"
          label={t("billing.fields.reference")}
          hint={t("billing.hints.reference")}
          error={fieldError(errors.reference)}
          maxLength={40}
          latin
          {...register("reference")}
        />
        <Controller
          control={control}
          name="daysAgo"
          render={({ field }) => (
            <SelectField
              id="payment-day"
              label={t("billing.fields.paidOn")}
              placeholder=""
              error={null}
              options={days}
              value={field.value}
              onValueChange={field.onChange}
              triggerRef={field.ref}
            />
          )}
        />
        {method === "cardToCard" && (
          <FormField
            id="payment-card-last4"
            label={t("billing.fields.cardLast4")}
            hint={t("billing.hints.cardLast4")}
            error={fieldError(errors.payerCardLast4)}
            inputMode="numeric"
            maxLength={4}
            latin
            {...register("payerCardLast4")}
          />
        )}
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{translateMessage(error)}</AlertDescription>
        </Alert>
      )}

      <DialogFooter>
        <Button type="button" variant="outline" onClick={onCancel} disabled={isSubmitting}>
          {t("billing.purchase.cancel")}
        </Button>
        <Button type="submit" disabled={isSubmitting || accounts.length === 0}>
          {isSubmitting && <LoaderCircleIcon className="animate-spin" />}
          {t(isSubmitting ? "billing.purchase.working" : "billing.purchase.submit")}
        </Button>
      </DialogFooter>
    </form>
  );
}

/** What to pay, from the server, for the chosen plan and mode. */
function QuoteSummary({ planId, mode }: { planId: string; mode: PaymentValues["mode"] }) {
  const { t } = useTranslation();
  const formatRials = useFormatRials();
  const formatDate = useFormatDate();
  const [quote, setQuote] = useState<Quote | null>(null);
  const [error, setError] = useState<RustMessage | null>(null);

  useEffect(() => {
    let current = true;
    setQuote(null);
    setError(null);
    quotePayment(planId, mode).then(
      (next) => current && setQuote(next),
      (e) => current && setError(toRustMessage(e)),
    );
    return () => {
      current = false;
    };
  }, [planId, mode]);

  if (error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{translateMessage(error)}</AlertDescription>
      </Alert>
    );
  }
  if (!quote) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <LoaderCircleIcon className="size-4 animate-spin" />
        {t("billing.purchase.quoting")}
      </p>
    );
  }
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 rounded-lg border p-3 text-sm">
      <dt className="text-muted-foreground">{t("billing.purchase.price")}</dt>
      <dd>{formatRials(quote.priceRials)}</dd>
      {quote.creditRials > 0 && (
        <>
          <dt className="text-muted-foreground">{t("billing.purchase.credit")}</dt>
          <dd>{formatRials(quote.creditRials)}</dd>
        </>
      )}
      <dt className="font-medium">{t("billing.purchase.amount")}</dt>
      <dd className="font-semibold">{formatRials(quote.amountRials)}</dd>
      <dt className="text-muted-foreground">{t("billing.purchase.period")}</dt>
      <dd>
        {t("billing.period", { from: formatDate(quote.startsAt * 1000), to: formatDate(quote.endsAt * 1000) })}
      </dd>
    </dl>
  );
}

/** Groups a card number in fours, as printed on cards. */
function formatCardNumber(cardNumber: string): string {
  return cardNumber.replace(/(\d{4})(?=\d)/g, "$1 ");
}

function AccountOption({
  account,
  checked,
  onSelect,
}: {
  account: PaymentAccount;
  checked: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div
      role="radio"
      aria-checked={checked}
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === " " || e.key === "Enter") {
          e.preventDefault();
          onSelect();
        }
      }}
      className={cn(
        "flex cursor-pointer flex-col gap-1 rounded-lg border p-3 text-sm transition-colors outline-none",
        "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
        checked ? "border-primary bg-accent" : "hover:bg-accent/50",
      )}
    >
      <span className="font-medium">
        {account.bankName} · {account.holderName}
      </span>
      {account.cardNumber && (
        <CopyLine label={t("billing.accounts.card")} value={account.cardNumber} shown={formatCardNumber(account.cardNumber)} />
      )}
      {account.iban && <CopyLine label={t("billing.accounts.iban")} value={account.iban} shown={account.iban} />}
    </div>
  );
}

/** A number to transfer to, with a button that copies it. */
function CopyLine({ label, value, shown }: { label: string; value: string; shown: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  async function copy(e: MouseEvent) {
    // Copying does not pick the account.
    e.stopPropagation();
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.warn("Could not copy:", error);
    }
  }

  return (
    <span className="flex items-center gap-2 text-muted-foreground">
      <span>{label}</span>
      <bdi dir="ltr" className="font-mono text-foreground">
        {shown}
      </bdi>
      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-6"
        onClick={copy}
        aria-label={t("billing.accounts.copy")}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
      </Button>
    </span>
  );
}
