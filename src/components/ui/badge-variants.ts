import { cva } from "class-variance-authority";

export const badgeVariants = cva(
  "inline-flex items-center justify-center min-h-[1.5rem] rounded-full border px-2.5 py-0.5 text-xs font-semibold leading-[var(--app-badge-line-height,1.35)] transition-colors focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 select-none",
  {
    variants: {
      variant: {
        default: "border-transparent bg-primary text-primary-foreground hover:bg-primary/80",
        secondary: "border-transparent bg-secondary text-secondary-foreground hover:bg-secondary/80",
        destructive: "border-transparent bg-destructive text-destructive-foreground hover:bg-destructive/80",
        outline: "text-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  },
);

