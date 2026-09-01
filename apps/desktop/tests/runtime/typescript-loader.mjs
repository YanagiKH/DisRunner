import { access, readFile } from 'node:fs/promises';

import ts from 'typescript';

export async function resolve(specifier, context, nextResolve) {
  if (specifier.endsWith('.cjs') && context.parentURL?.endsWith('.cts')) {
    const sourceUrl = new URL(specifier.replace(/\.cjs$/u, '.cts'), context.parentURL);
    try {
      await access(sourceUrl);
      return { shortCircuit: true, url: sourceUrl.href };
    } catch {
      // Fall through to Node's normal resolver for external CommonJS modules.
    }
  }
  return nextResolve(specifier, context);
}

export async function load(url, context, nextLoad) {
  if (!url.endsWith('.cts')) return nextLoad(url, context);
  const source = await readFile(new URL(url), 'utf8');
  const transpiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2023,
      verbatimModuleSyntax: false,
    },
    fileName: new URL(url).pathname.replace(/\.cts$/u, '.ts'),
    reportDiagnostics: true,
  });
  const errors = (transpiled.diagnostics ?? []).filter(
    (diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
  );
  if (errors.length > 0) {
    throw new SyntaxError(
      errors
        .map((diagnostic) => ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
        .join('\n'),
    );
  }
  return { format: 'module', shortCircuit: true, source: transpiled.outputText };
}
