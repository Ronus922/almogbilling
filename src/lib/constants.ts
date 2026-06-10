export const SESSION_COOKIE = 'almog_sid';
export const RESEND_COOLDOWN_SECONDS = 60;
export const RESET_TOKEN_LIFETIME_MIN = 60;
export const SESSION_LIFETIME_DAYS_REMEMBER = 30;
export const SESSION_LIFETIME_HOURS_DEFAULT = 24;

// Brute-force protection — sliding-window limits for authentication entry points.
export const AUTH_RATE_WINDOW_SEC = 15 * 60; // 15 minutes
export const LOGIN_MAX_PER_USER = 5; // failed logins per username per window
export const LOGIN_MAX_PER_IP = 20; // attempts per IP per window
export const FORGOT_PASSWORD_MAX_PER_IP = 10; // per IP per window
export const ACCEPT_INVITE_MAX_PER_IP = 15; // per IP per window
