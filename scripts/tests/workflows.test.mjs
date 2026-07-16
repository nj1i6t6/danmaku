import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import test from 'node:test';

const ROOT = new URL('../../', import.meta.url);
const read = async (path) => readFile(new URL(path, ROOT), 'utf8');
const ANDROID_RELEASE_SECRETS = [
  'ANDROID_RELEASE_KEYSTORE_BASE64',
  'ANDROID_RELEASE_STORE_PASSWORD',
  'ANDROID_RELEASE_KEY_ALIAS',
  'ANDROID_RELEASE_KEY_PASSWORD',
];

const required = {
  'ci.yml': [
    /pull_request:/, /push:/, /npm ci --prefix app/, /npm test --prefix app/,
    /npm ci --prefix clients\/web-overlay/, /npm test --prefix clients\/web-overlay/,
    /node --test desktop\/tests\/\*\.test\.mjs/, /cargo test --manifest-path desktop\/src-tauri\/Cargo\.toml/,
    /testDebugUnitTest lintDebug assembleDebug/, /verify-retired-stock\.mjs/, /verify-public-tree\.mjs/,
    /node --test --test-concurrency=1 scripts\/tests\/\*\.test\.mjs/, /npm audit --omit=dev --audit-level=high/,
    /DANMAKU_SERVER_URL:\s*http:\/\/127\.0\.0\.1:3999/, /verify-release-candidate\.mjs/,
  ],
  'build-windows.yml': [
    /workflow_dispatch:/, /runs-on: windows-latest/, /npm ci --prefix app/,
    /npm ci --prefix clients\/web-overlay/,
    /node --test desktop\/tests\/config\.test\.mjs desktop\/tests\/room-contract\.test\.mjs/, /cargo test --manifest-path desktop\/src-tauri\/Cargo\.toml/,
    /npm run tauri:build --prefix clients\/web-overlay/, /cargo install tauri-cli --version ["']2\.11\.4["'] --locked/, /UNSIGNED-ARTIFACT\.txt/, /unsigned/i, /\.exe/, /\.msi/,
  ],
  'build-macos.yml': [
    /workflow_dispatch:/, /runs-on: macos-latest/, /npm ci --prefix clients\/web-overlay/,
    /cargo test --manifest-path desktop\/src-tauri\/Cargo\.toml/, /cargo install tauri-cli --version ["']2\.11\.4["'] --locked/,
    /npm run tauri:build --prefix clients\/web-overlay/, /unsigned/i, /\.app/, /\.dmg/,
  ],
  'build-browser-extension.yml': [
    /workflow_dispatch:/, /npm ci --prefix clients\/web-overlay/,
    /playwright install/, /id:\s*chromium/, /CHROMIUM_PATH:\s*\$\{\{ steps\.chromium\.outputs\.path \}\}/,
    /UNPACKED_CHROMIUM_PATH:\s*\$\{\{ steps\.chromium\.outputs\.path \}\}/,
    /test:e2e/, /test:e2e:unpacked/, /package:extension/,
    /sha256/i, /verify:extension/, /upload-artifact/,
  ],
  'build-android.yml': [
    /workflow_dispatch:/, /if:\s*startsWith\(github\.ref,\s*['"]refs\/tags\/v['"]\)/, /environment:\s*android-release/, /DANMAKU_SERVER_URL:\s*https:\/\/danmaku\.kolvid\.app/,
    /testDebugUnitTest lintRelease assembleRelease bundleRelease/, /upload-artifact/,
    /ANDROID_RELEASE_KEYSTORE_BASE64/, /ANDROID_RELEASE_STORE_PASSWORD/,
    /ANDROID_RELEASE_KEY_ALIAS/, /ANDROID_RELEASE_KEY_PASSWORD/,
    /umask\s+077/, /RUNNER_TEMP/, /base64\s+(?:--decode|-d)/, /chmod\s+600/, /if:\s*always\(\)/,
    /ANDROID_HOME\/build-tools\/34\.0\.0\/apksigner/, /test\s+-x/,
    /jarsigner\s+(?:--verify|-verify)/, /jar verified\./, /jar is unsigned/,
    /Signer #1 certificate SHA-256 digest/, /f84e66da1201106a5b93bdc8f0a8747cd0482dc4fbb30a0dbf647bcb65f12578/,
    /sha256sum/, /danmaku-android-release/,
  ],
};

test('required CI and native/package workflows contain their verification gates', async () => {
  for (const [name, patterns] of Object.entries(required)) {
    const source = await read(`.github/workflows/${name}`);
    for (const pattern of patterns) assert.match(source, pattern, `${name} is missing ${pattern}`);
  }
});

test('workflows are verification-only, least-privilege, and use GitHub-hosted runners', async () => {
  const names = (await readdir(new URL('.github/workflows/', ROOT))).filter((name) => /\.ya?ml$/.test(name));
  assert.deepEqual(names.sort(), Object.keys(required).sort());
  for (const name of names) {
    const source = await read(`.github/workflows/${name}`);
    assert.match(source, /permissions:\s*\n\s*contents:\s*read/);
    assert.match(source, /actions\/checkout@v6[\s\S]*persist-credentials:\s*false/);
    assert.doesNotMatch(source, /actions\/(?:checkout|setup-node|setup-java|upload-artifact)@v[1-4]\b|setup-android@v[1-3]\b|setup-gradle@v[1-5]\b/);
    assert.doesNotMatch(source, /self-hosted|\bssh\b|\bscp\b|systemctl|kubectl|docker\s+push|gh\s+release|create-release|webstore|edge-addons/i);
    const permissionsBlock = source.match(/^permissions:[\s\S]*?(?=^jobs:)/m)?.[0] || '';
    assert.doesNotMatch(permissionsBlock, /\b(?:write|write-all)\b/i);
    const secretNames = [...source.matchAll(/\bsecrets\.([A-Z][A-Z0-9_]*)/g)].map((match) => match[1]);
    if (name === 'build-android.yml') {
      assert.deepEqual([...new Set(secretNames)].sort(), [...ANDROID_RELEASE_SECRETS].sort(), `${name} has an unexpected secret set`);
    } else {
      assert.deepEqual(secretNames, [], `${name} must not access GitHub secrets`);
    }
  }
});

test('public release workflows use the production endpoint only for final artifacts', async () => {
  const extension = await read('.github/workflows/build-browser-extension.yml');
  const extensionProductionStart = extension.indexOf('- name: Build production extension');
  const extensionFixture = extension.slice(extension.indexOf('- name: Build extension'), extensionProductionStart);
  assert.match(extensionFixture, /DANMAKU_SERVER_URL:\s*http:\/\/127\.0\.0\.1:3999/);
  const unpackedStart = extension.indexOf('- name: Run genuine unpacked MV3 lifecycle test');
  const loopbackDesktopStart = extension.indexOf('- name: Build loopback desktop output for release candidate');
  const loopbackPackageStart = extension.indexOf('- name: Package loopback extension for release candidate');
  const rcVerifyStart = extension.indexOf('- name: Verify local release-candidate invariants');
  assert.ok(unpackedStart >= 0 && unpackedStart < loopbackDesktopStart, 'unpacked test must precede RC desktop build');
  assert.ok(loopbackDesktopStart < loopbackPackageStart, 'RC desktop build must precede RC package');
  assert.ok(loopbackPackageStart < rcVerifyStart, 'RC package must precede RC verifier');
  assert.ok(rcVerifyStart < extensionProductionStart, 'RC verifier must pass before production extension build');
  const extensionRcGate = extension.slice(unpackedStart, extensionProductionStart);
  assert.match(
    extensionRcGate,
    /- name: Build loopback desktop output for release candidate\s+env:\s+DANMAKU_SERVER_URL:\s*http:\/\/127\.0\.0\.1:3999\s+run:\s*npm run build:desktop --prefix clients\/web-overlay/s,
  );
  assert.match(extensionRcGate, /- name: Package loopback extension for release candidate\s+run:\s*npm run package:extension --prefix clients\/web-overlay/s);
  assert.match(extensionRcGate, /- name: Verify local release-candidate invariants\s+run:\s*node scripts\/verify-release-candidate\.mjs --root \./s);
  assert.doesNotMatch(extensionRcGate, /DANMAKU_SERVER_URL:\s*https:\/\/danmaku\.kolvid\.app/);
  const extensionPackageStart = extension.indexOf('- name: Package extension and SHA-256 checksum');
  const extensionPrePackage = extension.slice(extension.indexOf('- name: Run genuine unpacked MV3 lifecycle test'), extensionPackageStart);
  assert.match(
    extensionPrePackage,
    /- name: Build production extension\s+env:\s+DANMAKU_SERVER_URL:\s*https:\/\/danmaku\.kolvid\.app\s+run:\s*npm run build:extension --prefix clients\/web-overlay/s,
  );
  assert.match(extensionPrePackage, /- name: Verify production extension\s+run:\s*npm run verify:extension --prefix clients\/web-overlay/s);
  assert.ok(extensionPackageStart > extension.indexOf('- name: Verify production extension'), 'production extension must be verified before packaging');
  assert.ok(extensionPackageStart > rcVerifyStart, 'production packaging must follow the RC gate');

  const windows = await read('.github/workflows/build-windows.yml');
  const windowsBuild = windows.slice(windows.indexOf('- name: Build Windows bundles'), windows.indexOf('- name: Upload Windows bundles'));
  assert.match(windowsBuild, /DANMAKU_SERVER_URL:\s*https:\/\/danmaku\.kolvid\.app/);
  assert.doesNotMatch(windowsBuild, /example\.invalid|127\.0\.0\.1/);

  const macos = await read('.github/workflows/build-macos.yml');
  const macosBuild = macos.slice(macos.indexOf('- name: Build unsigned macOS bundles'), macos.indexOf('- name: Mark artifacts as unsigned'));
  assert.match(macosBuild, /DANMAKU_SERVER_URL:\s*https:\/\/danmaku\.kolvid\.app/);
  assert.doesNotMatch(macosBuild, /example\.invalid|127\.0\.0\.1/);

  const ci = await read('.github/workflows/ci.yml');
  const ciBuild = ci.slice(ci.indexOf('- name: Build desktop and extension generated output'), ci.indexOf('- name: Test desktop JavaScript'));
  assert.match(ciBuild, /DANMAKU_SERVER_URL:\s*http:\/\/127\.0\.0\.1:3999/);
  assert.doesNotMatch(ciBuild, /https:\/\/danmaku\.kolvid\.app/);
});

test('Windows fresh checkouts run source policy tests without Unix-only RC packaging', async () => {
  const source = await read('.github/workflows/build-windows.yml');
  const suiteStart = source.indexOf('- name: Test repository policy tools');
  const rustStart = source.indexOf('- name: Test Tauri Rust', suiteStart);
  assert.ok(suiteStart >= 0 && rustStart > suiteStart, 'Windows workflow must contain the source policy test step');
  const preSuite = source.slice(0, suiteStart);
  assert.match(preSuite, /- name: Build shared desktop assets[\s\S]*DANMAKU_SERVER_URL:\s*http:\/\/127\.0\.0\.1:3999[\s\S]*npm run build:desktop --prefix clients\/web-overlay/);
  assert.doesNotMatch(preSuite, /(?:build|verify|package):extension/);

  const suite = source.slice(suiteStart, rustStart);
  for (const name of [
    'workflows.test.mjs',
    'documentation.test.mjs',
    'android-parity.test.mjs',
    'verify-retired-stock.test.mjs',
  ]) {
    assert.match(suite, new RegExp(`scripts/tests/${name.replaceAll('.', '\\.')}`));
  }
  assert.doesNotMatch(suite, /public-export\.test\.mjs/);
  assert.doesNotMatch(suite, /release-candidate\.test\.mjs|scripts\/tests\/\*\.test\.mjs/);
});

test('Windows and macOS use explicit portable Node client tests instead of npm test', async () => {
  const clientTests = (await readdir(new URL('clients/web-overlay/tests/', ROOT)))
    .filter((name) => name.endsWith('.test.mjs') && name !== 'build.test.mjs')
    .sort();
  assert.equal(clientTests.length, 19, 'the portable client test set must contain exactly 19 tests');
  const expectedCommand = [
    'node',
    '--test',
    '--test-concurrency=1',
    ...clientTests.map((name) => `clients/web-overlay/tests/${name}`),
  ].join(' ');

  for (const name of ['build-windows.yml', 'build-macos.yml']) {
    const source = await read(`.github/workflows/${name}`);
    const testStart = source.indexOf('- name: Test shared and extension units');
    const buildStart = source.indexOf('- name: Build shared desktop assets', testStart);
    assert.ok(testStart >= 0 && buildStart > testStart, `${name} must have a portable client test step`);
    const testStep = source.slice(testStart, buildStart);
    assert.match(source, /node-version:\s*['"]20['"]/);
    assert.doesNotMatch(source, /npm test --prefix clients\/web-overlay/);
    assert.doesNotMatch(source, /(?:clients\/web-overlay|desktop)\/tests\/\*\.test\.mjs/);
    assert.doesNotMatch(testStep, /clients\/web-overlay\/tests\/build\.test\.mjs/);
    assert.doesNotMatch(testStep, /clients\/web-overlay\/tests\/\*\.test\.mjs/);
    assert.ok(testStep.includes(`run: ${expectedCommand}`), `${name} must list every portable client test explicitly`);
    for (const representative of [
      'safe-render.test.mjs',
      'extension-background.test.mjs',
      'desktop-panel.test.mjs',
      'cross-platform-contract.test.mjs',
    ]) {
      assert.match(testStep, new RegExp(`clients/web-overlay/tests/${representative.replace('.', '\\.')}`));
    }
  }
});

test('Windows and macOS validate real bundles before writing unsigned markers', async () => {
  const cases = [
    {
      name: 'build-windows.yml',
      verify: '- name: Verify Windows bundles exist',
      marker: '- name: Mark artifacts as unsigned',
      checks: [
        /Get-ChildItem[\s\S]*Join-Path \$bundleRoot 'nsis'[\s\S]*-Filter '\*\.exe'[\s\S]*-File/,
        /Get-ChildItem[\s\S]*Join-Path \$bundleRoot 'msi'[\s\S]*-Filter '\*\.msi'[\s\S]*-File/,
        /\.Count\s+-lt\s+1[\s\S]*throw/,
      ],
    },
    {
      name: 'build-macos.yml',
      verify: '- name: Verify macOS bundles exist',
      marker: '- name: Mark artifacts as unsigned',
      forbidden: /-(?:mindepth|maxdepth)\b/,
      checks: [
        /for app in "\$bundleRoot"\/macos\/\*\.app; do[\s\S]*\[\[ -d "\$app" \]\]/,
        /for dmg in "\$bundleRoot"\/dmg\/\*\.dmg; do[\s\S]*\[\[ -f "\$dmg" \]\]/,
        /\[\[ .* -lt 1 \]\][\s\S]*exit 1/,
      ],
    },
  ];

  for (const { name, verify, marker, forbidden, checks } of cases) {
    const source = await read(`.github/workflows/${name}`);
    const verifyStart = source.indexOf(verify);
    const markerStart = source.indexOf(marker);
    assert.ok(verifyStart >= 0 && markerStart > verifyStart, `${name} must verify bundles before its marker step`);
    const verification = source.slice(verifyStart, markerStart);
    if (forbidden) assert.doesNotMatch(verification, forbidden, `${name} uses a non-portable bundle check`);
    for (const check of checks) assert.match(verification, check, `${name} is missing a fail-closed bundle check`);
  }
});

test('Android release artifacts are fail-closed, uniquely staged, and uploaded from one directory', async () => {
  const source = await read('.github/workflows/build-android.yml');
  const verifyStart = source.indexOf('- name: Verify signed Android release and create SHA-256 checksums');
  const uploadStart = source.indexOf('- name: Upload signed Android release artifacts');
  const cleanupStart = source.indexOf('- name: Cleanup Android release secrets');
  assert.ok(verifyStart >= 0 && uploadStart > verifyStart, 'verification must precede upload');
  assert.ok(cleanupStart > uploadStart, 'cleanup must follow upload');

  const upload = source.slice(uploadStart, cleanupStart);
  assert.match(upload, /path:\s*\$\{\{ runner\.temp \}\}\/danmaku-android-release\s*$/m);
  assert.doesNotMatch(upload, /android\/app\/build\/outputs/);

  const verify = source.slice(verifyStart, uploadStart);
  assert.match(verify, /"\$apksigner" verify --verbose --print-certs "\$apk"/);
  assert.match(verify, /exactly one|恰好一個|\{#.*\} -eq 1/i);
  assert.match(verify, /grep[^\n]*jar verified\./);
  assert.match(verify, /grep[^\n]*jar is unsigned/);
  assert.match(verify, /certificate SHA-256 digest/);
  assert.match(verify, /f84e66da1201106a5b93bdc8f0a8747cd0482dc4fbb30a0dbf647bcb65f12578/);
  assert.match(verify, /cp ["']?\$apk["']? ["']?\$checksum_dir\//);
  assert.match(verify, /cp ["']?\$aab["']? ["']?\$checksum_dir\//);
  assert.match(verify, /sha256sum --check/);
});

test('Android AAB release identity is verified with keytool and cleaned up', async () => {
  const source = await read('.github/workflows/build-android.yml');
  const verifyStart = source.indexOf('- name: Verify signed Android release and create SHA-256 checksums');
  const uploadStart = source.indexOf('- name: Upload signed Android release artifacts');
  const cleanupStart = source.indexOf('- name: Cleanup Android release secrets');
  assert.ok(verifyStart >= 0 && uploadStart > verifyStart && cleanupStart > uploadStart);

  const verify = source.slice(verifyStart, uploadStart);
  const jarsignerGate = verify.indexOf("if grep -Fq 'jar is unsigned'");
  const keytoolStart = verify.indexOf('keytool -printcert -jarfile "$aab"');
  assert.ok(jarsignerGate >= 0 && keytoolStart > jarsignerGate, 'keytool must run after the existing jarsigner gate');
  assert.match(verify, /aab_certificate_output="\$\{RUNNER_TEMP\}\/danmaku-keytool-aab-cert\.txt"/);
  assert.match(verify, /keytool -printcert -jarfile "\$aab" > "\$aab_certificate_output"/);
  assert.match(verify, /grep -Ec '\^\[\[:space:\]\]\*SHA256:'/);
  assert.match(verify, /aab_digest_line_count[\s\S]*-ne 1/);
  assert.ok(verify.includes("tr -d '[:space:]:' | tr '[:upper:]' '[:lower:]'"), 'AAB fingerprint must normalize separators, whitespace, and case');
  assert.match(verify, /expected_release_certificate_sha256[\s\S]*f84e66da1201106a5b93bdc8f0a8747cd0482dc4fbb30a0dbf647bcb65f12578/);
  assert.match(verify, /aab_certificate_sha256[\s\S]*!= "\$expected_release_certificate_sha256"/);

  const cleanup = source.slice(cleanupStart);
  assert.match(cleanup, /danmaku-keytool-aab-cert\.txt/);
});

test('Windows desktop upload keeps the unsigned marker beside both installer classes', async () => {
  const source = await read('.github/workflows/build-windows.yml');
  const uploadStart = source.indexOf('- name: Upload Windows bundles');
  assert.match(source, /name: danmaku-overlay-windows-x86_64-unsigned/);
  assert.match(source, /- name: Mark artifacts as unsigned[\s\S]*UNSIGNED-ARTIFACT\.txt/);
  const upload = source.slice(uploadStart);
  assert.match(upload, /bundle\/nsis\/\*\.exe/);
  assert.match(upload, /bundle\/msi\/\*\.msi/);
  assert.match(upload, /bundle\/UNSIGNED-ARTIFACT\.txt/);
});

test('release workflow documentation distinguishes deployment secrets from protected Android signing secrets', async () => {
  for (const path of ['README.md', 'docs/architecture.md', 'docs/self-hosting.md']) {
    const source = await read(path);
    assert.match(source, /不使用部署[／\/]服務秘密/);
    assert.match(source, /Android release workflow 只使用受保護 environment 中的四個 signing secrets/);
  }
});
