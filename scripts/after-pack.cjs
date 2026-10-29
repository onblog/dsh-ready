'use strict';

const { execFileSync, spawnSync } = require('node:child_process');
const path = require('node:path');

/**
 * Ad-hoc sign the packaged macOS app before the dmg is built.
 *
 * Without any signature an Apple Silicon Mac refuses to launch the bundle and
 * macOS reports it as "damaged". Ad-hoc signing is enough to make the binary
 * valid and launchable; because it is not an Apple Developer ID and the app is
 * not notarized, Gatekeeper still treats a quarantined copy as being from an
 * unidentified developer, which is the expected flow (allow it once in
 * System Settings → Privacy & Security → Open Anyway).
 *
 * Signing happens here, in afterPack, so it runs on the exact bundle that goes
 * into the dmg for every architecture. electron-builder's own identity: option
 * is left at null: a self-signed or ad-hoc identity configured there is easy to
 * get wrong, and a silently skipped signature is what produces "damaged".
 */
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${appName}.app`);

  execFileSync('codesign', ['--deep', '--force', '--sign', '-', appPath], {
    stdio: 'inherit',
  });

  // codesign -dv writes its report to stderr.
  const verify = spawnSync('codesign', ['-dv', appPath], { encoding: 'utf8' });
  const info = `${verify.stdout ?? ''}${verify.stderr ?? ''}`;
  const sealed = info.split('\n').find((line) => line.startsWith('Sealed Resources')) ?? '';
  console.log(`[after-pack] ad-hoc signed ${appPath}`);
  console.log(`[after-pack] ${sealed.trim()}`);
};
