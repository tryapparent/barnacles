import type { ComponentProps } from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

const buttonVariants = cva("control-button", {
  variants: { variant: { default: "control-primary", outline: "control-outline" } },
  defaultVariants: { variant: "default" },
});

export function Button({ className, variant, asChild = false, ...props }:
  ComponentProps<"button"> & VariantProps<typeof buttonVariants> & { asChild?: boolean }) {
  const Control = asChild ? Slot : "button";
  return <Control data-slot="button" data-variant={variant} className={buttonVariants({ variant, className })} {...props} />;
}

export function Badge({ className, ...props }: ComponentProps<"span">) {
  return <span data-slot="badge" className={className} {...props} />;
}
