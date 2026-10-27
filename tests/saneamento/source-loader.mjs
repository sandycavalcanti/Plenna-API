// Exercise current TypeScript without overwriting the tracked dist artifacts.
export async function resolve(specifier, context, nextResolve) {
  try {
    return await nextResolve(specifier, context);
  } catch (error) {
    if (!specifier.endsWith('.js')) throw error;
    const sourceSpecifier = specifier
      .replace('/dist/src/', '/src/')
      .replace(/\.js$/, '.ts');
    return nextResolve(sourceSpecifier, context);
  }
}
