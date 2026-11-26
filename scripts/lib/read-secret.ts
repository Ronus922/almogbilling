// scripts/lib/read-secret.ts — read a secret (a password) for a manual tool
// WITHOUT taking it from the command line (26/11/2026): a process's arguments
// are readable by every local account (`ps`, /proc/<pid>/cmdline) and stay in
// the shell history. Piped in → read from stdin (one line); at a terminal → a
// hidden prompt (nothing echoed).
//
//   read -rs PW; printf '%s' "$PW" | npx tsx scripts/create-super-admin.ts <email> "<name>"; unset PW
//   npx tsx scripts/create-super-admin.ts <email> "<name>"      # asks, hidden

export async function readSecret(prompt: string): Promise<string> {
  const stdin = process.stdin;
  if (!stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
    return Buffer.concat(chunks).toString('utf8').replace(/\r?\n$/, '');
  }
  process.stderr.write(prompt);
  stdin.setRawMode(true);
  stdin.resume();
  stdin.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    let value = '';
    const done = (err?: Error) => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.removeListener('data', onData);
      process.stderr.write('\n');
      if (err) reject(err);
      else resolve(value);
    };
    const onData = (text: string) => {
      for (const ch of text) {
        if (ch === '\r' || ch === '\n') return done();
        if (ch === '\u0003') return done(new Error('cancelled')); // Ctrl-C
        if (ch === '\u007f' || ch === '\b') value = value.slice(0, -1); // Backspace
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}
