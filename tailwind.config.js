/**
 * Maps each token name to `rgb(var(--ft-<token>-rgb) / <alpha-value>)`.
 *
 * Written out rather than inlined fifteen times so that the shape of the
 * expression lives in one place — getting it subtly wrong in one entry is
 * exactly the kind of mistake that produces no error and no rule.
 */
function ftColor(tokens) {
  return Object.fromEntries(
    Object.entries(tokens).map(([key, token]) => [
      key,
      `rgb(var(--ft-${token}-rgb) / <alpha-value>)`,
    ])
  );
}

/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      /*
        Through the `-rgb` channel tokens, not the colour tokens.

        These were `var(--ft-accent)` and so on, which works for `bg-ft-accent`
        and silently fails for `bg-ft-accent/10`: Tailwind puts the alpha inside
        the colour function, it cannot parse a `var()` to get in there, and it
        drops the modifier without a warning — emitting no rule, so the class
        name matches nothing and the element simply has no background. Thirteen
        of those had built up across the app before anyone noticed, because
        nothing anywhere says it went wrong.

        `<alpha-value>` is Tailwind's slot for the modifier, and `1` when there
        isn't one. See the note at the top of `styles.css` for how the two forms
        of each token are kept from drifting.
      */
      colors: {
        ft: ftColor({
          bg: "bg",
          surface: "surface",
          elevated: "elevated",
          border: "border",
          "border-subtle": "border-subtle",
          text: "text",
          "text-secondary": "text-secondary",
          "text-muted": "text-muted",
          accent: "accent",
          "accent-hover": "accent-hover",
          success: "success",
          warning: "warning",
          error: "error",
          tab: "tab",
          "tab-active": "tab-active",
        }),
      },
      fontFamily: {
        sans: [
          "-apple-system",
          "BlinkMacSystemFont",
          "SF Pro Text",
          "Segoe UI",
          "sans-serif",
        ],
        mono: [
          "JetBrains Mono",
          "Fira Code",
          "SF Mono",
          "Cascadia Code",
          "monospace",
        ],
      },
      fontSize: {
        xxs: "0.65rem",
      },
      boxShadow: {
        glow: "0 0 20px rgba(99, 102, 241, 0.15)",
        "elevated": "0 8px 32px rgba(0, 0, 0, 0.4)",
      },
    },
  },
  plugins: [],
};
