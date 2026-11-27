import { useEffect, useState } from "react";
import { Controller, useForm, useWatch, type Control, type UseFormSetValue } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Building2Icon, CheckIcon, InfoIcon, LoaderCircleIcon, RefreshCwIcon, TriangleAlertIcon } from "lucide-react";
import { useTranslation } from "react-i18next";
import { login, type Session } from "@/auth/session";
import { clinicSchema, clinicWithIdentitySchema, type ClinicValues } from "@/auth/schemas";
import {
  listCities,
  setupClinic,
  type FreeTrial,
  type MyClinic,
  type PendingSetup,
  type Province,
  type SetupTarget,
} from "@/auth/setup";
import { useFormatDate } from "@/i18n/calendar";
import { toRustMessage, translateMessage, type RustMessage } from "@/i18n/message";
import { fieldError } from "@/lib/form";
import { cn } from "@/lib/utils";
import { FormField } from "@/components/form-field";
import { LocationPicker } from "@/components/location-picker";
import { SelectField } from "@/components/select-field";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface ClinicSetupProps {
  setup: PendingSetup;
  /** With the free trial a first clinic started, if it did. */
  onLoggedIn: (session: Session, trial: FreeTrial | null) => void;
  /** Back to the login form: the person wants to use another account. */
  onCancel: () => void;
  /**
   * The computer is connected now, but logging in failed (e.g. no subscription):
   * the login form shows why.
   */
  onLoginFailed: (error: RustMessage) => void;
}

/**
 * First start, after logging in on a computer not connected to a clinic yet:
 * the person picks which of their clinics this computer belongs to, or adds a
 * new one (with none, straight away). Rendered inside the login screen's card.
 */
export function ClinicSetup({ setup, onLoggedIn, onCancel, onLoginFailed }: ClinicSetupProps) {
  const { t } = useTranslation();
  const hasClinics = setup.clinics.clinics.length > 0;
  const [adding, setAdding] = useState(!hasClinics);

  // Connects the computer, then logs in with the same credentials.
  async function connect(target: SetupTarget): Promise<RustMessage | null> {
    let trial: FreeTrial | null;
    try {
      trial = await setupClinic(setup.username, setup.password, target);
    } catch (e) {
      return toRustMessage(e);
    }
    try {
      onLoggedIn(await login(setup.username, setup.password), trial);
    } catch (e) {
      onLoginFailed(toRustMessage(e));
    }
    return null;
  }

  const name = setup.clinics.fullName || setup.username;
  return (
    <>
      <CardHeader>
        <CardTitle>{t(adding ? "setup.add.title" : "setup.pick.title")}</CardTitle>
        <CardDescription>
          {adding
            ? t(hasClinics ? "setup.add.description" : "setup.add.noClinic", { name })
            : t("setup.pick.description", { name })}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <Alert variant="info">
          <InfoIcon />
          <AlertTitle>{t("setup.firstRun.title")}</AlertTitle>
          <AlertDescription>
            <p>{t("setup.firstRun.onlyOne")}</p>
            <p>{t("setup.firstRun.backup")}</p>
          </AlertDescription>
        </Alert>
        {adding ? (
          <NewClinicForm setup={setup} connect={connect} onBack={hasClinics ? () => setAdding(false) : undefined} />
        ) : (
          <ClinicPicker clinics={setup.clinics.clinics} connect={connect} onAdd={() => setAdding(true)} />
        )}
        <Button variant="ghost" onClick={onCancel}>
          {t("setup.otherAccount")}
        </Button>
      </CardContent>
    </>
  );
}

interface ClinicPickerProps {
  clinics: MyClinic[];
  connect: (target: SetupTarget) => Promise<RustMessage | null>;
  onAdd: () => void;
}

