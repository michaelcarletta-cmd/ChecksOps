import * as React from "react";
import { Slot } from "@radix-ui/react-slot";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "@/lib/utils";

const defaultButtonStyles =
  "!border !border-[hsl(var(--button-light-border))] !bg-[hsl(var(--button-light-bg))] !text-[hsl(var(--button-light-foreground))] hover:!bg-[hsl(var(--button-light-hover))] hover:!text-[hsl(var(--button-light-foreground))] shadow-sm hover:shadow";

const darkButtonStyles =
  "!border !border-[hsl(var(--button-dark-border))] !bg-[hsl(var(--button-dark-bg))] !text-[hsl(var(--button-dark-foreground))] hover:!bg-[hsl(var(--button-dark-hover))] hover:!text-[hsl(var(--button-dark-foreground))]";

const ghostButtonStyles =
  "!border !border-transparent !bg-transparent !text-foreground hover:!bg-[hsl(var(--button-dark-hover))] hover:!text-foreground";

const destructiveButtonStyles =
  "!border !border-[hsl(var(--destructive))] !bg-[hsl(var(--destructive))] !text-[hsl(var(--destructive-foreground))] hover:opacity-90";

const successButtonStyles =
  "!border !border-[hsl(var(--success))] !bg-[hsl(var(--success))] !text-[hsl(var(--success-foreground))] hover:opacity-90 shadow-[0_4px_14px_-4px_hsl(var(--success)/0.4)]";

const buttonVariants = cva(
  "inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium ring-offset-background transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
  {
    variants: {
      variant: {
        default: defaultButtonStyles,
        destructive: destructiveButtonStyles,
        success: successButtonStyles,
        outline: darkButtonStyles,
        secondary: darkButtonStyles,
        ghost: ghostButtonStyles,
        link: "!border-transparent !bg-transparent !text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-10 px-4 py-2",
        sm: "h-9 rounded-md px-3",
        lg: "h-11 rounded-md px-8",
        icon: "h-10 w-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
);

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean;
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    const Comp = asChild ? Slot : "button";
    return <Comp className={cn(buttonVariants({ variant, size, className }))} ref={ref} {...props} />;
  },
);
Button.displayName = "Button";

export { Button, buttonVariants };
