מערכת ניהול דיירים וגבייה - Project Specification
> ⚠️ **REFERENCE ONLY — DO NOT IMPLEMENT FROM THIS FILE**
>
> זהו מפרט של האפליקציה הישנה ב-Base44 שממנה הפרויקט הנוכחי 
> מהגר. השתמש בקובץ כחומר עזר בלבד:
> - להבנת הלוגיקה העסקית (סעיף 6)
> - להבנת לקחים מהעבר (סעיף 11)
> - כתזכורת לשדות שייתכן ששכחנו להזכיר
>
> **אסור להעתיק ממנו ישירות**:
> - שמות טבלאות/שדות (ייתכן שנשנה)
> - מבני Entities (נבנה מחדש לפי החלטות חדשות)
> - Flows (נעצב מחדש)
>
> כל החלטה על המערכת החדשה נרשמת ב-PROJECT_CONTEXT.md 
> תחת Decisions Log. הקובץ הזה לא מהווה מקור סמכות.

---

[תוכן המסמך המקורי מתחיל כאן...]
## 1. Overview
מערכת ניהול דיירים וגבייה (Property and Debt Management System) היא פלטפורמת SaaS המיועדת לייעל ולנהל תהליכי גביית חובות, ניהול משימות, תקשורת עם דיירים וספקים, וארגון מסמכים עבור בנייני מגורים, משרדים ונכסים. האפליקציה מאפשרת למנהלי נכסים וחברות ניהול לנהל ביעילות את כלל הפעילות השוטפת מול הדיירים והנכס.

-   **מטרת האפליקציה**: לייעל את תהליכי הניהול של נכסים, לרבות מעקב וגביית חובות, ניהול משימות ותקלות, קביעת פגישות, תיעוד ותקשורת עם דיירים וספקים.
-   **קהל היעד**: מנהלי בניינים, חברות ניהול נכסים, בעלי נכסים וגורמי גבייה.
-   **הבעיה העסקית שהיא פותרת**: חוסר סדר וארגון בנתוני דיירים וחובות, תקשורת מפוזרת, קושי במעקב אחר משימות ותקלות, וצורך בפתרון מקיף לניהול נכסים תחת קורת גג אחת.
-   **שפה ראשית**: עברית (RTL)

## 2. User Roles & Permissions

המערכת מגדירה שלוש רמות תפקידים עיקריות בתוך האפליקציה, אשר קובעות את רמת הגישה וההרשאות של המשתמש:

-   **SUPER_ADMIN**: גישה מלאה לכלל הפונקציונליות והנתונים במערכת, כולל הגדרות מערכת וניהול משתמשים ותפקידים.
-   **ADMIN**: גישה מורחבת לרוב הפונקציונליות הניהולית והתפעולית. יכול לנהל דיירים, משימות, תקלות, אך ייתכן שמוגבל בשינוי הגדרות מערכת קריטיות או ניהול תפקידים.
-   **VIEWER**: גישת צפייה בלבד, עם אפשרות לבצע פעולות מוגבלות (לדוגמה: יצירת תקלות, צפייה במשימות ששויכו אליו).

**Permissions Matrix:**

| Role          | AppUser | Role | Contact | DebtorRecord | Status | LegalStatus | LegalStatusHistory | ImportRun | Comment | Task | WhatsAppTemplate | Notification | ChatMessage | Appointment | CalendarEvent | CalendarEventParticipant | Settings |
|:--------------|:--------|:-----|:--------|:-------------|:-------|:------------|:-------------------|:----------|:--------|:-----|:-----------------|:-------------|:------------|:------------|:--------------|:-------------------------|:---------|
| SUPER_ADMIN   | CRUD    | CRUD | CRUD    | CRUD         | CRUD   | CRUD        | CRUD               | CRUD      | CRUD    | CRUD | CRUD             | CRUD         | CRUD        | CRUD        | CRUD          | CRUD                     | CRUD     |
| ADMIN         | R       | R    | CRUD    | CRUD         | R      | R           | CR                 | CR        | CRUD    | CRUD | CRUD             | CRUD         | CRUD        | CRUD        | CRUD          | CRUD                     | R        |
| VIEWER        | R       | R    | R       | R            | R      | R           | R                  | R         | C       | R    | R                | R            | R           | R           | R             | R                        | R        |

**הסבר לטבלה:**
-   **C**: Create (יצירה)
-   **R**: Read (קריאה)
-   **U**: Update (עדכון)
-   **D**: Delete (מחיקה)
-   **פעולות מיוחדות**:
    -   **ADMIN**: יכול ליצור ולעדכן היסטוריית סטטוסים משפטיים (`LegalStatusHistory`), לייבא נתונים (`ImportRun`), ליצור תגובות (`Comment`), ליצור ולעדכן תבניות וואטסאפ (`WhatsAppTemplate`).
    -   **VIEWER**: יכול ליצור תגובות (`Comment`) ומשימות (`Task`), להגיש דוחות תקלות (`IssueReport`), לצפות ביומן ובאירועים.

**הרשאת רשומות (Row-Level Security):**
-   משתמשים יכולים לראות את כל הרשומות באופן כללי, למעט מקרים ספציפיים שבהם רשומות משויכות למשתמש (לדוגמה, התראות (`Notification`) או משימות (`Task`) ששויכו ספציפית למשתמש).
-   `AuthContext` מכיל את `accessiblePages` שמגדיר רשימת דפים ספציפיים אליהם המשתמש יכול לגשת. אם `accessiblePages` הוא `null`, המשתמש בעל גישה מלאה (לדוגמה, `SUPER_ADMIN` או `ADMIN` עם `is_admin: true` ב-`RoleData`).

## 3. Data Model

### Entity: AppUser
משתמש המערכת, מנוהל בנפרד מהמשתמשים של פלטפורמת Base44.
| Field         | Type     | Required | Default   | Notes                                     |
|:--------------|:---------|:---------|:----------|:------------------------------------------|
| id            | string   | yes      | (auto)    | מזהה רשומה ייחודית                        |
| created_date  | datetime | yes      | (auto)    | תאריך יצירת הרשומה                        |
| updated_date  | datetime | yes      | (auto)    | תאריך עדכון אחרון לרשומה                  |
| created_by    | string   | yes      | (auto)    | אימייל המשתמש שיצר את הרשומה             |
| first_name    | string   | yes      |           | שם פרטי                                   |
| last_name     | string   | no       |           | שם משפחה                                  |
| username      | string   | yes      |           | שם משתמש (באנגלית בלבד), ייחודי          |
| email         | email    | no       |           | כתובת דוא"ל                               |
| password_hash | string   | yes      |           | סיסמה מוצפנת (ב-base64)                   |
| role          | enum     | yes      | "VIEWER"  | תפקיד מערכת: "SUPER_ADMIN", "ADMIN", "VIEWER" |
| role_id       | reference| no       |           | מזהה תפקיד מותאם אישית (FK -> Role.id)    |
| department    | string   | no       |           | מחלקה                                     |
| is_active     | boolean  | no       | true      | האם המשתמש פעיל                           |
| base44_user_invited | boolean | no  | false     | האם הוזמן למערכת Base44                  |

### Entity: Role
הגדרות תפקידים מותאמות אישית, המשמשות להגדרת הרשאות granular בתוך האפליקציה.
| Field           | Type     | Required | Default                | Notes                                     |
|:----------------|:---------|:---------|:-----------------------|:------------------------------------------|
| id              | string   | yes      | (auto)                 | מזהה רשומה ייחודית                        |
| created_date    | datetime | yes      | (auto)                 | תאריך יצירת הרשומה                        |
| updated_date    | datetime | yes      | (auto)                 | תאריך עדכון אחרון לרשומה                  |
| created_by      | string   | yes      | (auto)                 | אימייל המשתמש שיצר את הרשומה             |
| name            | string   | yes      |                        | שם התפקיד                                 |
| description     | string   | no       |                        | תיאור התפקיד                              |
| color           | enum     | no       | "blue"                 | צבע התפקיד בממשק: "blue", "green", "purple", "orange", "red", "pink", "yellow", "indigo" |
| accessible_pages| array    | no       | []                     | רשימת דפים נגישים לתפקיד זה              |
| can_edit_records| boolean  | no       | false                  | האם יכול לערוך רשומות קיימות              |
| can_add_records | boolean  | no       | false                  | האם יכול להוסיף רשומות חדשות              |
| can_delete_records| boolean| no       | false                  | האם יכול למחוק רשומות                    |
| is_admin        | boolean  | no       | false                  | האם תפקיד זה מקבל הרשאות מנהל מלאות      |
| active          | boolean  | no       | true                   | האם התפקיד פעיל                           |

### Entity: Contact
רישום מפורט של פרטי יצירת קשר לדייר או לבעל דירה.
| Field                     | Type       | Required | Default       | Notes                                     |
|:--------------------------|:-----------|:---------|:--------------|:------------------------------------------|
| id                        | string     | yes      | (auto)        | מזהה רשומה ייחודית                        |
| created_date              | datetime   | yes      | (auto)        | תאריך יצירת הרשומה                        |
| updated_date              | datetime   | yes      | (auto)        | תאריך עדכון אחרון לרשומה                  |
| created_by                | string     | yes      | (auto)        | אימייל המשתמש שיצר את הרשומה             |
| apartment_number          | string     | yes      |               | מספר דירה (ייחודי)                         |
| owner_name                | string     | no       |               | שם בעל הדירה                              |
| owner_phone               | string     | no       |               | טלפון בעל הדירה                           |
| owner_email               | string     | no       |               | מייל בעל הדירה                            |
| tenant_name               | string     | no       |               | שם השוכר                                  |
| tenant_phone              | string     | no       |               | טלפון השוכר                               |
| tenant_email              | string     | no       |               | מייל השוכר                                |
| contact_type              | enum       | no       |               | סוג איש קשר ראשי (legacy): "owner", "tenant", "both" |
| resident_type             | enum       | no       | "owner"       | מי גר בדירה בפועל: "owner", "tenant", "operator" |
| operator_id               | reference  | no       |               | מזהה המפעיל המשויך לדירה (FK -> Operator.id) |
| owner_is_primary_contact  | boolean    | no       | true          | בעל דירה מקבל הודעות                    |
| tenant_is_primary_contact | boolean    | no       | false         | שוכר מקבל הודעות                          |
| operator_is_primary_contact | boolean  | no       | false         | מפעיל מקבל הודעות                        |
| address                   | string     | no       |               | כתובת מגורים (אופציונלי)                  |
| notes                     | string     | no       |               | הערות                                     |
| management_fees           | number     | no       |               | דמי ניהול (ייבוא בלבד, לקריאה בלבד)     |
| tags                      | array      | no       |               | תגיות לסינון                               |
| whatsapp_profile_image    | string     | no       |               | URL לתמונת פרופיל ווטסאפ (של איש הקשר)  |
| whatsapp_profile_image_url| string     | no       |               | URL לתמונת פרופיל ווטסאפ (מסונכרן מ-Green API) |
| whatsapp_profile_sync_status| enum     | no       |               | סטטוס סנכרון תמונת פרופיל ווטסאפ: "pending", "synced", "no_avatar", "unavailable", "failed" |
| whatsapp_profile_last_synced_at | datetime | no    |               | זמן סנכרון אחרון של תמונת פרופיל        |
| whatsapp_profile_sync_error | string   | no       |               | הודעת שגיאה אם סנכרון נכשל             |
| last_whatsapp_sent_at     | datetime   | no       |               | תאריך שליחת הודעת ווטסאפ אחרונה         |

