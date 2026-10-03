const { withAndroidManifest, withMainApplication, withDangerousMod, withAppBuildGradle } = require('@expo/config-plugins');
const fs = require('node:fs/promises');
const path = require('node:path');

function configurePhoneTap(manifest) {
  manifest['uses-feature'] ??= [];
  manifest['uses-feature'] = manifest['uses-feature'].filter((f) => f.$['android:name'] !== 'android.hardware.nfc.hce');
  manifest['uses-feature'].push({ $: { 'android:name': 'android.hardware.nfc.hce', 'android:required': 'false' } });
  const app = manifest.application?.[0];
  if (!app) throw new Error('Missing Android application.');
  app.service ??= [];
  const name = 'com.onchainpayments.devnet.nfc.PhoneTapService';
  app.service = app.service.filter((s) => s.$['android:name'] !== name);
  app.service.push({
    $: { 'android:name': name, 'android:exported': 'true', 'android:permission': 'android.permission.BIND_NFC_SERVICE' },
    'intent-filter': [{ action: [{ $: { 'android:name': 'android.nfc.cardemulation.action.HOST_APDU_SERVICE' } }] }],
    'meta-data': [{ $: { 'android:name': 'android.nfc.cardemulation.host_apdu_service', 'android:resource': '@xml/phone_tap_service' } }],
  });
  return manifest;
}
function registerPhoneTap(source) {
  const registration = 'add(com.onchainpayments.devnet.nfc.PhoneTapPackage())';
  if (source.includes(registration)) return source;
  const marker = 'PackageList(this).packages.apply {';
  if (!source.includes(marker)) throw new Error('Cannot register PhoneTapPackage in MainApplication.');
  return source.replace(marker, marker + '\n          ' + registration);
}
module.exports = (config) => {
  config = withAndroidManifest(config, (mod) => { configurePhoneTap(mod.modResults.manifest); return mod; });
  config = withMainApplication(config, (mod) => { mod.modResults.contents = registerPhoneTap(mod.modResults.contents); return mod; });
  config = withAppBuildGradle(config, (mod) => {
    const dependency = 'testImplementation("junit:junit:4.13.2")';
    if (!mod.modResults.contents.includes(dependency)) mod.modResults.contents = mod.modResults.contents.replace('dependencies {', 'dependencies {\n    ' + dependency);
    return mod;
  });
  return withDangerousMod(config, ['android', async (mod) => {
    const root = mod.modRequest.platformProjectRoot;
    const source = path.join(mod.modRequest.projectRoot, 'native/phone-tap');
    const target = path.join(root, 'app/src/main/java/com/onchainpayments/devnet/nfc');
    await fs.mkdir(target, { recursive: true });
    for (const file of ['PhoneTapProtocol.kt', 'PhoneTapService.kt', 'PhoneTapModule.kt', 'PhoneTapPackage.kt']) await fs.copyFile(path.join(source, file), path.join(target, file));
    await fs.mkdir(path.join(root, 'app/src/main/res/xml'), { recursive: true });
    await fs.copyFile(path.join(source, 'phone_tap_service.xml'), path.join(root, 'app/src/main/res/xml/phone_tap_service.xml'));
    const tests = path.join(root, 'app/src/test/java/com/onchainpayments/devnet/nfc');
    await fs.mkdir(tests, { recursive: true });
    await fs.copyFile(path.join(source, 'PhoneTapProtocolTest.kt'), path.join(tests, 'PhoneTapProtocolTest.kt'));
    return mod;
  }]);
};
module.exports.configurePhoneTap = configurePhoneTap;
module.exports.registerPhoneTap = registerPhoneTap;
