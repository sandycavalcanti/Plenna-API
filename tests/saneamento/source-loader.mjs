// Exercise current TypeScript without overwriting the tracked dist artifacts.
export async function resolve(specifier, context, nextResolve) {
  if (!specifier.endsWith('.js') || !specifier.includes('/dist/src/'))
    return nextResolve(specifier, context);

  const sourceSpecifier = specifier
    .replace('/dist/src/', '/src/')
    .replace(/\.js$/, '.ts');
  return nextResolve(sourceSpecifier, context);
}
