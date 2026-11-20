// Packages Perflw for Windows x64 into dist/Perflw-win32-x64.
// Usage: npm run build
// Keeps the package small: development folders stay out, pdf.js ships only the builds the app loads,
// Chromium keeps only the en-US locale (it falls back to en-US for every other system language), and runtime parts
// the app never uses are left out.
const path = require('node:path');
const fs = require('node:fs');
const { packager } = require('@electron/packager');

const root = path.join(__dirname, '..');

const ignore = [
  /^\/(dist|test|docs|scripts|\.claude)(\/|$)/,
  /^\/(README\.md|desktop\.ini|\.gitignore|package-lock\.json)$/,
  // pdf.js: the renderer loads build/pdf.min.mjs + build/pdf.worker.min.mjs; the main process loads
  // legacy/build/pdf.mjs, which imports legacy/build/pdf.worker.mjs in Node. Everything else is unused.
  /^\/node_modules\/pdfjs-dist\/(types|web|image_decoders|cmaps|standard_fonts|iccs)(\/|$)/,
  /^\/node_modules\/pdfjs-dist\/legacy\/(web|image_decoders)(\/|$)/,
  /^\/node_modules\/pdfjs-dist\/build\/pdf(\.worker)?\.mjs$/,
  /^\/node_modules\/pdfjs-dist\/legacy\/build\/pdf(\.worker)?\.min\.mjs$/,
  /^\/node_modules\/pdfjs-dist\/(legacy\/)?build\/pdf\.sandbox(\.min)?\.mjs$/,
  /\.(map|d\.ts|d\.mts|md)$/
];

/* Parts of the Electron runtime Perflw never uses (about 30 MB):
     dxcompiler.dll, dxil.dll           WebGPU shader compiler (Dawn); the app draws with Canvas 2D and CSS only
     vk_swiftshader*, vulkan-1.dll      software Vulkan / WebGL fallback; ANGLE on Direct3D (d3dcompiler_47.dll, kept) draws the UI */
const UNUSED_RUNTIME = ['dxcompiler.dll', 'dxil.dll', 'vk_swiftshader.dll', 'vk_swiftshader_icd.json', 'vulkan-1.dll'];
function trimRuntime(buildPath, _electronVersion, _platform, _arch, done) {
  try {
    const dir = path.join(buildPath, 'locales');
    for (const file of fs.readdirSync(dir)) if (file !== 'en-US.pak') fs.rmSync(path.join(dir, file));
    for (const file of UNUSED_RUNTIME) fs.rmSync(path.join(buildPath, file), { force: true });
    done();
  } catch (error) { done(error); }
}

packager({
  dir: root,
  name: 'Perflw',
  executableName: 'Perflw',
  appCopyright: 'Perflw',
  win32metadata: { ProductName: 'Perflw', FileDescription: 'Perflw', CompanyName: 'Perflw' },
  platform: 'win32',
  arch: 'x64',
  out: path.join(root, 'dist'),
  overwrite: true,
  icon: path.join(root, 'assets', 'icon.ico'),
  // The @napi-rs/canvas native module (pdf.js text reading in the main process) and its icudtl.dat
  // cannot load from inside an asar, so its folder stays unpacked.
  asar: { unpack: '**/*.node', unpackDir: '**/node_modules/@napi-rs/canvas-win32-x64-msvc' },
  prune: true,
  ignore,
  afterExtract: [trimRuntime]
}).then(paths => {
  for (const p of paths) console.log(`Built ${p}`);
}).catch(error => {
  console.error(error);
  process.exit(1);
});
