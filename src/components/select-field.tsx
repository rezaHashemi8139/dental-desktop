import type { Ref } from "react";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export interface SelectFieldProps {
  id: string;
  label: string;
  placeholder: string;
  error: string | null;
  disabled?: boolean;
  options: { value: string; label: string }[];
  value: string;
  onValueChange: (value: string) => void;
  /** For react-hook-form, to focus the field with an error. */
  triggerRef?: Ref<HTMLButtonElement>;
}

/** A labelled list to pick from, laid out like FormField. */
export function SelectField({ id, label, placeholder, error, disabled, options, value, onValueChange, triggerRef }: SelectFieldProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label htmlFor={id} className="mb-1">
        {label}
      </Label>
      <Select value={value} onValueChange={onValueChange} disabled={disabled}>
        <SelectTrigger
          id={id}
          ref={triggerRef}
          aria-invalid={!!error}
          aria-describedby={error ? `${id}-error` : undefined}
        >
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {error && (
        <p id={`${id}-error`} className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
