const js = require("@eslint/js");
const prettier = require("eslint-plugin-prettier");

module.exports = [
  js.configs.recommended,
  {
    files: ["**/*.js"],
    ignores: ["node_modules/**", "coverage/**", ".vercel/**"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: {
        // Node.js globals
        require: "readonly",
        module: "readonly",
        exports: "readonly",
        __dirname: "readonly",
        __filename: "readonly",
        process: "readonly",
        console: "readonly",
        Buffer: "readonly",
        setTimeout: "readonly",
        clearTimeout: "readonly",
        setInterval: "readonly",
        clearInterval: "readonly",
        setImmediate: "readonly",
        URL: "readonly",
        URLSearchParams: "readonly",
        fetch: "readonly",
        FormData: "readonly",
        Blob: "readonly",
        AbortController: "readonly"
      }
    },
    plugins: {
      prettier: prettier
    },
    rules: {
      // Prettier integration
      "prettier/prettier": "error",

      // Unused variables - error (with exceptions for function args starting with _)
      "no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrors: "none"
        }
      ],

      // Error level rules
      "no-debugger": "error",
      "no-duplicate-imports": "error",
      "no-var": "error",
      eqeqeq: ["error", "always", { null: "ignore" }],

      // Warning level rules
      "no-console": "warn",
      "prefer-const": "warn"
    }
  },
  {
    ignores: ["node_modules/**", "coverage/**", ".vercel/**", "*.min.js", "api/letters/**"]
  }
];
