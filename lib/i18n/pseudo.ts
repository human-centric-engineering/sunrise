/**
 * The pseudo-locale (§138 t-1071): `en`, accented and bracketed.
 *
 * Generated from the source catalogue when it is loaded, never written by
 * hand, so it cannot fall behind `en` or carry a key `en` does not have.
 * "Save" becomes "[Šåṽé]": still readable, so a screen can be used in it, and
 * any English left on the page is a string that did not come from the
 * catalogue. The brackets show where a string was cut off.
 *
 * Only the text is changed. Arguments, plural and select branches, rich-text
 * tags and number or date skeletons go through untouched, because the
 * message is parsed as ICU and only its literal parts are rewritten.
 */

import { parse, TYPE, type MessageFormatElement } from '@formatjs/icu-messageformat-parser';
import { printAST } from '@formatjs/icu-messageformat-parser/printer.js';

const ACCENTED: Record<string, string> = {
  a: 'å',
  b: 'ƀ',
  c: 'ç',
  d: 'ð',
  e: 'é',
  f: 'ƒ',
  g: 'ĝ',
  h: 'ĥ',
  i: 'î',
  j: 'ĵ',
  k: 'ķ',
  l: 'ļ',
  m: 'ɱ',
  n: 'ñ',
  o: 'ö',
  p: 'þ',
  q: 'ǫ',
  r: 'ŕ',
  s: 'š',
  t: 'ţ',
  u: 'û',
  v: 'ṽ',
  w: 'ŵ',
  x: 'ẋ',
  y: 'ý',
  z: 'ž',
  A: 'Å',
  B: 'Ɓ',
  C: 'Ç',
  D: 'Ð',
  E: 'É',
  F: 'Ƒ',
  G: 'Ĝ',
  H: 'Ĥ',
  I: 'Î',
  J: 'Ĵ',
  K: 'Ķ',
  L: 'Ļ',
  M: 'Ṁ',
  N: 'Ñ',
  O: 'Ö',
  P: 'Þ',
  Q: 'Ǫ',
  R: 'Ŕ',
  S: 'Š',
  T: 'Ţ',
  U: 'Û',
  V: 'Ṽ',
  W: 'Ŵ',
  X: 'Ẋ',
  Y: 'Ý',
  Z: 'Ž',
};

function accent(text: string): string {
  return text.replace(/[A-Za-z]/g, (ch) => ACCENTED[ch] ?? ch);
}

function rewrite(elements: MessageFormatElement[]): MessageFormatElement[] {
  return elements.map((el) => {
    switch (el.type) {
      case TYPE.literal:
        return { ...el, value: accent(el.value) };
      case TYPE.tag:
        return { ...el, children: rewrite(el.children) };
      case TYPE.plural:
      case TYPE.select:
        return {
          ...el,
          options: Object.fromEntries(
            Object.entries(el.options).map(([key, option]) => [
              key,
              { ...option, value: rewrite(option.value) },
            ])
          ),
        };
      default:
        return el;
    }
  });
}

/** One message in the pseudo-locale. Throws on a message that is not valid ICU. */
export function pseudoLocalizeMessage(message: string): string {
  const ast = rewrite(parse(message));
  return `[${printAST(ast)}]`;
}

/** A nested catalogue of messages. */
export interface MessageTree {
  [key: string]: string | MessageTree;
}

/** A whole catalogue in the pseudo-locale, with the same keys. */
export function pseudoLocalize(messages: MessageTree): MessageTree {
  return Object.fromEntries(
    Object.entries(messages).map(([key, value]) => [
      key,
      typeof value === 'string' ? pseudoLocalizeMessage(value) : pseudoLocalize(value),
    ])
  );
}