### Entity: DebtorRecord
רישום חובות מפורט לכל דירה, כולל סטטוסים אוטומטיים וידניים.
| Field                     | Type       | Required | Default         | Notes                                     |
|:--------------------------|:-----------|:---------|:----------------|:------------------------------------------|
| id                        | string     | yes      | (auto)          | מזהה רשומה ייחודית                        |
| created_date              | datetime   | yes      | (auto)          | תאריך יצירת הרשומה                        |
| updated_date              | datetime   | yes      | (auto)          | תאריך עדכון אחרון לרשומה                  |
| created_by                | string     | yes      | (auto)          | אימייל המשתמש שיצר את הרשומה             |
| apartment_number          | string     | yes      |                 | מספר דירה (ייחודי)                         |
| owner_name                | string     | no       |                 | שם בעלים                                  |
| phone_owner               | string     | no       |                 | טלפון בעל דירה                            |
| phone_tenant              | string     | no       |                 | טלפון שוכר                                |
| phone_primary             | string     | no       |                 | טלפון ראשי להצגה (או בעל דירה או שוכר) |
| phones_raw                | string     | no       |                 | טלפונים גולמיים מקובץ האקסל              |
| phones_manual_override    | boolean    | no       | false           | האם טלפונים עודכנו ידנית                 |
| total_debt                | number     | no       |                 | סה"כ חוב                                  |
| monthly_debt              | number     | no       |                 | חוב חודשי (דמי ניהול)                     |
| special_debt              | number     | no       |                 | חוב מיוחד (לדוגמה, מים חמים)             |
| details_monthly           | string     | no       |                 | פרטים חודשיים (לדוגמה, חודשים שבהם צובר חוב) |
| details_special           | string     | no       |                 | פרטים מיוחדים                             |
| management_months_raw     | string     | no       |                 | דמי ניהול לחודשים (גולמי מעמודה F באקסל) |
| months_in_arrears         | number     | no       |                 | חודשי פיגור                               |
| debt_status_auto          | enum       | no       | "תקין"          | סטטוס חוב אוטומטי: "תקין", "לגבייה מיידית", "חריגה מופרזת" |
| legal_status_id           | reference  | no       |                 | מזהה סטטוס משפטי מקושר (FK -> Status.id) |
| legal_status_overridden   | boolean    | no       | false           | האם הסטטוס המשפטי שונה ידנית             |
| legal_status_updated_at   | datetime   | no       |                 | מתי הסטטוס המשפטי עודכן לאחרונה         |
| legal_status_updated_by   | string     | no       |                 | מי עדכן את הסטטוס המשפטי (user email/id) |
| legal_status_source       | enum       | no       | "AUTO_DEFAULT"  | מקור עדכון סטטוס משפטי: "AUTO_DEFAULT", "MANUAL", "IMPORT", "SYSTEM_FIX" |
| legal_status_lock         | boolean    | no       | false           | נעילה מפני דריסה בייבוא - true = ידני, לא לדרוס |
| legal_status_manual       | string     | no       |                 | מצב משפטי ידני - טקסט חופשי (Deprecated) |
| notes                     | string     | no       |                 | הערות                                     |
| last_contact_date         | date       | no       |                 | תאריך קשר אחרון                           |
| next_action_date          | date       | no       |                 | תאריך פעולה הבאה                          |
| imported_this_run         | boolean    | no       | false           | האם הרשומה יובאה בריצה הנוכחית           |
| last_import_run_id        | reference  | no       |                 | מזהה ריצת ייבוא אחרונה (FK -> ImportRun.id) |
| last_import_at            | datetime   | no       |                 | תאריך וזמן ייבוא אחרון                   |
| flagged_as_cleared        | boolean    | no       | false           | דגל: הרשומה אופסה כי לא הופיעה בקובץ החדש |
| cleared_at                | datetime   | no       |                 | תאריך וזמן איפוס חוב                    |
| source_row_hash           | string     | no       |                 | Hash של נתוני המקור לזיהוי שינויים        |
| is_archived               | boolean    | no       | false           | האם הרשומה בארכיון                       |

### Entity: Settings
הגדרות כלליות עבור המערכת כולה.
| Field                         | Type       | Required | Default               | Notes                                     |
|:------------------------------|:-----------|:---------|:----------------------|:------------------------------------------|
| id                            | string     | yes      | (auto)                | מזהה רשומה ייחודית                        |
| created_date                  | datetime   | yes      | (auto)                | תאריך יצירת הרשומה                        |
| updated_date                  | datetime   | yes      | (auto)                | תאריך עדכון אחרון לרשומה                  |
| created_by                    | string     | yes      | (auto)                | אימייל המשתמש שיצר את הרשומה             |
| threshold_ok_max              | number     | no       | 1000                  | סף חוב תקין מקסימלי (עד סכום זה החוב תקין) |
| threshold_collect_from        | number     | no       | 1500                  | סף חוב לגבייה מיידית (מעל סכום זה)       |
| threshold_legal_from          | number     | no       | 5000                  | סף חוב לטיפול משפטי (מעל סכום זה)        |
| make_enabled                  | boolean    | no       | false                 | חיבור MAKE פעיל                          |
| make_webhook_status_change_url| string     | no       |                       | URL לשינוי סטטוס ב-MAKE                  |
| make_webhook_new_lawsuit_candidate_url| string | no |                       | URL למועמד לתביעה חדשה ב-MAKE           |
| make_webhook_new_record_url   | string     | no       |                       | URL לרשומה חדשה ב-MAKE                   |
| building_name                 | string     | no       | "בניין אלמוג"         | שם הבניין                                 |
| building_address              | string     | no       | "דוד אלעזר 10, חיפה" | כתובת הבניין                             |
| last_import_at                | datetime   | no       |                       | תאריך ושעת ייבוא אחרון                   |
| green_api_instance_id         | string     | no       |                       | Green API Instance ID לשליחת WhatsApp  |
| green_api_token               | string     | no       |                       | Green API Token לשליחת WhatsApp          |
| resend_api_key                | string     | no       |                       | מפתח API של Resend לשליחת מיילים        |
| gmail_sender_email            | string     | no       | "ronen.yeadim@gmail.com" | כתובת המייל לשליחת הודעות מערכת (Gmail) |

### Entity: Status
הגדרות סטטוסים כלליים או משפטיים עבור רשומות שונות.
| Field             | Type     | Required | Default                  | Notes                                     |
|:------------------|:---------|:---------|:-------------------------|:------------------------------------------|
| id                | string   | yes      | (auto)                   | מזהה רשומה ייחודית                        |
| created_date      | datetime | yes      | (auto)                   | תאריך יצירת הרשומה                        |
| updated_date      | datetime | yes      | (auto)                   | תאריך עדכון אחרון לרשומה                  |
| created_by        | string   | yes      | (auto)                   | אימייל המשתמש שיצר את הרשומה             |
| name              | string   | yes      |                          | שם הסטטוס                                 |
| type              | enum     | yes      | "GENERAL"                | סוג הסטטוס: "LEGAL", "GENERAL"            |
| description       | string   | no       |                          | תיאור הסטטוס                              |
| color             | string   | no       | "bg-slate-100 text-slate-700" | צבע התגית (Tailwind class)                |
| is_active         | boolean  | no       | true                     | האם הסטטוס פעיל                           |
| is_default        | boolean  | no       | false                    | סטטוס ברירת מחדל (רק אחד מסוג LEGAL)    |
| notification_emails| string  | no       |                          | כתובות אימייל לשליחת התראות (מופרדות בפסיקים) |

### Entity: LegalStatus
הגדרת מצבים משפטיים ייעודיים (ייתכן ש-Status מסוג LEGAL מחליף את זה).
| Field       | Type     | Required | Default               | Notes                                     |
|:------------|:---------|:---------|:----------------------|:------------------------------------------|
| id          | string   | yes      | (auto)                | מזהה רשומה ייחודית                        |
| created_date| datetime | yes      | (auto)                | תאריך יצירת הרשומה                        |
| updated_date| datetime | yes      | (auto)                | תאריך עדכון אחרון לרשומה                  |
| created_by  | string   | yes      | (auto)                | אימייל המשתמש שיצר את הרשומה             |
| name        | string   | yes      |                       | שם המצב המשפטי                           |
| description | string   | no       |                       | תיאור המצב המשפטי                         |
| color       | string   | no       | "bg-slate-100 text-slate-700" | צבע התגית (Tailwind class)                |
| order       | number   | no       | 0                     | סדר תצוגה                                 |
| is_active   | boolean  | no       | true                  | מצב משפטי פעיל                            |

