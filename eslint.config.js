// Eigenständige Flat-Config ohne externe Plugins, damit `npx eslint` ohne
// zusätzliche Dev-Dependencies läuft. Die Syntax- und Testabsicherung
// übernimmt weiterhin `npm test` (node --check + node --test); ESLint ergänzt
// Stil- und Qualitätsregeln.
export default [
  {
    ignores: ["node_modules/**", "dist/**"]
  },
  {
    files: ["**/*.js"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module"
    },
    rules: {
      "no-var": "error",
      "prefer-const": "error",
      "eqeqeq": ["error", "smart"],
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", caughtErrors: "none" }],
      "no-undef": "off"
    }
  }
];
