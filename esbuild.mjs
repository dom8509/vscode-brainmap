import * as esbuild from 'esbuild';
import { readdirSync } from 'node:fs';

const args = new Set(process.argv.slice(2));
const production = args.has('--production');
const watch = args.has('--watch');

const common = {
  bundle: true,
  minify: production,
  sourcemap: !production,
  logLevel: 'info',
};

const builds = args.has('--tests')
  ? [
      {
        ...common,
        entryPoints: readdirSync('test')
          .filter((f) => f.endsWith('.test.ts'))
          .map((f) => `test/${f}`),
        outdir: 'dist-test',
        platform: 'node',
        format: 'cjs',
        sourcemap: false,
      },
    ]
  : [
      {
        ...common,
        entryPoints: ['src/extension.ts'],
        outfile: 'dist/extension.js',
        platform: 'node',
        format: 'cjs',
        external: ['vscode'],
      },
      {
        ...common,
        entryPoints: ['src/webview/main.ts'],
        outfile: 'dist/webview.js',
        platform: 'browser',
        format: 'iife',
      },
    ];

if (watch) {
  for (const b of builds) {
    const ctx = await esbuild.context(b);
    await ctx.watch();
  }
} else {
  await Promise.all(builds.map((b) => esbuild.build(b)));
}
