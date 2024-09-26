module.exports = {
  "env": {
    "browser": true,
    "es2021": true
  },
  "extends": ["standard-with-typescript", "prettier"],
  "overrides": [
    {
      "env": {
        "node": true
      },
      "files": [
        ".eslintrc.{js,cjs}"
      ],
      "parserOptions": {
        "sourceType": "script"
      }
    }
  ],
  "parserOptions": {
    "ecmaVersion": "latest",
    "sourceType": "module",
  },
  "rules": {
    "@typescript-eslint/no-floating-promises": "off",
    "@typescript-eslint/non-nullable-type-assertion-style": "off",
    "@typescript-eslint/no-non-null-assertion": "off",
    "@typescript-eslint/no-unsafe-argument": "off",
    "@typescript-eslint/strict-boolean-expressions": "off",
    "@typescript-eslint/return-await": "off",
    "new-cap": "off",
  }
}
