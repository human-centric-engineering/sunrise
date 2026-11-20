/**
 * The strings and languages an app adds to the catalogue (§138 t-1072).
 *
 * Sunrise ships `en` and the pseudo-locale `en-XA`. An app registers, from
 * `initAppMessages()` in `lib/app/messages.ts`:
 *
 * - **its own strings**, for any supported locale ({@link registerAppMessages}),
 *   under the {@link APP_MESSAGE_NAMESPACES}. The platform never ships a
 *   namespace with either name, so an upgrade cannot collide with an app's;
 * - **a whole new locale**, with the platform's strings in it
 *   ({@link registerAppLocale}). It becomes supported everywhere the
 *   resolution looks (`supportedLocales()`), so a user, an org or a visitor
 *   can choose it;
 * - **replacements for individual platform strings**
 *   ({@link overridePlatformMessages}).
 *
 * A locale's catalogue is merged in this order, each layer winning over the
 * one before: the source (`en`: the platform's strings, then the app's `en`
 * strings, then the app's `en` overrides) → the locale's platform
 * translations and app strings → the locale's overrides. So a key a locale
 * lacks shows in English, per key. When the catalogue is built, the log
 * gives the count of missing keys and names up to 20 of them, once per
 * locale and count. The pseudo-locale is generated from the
 * source, app strings and overrides included.
 *
 * A platform key the platform does not have (one removed in an upgrade, or a
 * typo) is dropped with a warning rather than thrown, so an upgrade that
 * retires a string never takes an app's whole translation down with it.
 * A malformed tree, a string that is not valid ICU, a reserved namespace in
 * the wrong call, or a locale that is not registered throws, which rolls back everything the init registered.
 *
 * **Registration is synchronous and runs lazily** before the first catalogue
 * or supported-locale read (`platform.seam-realm`). Only the server reads
 * it: the catalogue (the request config, the email renderer) and the
 * supported list (the locale schemas on API routes). Keep it off the client.
 * It brings the catalogue, every translation an app registers and the ICU
 * parser with it. A client form checks only a tag's shape
 * (`lib/i18n/tags.ts`), and client components get their messages from the
 * server through `NextIntlClientProvider`.
 *
 * Boundary-clean: no `next/*` and no database imports.
 *
 * @see lib/app/messages.ts — the fork's scaffold
 * @see .context/ui/i18n.md
 */

import { parse } from '@formatjs/icu-messageformat-parser';
import en from '@/lib/i18n/messages/en.json';
import { initAppMessages } from '@/lib/app/messages';
import { createAppInitGate, restoreMap } from '@/lib/fork-init';
import { DEFAULT_LOCALE, PLATFORM_LOCALES, PSEUDO_LOCALE, isLanguageTag } from '@/lib/i18n/tags';
import { pseudoLocalize, type MessageTree } from '@/lib/i18n/pseudo';
import { logger } from '@/lib/logging';

/**
 * The top-level namespaces downstream tiers keep their own strings in: `app`
 * for a leaf app, `framework` for a framework between Sunrise and its apps.
 * Reserved: the platform's catalogue never has either, so an app's strings
 * never merge into, or collide with, a platform namespace.
 */
export const APP_MESSAGE_NAMESPACES: readonly string[] = Object.freeze(['app', 'framework']);

/** How deep a registered tree may nest. Far past anything a screen needs. */
const MAX_DEPTH = 16;

/** How many keys a warning lists; its `count` says how many there are in all. */
const MAX_LOGGED_KEYS = 20;

const SOURCE: MessageTree = en;

/** Registered locale (canonical tag) → the platform's strings in it. */
const appLocales = new Map<string, MessageTree>();
/** Supported locale → the app's own strings in it (only reserved namespaces). */
const appMessages = new Map<string, MessageTree>();
/** Supported locale → replacements for platform strings in it. */
const overrides = new Map<string, MessageTree>();
/** Built catalogues, by locale. Derived from the three maps; cleared when any changes. */
const built = new Map<string, MessageTree>();
/**
 * The missing-key warnings already logged, as `locale:count`. Not cleared with
 * {@link built}: each registration rebuilds every catalogue, and the same
 * gap should be logged once, not once per registration call.
 */
const warnedMissing = new Set<string>();

