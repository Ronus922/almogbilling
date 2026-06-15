import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

// Flat button system (מערכת כפתורים שטוחה) — see DESIGN.md "כפתורים / Buttons".
// Fully flat: no gradients, no shadows, no hover-lift. Solid fills, color-only
// hover transitions, Heebo, RTL. Mirrors src/app/styles/buttons.css (.btn-*);
// implemented here on Tailwind utilities so call-site className overrides merge
// predictably via tailwind-merge. Brand hexes come from the @theme skin tokens
// (bg-brand #3D5AFE, bg-brand-dark #2C44E0, brand-soft/-border/-text, ink, line-strong)
// which already equal the spec values.
const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center whitespace-nowrap select-none border-[1.5px] border-transparent font-bold leading-none transition-[background-color,border-color,color] duration-150 outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand active:brightness-[0.96] disabled:pointer-events-none disabled:opacity-50 aria-disabled:pointer-events-none aria-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        // Primary — solid brand.
        default: "bg-brand text-white hover:bg-brand-dark",
        // Secondary — white, strong line border. `outline` is an alias.
        secondary:
          "bg-white border-line-strong text-ink hover:bg-row-hover hover:border-ink-ghost aria-expanded:bg-row-hover",
        outline:
          "bg-white border-line-strong text-ink hover:bg-row-hover hover:border-ink-ghost aria-expanded:bg-row-hover",
        // Approve — solid green.
        approve: "bg-[#16a34a] text-white hover:bg-[#0f9040]",
        // New folder — soft brand tint.
        newfolder:
          "bg-brand-soft border-brand-border text-brand-text hover:bg-[#e0e6ff] hover:border-brand",
        // Delete — soft (white with red border/text).
        delete:
          "bg-white border-[#f8d2d3] text-[#b01b20] hover:bg-[#feefef] hover:border-[#e5484d] hover:text-[#c9353a]",
        // Destructive — solid red (delete · solid).
        destructive: "bg-[#e5484d] text-white hover:bg-[#c9353a]",
        // Ghost — transparent, muted ink.
        ghost: "bg-transparent text-ink-2 hover:bg-row-hover hover:text-ink aria-expanded:bg-row-hover",
        // Link — inline text, no chrome.
        link: "h-auto border-transparent bg-transparent px-0 text-brand underline-offset-4 hover:underline",
      },
      size: {
        // 44px regular · 36px sm · 52px lg · 44/36px icon. Radius 11/9/13.
        default: "h-11 gap-[9px] rounded-[11px] px-[22px] text-[14.5px]",
        xs: "h-7 gap-1.5 rounded-[9px] px-3 text-[13px] [&_svg:not([class*='size-'])]:size-3.5",
        sm: "h-9 gap-[7px] rounded-[9px] px-4 text-[13px]",
        lg: "h-[52px] gap-[11px] rounded-[13px] px-7 text-[16px]",
        icon: "size-11 gap-0 rounded-[11px] px-0",
        "icon-xs": "size-7 gap-0 rounded-[9px] px-0 [&_svg:not([class*='size-'])]:size-3.5",
        "icon-sm": "size-9 gap-0 rounded-[9px] px-0",
        "icon-lg": "size-[52px] gap-0 rounded-[13px] px-0",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
