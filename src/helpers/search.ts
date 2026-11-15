/**
 * Búsqueda de mensajes (ver ADR-04): el término se busca como texto literal dentro del contenido, sin
 * distinguir mayúsculas ni tildes ("cancion" encuentra "Canción").
 */

/** Largo máximo del término, después de recortar espacios. */
export const MAX_SEARCH_QUERY_LENGTH = 100;
export const DEFAULT_SEARCH_LIMIT = 25;
export const MAX_SEARCH_LIMIT = 50;

/** Letras que se escriben con o sin tilde en español (y portugués): cada una matchea todas sus variantes. */
const ACCENT_VARIANTS = new Map<string, string>([
  ['a', 'aáàâäã'],
  ['e', 'eéèêë'],
  ['i', 'iíìîï'],
  ['o', 'oóòôöõ'],
  ['u', 'uúùûü'],
  ['n', 'nñ'],
  ['c', 'cç'],
]);

const REGEX_SPECIAL = /[.*+?^${}()|[\]\\/-]/;

/** Saca las tildes y pasa a minúsculas: "Canción" → "cancion". */
export function foldAccents(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/**
 * Patrón (como string, para `$regex`) que encuentra `term` en cualquier parte del texto. Los caracteres
 * especiales se escapan: el usuario busca texto, no expresiones regulares. Las variantes con tilde van en
 * mayúscula y minúscula dentro de la clase, así no depende de cómo Mongo pliegue los no ASCII con `i`.
 */
export function buildContainsPattern(term: string): string {
  return [...foldAccents(term)]
    .map((char) => {
      const variants = ACCENT_VARIANTS.get(char);
      if (variants) return `[${variants}${variants.toUpperCase()}]`;
      return REGEX_SPECIAL.test(char) ? `\\${char}` : char;
    })
    .join('');
}
