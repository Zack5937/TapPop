const { withAndroidManifest } = require('@expo/config-plugins');

function configurePaymentNfc(manifest) {
  manifest['uses-permission'] ??= [];
  if (!manifest['uses-permission'].some((p) => p.$['android:name'] === 'android.permission.NFC')) {
    manifest['uses-permission'].push({ $: { 'android:name': 'android.permission.NFC' } });
  }
  manifest['uses-feature'] ??= [];
  manifest['uses-feature'] = manifest['uses-feature'].filter((f) => f.$['android:name'] !== 'android.hardware.nfc');
  manifest['uses-feature'].push({ $: { 'android:name': 'android.hardware.nfc', 'android:required': 'false' } });
  const activity = manifest.application?.[0]?.activity?.find((a) => a.$['android:name'] === '.MainActivity');
  if (!activity) throw new Error('Cannot install payment NFC filters: MainActivity is missing.');
  activity['intent-filter'] ??= [];
  // Own only these narrow discovery filters; leave Expo VIEW links intact.
  activity['intent-filter'] = activity['intent-filter'].filter((f) => !f.action?.some((a) => a.$['android:name'] === 'android.nfc.action.NDEF_DISCOVERED')
    || !f.data?.some((d) => d.$['android:scheme'] === 'tappay'));
  for (const host of ['pay', 'merchant', 'settle']) {
    activity['intent-filter'].push({
      action: [{ $: { 'android:name': 'android.nfc.action.NDEF_DISCOVERED' } }],
      category: [{ $: { 'android:name': 'android.intent.category.DEFAULT' } }],
      data: [{ $: { 'android:scheme': 'tappay', 'android:host': host } }],
    });
  }
  return manifest;
}
module.exports = (config) => withAndroidManifest(config, (mod) => {
  configurePaymentNfc(mod.modResults.manifest);
  return mod;
});
module.exports.configurePaymentNfc = configurePaymentNfc;
