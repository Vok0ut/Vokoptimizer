// Precompiles the React/JSX renderer into a single minified bundle (no runtime Babel).
const esbuild = require('esbuild');
const watch = process.argv.includes('--watch');

const opts = {
  entryPoints: ['src/renderer.jsx'],
  bundle: true,
  outfile: 'src/app.bundle.js',
  format: 'iife',
  minify: true,
  sourcemap: false,
  target: ['chrome120'],
  define: { 'process.env.NODE_ENV': '"production"' },
  logLevel: 'info',
};

(async () => {
  if (watch) {
    const ctx = await esbuild.context(opts);
    await ctx.watch();
    console.log('esbuild: watching renderer...');
  } else {
    await esbuild.build(opts).catch(() => process.exit(1));
    console.log('esbuild: renderer bundled -> src/app.bundle.js');
  }
})();