/** The account's clinics; only the ones this computer can join are selectable. */
function ClinicPicker({ clinics, connect, onAdd }: ClinicPickerProps) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<string | null>(
    // One clinic that can be picked: chosen already, still confirmed with the button.
    () => {
      const available = clinics.filter((clinic) => !clinic.cannotAdd);
      return available.length === 1 ? available[0].licenseNumber : null;
    },
  );
  const [error, setError] = useState<RustMessage | null>(null);
  const [working, setWorking] = useState(false);

  async function submit() {
    if (!selected) return;
    setError(null);
    setWorking(true);
    const failed = await connect({ kind: "existing", licenseNumber: selected });
    // On success this screen is gone already.
    if (failed) {
      setError(failed);
      setWorking(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <div role="radiogroup" aria-label={t("setup.pick.title")} className="flex flex-col gap-2">
        {clinics.map((clinic) => (
          <ClinicOption
            key={clinic.licenseNumber}
            clinic={clinic}
            checked={selected === clinic.licenseNumber}
            disabled={working}
            onSelect={() => setSelected(clinic.licenseNumber)}
          />
        ))}
      </div>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{translateMessage(error)}</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-col gap-2 sm:flex-row">
        <Button className="sm:flex-1" onClick={submit} disabled={!selected || working}>
          {working && <LoaderCircleIcon className="animate-spin" />}
          {t(working ? "setup.pick.working" : "setup.pick.submit")}
        </Button>
        <Button variant="outline" className="sm:flex-1" onClick={onAdd} disabled={working}>
          <Building2Icon />
          {t("setup.pick.addNew")}
        </Button>
      </div>
    </div>
  );
}

interface ClinicOptionProps {
  clinic: MyClinic;
  checked: boolean;
  disabled: boolean;
  onSelect: () => void;
}

function ClinicOption({ clinic, checked, disabled, onSelect }: ClinicOptionProps) {
  const { t } = useTranslation();
  const formatDate = useFormatDate();
  const unavailable = !!clinic.cannotAdd;
  const place = [clinic.city, clinic.address].filter(Boolean).join(" · ");

  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      disabled={unavailable || disabled}
      onClick={onSelect}
      className={cn(
        "flex items-start gap-3 rounded-lg border p-3 text-start transition-colors outline-none",
        "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
        checked ? "border-primary bg-accent" : "hover:bg-accent/50",
        unavailable && "cursor-not-allowed opacity-70 hover:bg-transparent",
      )}
    >
      <span
        className={cn(
          "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border",
          checked && "border-primary bg-primary text-primary-foreground",
        )}
      >
        {checked && <CheckIcon className="size-3" />}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="font-medium">{clinic.name}</span>
        {place && <span className="text-sm text-muted-foreground">{place}</span>}
        <span className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span>
            {t("setup.clinics.license")} <bdi dir="ltr">{clinic.licenseNumber}</bdi>
          </span>
          {!clinic.isOwner && <span>{t("setup.clinics.owner", { owner: clinic.ownerFullName })}</span>}
          {clinic.maxInstallations > 0 && (
            <span>
              {t("setup.clinics.devices", { count: clinic.installationCount, max: clinic.maxInstallations })}
            </span>
          )}
          <span>
            {clinic.subscriptionEndsAt
              ? t("setup.clinics.subscriptionUntil", { date: formatDate(clinic.subscriptionEndsAt * 1000) })
              : t("setup.clinics.noSubscription")}
          </span>
        </span>
        {clinic.cannotAdd && (
          <span className="flex items-start gap-1.5 text-xs text-destructive">
            <TriangleAlertIcon className="mt-px size-3.5 shrink-0" />
            {translateMessage(clinic.cannotAdd)}
          </span>
        )}
      </span>
    </button>
  );
}

interface NewClinicFormProps {
  setup: PendingSetup;
  connect: (target: SetupTarget) => Promise<RustMessage | null>;
  /** Back to the list of clinics, if there is one. */
  onBack?: () => void;
}

