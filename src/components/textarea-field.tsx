import type { ComponentProps } from "react";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

interface TextareaFieldProps extends ComponentProps<typeof Textarea> {
  id: string;
  label: string;
  hint?: string;
  error?: string | null;
}

/** A labelled multi-line input, laid out like FormField. */
export function TextareaField({ id, label, hint, error, ...textareaProps }: TextareaFieldProps) {
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="mb-1">
        {label}
      </Label>
      <Textarea id={id} aria-invalid={!!error} aria-describedby={describedBy} {...textareaProps} />
      {error ? (
        <p id={`${id}-error`} className="text-xs text-destructive">
          {error}
        </p>
      ) : (
        hint && (
          <p id={`${id}-hint`} className="text-xs text-muted-foreground">
            {hint}
          </p>
        )
      )}
    </div>
  );
}
