/**
 * LoadingScreen — full-page loading state for cold-start waits.
 *
 * Cycles through a list of playful phrases every ~2s so the user knows
 * the app is alive while Lambda + Aurora warm up. Used by ProtectedRoute
 * during the auth-configuring step (initial app boot) where cold-start
 * pain is most likely to be felt.
 */
import { useEffect, useState } from "react";

const PHRASES = [
  "Pruning trees…",
  "Fetching llamas…",
  "Warming up the hamsters…",
  "Counting digital pennies…",
  "Polishing the abacus…",
  "Tickling the database…",
  "Bribing the servers…",
  "Brewing coffee for the Lambdas…",
  "Negotiating with Aurora…",
  "Reticulating splines…",
  "Convincing the snake to slither…",
  "Reconciling reality…",
  "Defrosting the database…",
  "Hatching new endpoints…",
  "Feeding the cache hamsters…",
  "Folding the laundry of bytes…",
  "Petting the rate limiter…",
  "Asking the cloud nicely…",
  "Untangling the dependencies…",
  "Compiling vibes…",
  "Whispering to the JSON…",
  "Auditing imaginary receipts…",
  "Charming the JWT…",
  "Sharpening the algorithms…",
  "Pinging quokkas…",
  "Greasing the data pipeline…",
  "Apologizing to the garbage collector…",
  "Stretching the Lambdas…",
  "Waking up the database…",
  "Massaging the spreadsheet…",
  "Counting clouds, literally…",
  "Translating from binary to vibes…",
  "Feeding the dragons…",
  "Polishing the JSON…",
  "Spinning up some yarn…",
  "Convincing electrons to flow…",
  "Bargaining with API Gateway…",
  "Untying compiler knots…",
  "Aligning the chakras…",
  "Aligning the cosmic timeline…",
];

function pickPhrase(exclude: string | null): string {
  // Avoid picking the same phrase twice in a row so the user perceives motion.
  if (PHRASES.length < 2) return PHRASES[0] ?? "Loading…";
  let next = PHRASES[Math.floor(Math.random() * PHRASES.length)] ?? "Loading…";
  while (next === exclude) {
    next = PHRASES[Math.floor(Math.random() * PHRASES.length)] ?? "Loading…";
  }
  return next;
}

/**
 * useRotatingPhrase — cycles a random phrase from PHRASES every ~1.8s.
 * Shared by the full-screen LoadingScreen and any inline loading UI.
 */
export function useRotatingPhrase(intervalMs = 1800): string {
  const [phrase, setPhrase] = useState<string>(() => pickPhrase(null));

  useEffect(() => {
    const t = setInterval(() => {
      setPhrase((prev) => pickPhrase(prev));
    }, intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);

  return phrase;
}

export function LoadingScreen() {
  const phrase = useRotatingPhrase();

  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-6 py-16">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_30%_20%,rgba(56,189,248,0.18),transparent_55%),radial-gradient(circle_at_75%_70%,rgba(99,102,241,0.18),transparent_55%)]"
      />
      <div
        role="status"
        aria-live="polite"
        className="relative z-10 mx-auto flex max-w-md flex-col items-center text-center"
      >
        <div className="mb-8 flex items-end gap-2" aria-hidden>
          <span className="block h-3 w-3 animate-bounce rounded-full bg-primary [animation-delay:-0.3s]" />
          <span className="block h-3 w-3 animate-bounce rounded-full bg-primary [animation-delay:-0.15s]" />
          <span className="block h-3 w-3 animate-bounce rounded-full bg-primary" />
        </div>

        <p
          key={phrase}
          className="animate-in fade-in slide-in-from-bottom-1 text-lg font-medium duration-500"
        >
          {phrase}
        </p>
        <p className="mt-3 text-xs text-muted-foreground">
          One sec — services are warming up.
        </p>
      </div>
    </main>
  );
}