/** A new clinic, owned by the person setting up; this computer joins it. */
function NewClinicForm({ setup, connect, onBack }: NewClinicFormProps) {
  const { t } = useTranslation();
  const mine = setup.clinics;
  const [error, setError] = useState<RustMessage | null>(null);
  const {
    register,
    handleSubmit,
    control,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<ClinicValues>({
    // Old accounts without an identity on file give their identification code here.
    resolver: zodResolver(mine.identityOnFile ? clinicSchema : clinicWithIdentitySchema),
    defaultValues: {
      name: "",
      licenseNumber: "",
      phone: "",
      provinceId: "",
      cityId: "",
      address: "",
      postalCode: "",
      location: null,
      identityCode: "",
    },
  });

  // `values` are already checked and trimmed by the schema; the location is set.
  async function submit(values: ClinicValues) {
    setError(null);
    const { location, identityCode, provinceId: _province, cityId, ...clinic } = values;
    const target: SetupTarget = {
      kind: "new",
      clinic: { ...clinic, cityId: Number(cityId), latitude: location!.latitude, longitude: location!.longitude },
      ...(mine.identityOnFile ? {} : { identity: identityCode }),
    };
    const failed = await connect(target);
    if (failed) setError(failed);
  }

  // Registering never needs a subscription, but logging in to the clinic does.
  const noSubscription = !mine.subscriptionEndsAt;
  const overClinicLimit = !noSubscription && mine.ownedClinicCount >= mine.maxClinics;

  return (
    <form className="flex flex-col gap-6" onSubmit={handleSubmit(submit)} noValidate>
      {(noSubscription || overClinicLimit) && (
        <Alert variant="warning">
          <TriangleAlertIcon />
          <AlertDescription>
            {noSubscription
              ? t("setup.subscription.none")
              : t("setup.subscription.clinicLimit", { max: mine.maxClinics, count: mine.ownedClinicCount })}
          </AlertDescription>
        </Alert>
      )}

      <fieldset className="flex flex-col gap-4">
        <legend className="mb-4 text-sm font-semibold">{t("setup.clinic")}</legend>
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            id="clinic-name"
            label={t("setup.fields.clinicName")}
            error={fieldError(errors.name)}
            maxLength={200}
            autoFocus
            {...register("name")}
          />
          <FormField
            id="clinic-license-number"
            label={t("setup.fields.licenseNumber")}
            hint={t("setup.hints.licenseNumber")}
            error={fieldError(errors.licenseNumber)}
            maxLength={32}
            latin
            {...register("licenseNumber")}
          />
          <FormField
            id="clinic-phone"
            type="tel"
            label={t("setup.fields.clinicPhone")}
            error={fieldError(errors.phone)}
            autoComplete="tel"
            maxLength={16}
            latin
            {...register("phone")}
          />
          <FormField
            id="clinic-postal-code"
            label={t("setup.fields.postalCode")}
            error={fieldError(errors.postalCode)}
            autoComplete="postal-code"
            inputMode="numeric"
            maxLength={10}
            latin
            {...register("postalCode")}
          />
          <CityFields control={control} setValue={setValue} />
          <div className="sm:col-span-2">
            <FormField
              id="clinic-address"
              label={t("setup.fields.address")}
              error={fieldError(errors.address)}
              autoComplete="street-address"
              maxLength={500}
              {...register("address")}
            />
          </div>
          {!mine.identityOnFile && (
            <FormField
              id="clinic-owner-identity-code"
              label={t("setup.fields.identityCode")}
              hint={t("setup.hints.existingIdentityCode")}
              error={fieldError(errors.identityCode)}
              maxLength={24}
              latin
              {...register("identityCode")}
            />
          )}
          <div className="sm:col-span-2">
            <Controller
              control={control}
              name="location"
              render={({ field, fieldState }) => (
                <LocationPicker
                  id="clinic-location"
                  label={t("setup.fields.location")}
                  value={field.value}
                  onChange={field.onChange}
                  error={fieldError(fieldState.error)}
                />
              )}
            />
          </div>
        </div>
      </fieldset>

      {error && (
        <Alert variant="destructive">
          <AlertDescription>{translateMessage(error)}</AlertDescription>
        </Alert>
      )}

      <div className="flex flex-col gap-2 sm:flex-row">
        <Button type="submit" className="sm:flex-1" disabled={isSubmitting}>
          {isSubmitting && <LoaderCircleIcon className="animate-spin" />}
          {t(isSubmitting ? "setup.add.working" : "setup.add.submit")}
        </Button>
        {onBack && (
          <Button type="button" variant="outline" className="sm:flex-1" onClick={onBack} disabled={isSubmitting}>
            {t("setup.add.backToList")}
          </Button>
        )}
      </div>
    </form>
  );
}

/** Persian names, so Persian alphabetical order whatever the interface language. */
const nameOrder = new Intl.Collator("fa");

function sortByName(provinces: Province[]): Province[] {
  return provinces
    .map((province) => ({ ...province, cities: [...province.cities].sort((a, b) => nameOrder.compare(a.name, b.name)) }))
    .sort((a, b) => nameOrder.compare(a.name, b.name));
}

interface CityFieldsProps {
  control: Control<ClinicValues>;
  setValue: UseFormSetValue<ClinicValues>;
}

/**
 * The clinic's province, then one of its cities, from the server's list (official
 * Persian names). Different provinces may have cities of the same name.
 */
function CityFields({ control, setValue }: CityFieldsProps) {
  const { t } = useTranslation();
  const [provinces, setProvinces] = useState<Province[] | null>(null);
  const [error, setError] = useState<RustMessage | null>(null);
  // Changes on "retry", which loads the list again.
  const [attempt, setAttempt] = useState(0);
  const provinceId = useWatch({ control, name: "provinceId" });

  useEffect(() => {
    let current = true;
    setError(null);
    listCities().then(
      (list) => current && setProvinces(sortByName(list)),
      (e) => current && setError(toRustMessage(e)),
    );
    return () => {
      current = false;
    };
  }, [attempt]);

  if (error) {
    return (
      <div className="flex flex-col gap-2 sm:col-span-2">
        <Alert variant="destructive">
          <AlertDescription>{translateMessage(error)}</AlertDescription>
        </Alert>
        <Button type="button" variant="outline" onClick={() => setAttempt((n) => n + 1)}>
          <RefreshCwIcon />
          {t("auth.connection.retry")}
        </Button>
      </div>
    );
  }

  const loading = t("setup.placeholders.loading");
  const cities = provinces?.find((province) => String(province.id) === provinceId)?.cities ?? [];
  return (
    <>
      <Controller
        control={control}
        name="provinceId"
        render={({ field, fieldState }) => (
          <SelectField
            id="clinic-province"
            label={t("setup.fields.province")}
            placeholder={provinces ? t("setup.placeholders.province") : loading}
            error={fieldError(fieldState.error)}
            disabled={!provinces}
            options={(provinces ?? []).map((province) => ({ value: String(province.id), label: province.name }))}
            value={field.value}
            onValueChange={(value) => {
              field.onChange(value);
              // The city belongs to the province.
              setValue("cityId", "");
            }}
            triggerRef={field.ref}
          />
        )}
      />
      <Controller
        control={control}
        name="cityId"
        render={({ field, fieldState }) => (
          <SelectField
            id="clinic-city"
            label={t("setup.fields.city")}
            placeholder={provinces ? t("setup.placeholders.city") : loading}
            error={fieldError(fieldState.error)}
            disabled={!provinceId}
            options={cities.map((city) => ({ value: String(city.id), label: city.name }))}
            value={field.value}
            onValueChange={field.onChange}
            triggerRef={field.ref}
          />
        )}
      />
    </>
  );
}
