// -----------------------------------------------------------------------------
// The texts users and contributors read are UTF-8 without BOM, without control
// bytes, and never mojibake: UTF-8 bytes read as Latin-1 / Windows-1252 and
// saved again ("é" becoming "Ã" + "©", "’" becoming "â" + "€" + "™").
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const MOJIBAKE = /[ÂÃ][\u0080-¿€]|â€/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b-\u001f\u007f]/;
const FILES = [
  'gladys-assistant-integration.json',
  'docs/en.md',
  'docs/fr.md',
  'README.md',
  'CHANGELOG.md',
  'CLAUDE.md',
  'TODO.md',
  'THIRD_PARTY_NOTICES.md',
  'SECURITY.md',
  'src/i18n.js',
  'src/card.js',
];

for (const file of FILES) {
  test(`${file}: UTF-8 without BOM, no control byte, no mojibake`, () => {
    const bytes = readFileSync(new URL(`../${file}`, import.meta.url));
    assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'BOM');
    const text = bytes.toString('utf8');
    assert.ok(!text.includes('�'), 'invalid UTF-8');
    const lines = text.split('\n');
    assert.equal(lines.findIndex((l) => CONTROL.test(l)) + 1, 0, 'control byte on this line');
    assert.equal(lines.findIndex((l) => MOJIBAKE.test(l)) + 1, 0, 'mojibake on this line');
  });
}

test('the patterns catch what they should', () => {
  assert.match('FranÃ§ais', MOJIBAKE);
  assert.match('lâ€™app', MOJIBAKE);
  assert.doesNotMatch('Français « Découverte » 800×534 — l’app… 55 °C', MOJIBAKE);
  assert.match('a\u0007b', CONTROL);
  assert.doesNotMatch('a\tb', CONTROL);
});

test('LICENSE names nobody', () => {
  const license = readFileSync(new URL('../LICENSE', import.meta.url), 'utf8');
  assert.match(license, /Apache License/);
  assert.match(license, /Copyright \[yyyy\] \[name of copyright owner\]/);
  assert.doesNotMatch(license, /Copyright (?:\(c\) )?\d{4}/i);
});

test('the image ships the license and the third-party notices', () => {
  const dockerfile = readFileSync(new URL('../Dockerfile', import.meta.url), 'utf8');
  assert.match(dockerfile, /COPY [^\n]*LICENSE[^\n]*THIRD_PARTY_NOTICES\.md/);
  assert.match(dockerfile, /COPY package\.json/);
});

test('cover.png is a PNG of 800×534', () => {
  const png = readFileSync(new URL('../cover.png', import.meta.url));
  assert.deepEqual([...png.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal(png.readUInt32BE(16), 800);
  assert.equal(png.readUInt32BE(20), 534);
});
