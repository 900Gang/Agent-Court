import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([".next/**", "out/**", "dist/**", "coverage/**", "next-env.d.ts"]),
  {
    files: ["**/*.{ts,tsx,mjs}"],
    ignores: ["lib/config/env.ts", "*.config.ts", "*.config.mjs", "scripts/**", "tests/**"],
    rules: {
      "no-restricted-properties": [
        "error",
        {
          object: "process",
          property: "env",
          message: "Read environment variables only through lib/config/env.ts.",
        },
      ],
    },
  },
  {
    files: ["app/**/*.{ts,tsx}", "components/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/db", "@/db/*", "**/db/*"],
              message: "Routes and components must not import db/. Go through lib/services.",
            },
          ],
        },
      ],
    },
  },
]);