import js from "@eslint/js";
import globals from "globals";
import react from "eslint-plugin-react";

export default [
  js.configs.recommended,
  {
    ignores: ["dist/**", "node_modules/**", "data/**", "uploads/**"]
  },
  {
    files: ["**/*.{js,jsx}"],
    plugins: {
      react
    },
    settings: {
      react: {
        version: "detect"
      }
    },
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      parserOptions: {
        ecmaFeatures: {
          jsx: true
        }
      },
      globals: {
        ...globals.browser,
        ...globals.node
      }
    },
    rules: {
      "no-unused-vars": ["error", { "argsIgnorePattern": "^_", "varsIgnorePattern": "^_", "caughtErrorsIgnorePattern": "^_" }],
      "react/jsx-uses-react": "error",
      "react/jsx-uses-vars": "error"
    }
  }
];
