"use client"

import { Switch as SwitchPrimitive } from "@base-ui/react/switch"

import { cn } from "@/lib/utils"

function Switch({
  className,
  size = "default",
  ...props
}: SwitchPrimitive.Root.Props & { size?: "default" | "lg" }) {
  const isLg = size === "lg"
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer inline-flex shrink-0 cursor-pointer items-center rounded-full border border-transparent bg-slate-300 outline-none transition-colors focus-visible:ring-3 focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50 data-checked:bg-blue-600",
        isLg ? "h-[30px] w-[52px]" : "h-5 w-9",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className={cn(
          "pointer-events-none block rounded-full bg-white shadow-sm ring-0 transition-transform",
          isLg
            ? "h-6 w-6 translate-x-[3px] data-checked:translate-x-[25px] rtl:-translate-x-[3px] rtl:data-checked:-translate-x-[25px]"
            : "h-4 w-4 translate-x-0.5 data-checked:translate-x-[18px] rtl:-translate-x-0.5 rtl:data-checked:-translate-x-[18px]"
        )}
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