const appInit = createAppInitGate({
  label: 'i18n: initAppMessages',
  subject: 'app strings and languages',
  init: initAppMessages,
  snapshot: () => ({
    locales: new Map(appLocales),
    messages: new Map(appMessages),
    overrides: new Map(overrides),
  }),
  restore: (before) => {
    restoreMap(appLocales, before.locales);
    restoreMap(appMessages, before.messages);
    restoreMap(overrides, before.overrides);
    built.clear();
    warnedMissing.clear();
  },
});

/**
 * Add a language the platform does not ship, with the platform's strings in
 * it. `messages` is a partial copy of the platform catalogue (`common.save`,
 * …) in that language; a key left out shows in English. Re-registering a
 * locale replaces its platform strings. Your own strings in it go through
 * {@link registerAppMessages}.
 *
 * Throws on a tag that is not a language tag, on `en` or `en-XA` (change
 * those with {@link overridePlatformMessages}), on a malformed tree, and on
 * an `app` or `framework` namespace here.
 */
export function registerAppLocale(locale: string, messages: MessageTree = {}): void {
  const tag = canonicalTag(locale);
  if (PLATFORM_LOCALES.some((p) => p.toLowerCase() === tag.toLowerCase())) {
    throw new Error(
      `i18n: "${tag}" is a platform locale; change its strings with overridePlatformMessages()`
    );
  }
  const tree = checkTree(messages, `registerAppLocale("${tag}")`);
  refuseReserved(
    tree,
    `registerAppLocale("${tag}")`,
    'register your own strings with registerAppMessages()'
  );
  appLocales.set(tag, knownPlatformKeys(tree, tag, 'registerAppLocale'));
  built.clear();
}

/**
 * Add the app's own strings in a supported locale (`en`, or one registered
 * with {@link registerAppLocale} first). Every top-level key must be one of
 * {@link APP_MESSAGE_NAMESPACES}. Calls for the same locale merge, a later
 * key winning, so strings can be registered a module at a time.
 *
 * Throws on the pseudo-locale (it is generated from `en`), on a locale that
 * is not registered, on a malformed tree and on any other top-level key.
 */
export function registerAppMessages(locale: string, messages: MessageTree): void {
  const target = writableLocale(locale, 'registerAppMessages');
  const tree = checkTree(messages, `registerAppMessages("${target}")`);
  for (const key of Object.keys(tree)) {
    if (!APP_MESSAGE_NAMESPACES.includes(key)) {
      throw new Error(
        `i18n: registerAppMessages("${target}") got the namespace "${key}"; an app's strings go under ${APP_MESSAGE_NAMESPACES.map((n) => `"${n}"`).join(' or ')}`
      );
    }
  }
  const current = appMessages.get(target) ?? {};
  const where = `registerAppMessages("${target}")`;
  refuseReshape(current, tree, where);
  // Every locale's strings merge over the source's, so a key must have the
  // same shape in all of them.
  for (const [other, theirs] of appMessages) {
    if (other !== target) refuseReshape(theirs, tree, where, '', other);
  }
  appMessages.set(target, merge(current, tree));
  built.clear();
}

/**
 * Replace individual platform strings in a supported locale. Applied last,
 * over the platform's text and any translation. Calls for the same locale
 * merge. A key the platform does not have is dropped with a warning.
 *
 * Throws on the pseudo-locale, on a locale that is not registered, on a
 * malformed tree, and on an `app` or `framework` namespace (those are yours:
 * register them).
 */
export function overridePlatformMessages(locale: string, messages: MessageTree): void {
  const target = writableLocale(locale, 'overridePlatformMessages');
  const tree = checkTree(messages, `overridePlatformMessages("${target}")`);
  refuseReserved(
    tree,
    `overridePlatformMessages("${target}")`,
    'register them with registerAppMessages()'
  );
  const known = knownPlatformKeys(tree, target, 'overridePlatformMessages');
  overrides.set(target, merge(overrides.get(target) ?? {}, known));
  built.clear();
}

/** The locales an app registered, in registration order. */
export function appLocaleTags(): readonly string[] {
  appInit.ensure();
  return [...appLocales.keys()];
}

/**
 * The full catalogue for `locale`: the source language merged with what the
 * app registered for it. A tag with no catalogue of its own falls back to its
 * base language (`fr-CA` → `fr`), then to the source. The pseudo-locale is
 * served only when asked for by name.
 */
