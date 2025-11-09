import globals from "globals";
import { defineConfig } from "eslint/config";

// Minimal, no-op ESLint config for backend (Node). No rules enforced.
export default defineConfig([
  {
    files: ["**/*.{js,cjs,mjs,ts,mts,cts}"],
    ignores: [
      "dist/**",
      "node_modules/**"
    ],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: globals.node
    },
    rules: {}
  }
]);
