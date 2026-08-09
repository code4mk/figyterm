/** @type {import('tailwindcss').Config} */
export default {
  darkMode: "class",
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        ft: {
          bg: "var(--ft-bg)",
          surface: "var(--ft-surface)",
          elevated: "var(--ft-elevated)",
          border: "var(--ft-border)",
          "border-subtle": "var(--ft-border-subtle)",
          text: "var(--ft-text)",
          "text-secondary": "var(--ft-text-secondary)",
          "text-muted": "var(--ft-text-muted)",
          accent: "var(--ft-accent)",
          "accent-hover": "var(--ft-accent-hover)",
          success: "var(--ft-success)",
          warning: "var(--ft-warning)",
          error: "var(--ft-error)",
          tab: "var(--ft-tab)",
          "tab-active": "var(--ft-tab-active)",
        },
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
