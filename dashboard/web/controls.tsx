import type { ComponentProps } from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";
import { clsx } from "clsx";
import { ChevronDownIcon } from "lucide-react";

const buttonVariants = cva("control-button", {
  variants: { variant: { default: "control-primary", outline: "control-outline" } },
  defaultVariants: { variant: "default" },
});

export function Button({ className, variant, asChild = false, ...props }:
  ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Control = asChild ? Slot : "button";
  return <Control data-slot="button" data-variant={variant} className={buttonVariants({ variant, className })} {...props} />;
}

export function NativeSelect({ className, ...props }: ComponentProps<"select">) {
  return <div className="control-select" data-slot="native-select-wrapper">
    <select data-slot="native-select" className={clsx("control-input", className)} {...props} />
    <ChevronDownIcon data-slot="native-select-icon" aria-hidden="true" />
  </div>;
}
