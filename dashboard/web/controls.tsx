import type { ComponentProps, ReactNode } from "react";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
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

export const Tabs = TabsPrimitive.Root;
export const TabsContent = TabsPrimitive.Content;

export function TabsList({ className, ...props }: ComponentProps<typeof TabsPrimitive.List>) {
  return <TabsPrimitive.List data-slot="tabs-list" className={clsx("control-tabs", className)} {...props} />;
}

export function TabsTrigger({ className, ...props }: ComponentProps<typeof TabsPrimitive.Trigger>) {
  return <TabsPrimitive.Trigger data-slot="tabs-trigger" className={clsx("control-tab", className)} {...props} />;
}

export const TooltipProvider = TooltipPrimitive.Provider;
export const Tooltip = TooltipPrimitive.Root;
export const TooltipTrigger = TooltipPrimitive.Trigger;

export function TooltipContent({ className, sideOffset = 6, ...props }: ComponentProps<typeof TooltipPrimitive.Content>) {
  return <TooltipPrimitive.Portal>
    <TooltipPrimitive.Content data-slot="tooltip-content" sideOffset={sideOffset} collisionPadding={8} className={clsx("control-tooltip", className)} {...props} />
  </TooltipPrimitive.Portal>;
}

export function Tip({ label, children }: { label: ReactNode; children: ReactNode }) {
  return <Tooltip><TooltipTrigger asChild>{children}</TooltipTrigger>
    <TooltipContent side="bottom">{label}</TooltipContent></Tooltip>;
}
