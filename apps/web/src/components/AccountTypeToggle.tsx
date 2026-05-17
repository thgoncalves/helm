import { type ReactNode } from "react";
import { cn } from "@/lib/utils";

export type AccountType = "personal" | "business";

interface AccountTypeToggleProps {
  value: AccountType;
  onChange: (value: AccountType) => void;
}

/**
 * Pill-shaped segmented control for choosing between Personal and Business.
 * Selected option carries a green outline; unselected sits flush.
 */
export function AccountTypeToggle({
  value,
  onChange,
}: AccountTypeToggleProps) {
  return (
    <div
      role="tablist"
      aria-label="Account type"
      className="inline-flex items-center gap-1 rounded-full bg-muted p-1"
    >
      <ToggleButton
        active={value === "personal"}
        onClick={() => onChange("personal")}
      >
        Personal
      </ToggleButton>
      <ToggleButton
        active={value === "business"}
        onClick={() => onChange("business")}
      >
        Business
      </ToggleButton>
    </div>
  );
}

function ToggleButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={cn(
        "rounded-full border-2 px-6 py-2 text-sm font-semibold transition-colors",
        active
          ? "border-green-600 bg-background text-foreground"
          : "border-transparent text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}