### Entity: LegalStatusHistory
מעקב אחר שינויים בסטטוס המשפטי של רשומת חוב.
| Field               | Type       | Required | Default         | Notes                                     |
|:--------------------|:-----------|:---------|:----------------|:------------------------------------------|
| id                  | string     | yes      | (auto)          | מזהה רשומה ייחודית                        |
| created_date        | datetime   | yes      | (auto)          | תאריך יצירת הרשומה                        |
| updated_date        | datetime   | yes      | (auto)          | תאריך עדכון אחרון לרשומה                  |
| created_by          | string     | yes      | (auto)          | אימייל המשתמש שיצר את הרשומה             |
| debtor_record_id    | reference  | yes      |                 | מזהה רשומת החייב (FK -> DebtorRecord.id) |
| apartment_number    | string     | no       |                 | מספר דירה (לנוחות תצוגה)                   |
| old_status_id       | reference  | no       |                 | סטטוס משפטי קודם (FK -> Status.id)        |
| old_status_name     | string     | no       |                 | שם הסטטוס הקודם (לנוחות תצוגה)             |
| new_status_id       | reference  | yes      |                 | סטטוס משפטי חדש (FK -> Status.id)         |
| new_status_name     | string     | no       |                 | שם הסטטוס החדש (לנוחות תצוגה)             |
| changed_at          | datetime   | yes      |                 | תאריך ושעת השינוי                         |
| changed_by          | string     | no       |                 | מי ביצע את השינוי (user email/id)        |
| source              | enum       | yes      | "MANUAL"        | מקור השינוי: "AUTO_DEFAULT", "MANUAL", "IMPORT", "SYSTEM_FIX" |
| notes               | string     | no       |                 | הערות נוספות על השינוי                   |

### Entity: ImportRun
תיעוד של כל ריצת ייבוא נתונים למערכת.
| Field             | Type       | Required | Default      | Notes                                     |
|:------------------|:-----------|:---------|:-------------|:------------------------------------------|
| id                | string     | yes      | (auto)       | מזהה רשומה ייחודית                       |
| created_date      | datetime   | yes      | (auto)       | תאריך יצירת הרשומה                       |
| updated_date      | datetime   | yes      | (auto)       | תאריך עדכון אחרון לרשומה                 |
| created_by        | string     | yes      | (auto)       | אימייל המשתמש שיצר את הרשומה            |
| import_run_id     | string     | yes      |              | מזהה ייחודי לריצת ייבוא                 |
| file_name         | string     | no       |              | שם קובץ האקסל המיובא                      |
| started_at        | datetime   | yes      |              | זמן התחלה                                 |
| finished_at       | datetime   | no       |              | זמן סיום                                  |
| status            | enum       | yes      | "RUNNING"    | סטטוס הריצה: "RUNNING", "SUCCESS", "PARTIAL", "FAILED" |
| stage             | string     | no       |              | שלב נוכחי: READ_EXCEL / VALIDATION / UPSERT / POST_PROCESS / QA / COMPLETE |
| total_rows_read   | number     | no       | 0            | סה"כ שורות שנקראו מהקובץ                 |
| unique_apartments | number     | no       | 0            | מספר דירות ייחודיות                      |
| success_rows_count| number     | no       | 0            | שורות שעובדו בהצלחה                       |
| created_count     | number     | no       | 0            | רשומות חדשות שנוצרו                       |
| updated_count     | number     | no       | 0            | רשומות שעודכנו                            |
| failed_rows_count | number     | no       | 0            | שורות שנכשלו                             |
| skipped_rows_count| number     | no       | 0            | שורות שדולגו (ריקודות)                   |
| cleared_count     | number     | no       | 0            | דירות שאופסו (לא בקובץ)                 |
| invalid_monthly_count| number  | no       | 0            | ערכי דמי ניהול לא תקינים                 |
| invalid_special_count| number  | no       | 0            | ערכי מים חמים לא תקינים                  |
| error_summary     | string     | no       |              | תיאור קצר של השגיאות                      |
| error_details     | array      | no       |              | רשימת שגיאות מפורטת (rowIndex, apartmentNumber, errorType, errorMessage) |
| qa_validation     | boolean    | no       |              | האם עבר ולידציית QA                      |
| qa_delta          | number     | no       |              | פער בסכומים (QA)                         |
| import_mode       | enum       | no       |              | מצב ייבוא: "fill_missing", "reset"      |

### Entity: Comment
הערות כלליות המשויכות לרשומת חייב.
| Field           | Type     | Required | Default | Notes                                     |
|:----------------|:---------|:---------|:--------|:------------------------------------------|
| id              | string   | yes      | (auto)  | מזהה רשומה ייחודית                        |
| created_date    | datetime | yes      | (auto)  | תאריך יצירת הרשומה                        |
| updated_date    | datetime | yes      | (auto)  | תאריך עדכון אחרון לרשומה                  |
| created_by      | string   | yes      | (auto)  | אימייל המשתמש שיצר את הרשומה             |
| debtor_record_id| reference| yes      |         | מזהה רשומת החייב (FK -> DebtorRecord.id) |
| apartment_number| string   | no       |         | מספר דירה (לנוחות תצוגה)                   |
| content         | string   | yes      |         | תוכן ההערה                                |
| author_name     | string   | yes      |         | שם המשתמש שכתב את ההערה                  |
| author_email    | string   | no       |         | אימייל המשתמש                             |

### Entity: Task
משימה כללית לניהול עבודה.
| Field           | Type     | Required | Default       | Notes                                     |
|:----------------|:---------|:---------|:--------------|:------------------------------------------|
| id              | string   | yes      | (auto)        | מזהה רשומה ייחודית                        |
| created_date    | datetime | yes      | (auto)        | תאריך יצירת הרשומה                        |
| updated_date    | datetime | yes      | (auto)        | תאריך עדכון אחרון לרשומה                  |
| created_by      | string   | yes      | (auto)        | אימייל המשתמש שיצר את הרשומה             |
| title           | string   | yes      |               | כותרת המשימה                              |
| description     | string   | no       |               | תיאור המשימה                              |
| target_type     | enum     | yes      | "room"        | סוג היעד: "room", "area"                  |
| target_id       | string   | yes      |               | מזהה היעד (דירה או אזור)                   |
| priority        | enum     | yes      | "low"         | דחיפות המשימה: "low", "high", "urgent"    |
| status          | enum     | yes      | "open"        | סטטוס המשימה: "open", "in_progress", "resolved" |
| reporter_email  | string   | no       |               | דוא"ל המשתמש שדיווח על המשימה             |
| assigned_to     | string   | no       |               | שמות משתמשים שהוקצתה להם המשימה (מופרדים בפסיק) |
| images          | array    | no       | []            | URLs של תמונות מצורפות                  |
| videos          | array    | no       | []            | URLs של סרטונים מצורפים                  |
| notes           | string   | no       |               | הערות                                     |
| history         | array    | no       | []            | היסטוריה של שינויים במשימה               |

### Entity: WhatsAppTemplate
תבניות הודעות WhatsApp לשימוש חוזר.
| Field   | Type     | Required | Default | Notes                                     |
|:--------|:---------|:---------|:--------|:------------------------------------------|
| id      | string   | yes      | (auto)  | מזהה רשומה ייחודית                       |
| created_date| datetime | yes    | (auto)  | תאריך יצירת הרשומה                       |
| updated_date| datetime | yes    | (auto)  | תאריך עדכון אחרון לרשומה                 |
| created_by | string   | yes    | (auto)  | אימייל המשתמש שיצר את הרשומה            |
| name    | string   | yes      |         | שם התבנית                                |
| content | string   | yes      |         | תוכן התבנית, תומך במשתנים {{name}} ו-{{debt}} |

### Entity: Notification
הודעות והתראות הנשלחות למשתמשים.
| Field             | Type     | Required | Default    | Notes                                     |
|:------------------|:---------|:---------|:-----------|:------------------------------------------|
| id                | string   | yes      | (auto)     | מזהה רשומה ייחודית                       |
| created_date      | datetime | yes      | (auto)     | תאריך יצירת הרשומה                       |
| updated_date      | datetime | yes      | (auto)     | תאריך עדכון אחרון לרשומה                 |
| created_by        | string   | yes      | (auto)     | אימייל המשתמש שיצר את הרשומה            |
| user_username     | string   | yes      |            | שם המשתמש שאמור לקבל את ההתראה         |
| type              | enum     | yes      |            | סוג ההתראה (לדוגמה: "task_assigned", "whatsapp_message_received") |
| title             | string   | no       |            | כותרת קצרה של ההתראה                     |
| message           | string   | yes      |            | תוכן ההתראה                               |
| is_read           | boolean  | no       | false      | האם ההתראה נקראה                        |
| source_module     | enum     | no       |            | המודול שממנו נוצרה ההתראה: "tasks", "calendar", "whatsapp", "issues", "internal_chat" |
| source_entity_type| string   | no       |            | סוג הרשומה המקורית (Task, ChatMessage...) |
| source_entity_id  | string   | no       |            | מזהה הרשומה המקורית                      |
| action_url        | string   | no       |            | URL לניווט בלחיצה על ההתראה             |
| priority          | enum     | no       | "normal"   | עדיפות ההתראה: "low", "normal", "high", "urgent" |
| dedupe_key        | string   | no       |            | מפתח למניעת כפילויות. פורמט: type:entity_id:user[:date] |
| task_id           | string   | no       |            | מזהה משימה ישנה (לתיאום לאחור)          |
| task_pro_id       | string   | no       |            | מזהה TaskPro (לתיאום לאחור)             |
| task_type         | string   | no       |            | סוג משימה (legacy)                       |
| assigner_name     | string   | no       |            | שם המקצה                                  |

### Entity: ChatMessage
הודעות צ'אט (ווטסאפ או פנימיות).
| Field             | Type       | Required | Default    | Notes                                     |
|:------------------|:-----------|:---------|:-----------|:------------------------------------------|
| id                | string     | yes      | (auto)     | מזהה רשומה ייחודית                       |
| created_date      | datetime   | yes      | (auto)     | תאריך יצירת הרשומה                       |
| updated_date      | datetime   | yes      | (auto)     | תאריך עדכון אחרון לרשומה                 |
| created_by        | string     | yes      | (auto)     | אימייל המשתמש שיצר את הרשומה            |
| contact_id        | reference  | no       |            | ID של איש הקשר המשויך (FK -> Contact.id). ריק אם unlinked. |
| contact_phone     | string     | yes      |            | מספר טלפון של השולח/נמען                  |
| sender_chat_id    | string     | no       |            | chatId מ-Green API (לדוגמה: 972501234567@c.us) |
| sender_phone_raw  | string     | no       |            | מספר טלפון גולמי כפי שהגיע מ-Green API   |
| external_message_id| string    | no       |            | idMessage מ-Green API (מזהה ייחודי להודעה בחוץ) |
| link_status       | enum       | no       | "linked"   | האם ההודעה משויכת ל-Contact קיים: "linked", "unlinked" |
| direction         | enum       | yes      |            | כיוון ההודעה: "sent", "received"          |
| message_type      | enum       | yes      |            | סוג ההודעה: "text", "image", "document"   |
| content           | string     | no       |            | תוכן ההודעה (טקסט או URL לקובץ)          |
| timestamp         | datetime   | yes      |            | זמן ההודעה                                |

