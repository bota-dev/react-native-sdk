import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const workflow = readFileSync(new URL('../.github/workflows/publish.yml', import.meta.url), 'utf8');

test('legacy release CI is candidate-only and cannot publish to npm', () => {
  assert.match(workflow, /tags:\s*\n\s*- ['"]v0\.0\.\*['"]/);
  assert.doesNotMatch(workflow, /^\s{2}release:/m);
  assert.doesNotMatch(workflow, /id-token:\s*write/);
  assert.doesNotMatch(workflow, /registry-url:/);
  assert.doesNotMatch(workflow, /\bnpm(?:@[^ ]+)?\s+publish\b/);
  assert.doesNotMatch(workflow, /\bnpx\b[^\n]*\bpublish\b/);
});

test('legacy candidates use a fixed npm CLI and immutable tag identity', () => {
  assert.match(workflow, /NPM_CLI_VERSION:\s*['"]?12\.0\.2['"]?/);
  assert.match(workflow, /git cat-file -t "\$GITHUB_REF_NAME"/);
  assert.match(workflow, /git merge-base --is-ancestor "\$SOURCE_REVISION" origin\/main/);
  assert.match(workflow, /test "\$GITHUB_REF_NAME" = "v\$PACKAGE_VERSION"/);
  assert.match(workflow, /\^v0\\\.0\\\.\[0-9\]\+\$/);
});

test('legacy candidates are packed twice, verified, and preserved', () => {
  assert.equal((workflow.match(/\bpack --ignore-scripts\b/g) ?? []).length, 2);
  assert.match(workflow, /cmp "\$FIRST_TARBALL" "\$SECOND_TARBALL"/);
  assert.match(workflow, /release:candidate -- create/);
  assert.match(workflow, /release:candidate -- verify/);
  assert.match(workflow, /actions\/upload-artifact@/);
  assert.match(workflow, /legacy-react-native-\$\{\{ github\.ref_name \}\}-\$\{\{ env\.SOURCE_REVISION \}\}/);
});
