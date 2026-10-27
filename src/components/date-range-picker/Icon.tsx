/**
 * Icon — אייקוני הרכיב כ-SVG inline (גאומטריית Material Symbols Outlined, viewBox 0 -960 960 960).
 * בלי פונט אייקונים: אין צורך לטעון Material Symbols. הגודל לפי font-size (1em), הצבע currentColor.
 */
const PATHS = {
  calendar_month:
    'M200-80q-33 0-56.5-23.5T120-160v-560q0-33 23.5-56.5T200-800h40v-80h80v80h320v-80h80v80h40q33 0 56.5 23.5T840-720v560q0 33-23.5 56.5T760-80H200Zm0-80h560v-400H200v400Zm0-480h560v-80H200v80Zm0 0v-80 80Z',
  expand_more: 'M480-345 240-585l56-56 184 184 184-184 56 56-240 240Z',
  expand_less: 'm296-345-56-56 240-240 240 240-56 56-184-184-184 184Z',
  bedtime:
    'M484-80q-84 0-157.5-32t-128-86.5Q144-253 112-326.5T80-484q0-146 93-257.5T410-880q-18 99 11 193.5T521-521q71 71 165.5 100T880-410q-26 144-138 237T484-80Zm0-80q88 0 163-44t118-121q-86-8-163-43.5T464-465q-61-61-97-138t-43-163q-77 43-120.5 118.5T160-484q0 135 94.5 229.5T484-160Zm-20-305Z',
  chevron_right: 'M504-480 320-664l56-56 240 240-240 240-56-56 184-184Z',
  chevron_left: 'M560-240 320-480l240-240 56 56-184 184 184 184-56 56Z',
  close:
    'm256-200-56-56 224-224-224-224 56-56 224 224 224-224 56 56-224 224 224 224-56 56-224-224-224 224Z',
  add: 'M440-440H200v-80h240v-240h80v240h240v80H520v240h-80v-240Z',
  remove: 'M200-440v-80h560v80H200Z',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, className }: { name: IconName; className?: string }) {
  return (
    <svg
      className={className ? `drp-mi ${className}` : 'drp-mi'}
      width="1em"
      height="1em"
      viewBox="0 -960 960 960"
      fill="currentColor"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
