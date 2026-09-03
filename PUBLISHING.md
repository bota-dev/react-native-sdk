# Publishing The Legacy React Native SDK

This repository owns the production `0.0.x` maintenance line of
`@bota.dev/react-native-sdk`. Untagged npm installs resolve through the
`latest` dist-tag. The synchronized Bota App SDK is published from
[`bota-dev/app-sdk`](https://github.com/bota-dev/app-sdk) under the `beta`
dist-tag.

GitHub Actions never publishes this maintenance line. It builds and preserves
one checksum-bound candidate; a maintainer publishes that exact tarball from an
interactive npm session protected by WebAuthn.

## 1. Prepare The Version

1. Update `package.json` and `package-lock.json` to the same new `0.0.x`
   version.
2. Run the normal typecheck, test, release-policy, and build gates.
3. Merge the reviewed version commit to `main`.

Do not use a stable `1.x` version in this repository. Do not move either npm
dist-tag while preparing source.

## 2. Create The Candidate

Create an annotated tag on the exact `main` commit and push it:

```bash
set -euo pipefail
VERSION="$(node -p 'require("./package.json").version')"
SOURCE_REVISION="$(git rev-parse HEAD)"
git tag -a "v$VERSION" -m "Bota React Native SDK $VERSION"
git push origin "v$VERSION"
```

The **Prepare legacy release candidate** workflow accepts only an exact
annotated `v0.0.x` tag whose commit belongs to `origin/main`. It runs the gates,
packs twice with npm `12.0.2`, rejects byte drift, and uploads:

```text
legacy-react-native-v0.0.x-<source-revision>
```

The artifact contains the npm tarball and `release-candidate.json`. Download it
beside a checkout of the same tag. Never rebuild after tagging.

## 3. Verify Before Authentication

```bash
set -euo pipefail
PACKAGE_PATH="$(find . -maxdepth 1 -name '*.tgz' -print -quit)"
node scripts/release-candidate.mjs verify \
  --tarball "$PACKAGE_PATH" \
  --inventory release-candidate.json
BETA_BEFORE="$(npx --yes npm@12.0.2 view @bota.dev/react-native-sdk dist-tags.beta)"
```

Stop if verification fails or if the inventory source revision is not the
tagged commit. If the version already exists on npm, compare its `dist.shasum`
with `tarball.sha1` in the inventory. The same hash means publication is already
complete; a different hash is a hard stop.

## 4. Publish The Preserved Tarball

Sign in to npm interactively with the maintainer account, then publish only the
downloaded tarball:

```bash
set -euo pipefail
npx --yes npm@12.0.2 publish "$PACKAGE_PATH" --access public --tag latest
```

Do not publish the checkout directory and do not omit `--tag latest`.

## 5. Verify The Registry

```bash
set -euo pipefail
VERSION="$(node -p 'require("./release-candidate.json").version')"
EXPECTED_SHA1="$(node -p 'require("./release-candidate.json").tarball.sha1')"
PUBLISHED_SHA1="$(npx --yes npm@12.0.2 view "@bota.dev/react-native-sdk@$VERSION" dist.shasum)"
LATEST_AFTER="$(npx --yes npm@12.0.2 view @bota.dev/react-native-sdk dist-tags.latest)"
BETA_AFTER="$(npx --yes npm@12.0.2 view @bota.dev/react-native-sdk dist-tags.beta)"
test "$PUBLISHED_SHA1" = "$EXPECTED_SHA1"
test "$LATEST_AFTER" = "$VERSION"
test "$BETA_AFTER" = "$BETA_BEFORE"
```

The release is complete only when the published bytes match, `latest` points
to the new `0.0.x` version, and `beta` is unchanged.
