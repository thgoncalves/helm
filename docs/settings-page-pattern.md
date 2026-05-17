# Settings page pattern

A portable spec of the settings UI used in Cerebro. Reuse the layout, search,
scroll-spy, and theme system in another app; replace the section contents with
your own.

The only piece meant to be copied *verbatim* across apps is the **theme
system** (CSS-variable palettes + `useTheme` hook + `ThemeCard` picker).
Everything else is a structural template.

---

## 1. Layout — three zones

```
┌─────────────────────────────────────────────────────────────────────────┐
│ App header (outside Settings)                                           │
├──────────────┬──────────────────────────────────────────────────────────┤
│ ┌──────────┐ │                                                          │
│ │ Search…  │ │   Theme                                                  │
│ ├──────────┤ │   Pick a colour palette…                                 │
│ │ Theme    │ │   ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐                   │
│ │ Section… │ │   │ card │ │ card │ │ card │ │ card │                   │
│ │ Section… │ │   └──────┘ └──────┘ └──────┘ └──────┘                   │
│ │ Section… │ │                                                          │
│ │          │ │   Section heading                                        │
│ │          │ │   paragraph…                                             │
│ │          │ │   (form / grid / list / editor)                          │
│ │          │ │   [save]  ✓ saved   or   ⚠ unsaved changes               │
│ │ ← 240 →  │ │                                                          │
│ └──────────┘ │   …more sections, scrollable                             │
└──────────────┴──────────────────────────────────────────────────────────┘
```

Three responsibilities, three nodes:

- **Sidebar** (`<aside>`, `w-60`): search box on top, section list below. Fixed
  width, no horizontal scroll. The whole component is `h-full flex` so the
  sidebar and main fill the available height; only the inner panels scroll.
- **Main scroller** (`<div ref={scrollerRef} className="overflow-y-auto">`):
  the only vertical scroller. The sidebar listens for *its* scroll events to
  drive scroll-spy.
- **Modals** (folder picker, etc.): full-screen `fixed inset-0` overlays —
  rendered as siblings of the main flex, not inside the scroller.

```tsx
<div className="h-full flex">
  <aside className="w-60 shrink-0 border-r border-line flex flex-col min-h-0">
    {/* search + nav */}
  </aside>

  <div ref={scrollerRef} className="flex-1 overflow-y-auto min-h-0">
    <div className="px-6 py-6 space-y-10 max-w-5xl">
      {/* sections */}
    </div>
  </div>

  {modalOpen && <Modal …/>}
</div>
```

Notes:
- `min-h-0` on flex children is what lets the inner `overflow-y-auto` actually
  scroll instead of pushing the parent.
- `max-w-5xl` caps the form column width even on wide displays — keeps fields
  legible.
- `space-y-10` between sections gives them clear visual separation without
  borders or cards.

---

## 2. Section metadata — one array, two consumers

The sidebar nav AND the search filter both read from the same array:

```ts
interface SectionMeta {
  id: string;          // matches the <section id> in the DOM
  title: string;       // sidebar label + section heading
  keywords: string[];  // boosts search recall — see below
}

const SECTIONS: SectionMeta[] = [
  { id: "theme",     title: "Theme",     keywords: ["theme", "palette", "dark", "light", "appearance"] },
  { id: "account",   title: "Account",   keywords: ["account", "profile", "email", "password"] },
  // …
];
```

Adding a section = one entry here + one `<section id={…}>` in the main scroller.
That keeps the nav and the content from drifting apart.

**Keyword discipline:** put *field names* and *jargon* in `keywords`, not just
synonyms of the title. The user-visible payoff is that typing `email` finds the
"Account" section even though "email" isn't in its title. Cerebro's "Models"
section lists `vision`, `embedding`, `planner`, etc. — every model role name.

---

## 3. Search — substring AND across whitespace tokens

