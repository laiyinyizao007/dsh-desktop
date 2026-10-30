/**
 * electron-builder configuration for an unofficial Linux/arm64 build of
 * DSH Desktop.
 *
 * The upstream project ships macOS and Windows builds only (the README lists
 * Linux as "Not currently supported"), so this file layers a Linux target on
 * top of the repository's own `package.json#build` block instead of editing it.
 *
 * Usage:
 *   npx electron-vite build
 *   npx electron-builder --linux --arm64 --publish never --config electron-builder.linux.cjs
 */
const packageJson = require('./package.json')

const base = packageJson.build

module.exports = {
  ...base,
  appId: 'io.dsh.desktop',
  productName: 'DSH Desktop',
  // electron-builder refuses to reuse the macOS-only notarize hook.
  afterSign: undefined,
  // The upstream `afterPack` gate runs a Windows `.exe` verifier, so it must be
  // dropped for the Linux target (it fails with ENOENT on a `.exe` that does
  // not exist on this platform).
  afterPack: undefined,
  // The upstream `beforePack` script prepares the macOS DMG background image,
  // which only exists on macOS. Keep the Linux build independent of it.
  artifactName: 'dsh-desktop-linux-${arch}.${ext}',
  directories: {
    ...base.directories,
    output: 'dist-linux'
  },
  linux: {
    target: [
      {
        target: 'AppImage',
        arch: ['arm64']
      },
      {
        target: 'deb',
        arch: ['arm64']
      }
    ],
    category: 'Development',
    icon: 'build/icon.png',
    // The app ships its own fonts; keep the desktop entry self-contained.
    synopsis: 'DSH Desktop — DeepSeek Harness desktop shell',
    description: 'Unofficial Linux build of DSH Desktop (DeepSeek Harness desktop).',
    desktop: {
      entry: {
        Name: 'DSH Desktop',
        Comment: 'DeepSeek Harness desktop shell',
        Categories: 'Development;IDE;',
        StartupWMClass: 'dsh-desktop',
        MimeType: 'x-scheme-handler/dsh;'
      }
    }
  },
  deb: {
    depends: [
      'libgtk-3-0',
      'libnotify4',
      'libnss3',
      'libxss1',
      'libxtst6',
      'xdg-utils',
      'libatspi2.0-0',
      'libuuid1',
      'libsecret-1-0'
    ],
    priority: 'optional'
  },
  publish: null
}
