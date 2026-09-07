import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['.next/**', 'node_modules/**', 'coverage/**', 'src/generated/**'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  {
    languageOptions: {
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      eqeqeq: ['error', 'always'],
      // Tenant data access must go through the helpers in src/lib/db/tenant.ts.
      // Instantiating a client elsewhere would sidestep the organisation
      // context and therefore the row-level security policies.
      'no-restricted-syntax': [
        'error',
        {
          selector: "NewExpression[callee.name='PrismaClient']",
          message:
            'Do not construct a PrismaClient. Use withOrganisation/withUser from @/lib/db/tenant so the organisation context is set.',
        },
      ],
    },
  },
  {
    files: ['src/lib/db/tenant.ts'],
    rules: { 'no-restricted-syntax': 'off' },
  },
  {
    files: ['tests/**'],
    rules: { '@typescript-eslint/no-non-null-assertion': 'off' },
  },
);
