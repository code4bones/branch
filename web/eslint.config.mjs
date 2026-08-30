import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  {
    files: ["src/**/*.ts", "tests/**/*.ts"],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname
      }
    },
    rules: {
      "@typescript-eslint/no-explicit-any": "error"
    }
  },
  {
    ignores: ["dist/", "dist-test/", "node_modules/", "eslint.config.mjs"]
  }
);
