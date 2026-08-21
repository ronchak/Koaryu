export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const modulePath = specifier.slice(2);
    const withExtension = /\.[cm]?[jt]sx?$/.test(modulePath)
      ? modulePath
      : `${modulePath}.ts`;
    return {
      shortCircuit: true,
      url: new URL(`../../src/${withExtension}`, import.meta.url).href,
    };
  }

  return nextResolve(specifier, context);
}
