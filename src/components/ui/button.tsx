import { Slot } from "@radix-ui/react-slot";
import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/utils";

type ButtonVariant = "primary" | "secondary" | "ghost";
type ButtonSize = "default" | "icon";

const baseClasses = "soniq-button inline-flex min-h-9 items-center justify-center gap-2 rounded-lg px-3.5 py-2 text-sm font-semibold outline-none transition-transform duration-100 ease-out active:scale-[0.97] disabled:pointer-events-none disabled:opacity-45 focus-visible:ring-2 focus-visible:ring-[color:var(--focus-ring)] focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--window)]";
const variantClasses: Record<ButtonVariant, string> = {
  primary: "bg-[var(--button-primary)] text-[var(--button-primary-foreground)] hover:bg-[var(--button-primary-hover)]",
  secondary: "bg-[var(--button-secondary)] text-[var(--foreground)] hover:bg-[var(--button-secondary-hover)]",
  ghost: "min-h-8 px-2.5 py-1.5 text-[var(--secondary-label)] hover:bg-[var(--control-fill)] hover:text-[var(--foreground)]",
};
const sizeClasses: Record<ButtonSize, string> = {
  default: "",
  icon: "size-9 p-0",
};

function buttonVariants({ variant = "primary", size = "default" }: { variant?: ButtonVariant; size?: ButtonSize } = {}) {
  return cn(baseClasses, variantClasses[variant], sizeClasses[size]);
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  asChild?: boolean;
  children: ReactNode;
  size?: ButtonSize;
  variant?: ButtonVariant;
};

function Button({ className, variant, size, asChild = false, ...props }: ButtonProps) {
  const Comp = asChild ? Slot : "button";
  return <Comp className={cn(buttonVariants({ variant, size }), className)} {...props} />;
}

export { Button, buttonVariants };
