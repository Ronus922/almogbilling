// The flat button set of /portal/login, shared by the code step and the three
// windows that sit on top of it (ref/OTP States.html). Kept in one module so a
// sheet and the card behind it can never drift into two different buttons.

export const BTN = 'flex h-[54px] w-full items-center justify-center gap-[10px] rounded-[14px] border-[1.5px] border-transparent text-[17px] font-bold transition-colors min-[601px]:h-[48px] min-[601px]:rounded-[11px] min-[601px]:text-[16px]';
export const BTN_ON = 'bg-brand text-white hover:bg-[#2C44E0]';
export const BTN_DIS = 'bg-[#DCE2FF] text-white cursor-default';
export const BTN_OK = 'bg-[#12A150] text-white cursor-default';
export const BTN_SEC = 'border-[#E2E8F0] bg-white text-[#0F172A] hover:bg-[#F5F7FB]';
export const BTN_GHOST = 'flex h-[44px] w-full items-center justify-center rounded-[14px] text-[15px] font-semibold text-brand transition-colors hover:bg-[#F5F7FB]';
export const LINK = '-my-[12px] inline-flex min-h-[44px] items-center font-semibold text-brand transition-colors hover:text-[#2B3FB8] hover:underline disabled:pointer-events-none disabled:opacity-50';
