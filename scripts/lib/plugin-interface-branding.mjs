export const EXPECTED_PLUGIN_BRANDING = Object.freeze({
  logo: "./assets/logo.png",
  composerIcon: "./assets/icon.png",
});

export function assertPluginInterfaceBranding(
  manifest,
  label,
  expected = EXPECTED_PLUGIN_BRANDING,
) {
  const interfaceSpec = manifest?.interface;
  if (interfaceSpec?.logo !== expected.logo
    || interfaceSpec?.composerIcon !== expected.composerIcon) {
    throw new Error(
      `${label} must declare top-level interface.logo=${expected.logo} and interface.composerIcon=${expected.composerIcon}`,
    );
  }
}
