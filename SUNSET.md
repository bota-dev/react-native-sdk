# Standalone React Native SDK sunset

Maintenance of `@bota.dev/react-native-sdk` ended on September 29, 2026.
New SDK work and support move to [Bota App SDK](https://github.com/bota-dev/app-sdk).
Existing npm versions, tags and source history remain available. Retirement does
not replace installed packages or change their tarballs.

## Migrate

Use `@bota.dev/react-native-app-sdk`, currently `2.0.0-beta.7` (a prerelease).
Follow the [migration guide](https://github.com/bota-dev/app-sdk/blob/main/docs/migrations/app-sdk-package-names.md)
and [compatibility limits](https://github.com/bota-dev/app-sdk/blob/main/docs/parity/maintenance-baseline.md).

```sh
npm uninstall @bota.dev/react-native-sdk
npm install --save-exact @bota.dev/react-native-app-sdk@2.0.0-beta.7
```

Update imports and rebuild the native application. The successor requires a
compatible React/React Native and native OS matrix; it is not a JavaScript-only
package replacement. Native files replace legacy JS byte stores. Scoped backend
completion callbacks and connection identity checks remain required. Do not
co-install the old and new facades.

Demo 1.0.10, Bota One 1.0.7 and the public React Native example already use App
SDK beta.6. Beta.7 repairs publication tooling, so those verified binaries remain
valid. The [beta.7 release](https://github.com/bota-dev/app-sdk/releases/tag/v2.0.0-beta.7)
published all five SDK packages. Retirement does not promote it to stable or
establish physical iPhone acceptance.

## Retained history

The old package's final `latest` version is `0.0.67`; its historical `beta` tag
is `1.2.0-beta.11`. Both package lines are retired. Tags are preserved rather
than redirected to another package. No further release from this repository is
planned; the old publishing instructions are retained as historical evidence.

Issues [#1](https://github.com/bota-dev/react-native-sdk/issues/1),
[#2](https://github.com/bota-dev/react-native-sdk/issues/2) and
[#3](https://github.com/bota-dev/react-native-sdk/issues/3) retain their original
reports. Retirement does not mark them fixed or prove their old acceptance
criteria. Report current App SDK problems in the
[App SDK tracker](https://github.com/bota-dev/app-sdk/issues).