export function catalogueFor(locale: string): MessageTree {
  appInit.ensure();
  const key =
    locale.toLowerCase() === PSEUDO_LOCALE.toLowerCase()
      ? PSEUDO_LOCALE
      : (servingTag(locale) ?? DEFAULT_LOCALE);
  let catalogue = built.get(key);
  if (!catalogue) {
    catalogue = build(key);
    built.set(key, catalogue);
  }
  return catalogue;
}

/** Test-only: clear the registry and re-arm the one-shot app init. */
export function __resetAppMessagesForTests(): void {
  appLocales.clear();
  appMessages.clear();
  overrides.clear();
  built.clear();
  warnedMissing.clear();
  appInit.reset();
}

function build(locale: string): MessageTree {
  const source = merge(SOURCE, appMessages.get(DEFAULT_LOCALE), overrides.get(DEFAULT_LOCALE));
  if (locale === DEFAULT_LOCALE) return source;
  if (locale === PSEUDO_LOCALE) return pseudoLocalize(source);
  const own = merge(appLocales.get(locale), appMessages.get(locale), overrides.get(locale));
  const missing = missingKeys(source, own);
  const warning = `${locale}:${missing.length}`;
  if (missing.length > 0 && !warnedMissing.has(warning)) {
    warnedMissing.add(warning);
    logger.warn('i18n: strings missing from an app locale show in English', {
      locale,
      count: missing.length,
      keys: missing.slice(0, MAX_LOGGED_KEYS),
    });
  }
  return merge(source, own);
}

/** The canonical spelling of a language tag (`pt-br` → `pt-BR`); throws on a tag that is not one. */
function canonicalTag(locale: unknown): string {
  let canonical: string | undefined;
  if (typeof locale === 'string' && isLanguageTag(locale)) {
    try {
      [canonical] = Intl.getCanonicalLocales(locale);
    } catch {
      // Falls through to the throw: the shape check passed but Intl refuses it.
    }
  }
  if (typeof locale !== 'string' || !canonical) {
    throw new Error(`i18n: ${JSON.stringify(locale)} is not a language tag`);
  }
  // Case only: `Intl` also renames deprecated codes (`iw` → `he`), and a tag
  // stored under another name than the one registered would not match the
  // lookups, which compare case-insensitively.
  if (canonical.toLowerCase() !== locale.toLowerCase()) {
    throw new Error(`i18n: "${locale}" is a deprecated tag; use "${canonical}"`);
  }
  return canonical;
}

/** The registered app locale `locale` names (case-insensitive), or null. */
function registeredTag(locale: string): string | null {
  const wanted = locale.toLowerCase();
  for (const tag of appLocales.keys()) if (tag.toLowerCase() === wanted) return tag;
  return null;
}

/** The registered app locale that serves `locale`: itself, or its base language. */
function servingTag(locale: string): string | null {
  const parts = locale.split('-');
  for (let n = parts.length; n > 0; n--) {
    const tag = registeredTag(parts.slice(0, n).join('-'));
    if (tag) return tag;
  }
  return null;
}

/** The locale a write targets: `en` or a registered app locale. */
function writableLocale(locale: string, fn: string): string {
  const tag = canonicalTag(locale);
  if (tag.toLowerCase() === PSEUDO_LOCALE.toLowerCase()) {
    throw new Error(
      `i18n: ${fn}("${tag}"): the pseudo-locale is generated from "${DEFAULT_LOCALE}"; register for "${DEFAULT_LOCALE}"`
    );
  }
  if (tag.toLowerCase() === DEFAULT_LOCALE) return DEFAULT_LOCALE;
  const registered = registeredTag(tag);
  if (!registered) {
    throw new Error(`i18n: ${fn}("${tag}"): register the locale with registerAppLocale() first`);
  }
  return registered;
}

/**
 * Throws when `incoming` would turn a string in `current` into a group of
 * strings, or the other way round: the merge would silently drop the group.
 */
function refuseReshape(
  current: MessageTree,
  incoming: MessageTree,
  where: string,
  path = '',
  inLocale?: string
): void {
  for (const [key, value] of Object.entries(incoming)) {
    if (!Object.hasOwn(current, key)) continue;
    const at = path ? `${path}.${key}` : key;
    const before = current[key];
    if (typeof before !== typeof value) {
      throw new Error(
        `i18n: ${where}: "${at}" was registered${inLocale ? ` in "${inLocale}"` : ''} as ${typeof before === 'string' ? 'a string' : 'a group of strings'} and cannot change shape`
      );
    }
    if (typeof before === 'object' && typeof value === 'object') {
      refuseReshape(before, value, where, at, inLocale);
    }
  }
}

