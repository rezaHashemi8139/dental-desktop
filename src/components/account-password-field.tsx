import type { ComponentProps } from "react";
import { useTranslation } from "react-i18next";
import { MAX_WRONG_PASSWORDS } from "@/lib/backup";
import { FormField } from "@/components/form-field";

type AccountPasswordFieldProps = Omit<ComponentProps<typeof FormField>, "label" | "hint" | "type" | "latin">;

/**
 * The user's own account password, asked for by every database action ("is it
 * really you?"), last in the form, just above the submit button. Rust checks it.
 */
export function AccountPasswordField(props: AccountPasswordFieldProps) {
  const { t } = useTranslation();
  return (
    <div className="border-t pt-4">
      <FormField
        type="password"
        label={t("identity.fields.accountPassword")}
        hint={t("identity.hint", { max: MAX_WRONG_PASSWORDS })}
        autoComplete="current-password"
        latin
        {...props}
      />
    </div>
  );
}
