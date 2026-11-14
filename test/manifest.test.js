// -----------------------------------------------------------------------------
// The manifest is the contract with Gladys and the store: these tests tie it
// to the code, and check the texts the users read.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DEFAULT_CONFIG } from '../src/config.js';
import {
  ACTION_BUDGET_MS,
  ACTION_TIMEOUT_S,
  ACTIONS,
  HOURLY_CAP,
  MAX_TEXT_CHARS,
  REQUEST_TIMEOUT_MS,
  SCENE_ACTIONS,
} from '../src/constants.js';
import { setup } from './helpers.js';

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('gladys-assistant-integration.json'));
const handlers = read('src/handlers.js');

function* texts(node, path = '') {
  if (Array.isArray(node)) {
    for (const [i, entry] of node.entries()) {
      yield* texts(entry, `${path}[${i}]`);
    }
  } else if (node && typeof node === 'object') {
    if ('en' in node || 'fr' in node) {
      yield [path, node];
      return;
    }
    for (const [key, value] of Object.entries(node)) {
      yield* texts(value, `${path}.${key}`);
    }
  }
}

const fields = Object.fromEntries(manifest.config_schema.map((f) => [f.key, f]));
const allFields = [
  ...manifest.config_schema,
  ...manifest.contact_schema,
  ...manifest.actions.flatMap((a) => a.fields ?? []),
  ...manifest.scene_actions.flatMap((a) => a.fields ?? []),
];

test('the store basics: versions agree, semver, never pinned elsewhere', () => {
  assert.equal(manifest.manifest_version, 1);
  assert.equal(manifest.type, 'communication');
  assert.deepEqual(manifest.messaging, { receive: false });
  assert.equal(manifest.gladys_version, '>=5.1.0');
  assert.equal(manifest.countries, undefined, 'world wide');
  const pkg = JSON.parse(read('package.json'));
  const lock = JSON.parse(read('package-lock.json'));
  assert.equal(pkg.name, 'gladys-microsoft-teams');
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  for (const version of [manifest.version, lock.version, lock.packages[''].version]) {
    assert.equal(version, pkg.version);
  }
  assert.equal(manifest.docker_image, `ghcr.io/lm1lc3n7/gladys-microsoft-teams:${pkg.version}`);
  assert.equal(
    manifest.cover_image,
    'https://raw.githubusercontent.com/LM1LC3N7/gladys-microsoft-teams/main/cover.png',
  );
  assert.deepEqual(manifest.transports, ['cloud']);
  assert.deepEqual(manifest.categories, ['notifications']);
  assert.equal(manifest.keywords, undefined);
  assert.match(pkg.scripts.test, /^node --test --test-timeout=\d+$/);
  assert.match(pkg.dependencies['@gladysassistant/integration-sdk'], /^\^0\.16\.\d+$/);
  for (const lang of ['en', 'fr']) {
    const length = manifest.description[lang].length;
    assert.ok(length >= 10 && length <= 100, `description.${lang}: ${length} characters`);
  }
});

test('every text is in English and French, trimmed, sections bounded', () => {
  for (const [path, text] of texts(manifest)) {
    for (const lang of ['en', 'fr']) {
      assert.ok(text[lang]?.trim(), `${path} needs ${lang}`);
      assert.equal(text[lang], text[lang].trim(), `${path}.${lang} has blanks around`);
    }
  }
  for (const section of manifest.config_schema.filter((f) => f.type === 'section')) {
    for (const lang of ['en', 'fr']) {
      assert.ok(section.description[lang].length <= 1000, `${section.key}.${lang}`);
    }
    assert.ok((section.links ?? []).every((l) => l.url.startsWith('https://')));
  }
  assert.match(fields.intro.description.en, /Never tested with a real Teams account/);
  assert.match(fields.intro.description.fr, /Jamais testé avec un vrai compte Teams/);
  assert.match(fields.intro.description.en, /not affiliated with Microsoft/);
});

test('the configuration matches the code: defaults, bounds, no gladys_ key', () => {
  for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
    assert.equal(fields[key].default, value, key);
  }
  for (const field of manifest.config_schema.filter((f) => f.default !== undefined)) {
    assert.ok(field.key in DEFAULT_CONFIG, `${field.key} has no default in the code`);
  }
  const cap = fields.max_messages_per_hour;
  assert.deepEqual(
    [cap.default, cap.min, cap.max],
    [HOURLY_CAP.default, HOURLY_CAP.min, HOURLY_CAP.max],
  );
  for (const field of allFields) {
    assert.doesNotMatch(field.key, /^gladys_/);
  }
});

