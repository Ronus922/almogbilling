// Stub for the `server-only` / `client-only` import guards so CLI scripts can
// import server-side modules (e.g. src/lib/db/*) under tsx. Next.js provides the
// real `server-only` package only inside its build, where the guard is enforced;
// it is NOT resolvable in a plain node/tsx run. This empty module is mapped in
// scripts/tsconfig.scripts.json and is used ONLY by scripts — the app build
// continues to use the real package via the untouched root tsconfig.json.
export {};
