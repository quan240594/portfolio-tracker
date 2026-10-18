// The spike is throwaway measurement code outside the pnpm workspace: lint nothing here (ESLint would otherwise pick
// up a parent config). The workspace packages each lint only their own directory, so no other config reaches this folder.
export default [{ ignores: ['**'] }];
