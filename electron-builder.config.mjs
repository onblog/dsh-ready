import { execFileSync } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = dirname(fileURLToPath(import.meta.url))

export default {
  appId: 'com.onblog.dsh-ready',
  productName: 'DSH 就位',
  directories: {
    output: 'release',
    buildResources: 'assets',
  },
  files: ['electron/**/*', 'renderer/**/*', 'package.json'],
  asar: true,
  // The live origin and the contact address never enter the repository, so they are
  // baked into a generated module right before packaging (from SITE_URL /
  // CONTACT_EMAIL, env or .env). Every `dist*` script gets it for free this way.
  beforeBuild: () => {
    execFileSync(process.execPath, [join(ROOT, 'scripts', 'write-site-config.cjs')], {
      stdio: 'inherit',
    })
  },
  // Ad-hoc signing happens in afterPack, on the exact bundle that goes into the
  // dmg; that hook runs after packaging and before the dmg is built.
  afterPack: 'scripts/after-pack.cjs',
  // macOS on Apple Silicon has no Rosetta here: the legacy NSIS bundle is an
  // x86_64 makensis and cannot run. 1.2.1 is the unified bundle with a native
  // darwin-arm64 entrypoint.
  toolsets: {
    nsis: '1.2.1',
  },
  mac: {
    icon: 'assets/icon.icns',
    // Signing is handled by afterPack; a bogus identity here would make
    // electron-builder silently skip signing, and an unsigned bundle is
    // reported as "damaged" on Apple Silicon.
    identity: null,
    category: 'public.app-category.developer-tools',
    target: [{ target: 'dmg', arch: ['arm64', 'x64'] }],
    artifactName: 'dsh-ready-${version}-${arch}.${ext}',
    // No paid Apple certificate. Ad-hoc signing is done in afterPack; Gatekeeper
    // still shows the standard "unidentified developer" block once and lets the
    // user allow it from System Settings → Privacy & Security.
    hardenedRuntime: false,
    gatekeeperAssess: false,
  },
  dmg: {
    title: 'DSH 就位',
  },
  win: {
    icon: 'assets/icon.png',
    executableName: 'dsh-ready',
    target: [{ target: 'nsis', arch: ['x64'] }],
    artifactName: 'dsh-ready-${version}-${arch}.${ext}',
  },
  nsis: {
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    shortcutName: 'DSH 就位',
  },
  linux: {
    target: ['AppImage'],
    category: 'Development',
    artifactName: 'dsh-ready-${version}-${arch}.${ext}',
  },
}