test('the webhook URLs are secrets: no default, kept by Gladys, never said encrypted', () => {
  const secrets = allFields.filter((f) => f.type === 'secret');
  assert.deepEqual(secrets.map((f) => f.key).sort(), ['channel_webhook_url', 'webhook_url']);
  for (const field of secrets) {
    assert.equal(field.default, undefined, field.key);
    assert.equal(field.placeholder, undefined, field.key);
    assert.match(
      field.description.en,
      /kept by Gladys in its database, never shown again, sent only to Microsoft/i,
    );
    assert.match(
      field.description.fr,
      /gardée? par Gladys dans sa base, jamais réaffiché, envoyé seulement à Microsoft/i,
    );
  }
  assert.equal(manifest.contact_schema.length, 1);
  assert.equal(manifest.contact_schema[0].required, true);
  for (const path of [
    'gladys-assistant-integration.json',
    'docs/en.md',
    'docs/fr.md',
    'README.md',
    'TODO.md',
    'CHANGELOG.md',
    'CLAUDE.md',
    'src/i18n.js',
  ]) {
    assert.doesNotMatch(read(path), /chiffré|chiffrement|crypté|encrypt|hachage|hashed/i, path);
  }
});

test('the actions and the scene action are the ones the code handles', () => {
  assert.deepEqual(
    manifest.actions.map((a) => a.key),
    Object.values(ACTIONS),
  );
  assert.deepEqual(
    manifest.scene_actions.map((a) => a.key),
    Object.values(SCENE_ACTIONS),
  );
  assert.match(handlers, /onAction\(ACTIONS\.TEST,/);
  assert.match(handlers, /onSceneAction\(SCENE_ACTIONS\.POST,/);
  assert.match(handlers, /onSendMessage\(/);
  for (const action of [...manifest.actions, ...manifest.scene_actions]) {
    assert.equal(action.timeout_seconds, ACTION_TIMEOUT_S);
  }
  assert.ok(ACTION_BUDGET_MS + 1000 <= ACTION_TIMEOUT_S * 1000, 'answered before Gladys gives up');
  assert.ok(REQUEST_TIMEOUT_MS <= ACTION_BUDGET_MS);
  const post = manifest.scene_actions[0];
  assert.deepEqual(
    post.outputs.map((o) => o.key),
    ['status'],
  );
  const text = post.fields.find((f) => f.key === 'text');
  assert.equal(text.required, true);
  assert.ok(
    post.fields.filter((f) => f.required).every((f) => f.key === 'text'),
    'only the text is required',
  );
  assert.match(post.description.en, new RegExp(String(MAX_TEXT_CHARS)));
  assert.equal(manifest.scene_triggers, undefined, 'nothing is received');
  assert.equal(manifest.widgets, undefined);
  assert.equal(manifest.webhooks, undefined);
});

test('select options follow the core rules (label, unique value, no other key)', () => {
  for (const field of allFields.filter((f) => f.options)) {
    const values = field.options.map((o) => `${o.value}`);
    assert.equal(new Set(values).size, values.length, field.key);
    for (const option of field.options) {
      assert.deepEqual(Object.keys(option).sort(), ['label', 'value']);
      assert.equal(typeof option.value, 'string');
      assert.ok(option.value.trim() === option.value && option.value);
      for (const lang of ['en', 'fr']) {
        assert.equal(typeof option.label[lang], 'string');
        assert.ok(option.label[lang] === option.label[lang].trim() && option.label[lang]);
      }
    }
    if (field.default !== undefined) {
      assert.ok(values.includes(field.default), `${field.key}: default among the options`);
    }
  }
  assert.equal(JSON.stringify(manifest).includes('supported_options'), false);
});

test('no device is ever published (no supported_options to check)', async (t) => {
  const { gladys } = await setup(t);
  assert.equal(gladys.fake.discoveredDevices.length, 0);
  assert.equal(gladys.fake.states.length, 0);
  assert.equal(gladys.fake.sceneEvents.length, 0);
});
