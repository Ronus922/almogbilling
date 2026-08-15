# אייקון המערכת — כיוון A · מגדל

## הקבצים
| קובץ | שימוש |
|---|---|
| `favicon.svg` | favicon מודרני (רדיוס 7px, גאומטריה מפושטת) |
| `favicon-16/32/48.png` | לאיחוד ל־`favicon.ico` |
| `icon-180.png` | `apple-touch-icon` (ללא שקיפות) |
| `icon-192.png` · `icon-512.png` | PWA manifest |
| `icon-maskable-512.png` | Android maskable — התוכן ב־68% מרכזי |
| `icon-rounded.svg` | אייקון מעוגל לשימוש בתוך הממשק |
| `mark-mono.svg` | סימן מונוכרום (`currentColor`) — הדפסה / רקע צבעוני |

## שני עוביים — חשוב
מעל 48px משתמשים בגאומטריה המלאה (חלונות + שקיפויות).
ב־32px ומטה בגאומטריה המפושטת (בלי חלונות, קווים עבים). אין להקטין את 512 ל־16.

## צבעים
גרדיאנט רקע `115deg #2B3FB8 → #3D5AFE 62% → #5872FF` · סימן לבן · חלונות `#3D5AFE`.

## הטמעה
```html
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/icon-180.png">
<link rel="manifest" href="/manifest.webmanifest">
```
```json
{ "icons": [
  { "src": "/icon-192.png", "sizes": "192x192", "type": "image/png" },
  { "src": "/icon-512.png", "sizes": "512x512", "type": "image/png" },
  { "src": "/icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" }
], "theme_color": "#3D5AFE", "background_color": "#EEF1F8" }
```