function refuseReserved(tree: MessageTree, where: string, instead: string): void {
  for (const key of Object.keys(tree)) {
    if (APP_MESSAGE_NAMESPACES.includes(key)) {
      throw new Error(`i18n: ${where} got the "${key}" namespace; ${instead}`);
    }
  }
}

/**
 * A validated copy of a registered tree: a plain object of plain objects and
 * strings. Checked rather than trusted, because an init built from JSON or
 * written in JavaScript can pass anything, and a non-string leaf would reach
 * next-intl as a message.
 */
function checkTree(value: unknown, where: string, path = '', depth = 0): MessageTree {
  if (!isPlainObject(value)) {
    throw new Error(`i18n: ${where}: ${path || 'the messages'} must be an object of strings`);
  }
  if (depth >= MAX_DEPTH) {
    throw new Error(`i18n: ${where}: ${path} nests deeper than ${MAX_DEPTH} levels`);
  }
  const out: MessageTree = {};
  for (const [key, child] of Object.entries(value)) {
    const at = path ? `${path}.${key}` : key;
    // next-intl reads a dot as a path separator, and `__proto__` would set the
    // copy's prototype rather than a key.
    if (key === '' || key.includes('.') || key === '__proto__') {
      throw new Error(`i18n: ${where}: "${at}" is not a usable key`);
    }
    if (typeof child === 'string') out[key] = checkMessage(child, where, at);
    else out[key] = checkTree(child, where, at, depth + 1);
  }
  return out;
}

/**
 * `message`, if it is valid ICU. Checked when it is registered, so a broken
 * string fails the init (which rolls back) instead of throwing on every
 * render: next-intl and the pseudo-locale both parse it.
 */
function checkMessage(message: string, where: string, at: string): string {
  try {
    parse(message);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`i18n: ${where}: "${at}" is not a valid ICU message (${reason})`);
  }
  return message;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto: unknown = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * The part of `tree` the platform catalogue has, with the same shape (a
 * string where it has a string). The rest is dropped and named in one
 * warning: a string removed in an upgrade, or a typo.
 */
function knownPlatformKeys(tree: MessageTree, locale: string, fn: string): MessageTree {
  const dropped: string[] = [];
  const kept = pick(tree, SOURCE, '', dropped);
  if (dropped.length > 0) {
    logger.warn(`i18n: ${fn} ignored strings the platform does not have`, {
      locale,
      count: dropped.length,
      keys: dropped.slice(0, MAX_LOGGED_KEYS),
    });
  }
  return kept;
}

function pick(tree: MessageTree, shape: MessageTree, path: string, dropped: string[]): MessageTree {
  const out: MessageTree = {};
  for (const [key, value] of Object.entries(tree)) {
    const at = path ? `${path}.${key}` : key;
    const expected = Object.hasOwn(shape, key) ? shape[key] : undefined;
    if (typeof value === 'string' && typeof expected === 'string') out[key] = value;
    else if (typeof value === 'object' && expected !== undefined && typeof expected === 'object') {
      out[key] = pick(value, expected, at, dropped);
    } else dropped.push(at);
  }
  return out;
}

/** A new tree: each later one's keys over the earlier, objects merged key by key. */
function merge(...trees: Array<MessageTree | undefined>): MessageTree {
  const out: MessageTree = {};
  for (const tree of trees) {
    if (!tree) continue;
    for (const [key, value] of Object.entries(tree)) {
      const current = out[key];
      out[key] =
        typeof value === 'object' && typeof current === 'object' ? merge(current, value) : value;
    }
  }
  return out;
}

/** Every leaf key of `source` that `own` has no string for. */
function missingKeys(source: MessageTree, own: MessageTree, path = ''): string[] {
  const missing: string[] = [];
  for (const [key, value] of Object.entries(source)) {
    const at = path ? `${path}.${key}` : key;
    const theirs = Object.hasOwn(own, key) ? own[key] : undefined;
    if (typeof value === 'string') {
      if (typeof theirs !== 'string') missing.push(at);
    } else {
      missing.push(...missingKeys(value, typeof theirs === 'object' ? theirs : {}, at));
    }
  }
  return missing;
}