### Entity: Appointment
פגישות ואירועים ביומן.
| Field                | Type       | Required | Default         | Notes                                     |
|:---------------------|:-----------|:---------|:----------------|:------------------------------------------|
| id                   | string     | yes      | (auto)          | מזהה רשומה ייחודית                       |
| created_date         | datetime   | yes      | (auto)          | תאריך יצירת הרשומה                       |
| updated_date         | datetime   | yes      | (auto)          | תאריך עדכון אחרון לרשומה                 |
| created_by           | string     | yes      | (auto)          | אימייל המשתמש שיצר את הרשומה            |
| title                | string     | yes      |                 | כותרת הפגישה/משימה                       |
| appointment_type     | enum       | no       | "פגישה"         | סוג הפגישה: "פגישה", "משימה", "אחר"      |
| attendees_users      | array      | no       |                 | רשימת משתתפים (אובייקטים {id, name, email}) |
| attendees_contacts   | array      | no       |                 | רשימת ID של אנשי קשר משתתפים             |
| date                 | date       | yes      |                 | תאריך הפגישה                              |
| start_time           | string     | yes      |                 | שעת התחלה (לדוגמה, "10:00")              |
| start_datetime       | datetime   | no       |                 | תאריך ושעה מלאים של ההתחלה               |
| end_time             | string     | yes      |                 | שעת סיום (לדוגמה, "11:00")                |
| end_datetime         | datetime   | no       |                 | תאריך ושעה מלאים של הסיום                |
| is_recurring         | boolean    | no       | false           | האם זהו אירוע חוזר                        |
| recurrence_pattern   | enum       | no       |                 | תדירות החזרה: "יומי", "שבועי", "חודשי", "שנתי" |
| recurrence_interval  | integer    | no       | 1               | כל כמה יחידות זמן (לדוגמה, כל 2 שבועות) |
| recurrence_count     | integer    | no       |                 | מספר חזרות (מספר המופעים הכולל)          |
| series_id            | string     | no       |                 | מזהה הסדרה החוזרת - משותף לכל המופעים בסדרה |
| series_occurrence_number| integer | no       |                 | מספר סידורי בסדרה החוזרת (1, 2, 3 וכו') |
| is_exception         | boolean    | no       | false           | האם אירוע זה הוא עריכה/חריגה מהסדרה     |
| location             | string     | no       |                 | מיקום הפגישה                              |
| reminder_before      | enum       | no       |                 | זמן התזכורת לפני: "15m", "30m", "1h", "1d" |
| reminder_method      | enum       | no       | "email"         | אופן שליחת התזכורת: "email", "sms", "whatsapp", "none" |
| event_color          | string     | no       |                 | קוד צבע לאירוע (לדוגמה, #FF6B6B)         |
| description          | string     | no       |                 | תיאור האירוע                             |
| attachments          | array      | no       |                 | רשימת URL לקבצים מצורפים                 |

### Entity: CalendarEvent
אירועים כלליים בלוח השנה. דומה ל-Appointment אך עם סוגי שדות מעט שונים.
| Field               | Type       | Required | Default         | Notes                                     |
|:--------------------|:-----------|:---------|:----------------|:------------------------------------------|
| id                  | string     | yes      | (auto)          | מזהה רשומה ייחודית                       |
| created_date        | datetime   | yes      | (auto)          | תאריך יצירת הרשומה                       |
| updated_date        | datetime   | yes      | (auto)          | תאריך עדכון אחרון לרשומה                 |
| created_by          | string     | yes      | (auto)          | אימייל המשתמש שיצר את הרשומה            |
| title               | string     | yes      |                 | כותרת הפגישה/אירוע                       |
| item_kind           | enum       | no       | "meeting"       | סוג הפריט: "meeting", "event"             |
| meeting_type        | string     | no       |                 | סוג הפגישה                                |
| event_date          | date       | yes      |                 | תאריך האירוע                             |
| start_datetime      | datetime   | no       |                 | תאריך ושעת התחלה מלאים                   |
| end_datetime        | datetime   | no       |                 | תאריך ושעת סיום מלאים                     |
| is_all_day          | boolean    | no       | false           | האם זהו אירוע כל היום                     |
| location            | string     | no       |                 | מיקום האירוע                             |
| reminder_offset_minutes| integer | no       |                 | דקות לפני האירוע לתזכורת                 |
| reminder_channel    | enum       | no       | "none"          | ערוץ תזכורת: "sms", "email", "whatsapp", "none" |
| color_key           | string     | no       |                 | מפתח צבע מהפלטפורמה                      |
| description         | string     | no       |                 | תיאור מפורט                              |
| recurrence_enabled  | boolean    | no       | false           | האם האירוע חוזר                          |
| recurrence_type     | enum       | no       |                 | סוג החזרה: "weekly", "monthly", "yearly" |
| recurrence_interval | integer    | no       | 1               | כל כמה יחידות                           |
| recurrence_end_type | enum       | no       | "never"         | מתי מסתיימת החזרה: "never", "until_date", "count" |
| recurrence_until_date| date      | no       |                 | תאריך סיום החזרה                        |
| recurrence_count    | integer    | no       |                 | מספר חזרות                              |
| parent_series_id    | string     | no       |                 | מזהה סדרת האב החוזרת                     |
| source_type         | enum       | no       | "manual"        | מקור יצירה: "manual", "generated_occurrence" |
| status              | enum       | no       | "scheduled"     | סטטוס אירוע: "scheduled", "completed", "cancelled" |
| owner_user_id       | string     | no       |                 | מזהה המשתמש הבעלים                       |
| owner_user_name     | string     | no       |                 | שם המשתמש הבעלים                         |

### Entity: CalendarEventParticipant
משתתפים באירועי לוח שנה.
| Field               | Type     | Required | Default    | Notes                                     |
|:--------------------|:---------|:---------|:-----------|:------------------------------------------|
| id                  | string   | yes      | (auto)     | מזהה רשומה ייחודית                       |
| created_date        | datetime | yes      | (auto)     | תאריך יצירת הרשומה                       |
| updated_date        | datetime | yes      | (auto)     | תאריך עדכון אחרון לרשומה                 |
| created_by          | string   | yes      | (auto)     | אימייל המשתמש שיצר את הרשומה            |
| calendar_event_id   | reference| yes      |            | מזהה האירוע (FK -> CalendarEvent.id)    |
| participant_source  | enum     | yes      |            | סוג המשתתף: "user", "resident", "supplier" |
| participant_id      | string   | yes      |            | מזהה המשתתף (ID של User, Contact, Supplier) |
| display_name_cache  | string   | no       |            | שם להצגה (לנוחות תצוגה)                   |
| email_cache         | string   | no       |            | דוא"ל (לנוחות תצוגה)                       |
| phone_cache         | string   | no       |            | טלפון (לנוחות תצוגה)                      |
| attendance_status   | enum     | no       | "pending"  | סטטוס הגעה: "pending", "accepted", "declined", "tentative" |

### Other Referenced Entities (Schemas not fully detailed in context):
-   `AppSettings` (הגדרות אפליקציה כלליות)
-   `CalendarHoliday` (חגים בלוח השנה)
-   `DocumentFolder` (תיקיות מסמכים)
-   `DocumentFile` (קבצי מסמכים)
-   `DocumentPermission` (הרשאות למסמכים)
-   `DocumentLink` (קישורי מסמכים)
-   `MeetingType` (סוגי פגישות)
-   `Supplier` (ספקים)
-   `SupplierCategory` (קטגוריות ספקים)
-   `SupplierDocument` (מסמכי ספקים)
-   `Operator` (מפעילים)
-   `TodoCategory` (קטגוריות למשימות לביצוע)
-   `TodoItem` (פריטי משימה לביצוע)
-   `TodoComment` (הערות למשימות לביצוע)
-   `TaskRecurrenceRule` (כללי חזרה למשימות)
-   `TaskReminder` (תזכורות למשימות)
-   `TaskComment` (הערות למשימות)
-   `TaskActivity` (פעילויות במשימות)
-   `BroadcastCampaign` (קמפיינים המוניים)
-   `BroadcastRecipient` (נמעני קמפיינים)
-   `TaskPro` (משימות מתקדמות)
-   `TaskProAttendee` (משתתפי משימות מתקדמות)
-   `TaskProComment` (הערות למשימות מתקדמות)
-   `TaskProAttachment` (קבצים מצורפים למשימות מתקדמות)
-   `TaskProActivity` (פעילויות במשימות מתקדמות)
-   `TaskProReminder` (תזכורות למשימות מתקדמות)
-   `TaskProRecurrenceRule` (כללי חזרה למשימות מתקדמות)
-   `TaskProTemplate` (תבניות למשימות מתקדמות)
-   `TaskProSavedView` (תצוגות שמורות למשימות מתקדמות)
-   `InternalMessage` (הודעות פנימיות)
-   `InternalConversation` (שיחות פנימיות)
-   `DebtSnapshot` (תמונת מצב חובות)
-   `IssueReport` (דוחות תקלות)
-   `Area` (אזורים בבניין)

**Indexes and Uniqueness:**
-   `AppUser.username`: Unique index.
-   `Contact.apartment_number`: Unique index.
-   `DebtorRecord.apartment_number`: Unique index.
-   לא הוגדרו אינדקסים וייחודיות נוספים באופן מפורש בקונטקסט.

**Validation Rules:**
-   `AppUser.email`: פורמט אימייל תקין.
-   `DebtorRecord.total_debt`, `monthly_debt`, `special_debt`: חייבים להיות מספרים.
-   `WhatsAppTemplate.content`: תומך במשתני {{name}} ו-{{debt}}.
-   `Task.priority`, `status`: ערכים מוגדרים מראש.
-   `Appointment.date`, `start_time`, `end_time`: פורמט תאריך ושעה תקין.
-   סף חובות ב-`Settings` (`threshold_ok_max`, `threshold_collect_from`, `threshold_legal_from`): חייבים להיות מספרים חיוביים ולקיים סדר הגיוני (ok < collect < legal).

## 4. Pages & Routes

### Page: AppLogin
-   **Route**: `/AppLogin` (ומפנה אוטומטית ל-`/` אם אין משתמש)
-   **מטרה**: מסך התחברות למערכת, או הרשמה ראשונית של מנהל מערכת אם אין משתמשים קיימים.
-   **גישה**: פתוח לכולם (לפני אימות). אם המשתמש הוא מפתח Base44, הוא מקבל גישה אוטומטית לדאשבורד.
-   **Components עיקריים**: טופס התחברות (שם משתמש, סיסמה), כפתור התחברות. במצב Setup: טופס הרשמת מנהל (שם מלא, אימייל, סיסמה).
-   **אילו דפים ניתן לנווט מכאן**: לאחר התחברות מוצלחת, ניווט לדף הראשי (Dashboard).

### Page: Dashboard
-   **Route**: `/` (דף הבית הראשי של המערכת)
-   **מטרה**: הצגת סיכום מצב החובות, משימות, התראות וסטטוסים משפטיים של דירות. נקודת כניסה לניהול חייבים.
-   **גישה**: `SUPER_ADMIN`, `ADMIN`, `VIEWER` (בהתאם להרשאות).
-   **Entities מוצגים/נערכים**: `DebtorRecord`, `Settings`, `Status`, `LegalStatus`.
-   **Components עיקריים**:
    -   `KPICards`: כרטיסי סיכום סטטיסטיקות (סה"כ חובות, מספר דירות בסטטוסים שונים).
    -   `LastImportIndicator`: חיווי על מועד הייבוא האחרון עם כפתורי סנכרון/ייבוא.
    -   `DebtorsTable`: טבלה אינטראקטיבית עם פילטרים, חיפוש, ומיון לרשומות חייבים.
    -   `ApartmentDetailModal`: מודל מפורט להצגה ועריכה של פרטי דירה וחובות.
    -   `NotificationBell`: פעמון התראות.
-   **אילו דפים ניתן לנווט מכאן**: `DebtorHistory`, `Import`, `ExportData`, `ApartmentDetailModal` (popup), `WhatsAppChat`, `StatusManagement`.

### Page: Contacts
-   **Route**: `/Contacts`
-   **מטרה**: ניהול רשימת אנשי הקשר (דיירים, בעלי דירות, שוכרים).
-   **גישה**: `SUPER_ADMIN`, `ADMIN`, `VIEWER`.
-   **Entities מוצגים/נערכים**: `Contact`, `DebtorRecord`.
-   **Components עיקריים**: טבלה להצגת אנשי קשר, טופס יצירה/עריכה של איש קשר.
-   **אילו דפים ניתן לנווט מכאן**: `WhatsAppChat` (פתיחת צ'אט עם איש קשר).

### Page: WhatsAppChat
-   **Route**: `/WhatsAppChat`
-   **מטרה**: ממשק צ'אט לניהול הודעות WhatsApp עם אנשי הקשר.
-   **גישה**: `SUPER_ADMIN`, `ADMIN`, `VIEWER`.
-   **Entities מוצגים/נערכים**: `ChatMessage`, `Contact`, `WhatsAppTemplate`.
-   **Components עיקריים**: רשימת שיחות, חלון צ'אט, תיבת שליחת הודעה, תבניות הודעה מהירות.
-   **אילו דפים ניתן לנווט מכאן**: `Contact` (לפרטי איש הקשר).

### Page: Calendar
-   **Route**: `/Calendar`
-   **מטרה**: הצגת אירועים, פגישות ומשימות בלוח שנה.
-   **גישה**: `SUPER_ADMIN`, `ADMIN`, `VIEWER`.
-   **Entities מוצגים/נערכים**: `Appointment`, `CalendarEvent`, `CalendarEventParticipant`.
-   **Components עיקריים**: לוח שנה חודשי/שבועי/יומי, מודל יצירה/עריכה של אירוע/פגישה.
-   **אילו דפים ניתן לנווט מכאן**: לא הוגדר ניווט לדפים אחרים, אך ניתן לפתוח מודלים לעריכת אירועים.

### Page: TasksPro
-   **Route**: `/TasksPro`
-   **מטרה**: ניהול משימות מתקדמות באמצעות לוח קנבן או רשימה.
-   **גישה**: `SUPER_ADMIN`, `ADMIN`, `VIEWER`.
-   **Entities מוצגים/נערכים**: `TaskPro`, `AppUser`, `Contact`, `TaskProAttachment`, `TaskProComment`.
-   **Components עיקריים**:
    -   `TaskProKanbanDnd`: לוח קנבן עם גרירה ושחרור לניהול סטטוסי משימות.
    -   `TaskProTable`: טבלת משימות.
    -   `TaskProFormDialog`: מודל ליצירה ועריכה של משימה.
    -   `TaskProDetailsDialog`: מודל להצגת פרטי משימה.
    -   `TaskProKpiBar`: סרגל KPIs למשימות.
-   **אילו דפים ניתן לנווט מכאן**: אין ניווט ישיר לדפים אחרים, אלא פעולות בתוך המודלים.

### Page: Documents
-   **Route**: `/Documents`
-   **מטרה**: אחסון וניהול מסמכים בתיקיות.
-   **גישה**: `SUPER_ADMIN`, `ADMIN`, `VIEWER`.
-   **Entities מוצגים/נערכים**: `DocumentFolder`, `DocumentFile`, `DocumentPermission`.
-   **Components עיקריים**: מנהל קבצים, אפשרות יצירה/עריכה/מחיקה של תיקיות וקבצים, העלאת קבצים.
-   **אילו דפים ניתן לנווט מכאן**: לא הוגדר.

### Page: Settings
-   **Route**: `/Settings`
-   **מטרה**: הגדרת פרמטרים גלובליים למערכת, כגון ספי חוב, פרטי בניין, מפתחות API לאינטגרציות.
-   **גישה**: `SUPER_ADMIN`, `ADMIN` (הרשאת קריאה בלבד).
-   **Entities מוצגים/נערכים**: `Settings`.
-   **Components עיקריים**: טופס הגדרות המכיל שדות קלט (Input, Checkbox, Select) עבור כל הגדרה.
-   **אילו דפים ניתן לנווט מכאן**: לא הוגדר.

### Page: Import
-   **Route**: `/Import`
-   **מטרה**: ייבוא נתוני חובות ודיירים מקובץ Excel.
-   **גישה**: `SUPER_ADMIN`, `ADMIN`.
-   **Entities מוצגים/נערכים**: `DebtorRecord`, `Contact`, `ImportRun`.
-   **Components עיקריים**: `ExcelImporter` (טופס בחירת קובץ, כפתור ייבוא, חיווי סטטוס ייבוא).
-   **אילו דפים ניתן לנווט מכאן**: `Dashboard`.

### Page: UsersManagement
-   **Route**: `/UsersManagement`
-   **מטרה**: ניהול משתמשי המערכת (`AppUser`), יצירה, עריכה ומחיקה.
-   **גישה**: `SUPER_ADMIN`, `ADMIN`.
-   **Entities מוצגים/נערכים**: `AppUser`, `Role`.
-   **Components עיקריים**: טבלת משתמשים, מודל יצירה/עריכה של משתמש.
-   **אילו דפים ניתן לנווט מכאן**: `RolesManagement`.

### Page: RolesManagement
-   **Route**: `/RolesManagement`
-   **מטרה**: ניהול תפקידי המערכת (`Role`), יצירה, עריכה ומחיקה, והגדרת הרשאות ספציפיות לכל תפקיד.
-   **גישה**: `SUPER_ADMIN`.
-   **Entities מוצגים/נערכים**: `Role`.
-   **Components עיקריים**: טבלת תפקידים, מודל יצירה/עריכה של תפקיד עם בחירת הרשאות ודפים נגישים.
-   **אילו דפים ניתן לנווט מכאן**: `UsersManagement`.

### Page: StatusManagement
-   **Route**: `/StatusManagement`
-   **מטרה**: ניהול סטטוסים משפטיים וכלליים.
-   **גישה**: `SUPER_ADMIN`, `ADMIN`.
-   **Entities מוצגים/נערכים**: `Status`, `LegalStatus`.
-   **Components עיקריים**: טבלאות סטטוסים, טופס יצירה/עריכה של סטטוס.
-   **אילו דפים ניתן לנווט מכאן**: לא הוגדר.

### Page: WhatsAppTemplates
-   **Route**: `/WhatsAppTemplates`
-   **מטרה**: יצירה וניהול של תבניות הודעות WhatsApp.
-   **גישה**: `SUPER_ADMIN`, `ADMIN`.
-   **Entities מוצגים/נערכים**: `WhatsAppTemplate`.
-   **Components עיקריים**: טבלת תבניות, טופס יצירה/עריכה של תבנית עם שדות משתנים.
-   **אילו דפים ניתן לנווט מכאן**: לא הוגדר.

### Page: ExportData
-   **Route**: `/ExportData`
-   **מטרה**: ייצוא נתונים מהמערכת בפורמטים שונים.
-   **גישה**: `SUPER_ADMIN`, `ADMIN`.
-   **Entities מוצגים/נערכים**: `DebtorRecord`, `Contact`.
-   **Components עיקריים**: `ExcelExporter` (בחירת שדות, פילטרים, כפתור ייצוא).
-   **אילו דפים ניתן לנווט מכאן**: לא הוגדר.

### Page: DebtorHistoryPage
-   **Route**: `/DebtorHistory`
-   **מטרה**: הצגת היסטוריית שינויים בסטטוסים המשפטיים של חייב ספציפי.
-   **גישה**: `SUPER_ADMIN`, `ADMIN`, `VIEWER`.
-   **Entities מוצגים/נערכים**: `LegalStatusHistory`, `DebtorRecord`, `Status`.
-   **Components עיקריים**: טבלת היסטוריה, פילטרים לפי חייב/דירה.
-   **אילו דפים ניתן לנווט מכאן**: לא הוגדר.

### Page: InternalChat
-   **Route**: `/InternalChat`
-   **מטרה**: צ'אט פנימי בין משתמשי המערכת.
-   **גישה**: `SUPER_ADMIN`, `ADMIN`, `VIEWER`.
-   **Entities מוצגים/נערכים**: `InternalConversation`, `InternalMessage`, `AppUser`.
-   **Components עיקריים**: רשימת שיחות, חלון צ'אט.
-   **אילו דפים ניתן לנווט מכאן**: לא הוגדר.

### Page: IssuesManagement
-   **Route**: `/IssuesManagement`
-   **מטרה**: ניהול ודיווח תקלות בבניין.
-   **גישה**: `SUPER_ADMIN`, `ADMIN`, `VIEWER` (דיווח תקלות).
-   **Entities מוצגים/נערכים**: `IssueReport`, `AppUser`, `Task`, `TaskAttachment`.
-   **Components עיקריים**: לוח קנבן לתקלות, טופס דיווח תקלה, מודל פרטי תקלה.
-   **אילו דפים ניתן לנווט מכאן**: לא הוגדר.

### Page: RoomsAreas
-   **Route**: `/RoomsAreas`
-   **מטרה**: ניהול הגדרות של חדרים/דירות ואזורים בבניין (לדוגמה, הקצאת משימות לאזור מסוים).
-   **גישה**: `SUPER_ADMIN`, `ADMIN`.
-   **Entities מוצגים/נערכים**: `Area`, `Contact`.
-   **Components עיקריים**: טבלת חדרים/אזורים, טופס עריכה.
-   **אילו דפים ניתן לנווט מכאן**: לא הוגדר.

### Page: SupplierManagement
-   **Route**: `/SupplierManagement`
-   **מטרה**: ניהול ספקים ושירותים.
-   **גישה**: `SUPER_ADMIN`, `ADMIN`.
-   **Entities מוצגים/נערכים**: `Supplier`, `SupplierCategory`, `SupplierDocument`.
-   **Components עיקריים**: טבלת ספקים, טופס יצירה/עריכה של ספק, ניהול קטגוריות.
-   **אילו דפים ניתן לנווט מכאן**: לא הוגדר.

### Page: TodoReminders
-   **Route**: `/TodoReminders`
-   **מטרה**: ניהול רשימת משימות לביצוע ותזכורות.
-   **גישה**: `SUPER_ADMIN`, `ADMIN`, `VIEWER`.
-   **Entities מוצגים/נערכים**: `TodoItem`, `TodoCategory`, `TodoComment`.
-   **Components עיקריים**: רשימת משימות, טופס יצירה/עריכה, ניהול קטגוריות.
-   **אילו דפים ניתן לנווט מכאן**: לא הוגדר.

### Page: TaskAnalyticsDashboard
-   **Route**: `/TaskAnalyticsDashboard`
-   **מטרה**: לוח מחוונים אנליטי המציג נתונים וסטטיסטיקות על משימות.
-   **גישה**: `SUPER_ADMIN`, `ADMIN`.
-   **Entities מוצגים/נערכים**: `Task`, `TaskPro`.
-   **Components עיקריים**: גרפים וטבלאות סיכום.
-   **אילו דפים ניתן לנווט מכאן**: לא הוגדר.

### Page: AllNotifications
-   **Route**: `/AllNotifications`
-   **מטרה**: הצגת כל ההתראות למשתמש בדף ייעודי.
-   **גישה**: `SUPER_ADMIN`, `ADMIN`, `VIEWER`.
-   **Entities מוצגים/נערכים**: `Notification`.
-   **Components עיקריים**: טבלת התראות עם פילטרים.
-   **אילו דפים ניתן לנווט מכאן**: דפי יעד של התראות (לדוגמה, דף משימה).

### Page: ReportIssue
-   **Route**: `/ReportIssue`
-   **מטרה**: טופס מהיר לדיווח תקלה חדשה.
-   **גישה**: `SUPER_ADMIN`, `ADMIN`, `VIEWER`.
-   **Entities מוצגים/נערכים**: `IssueReport`.
-   **Components עיקריים**: טופס דיווח תקלה עם אפשרות העלאת קבצים.
-   **אילו דפים ניתן לנווט מכאן**: לא הוגדר, כנראה חוזר לדף הקודם או מציג הודעת הצלחה.

### Page: TasksManagement (Task entity, not TaskPro)
-   **Route**: `/TasksManagement`
-   **מטרה**: ניהול משימות מהדור הקודם (Task entity).
-   **גישה**: `SUPER_ADMIN`, `ADMIN`, `VIEWER`.
-   **Entities מוצגים/נערכים**: `Task`, `Contact`.
-   **Components עיקריים**: טבלת משימות, טופס יצירה/עריכה של משימה.
-   **אילו דפים ניתן לנווט מכאן**: לא הוגדר.

## 5. User Flows

### Flow: ייבוא נתוני חובות ודיירים (מרכזי)
1.  **משתמש מסוג ADMIN/SUPER_ADMIN** לוחץ על פריט התפריט "ייבוא נתונים" כדי לנווט לדף `/Import`.
2.  **המערכת מציגה** את דף הייבוא, הכולל טופס להעלאת קובץ Excel וכפתור "ייבוא".
3.  המשתמש בוחר קובץ Excel ולוחץ על "ייבוא".
4.  **המערכת מבצעת** את הפעולות הבאות:
    -   **DB operation**:
        -   קריאת נתונים מקובץ ה-Excel.
        -   יצירה/עדכון של רשומות ב-`DebtorRecord` ו-`Contact` בהתבסס על מספר הדירה (אם קיים - עדכון, אם לא - יצירה).
        -   עדכון שדות כמו `last_import_at` ב-`Settings`.
        -   יצירת רשומת `ImportRun` לתיעוד תהליך הייבוא (סטטוס, כמות שורות, שגיאות).
    -   **Side effects**:
        -   חישוב אוטומטי של `debt_status_auto` עבור כל רשומת חייב חדשה/מעודכנת.
        -   לוגיקת deduplication עבור `DebtorRecord` (שמירה על הרשומה העדכנית ביותר לכל מספר דירה).
        -   איפוס חובות (clearing) לרשומות חייבים קיימות שלא נמצאו בקובץ המיובא, תוך תיעוד ב-`ImportRun.cleared_count`.
    -   **Validation**:
        -   בדיקת תקינות נתונים בשדות כספיים.
        -   זיהוי שורות עם נתונים חסרים או לא תקינים.
5.  **המערכת מציגה** סיכום של תהליך הייבוא (הצלחות, כשלונות, שגיאות ספציפיות) בדף הייבוא.
6.  **מעבר לדף**: המשתמש יכול לנווט חזרה ל-`Dashboard` כדי לראות את הנתונים המעודכנים.

### Flow: שינוי סטטוס משפטי של חייב
1.  **משתמש מסוג ADMIN/SUPER_ADMIN** מנווט לדף `Dashboard`, מאתר חייב בטבלה ולוחץ עליו כדי לפתוח את `ApartmentDetailModal`.
2.  **המערכת מציגה** את מודל פרטי הדירה, הכולל את הסטטוס המשפטי הנוכחי ושדה בחירה (Select) לשינוי הסטטוס.
3.  המשתמש בוחר סטטוס משפטי חדש מהרשימה.
4.  **המערכת מבצעת** את הפעולות הבאות:
    -   **DB operation**:
        -   עדכון השדה `legal_status_id` (וגם `legal_status_overridden`, `legal_status_updated_at`, `legal_status_updated_by`, `legal_status_source='MANUAL'`) ברשומת ה-`DebtorRecord` המתאימה.
        -   יצירת רשומה חדשה ב-`LegalStatusHistory` עם פרטי השינוי (סטטוס קודם, סטטוס חדש, מי ביצע, מתי, מקור "MANUAL").
    -   **Side effects**:
        -   אם הוגדר ב-`Settings.make_webhook_status_change_url`, נשלחת קריאת webhook ל-MAKE עם פרטי השינוי.
        -   אם לסטטוס החדש הוגדרו `notification_emails`, תישלח התראת מייל לכתובות אלו.
        -   (במערכת אחרת) ייתכן שתישלח התראה למשתמשים אחרים או שרשומות קשורות (כמו `Task`) יעודכנו.
5.  **המערכת מציגה** הודעת הצלחה ומרעננת את נתוני הטבלה ב-`Dashboard`.

### Flow: דיווח תקלה חדשה
1.  **משתמש מכל סוג** מנווט לדף `IssuesManagement` ולוחץ על כפתור "דווח תקלה".
2.  **המערכת מציגה** מודל דיווח תקלה, הכולל שדות כותרת, תיאור, קבצים מצורפים ואפשרות להקצאת משתמש (תלוי הרשאה).
3.  המשתמש ממלא את הפרטים, מצלם/מעלה תמונות או סרטונים, ומגיש את הטופס.
4.  **המערכת מבצעת** את הפעולות הבאות:
    -   **DB operation**:
        -   יצירת רשומה חדשה ב-`IssueReport`.
        -   יצירת רשומות `TaskAttachment` עבור קבצים שהועלו.
    -   **Side effects**:
        -   שליחת התראה (`Notification`) למשתמש שהוקצה למשימה, או למנהלים, על תקלה חדשה.
        -   (במערכת אחרת) ייתכן שתישלח הודעת מייל/WhatsApp רלוונטית.
5.  **המערכת מציגה** הודעת הצלחה ומוסיפה את התקלה ללוח הקנבן/רשימה בדף `IssuesManagement`.

**Edge Cases:**
-   **לוגין כ-Base44 Developer**: אם משתמש נכנס לאפליקציה מממשק Base44 כמפתח, המערכת מזהה אותו אוטומטית כ-`SUPER_ADMIN` ומעניקה גישה מלאה, תוך עקיפת מסך הלוגין המקומי.
-   **שגיאת 402 Payment Required בפונקציות Backend**: אם המנוי של האפליקציה ב-Base44 אינו תומך בפונקציות Backend (לדוגמה, בחבילה חינמית), קריאות לפונקציות כמו סנכרון נתונים או שליחת הודעות ייכשלו עם שגיאת 402, גם אם הקוד תקין בסביבת פיתוח מקומית.
-   **ניסיון ניווט לדף לא מורשה**: המערכת תפנה לדף הלוגין או תציג הודעת "אין הרשאה" באמצעות `PageGuard` אם למשתמש אין `accessiblePages` מתאים לדף המבוקש.

## 6. Business Logic & Rules

-   **חישוב סטטוס חוב אוטומטי (DebtorRecord.debt_status_auto)**:
    -   מבוסס על `DebtorRecord.total_debt` ו-`Settings` גלובליים:
        -   `debt_status_auto = "תקין"` אם `total_debt <= Settings.threshold_ok_max`
        -   `debt_status_auto = "לגבייה מיידית"` אם `Settings.threshold_ok_max < total_debt <= Settings.threshold_collect_from`
        -   `debt_status_auto = "חריגה מופרזת"` אם `total_debt > Settings.threshold_collect_from`
    -   הסטטוס האוטומטי משתנה רק אם `legal_status_lock` הוא `false`.
-   **היררכיית סטטוסים משפטיים**:
    -   סטטוסים משפטיים (`Status.type = 'LEGAL'`) יכולים להיות "מכתב התראה", "לטיפול משפטי", "בהליך משפטי".
    -   כאשר `DebtorRecord.total_debt` עובר את `Settings.threshold_legal_from`, הסטטוס המשפטי האוטומטי (אם לא ננעל ידנית) ישתנה ל"לטיפול משפטי".
-   **נעילת סטטוס משפטי (DebtorRecord.legal_status_lock)**:
    -   כאשר משתמש משנה ידנית את הסטטוס המשפטי (`legal_status_overridden = true` ו-`legal_status_source = 'MANUAL'`), השדה `legal_status_lock` מוגדר ל-`true` כדי למנוע דריסה אוטומטית על ידי ייבוא או חישובים אחרים.
-   **Deduplication בייבוא נתונים**:
    -   בעת ייבוא קובץ Excel, אם קיימות מספר רשומות עבור אותו `apartment_number`, רק הרשומה העדכנית ביותר (לפי `updated_date` או `created_date`) נשמרת. הרשומות הישנות נמחקות או מסומנות כארכיון.
-   **מכונת מצבים למשימות (Task.status)**:
    -   **open**: משימה נוצרה, ממתינה לטיפול.
    -   **in_progress**: משימה בטיפול.
    -   **resolved**: משימה נפתרה/הושלמה.
    -   **מעברים מורשים**: `open -> in_progress`, `in_progress -> resolved`, `open -> resolved`. אין מעברים מ-`resolved`.

-   **טריגרים ואוטומציות (Backend Functions, כרגע מושבתות בגלל המנוי)**:
    -   **whatsappWebhook**: מקבלת הודעות נכנסות מ-Green API, יוצרת רשומות `ChatMessage`, ומעדכנת `Contact.last_whatsapp_sent_at`.
    -   **sendWhatsApp**: שולחת הודעת WhatsApp לאיש קשר ספציפי.
    -   **pollGreenAPIMessages**: סורקת הודעות חדשות מ-Green API באופן יזום.
    -   **sendStatusChangeNotification**: נשלחת לאחר שינוי סטטוס משפטי ב-`DebtorRecord`, שולחת התראות (מיילים/וואטסאפ) למשתמשים מוגדרים או לכתובות אימייל המוגדרות בסטטוס.
    -   **syncWhatsAppProfileImages**: מסנכרנת תמונות פרופיל של אנשי קשר מ-WhatsApp.
    -   **sendAppointmentNotificationEmail/WhatsApp**: שולחת תזכורות לפגישות/אירועים.
    -   **checkDueDateNotifications**: בודקת תאריכי יעד למשימות ושולחת התראות.
    -   **inviteUserToBase44**: מזמינה משתמשים חדשים לפלטפורמת Base44 (לא `AppUser`).
    -   **syncHebrewHolidays**: מסנכרנת חגים עבריים ללוח השנה.
    -   **buildingAgent**: סוכן AI (לא פעיל כרגע) שמבצע פעולות שונות הקשורות לבניין.
    -   **createTaskNotification/createTaskProNotification**: יצירת התראות למשתמשים כאשר משויכות להם משימות.
    -   **importBuildingDebtReport**: ייבוא נתוני חובות (בטח נקרא מ-`Import` page).
    -   **syncContactToDebtorRecord**: מסנכרן נתוני קשר בין `Contact` ל-`DebtorRecord`.
-   **חוקי הרשאה ברמת רשומה (Row-Level)**: לא הוגדרו חוקי RLS מורכבים מעבר להרשאות לפי תפקיד ו-`accessiblePages`.

## 7. Integrations & External Services

-   **Green API (WhatsApp)**:
    -   **מטרה**: שליחה וקבלה של הודעות WhatsApp.
    -   **סוג אינטגרציה**: API חיצוני (דרך Green API webhook וקריאות API ישירות).
    -   **Authentication**: באמצעות `GREEN_API_INSTANCE_ID` ו-`GREEN_API_TOKEN` (שמורים כ-secrets).
    -   **שימוש**: `whatsappWebhook` (לקבלת הודעות נכנסות), `sendWhatsApp` (לשליחת הודעות יוצאות), `pollGreenAPIMessages` (לסריקת הודעות), `syncWhatsAppProfileImages` (לסנכרון תמונות פרופיל).
-   **Bllink**:
    -   **מטרה**: ייבוא נתוני חובות.
    -   **סוג אינטגרציה**: API חיצוני (כנראה קריאת REST או קובץ).
    -   **Authentication**: באמצעות `BLLINK_USERNAME` ו-`BLLINK_PASSWORD` (שמורים כ-secrets).
    -   **שימוש**: `importBuildingDebtReport` (לייבוא נתונים).
-   **MAKE (formerly Integromat)**:
    -   **מטרה**: אוטומציה של תהליכים בעקבות אירועים במערכת.
    -   **סוג אינטגרציה**: Webhooks יוצאים.
    -   **Authentication**: לא הוגדר (כנראה URL עם טוקן מובנה).
    -   **שימוש**: נשלחים Webhooks מ-`make_webhook_status_change_url`, `make_webhook_new_lawsuit_candidate_url`, `make_webhook_new_record_url` לאחר שינויים בנתוני חייבים.
-   **Gmail (Base44 Connector)**:
    -   **מטרה**: שליחת מיילים דרך חשבון Gmail.
    -   **סוג אינטגרציה**: Base44 App Connector (OAuth).
    -   **Authentication**: OAuth 2.0 עם Scope `https://www.googleapis.com/auth/gmail.send`. מחובר כ-Shared Connector.
    -   **שימוש**: `sendAppointmentNotificationEmail`, `sendWelcomeEmail`, `testEmail` ופונקציות נוספות הדורשות שליחת דוא"ל. `gmail_sender_email` מוגדר ב-`Settings`.
-   **Resend**:
    -   **מטרה**: שליחת מיילים.
    -   **סוג אינטגרציה**: API חיצוני.
    -   **Authentication**: באמצעות `resend_api_key` (שמור כ-secret).
    -   **שימוש**: שליחת מיילים.
-   **לוח שנה עברי / חגים עבריים**:
    -   **מטרה**: שילוב נתוני חגים עבריים בלוח השנה.
    -   **סוג אינטגרציה**: לא מפורט מקור הנתונים.
    -   **שימוש**: `syncHebrewHolidays` (פונקציה לסנכרון).
-   **File Storage**:
    -   **מטרה**: אחסון קבצים (תמונות, מסמכים, סרטונים).
    -   **סוג אינטגרציה**: Base44 Core.UploadFile (עבור קבצים ציבוריים), Base44 Core.UploadPrivateFile (עבור קבצים פרטיים).
    -   **שימוש**: העלאת קבצים מצורפים למשימות, תקלות, מסמכים.

## 8. UI / Design System

-   **Primary color**: `#1a5cb3` (מהגדרת `--primary: 222 62% 51%;` ב-`globals.css`, שמתורגם ל-HSL ואז ל-RGB).
-   **Secondary color**: לא הוגדר במפורש, אך יש שימוש בצבעי אפור-כחול (slate) רבים.
-   **Accent color**: לא הוגדר במפורש, אך צבעים כמו אמבר, סגול, ואדום משמשים לציון סטטוסים שונים.
-   **Status colors**:
    -   Success: לא הוגדר במפורש, אך ירוק נפוץ להצלחה.
    -   Warning: אמבר (לדוגמה, `bg-amber-100 text-amber-800` עבור "מכתב התראה").
    -   Error: אדום (לדוגמה, `bg-red-100 text-red-800` עבור "בהליך משפטי").
    -   Info: כחול או סגול.
-   **Typography**:
    -   **Font Families**: `Noto Sans Hebrew` (עברית), -apple-system, BlinkMacSystemFont, 'Segoe UI', 'Roboto', sans-serif.
    -   **גדלים מרכזיים**: `html { font-size: 17px; }`
    -   **Weights**:
        -   Body: 400
        -   H1, H2, H3: 800
        -   H4, H5, H6, Strong, B: 700
-   **Spacing / sizing conventions**:
    -   פינות מעוגלות: `var(--radius)` (מוגדר כ-0.5rem כברירת מחדל, עם `lg`, `md`, `sm` נגזרים ממנו).
    -   ריווחים פנימיים: `p-` ו-`px-` `py-` של Tailwind.
    -   גבהים: רכיבים כמו `Input` ו-`Button` מוגדרים בגובה `h-9`.
-   **Component library בשימוש**: shadcn/ui.
-   **Layout**:
    -   **סוג ניווט**: Sidebar קבוע בצד ימין (RTL) במצב דסקטופ, הניתן לכיווץ. תפריט המבורגר במובייל.
    -   **Breakpoints**: שימוש ב-`md` עבור מעבר ממובייל לדסקטופ (לדוגמה, `md:flex`, `md:mr-20`).
-   **RTL**: כן, מלא. מוגדר ב-`globals.css` וב-`layout`.
-   **Dark mode**: כן. מוגדר ב-`tailwind.config.js` וב-`index.css`.
-   **דפוסי אינטראקציה מיוחדים**:
    -   **Drag-and-drop**: בלוחות קנבן כמו `TasksPro` ו-`IssuesManagement` (באמצעות `@hello-pangea/dnd`).
    -   **Modal/Dialogs**: נפוץ לפרטי רשומה (ApartmentDetailModal), יצירה/עריכה (TaskProFormDialog, ContactFormDialog), ואישורי פעולה (AlertDialog).
    -   **Tooltips**: למידע נוסף.
-   **Iconography**: `lucide-react`.

## 9. Current State

-   **מה מוכן ופעיל בפרודקשן**:
    -   מערכת התחברות וניהול משתמשים/תפקידים פנימית (AppUser, Role).
    -   דאשבורד מרכזי לניהול חייבים עם טבלאות אינטראקטיביות, סינונים וכרטיסי KPI.
    -   ייבוא נתוני חייבים ודיירים מקובץ Excel.
    -   מודל מפורט להצגה ועריכה של פרטי דירה וחובות (`ApartmentDetailModal`) כולל שינוי סטטוס משפטי והיסטוריה.
    -   ניהול אנשי קשר (`Contact`) וספקים (`Supplier`).
    -   מערכת משימות מתקדמות (`TasksPro`) עם לוח קנבן וניהול משימות.
    -   ניהול תקלות (`IssuesManagement`) עם דיווח ומעקב.
    -   ניהול יומן פגישות ואירועים (`Calendar`).
    -   ניהול מסמכים (`Documents`) בתיקיות.
    -   ממשק צ'אט WhatsApp וצ'אט פנימי.
    -   ניהול תבניות הודעות WhatsApp.
    -   מערכת התראות מובנית (`NotificationBell`).
    -   דפי ניהול משתמשים ותפקידים.
    -   דף הגדרות מערכת גלובליות.
    -   ייצוא נתונים.
    -   ממשק מלא בעברית ו-RTL.

-   **מה חלקי / בפיתוח**:
    -   **פונקציות Backend**: למרות שהקוד לפונקציות כמו סנכרון נתונים, שליחת הודעות WhatsApp/מייל, ואינטגרציות נוספות קיימות בקוד, הן **אינן פעילות בדומיין המפורסם** עקב הגבלת תוכנית המנוי הנוכחית של Base44 (דורש שדרוג ל-Builder+ ומעלה). הן עובדות רק בסביבת הפיתוח המקומית.
    -   **סוכן AI (`BuildingAgent`)**: הרכיב קיים אך מופעל דרך פונקציית Backend, ולכן מושבת בפרודקשן כרגע.
    -   **אינטגרציות עם MAKE**: מוגדרים Webhooks ב-`Settings` אך הפונקציונליות תלויה בפונקציות Backend.
-   **Known bugs / TODOs**:
    -   **שגיאת "402 Payment Required"**: קריאות לפונקציות Backend נכשלות בפרודקשן עקב מגבלת המנוי.
    -   **Base44 Admin Login**: היה באג שבו מפתח Base44 לא עקף אוטומטית את מסך הלוגין המקומי, אך זה תוקן לאחרונה בקוד.
    -   **אינדקסים וייחודיות**: לא מפורטים במלואם, דורש בחינה מקיפה.
    -   **Relational Logic**: ייתכן שחלק מהקשרים (reference fields) אינם מוגדרים במפורש ברמת ה-DB ונסמכים על לוגיקת האפליקציה בלבד.
-   **סטטיסטיקות אם יש (כמות משתמשים, רשומות)**: לא זמין מידע סטטיסטי.

## 10. Sample Data

**Entity: AppUser**
```json
{
  "id": "appuser_abcdef12345",
  "created_date": "2024-01-01T10:00:00Z",
  "updated_date": "2024-01-01T10:00:00Z",
  "created_by": "initial_admin@example.com",
  "first_name": "ישראל",
  "last_name": "ישראלי",
  "username": "yisrael.yisraeli",
  "email": "yisrael.yisraeli@example.com",
  "password_hash": "cGFzc3dvcmQxMjM0NQ==",
  "role": "SUPER_ADMIN",
  "role_id": "role_superadmin_001",
  "department": "הנהלה",
  "is_active": true,
  "base44_user_invited": false
}
Entity: Role

{
  "id": "role_admin_001",
  "created_date": "2024-01-05T11:00:00Z",
  "updated_date": "2024-01-05T11:00:00Z",
  "created_by": "yisrael.yisraeli@example.com",
  "name": "מנהל מערכת",
  "description": "תפקיד עם הרשאות ניהול רחבות",
  "color": "green",
  "accessible_pages": ["Dashboard", "Contacts", "WhatsAppChat", "TasksPro", "IssuesManagement", "Import"],
  "can_edit_records": true,
  "can_add_records": true,
  "can_delete_records": false,
  "is_admin": true,
  "active": true
}
Entity: Contact

{
  "id": "contact_abcdef12345",
  "created_date": "2024-03-15T08:30:00Z",
  "updated_date": "2024-03-20T14:15:00Z",
  "created_by": "admin@example.com",
  "apartment_number": "12A",
  "owner_name": "משה כהן",
  "owner_phone": "0501234567",
  "owner_email": "moshe.cohen@example.com",
  "tenant_name": "דנה לוי",
  "tenant_phone": "0529876543",
  "tenant_email": "dana.levi@example.com",
  "resident_type": "tenant",
  "owner_is_primary_contact": false,
  "tenant_is_primary_contact": true,
  "address": "רחוב האלמוג 10, חיפה",
  "notes": "דיירת שקטה, משלמת בזמן",
  "tags": ["שקט", "משלם בזמן"],
  "whatsapp_profile_sync_status": "synced"
}
Entity: DebtorRecord

{
  "id": "debtor_abcdef12345",
  "created_date": "2024-03-15T08:30:00Z",
  "updated_date": "2024-04-20T10:00:00Z",
  "created_by": "admin@example.com",
  "apartment_number": "12A",
  "owner_name": "משה כהן",
  "phone_owner": "0501234567",
  "phone_tenant": "0529876543",
  "phone_primary": "0529876543",
  "total_debt": 6500,
  "monthly_debt": 1500,
  "special_debt": 5000,
  "months_in_arrears": 4,
  "debt_status_auto": "לגבייה מיידית",
  "legal_status_id": "status_legal_002",
  "legal_status_overridden": true,
  "legal_status_updated_at": "2024-04-18T09:00:00Z",
  "legal_status_updated_by": "admin@example.com",
  "legal_status_source": "MANUAL",
  "legal_status_lock": true,
  "notes": "נשלח מכתב התראה ב-18/04. ממתין לתגובה.",
  "last_contact_date": "2024-04-18",
  "next_action_date": "2024-04-25",
  "last_import_at": "2024-04-20T08:00:00Z",
  "is_archived": false
}
Entity: Status

{
  "id": "status_legal_002",
  "created_date": "2024-02-01T09:00:00Z",
  "updated_date": "2024-02-01T09:00:00Z",
  "created_by": "system",
  "name": "מכתב התראה",
  "type": "LEGAL",
  "description": "סטטוס המציין שליחת מכתב התראה ראשוני לחייב",
  "color": "bg-amber-100 text-amber-800",
  "is_active": true,
  "is_default": false,
  "notification_emails": "legal@example.com,collection@example.com"
}
Entity: Task

{
  "id": "task_abcdef12345",
  "created_date": "2024-04-01T10:00:00Z",
  "updated_date": "2024-04-05T12:00:00Z",
  "created_by": "user@example.com",
  "title": "תיקון נזילה בדירה 12A",
  "description": "נזילה מהתקרה בחדר האמבטיה בדירה 12A. דחוף.",
  "target_type": "room",
  "target_id": "12A",
  "priority": "urgent",
  "status": "in_progress",
  "reporter_email": "user@example.com",
  "assigned_to": "technician@example.com",
  "images": ["https://images.unsplash.com/photo-1579547621466-9e61280b1e1b"],
  "notes": "נא לתאם כניסה עם הדיירים לפני ההגעה.",
  "history": [
    {"timestamp": "2024-04-01T10:00:00Z", "action": "created", "by": "user@example.com"},
    {"timestamp": "2024-04-05T12:00:00Z", "action": "status_changed", "old_status": "open", "new_status": "in_progress", "by": "admin@example.com"}
  ]
}
Entity: WhatsAppTemplate

{
  "id": "whatsapp_template_001",
  "created_date": "2024-03-01T09:00:00Z",
  "updated_date": "2024-03-01T09:00:00Z",
  "created_by": "admin@example.com",
  "name": "תזכורת חוב ראשונית",
  "content": "שלום {{name}},\nזוהי תזכורת ידידותית לגבי יתרת חוב בסך {{debt}} שקלים. אנא הסדירו את התשלום בהקדם."
}
11. Key Decisions & Gotchas
מערכת אימות משתמשים כפולה:
החלטה: המערכת משתמשת במערכת אימות משלה (AppUser, Role entities, localStorage) במקביל למערכת האימות המובנית של Base44.
למה: מאפשרת שליטה מדויקת יותר על תפקידי משתמשים והרשאות בתוך האפליקציה, וכן תמיכה במשתמשים שאינם משתמשי Base44 ישירים.
Gotcha: יצרה בלבול אצל מפתחים Base44 שלא נכנסו אוטומטית כמנהלי מערכת, ודורשת לוגיקה ייעודית ב-AuthContext כדי לעקוף זאת.
תלות בפונקציות Backend למטלות קריטיות:
החלטה: שימוש נרחב בפונקציות Backend עבור אינטגרציות חיצוניות (WhatsApp, Bllink, MAKE) ולוגיקה עסקית מורכבת.
Gotcha: פונקציות אלו מושבתות בפרודקשן אם תוכנית המנוי של Base44 אינה כוללת אותן (שגיאת 402), מה שמשבית פונקציונליות מרכזית באפליקציה. יש לוודא שדרוג תוכנית המנוי.
עיצוב RTL מלא ועברית:
החלטה: כלל גורף לעיצוב ופיתוח האפליקציה בעברית מלאה ובכיווניות מימין לשמאל (RTL) עם דגש על UI/UX מודרני ונקי.
Gotcha: דורש תשומת לב מתמדת לכל רכיב UI, טקסט, וריווח, כולל התאמת רכיבי UI קיימים (כמו shadcn/ui) לכיווניות הנכונה.
טיפול בסטטוס חובות דינמי:
החלטה: סטטוס חוב אוטומטי מחושב לפי ספים גלובליים, אך ניתן לנעול ולשנות סטטוסים משפטיים באופן ידני.
Gotcha: מורכבות בלוגיקה של עדכון סטטוסים כדי למנוע דריסה בין מקורות שונים (ייבוא, ידני, אוטומטי) ולשמור על היסטוריית שינויים.
ניהול נתונים מבוסס Entity:
החלטה: שימוש נרחב במודל נתונים מבוסס entities של Base44.
Gotcha: מחייב הבנה של המודל, כולל שדות מערכת מובנים (id, created_date וכו') ואיך קשרים בין entities ממופים.
