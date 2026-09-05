import tsParser from "@typescript-eslint/parser";

export default [
  { ignores: ["node_modules/**"] },
  {
    files: ["skynet.ts", "src/**/*.ts", "smoke.test.ts"],
    languageOptions: { parser: tsParser, ecmaVersion: "latest", sourceType: "module" },
    rules: { complexity: ["error", 10] },
  },
];
