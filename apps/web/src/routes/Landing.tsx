/**
 * Landing — public marketing/personal page served at vesselone.ca.
 *
 * This page renders only when the host matches the apex/www domain (see
 * `shouldShowLanding` in App.tsx); the Helm app itself lives at
 * app.vesselone.ca. The single CTA jumps to the app for sign-in.
 */
const APP_URL =
  (import.meta.env["VITE_APP_URL"] as string | undefined) ||
  "https://app.vesselone.ca/";

export function Landing() {
  return (
    <main className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-6 py-16">
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_30%_20%,rgba(56,189,248,0.18),transparent_55%),radial-gradient(circle_at_75%_70%,rgba(99,102,241,0.18),transparent_55%)]"
      />
      <div className="relative z-10 mx-auto max-w-xl text-center">
        <div className="mb-6 flex items-center justify-center gap-3">
          <img
            src="/helm-logo.svg"
            alt=""
            className="h-10 w-10"
            onError={(e) => {
              // The Helm app may not ship a public logo file at this path;
              // if missing just hide the img instead of showing a broken
              // icon placeholder.
              (e.currentTarget as HTMLImageElement).style.display = "none";
            }}
          />
          <span className="text-2xl font-bold tracking-tight">Vessel One</span>
        </div>

        <h1 className="text-4xl font-bold leading-tight sm:text-5xl">
          Thiago Pinto
        </h1>
        <p className="mt-3 text-lg text-muted-foreground sm:text-xl">
          Software engineer in Calgary. This domain hosts my personal
          financial workspace.
        </p>

        <div className="mt-10 flex flex-col items-center gap-3 sm:flex-row sm:justify-center">
          <a
            href={APP_URL}
            className={
              "inline-flex h-11 items-center justify-center rounded-md bg-primary px-6 text-sm font-medium text-primary-foreground " +
              "shadow transition hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring " +
              "focus-visible:ring-offset-2"
            }
          >
            Sign in to Helm →
          </a>
          <a
            href="mailto:th.goncalves@gmail.com"
            className={
              "inline-flex h-11 items-center justify-center rounded-md border border-input bg-background px-6 text-sm font-medium " +
              "transition hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 " +
              "focus-visible:ring-ring focus-visible:ring-offset-2"
            }
          >
            Get in touch
          </a>
        </div>

        <p className="mt-12 text-xs text-muted-foreground">
          © {new Date().getFullYear()} Vessel One
        </p>
      </div>
    </main>
  );
}
