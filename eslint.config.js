const js = require('@eslint/js');

module.exports = [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        require: 'readonly',
        module: 'readonly',
        exports: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        process: 'readonly',
        Buffer: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        setImmediate: 'readonly',
        clearImmediate: 'readonly',
        global: 'readonly',
      },
    },
    rules: {
      'no-unused-vars': 'warn',
      'no-console': 'off',
      // escapeForBlock intentionally uses zero-width characters in its
      // replacement string to defang nested closing tags.
      'no-irregular-whitespace': [
        'error',
        { skipStrings: true, skipTemplates: true },
      ],
    },
  },
  {
    // Vendored third-party code; not subject to project lint rules.
    ignores: ['vendor/**'],
  },
];
