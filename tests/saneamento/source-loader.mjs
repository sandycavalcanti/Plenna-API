// Exercise current TypeScript without overwriting the tracked dist artifacts.
export async function resolve(specifier, context, nextResolve) {
  if (specifier.includes('/dist/src/') && specifier.endsWith('.js')) {
    specifier = specifier
      .replace('/dist/src/', '/src/')
      .replace(/\.js$/, '.ts');
  }
  return nextResolve(specifier, context);
}