```ts
function matchesQuery(meta: SectionMeta, q: string): boolean {
  if (!q) return true;
  const haystack = (meta.title + " " + meta.keywords.join(" ")).toLowerCase();
  return q.split(/\s+/).filter(Boolean).every((tok) => haystack.includes(tok));
}
```

Why this and not fuzzy: it's predictable. `dark theme` finds the Theme section
(both tokens hit). Misspellings don't match — but the keyword list cushions
that. Substring beats prefix because users type fragments (`pwd` won't match
"password", but `password` won't match `pwd` either — keep keywords short).

The filtered set is computed once with `useMemo` and a `Set` of ids:

```ts
const visibleSections = useMemo(
  () => SECTIONS.filter((s) => matchesQuery(s, q)),
  [q],
);
const visibleIds = useMemo(
  () => new Set(visibleSections.map((s) => s.id)),
  [visibleSections],
);
```

Render each section behind `{visibleIds.has("foo") && <section…>}`. When the
filter shrinks, the unmatched sections are unmounted entirely (their state is
fine to lose; on remount the controlled inputs re-seed from the saved props).

Empty-state in two places:
- sidebar: `no matches`
- main: `No settings match \`<q>\`.`

---

## 4. Scroll-spy — direct scroll listener, with a click lock

`IntersectionObserver` looks tempting but is awkward when multiple section
headings can be visible at once. A scroll listener on the main scroller is
simpler:

```ts
useEffect(() => {
  const root = scrollerRef.current;
  if (!root) return;
  const onScroll = () => {
    if (Date.now() < spyLockUntilRef.current) return;   // see below
    const rootTop = root.getBoundingClientRect().top;
    let active = SECTIONS[0].id;
    for (const s of SECTIONS) {
      if (!visibleIds.has(s.id)) continue;
      const el = document.getElementById(s.id);
      if (!el) continue;
      const top = el.getBoundingClientRect().top - rootTop;
      if (top <= 80) active = s.id;                     // 80px threshold below the scroller's top
    }
    setActiveId(active);
  };
  root.addEventListener("scroll", onScroll, { passive: true });
  onScroll();
  return () => root.removeEventListener("scroll", onScroll);
}, [visibleIds]);
```

> Rule: the **last** section whose heading has crossed a small threshold below
> the scroller's top is "active." Walking the array in order and overwriting
> `active` gives you that for free.

Click-to-scroll uses `scrollIntoView({ behavior: "smooth" })` + a brief
**lock** so scroll-spy doesn't reassert during the animation:

```ts
const scrollToSection = useCallback((id: string) => {
  document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  setActiveId(id);
  spyLockUntilRef.current = Date.now() + 700;  // grace window covers smooth-scroll
}, []);
```

Without the lock, clicking the last section ("Files: Exclude" in Cerebro) would
flash "active" then jump back to whatever section is actually pinned at the
top — because the scroller can't push the last heading high enough to clear
the 80px threshold. The lock makes the explicit click win.

Add `scroll-mt-4` to each `<section>` so smooth-scroll lands a bit below the
top edge:

```tsx
<section id="theme" className="scroll-mt-4">…</section>
```

---

## 5. Sidebar item style

```tsx
<button
  onClick={() => scrollToSection(s.id)}
  className={`w-full text-left px-4 py-1.5 text-sm transition ${
    activeId === s.id
      ? "text-fg-strong bg-elev/40 border-l-2 border-accent"
      : "text-muted hover:text-fg border-l-2 border-transparent"
  }`}
>
  {s.title}
</button>
```

The transparent `border-l-2` on the inactive state reserves the gutter so the
text doesn't shift when the accent bar appears. Standard but easy to forget.

---

## 6. Section anatomy

Every section follows the same skeleton:

```tsx
<section id="…" className="scroll-mt-4">
  <h2 className="text-lg font-semibold text-fg-strong mb-1">Title</h2>
  <p className="text-sm text-muted mb-4">One-sentence what+why explanation.</p>

  {error && <ErrorBanner>{error}</ErrorBanner>}

  {/* body — form / grid / list */}

  <div className="mt-4 flex items-center gap-3">
    <button className="… bg-accent text-white …" disabled={!dirty || saving}>
      {saving ? "saving…" : "save"}
    </button>
    {savedAt && !dirty && <span className="text-xs text-success">✓ saved</span>}
    {dirty && <span className="text-xs text-warning">unsaved changes</span>}
  </div>
</section>
```

Two state flags shape the footer:
- **`dirty`** — `true` when the local draft differs from the prop. Computed
  cheaply on every render; don't memoize.
- **`savedAt`** — timestamp of the last successful save. Used only to show the
  ✓; clear it when the user edits again.

The save button is double-gated: disabled when not dirty (nothing to save) AND
when saving (avoid double-submits).

### Three body styles to pick from

| Body | When | Cerebro example |
| --- | --- | --- |
| **Auto-fit grid** of `<label>` inputs | many short fields, equal weight | Models (7 LLM role inputs) |
| **Indented list** with hover ✕ | small array of strings | Files: Exclude (glob patterns) |
| **Single row + button** | one setting that opens a modal/picker | Knowledge base (watch folder + browse) |

The auto-fit grid is one line:
```tsx
<div className="grid gap-3"
     style={{ gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))" }}>
```

The indented list uses a left rule + opacity-on-hover delete:
```tsx
<div className="border-l-2 border-line pl-4 space-y-1">
  {items.map((p, i) => (
    <div className="group flex items-center gap-2 py-0.5">
      <code className="flex-1 font-mono text-fg-strong">{p}</code>
      <button className="text-faint hover:text-danger opacity-0 group-hover:opacity-100 transition">
        ✕
      </button>
    </div>
  ))}
</div>
```

---

## 7. Theme system — the part you copy verbatim

The visual language is **token names**, not literal colors. Components only
ever reference semantic Tailwind classes (`bg-surface`, `text-fg-strong`,
`border-line`, `text-accent`, `text-danger`). Each theme is a CSS block that
maps those tokens to RGB triplets.

### 7a. Token vocabulary

These are the names every component reaches for. Keep this set stable across
apps; add app-specific tokens (`person`, `concept`, etc.) separately.

| Token | Role |
| --- | --- |
| `app` | App background (the dimmest layer) |
| `surface` | Card / panel background — one step up from `app` |
| `elev` | Hovered / pressed / "selected" backgrounds — one step up from `surface` |
| `line` | Default borders & dividers |
| `line-strong` | Stronger borders (modal edges, focused inputs) |
| `fg` | Body text |
| `fg-strong` | Headings, primary text |
| `muted` | Secondary text (descriptions) |
| `faint` | Tertiary text (placeholders, timestamps) |
| `accent` | Primary interactive color (links, buttons, focus rings) |
| `success` | "Saved", positive confirmations |
| `warning` | "Unsaved", attention without alarm |
| `danger` | Errors, destructive actions |

### 7b. CSS — palette per `data-theme`

`index.css`:

```css
:root,
:root[data-theme="tokyo-night"] {
  --c-app: 26 27 38;
  --c-surface: 22 22 30;
  --c-elev: 41 46 66;
  --c-line: 41 46 66;
  --c-line-strong: 65 72 104;
  --c-fg: 169 177 214;
  --c-fg-strong: 192 202 245;
  --c-muted: 154 165 206;
  --c-faint: 86 95 137;
  --c-accent: 122 162 247;
  --c-success: 158 206 106;
  --c-warning: 224 175 104;
  --c-danger: 247 118 142;
}

:root[data-theme="catppuccin-mocha"] { /* same keys, different triplets */ }
:root[data-theme="catppuccin-latte"] { /* light variant */ }
```

**Triplets, not hex.** Tailwind's `<alpha-value>` syntax lets you do
`bg-surface/40` (40% opacity) only if the color is stored as raw `r g b`. Hex
won't compose with opacity utilities.

**Switching themes is one line.** Setting `<html data-theme="…">` swaps the
palette instantly — no React re-render needed because the components reference
tokens, not values.

### 7c. Tailwind wiring

`tailwind.config.js`:

```js
const c = (name) => `rgb(var(--c-${name}) / <alpha-value>)`;

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        app: c("app"),
        surface: c("surface"),
        elev: c("elev"),
        line: c("line"),
        "line-strong": c("line-strong"),
        fg: c("fg"),
        "fg-strong": c("fg-strong"),
        muted: c("muted"),
        faint: c("faint"),
        accent: c("accent"),
        success: c("success"),
        warning: c("warning"),
        danger: c("danger"),
      },
    },
  },
};
```

That's the entire bridge from CSS variables to Tailwind utilities.

### 7d. Boilerplate body styles

```css
html, body, #root { height: 100%; width: 100%; margin: 0; }
body {
  overflow: hidden;
  background: rgb(var(--c-app));
  color: rgb(var(--c-fg));
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}

/* Theme-tinted scrollbars */
*::-webkit-scrollbar { width: 10px; height: 10px; }
*::-webkit-scrollbar-track { background: transparent; }
*::-webkit-scrollbar-thumb {
  background: rgb(var(--c-elev) / 0.85);
  border-radius: 6px;
  border: 2px solid transparent;
  background-clip: padding-box;
}
*::-webkit-scrollbar-thumb:hover { background: rgb(var(--c-line-strong) / 0.95); }
* { scrollbar-color: rgb(var(--c-elev) / 0.85) transparent; scrollbar-width: thin; }
```

### 7e. Theme registry + hook (TypeScript)

```ts
export type ThemeId = "tokyo-night" | "catppuccin-mocha" | "catppuccin-latte" | …;

export interface ThemeMeta {
  id: ThemeId;
  name: string;
  variant: "dark" | "light";
  /** Five colors used to render the swatch preview in the picker. */
  swatch: { app: string; surface: string; accent: string; warning: string; danger: string };
}

export const THEMES: ThemeMeta[] = [
  { id: "tokyo-night", name: "Tokyo Night", variant: "dark",
    swatch: { app: "#1a1b26", surface: "#16161e", accent: "#7aa2f7", warning: "#e0af68", danger: "#f7768e" } },
  // …
];

const STORAGE_KEY = "myapp:theme";          // namespace per app
const DEFAULT_THEME: ThemeId = "tokyo-night";

export function getStoredTheme(): ThemeId {
  if (typeof window === "undefined") return DEFAULT_THEME;
  const v = window.localStorage.getItem(STORAGE_KEY) as ThemeId | null;
  return v && THEMES.some((t) => t.id === v) ? v : DEFAULT_THEME;
}

export function applyTheme(id: ThemeId): void {
  document.documentElement.dataset.theme = id;
}

/** Bootstrap on first import — call once at module top of `main.tsx`. */
export function bootstrapTheme(): ThemeId {
  const id = getStoredTheme();
  applyTheme(id);
  return id;
}

export function useTheme() {
  const [theme, setThemeState] = useState<ThemeId>(() => getStoredTheme());

  useEffect(() => {
    applyTheme(theme);
    window.localStorage.setItem(STORAGE_KEY, theme);
    window.dispatchEvent(new CustomEvent("myapp:theme-changed", { detail: theme }));
  }, [theme]);

  // Cross-tab / cross-component sync: any setter dispatches an event;
  // every other useTheme listens and updates its local state.
  useEffect(() => {
    const onChange = (e: Event) => {
      const id = (e as CustomEvent<ThemeId>).detail;
      if (id && id !== theme) setThemeState(id);
    };
    window.addEventListener("myapp:theme-changed", onChange);
    return () => window.removeEventListener("myapp:theme-changed", onChange);
  }, [theme]);

  return { theme, setTheme: setThemeState, themes: THEMES };
}
```

Two reasons to dispatch a custom event: (a) multiple `useTheme()` consumers
stay in sync without a Context, (b) non-React canvas / chart code can listen
and re-read colors from CSS variables (Cerebro's graph view does this).

Call `bootstrapTheme()` once at the top of `main.tsx`, *before* React mounts —
otherwise the first paint flashes the default palette.

### 7f. Theme picker UI

```tsx
<div className="grid gap-2"
     style={{ gridTemplateColumns: "repeat(auto-fill, minmax(160px, 1fr))" }}>
  {THEMES.map((t) => (
    <ThemeCard key={t.id} {...t} active={theme === t.id} onSelect={() => setTheme(t.id)} />
  ))}
</div>

function ThemeCard({ name, variant, swatch, active, onSelect }) {
  return (
    <button onClick={onSelect}
            className={`text-left p-2 rounded border transition ${
              active
                ? "border-accent ring-2 ring-accent/40 bg-elev/30"
                : "border-line hover:border-line-strong bg-surface"
            }`}>
      <div className="h-7 rounded mb-1.5 flex items-center px-1.5 gap-1"
           style={{ background: swatch.app, border: `1px solid ${swatch.surface}` }}>
        <span className="w-2 h-2 rounded-full" style={{ background: swatch.accent }} />
        <span className="w-2 h-2 rounded-full" style={{ background: swatch.warning }} />
        <span className="w-2 h-2 rounded-full" style={{ background: swatch.danger }} />
      </div>
      <div className="flex items-center justify-between gap-1">
        <span className="text-xs text-fg-strong truncate">{name}</span>
        <span className="text-[10px] text-faint uppercase tracking-wider">{variant}</span>
      </div>
    </button>
  );
}
```

The card shows a mini "app window" colored by `swatch.app` and `swatch.surface`,
with three traffic-light dots for accent / warning / danger. Selected state =
accent border + soft ring. The card itself uses theme tokens for *its* chrome
(`border-line`, `bg-surface`) so the picker re-skins with the rest of the UI
when you change theme — small but satisfying.

---

## 8. Modals (only if you need one)

A modal lives outside the main scroller as a sibling of `<aside>` and
`<div ref={scrollerRef}>`, full-screen overlay, click-outside-to-close, ESC
to dismiss handled by the parent if needed:

```tsx
<div className="fixed inset-0 bg-black/60 grid place-items-center z-20"
     onClick={onClose}>
  <div className="bg-surface border border-line-strong rounded-lg w-full max-w-xl mx-4 flex flex-col max-h-[80vh]"
       onClick={(e) => e.stopPropagation()}>
    {/* header   px-4 py-3 border-b border-line */}
    {/* body     flex-1 overflow-y-auto */}
    {/* footer   px-4 py-3 border-t border-line flex justify-end gap-2 */}
  </div>
</div>
```

Three-band card (header / body / footer) with `max-h-[80vh]` keeps it from
overflowing the viewport on small screens. `onClick` on the backdrop closes;
`stopPropagation` on the card prevents the same click from re-closing.

---

## 9. Implementation checklist for the new app

1. Copy `index.css` palette blocks + Tailwind config color map (Section 7b/7c).
2. Copy `theme.ts` — change `STORAGE_KEY` and event name to your app
   namespace. Trim or extend `THEMES` to taste.
3. Call `bootstrapTheme()` at the top of `main.tsx`.
4. Scaffold `SettingsView.tsx`:
   - `SECTIONS` array (Section 2)
   - search box + nav (Section 3, 5)
   - scroll-spy effect + click-to-scroll (Section 4)
   - sections rendered behind `visibleIds.has(...)` (Section 6)
5. First section is **Theme**, same swatch grid as Cerebro (Section 7f).
6. Add your app's sections following the section anatomy (Section 6).
7. If you need a picker, drop in the modal skeleton (Section 8).

Everything else — what each section does, what gets saved, validation — is
yours to define.
