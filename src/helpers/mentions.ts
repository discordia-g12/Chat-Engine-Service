/**
 * Menciones dentro del texto de un mensaje (historia #46).
 *
 * - `<@userId>`: un usuario. Los ids son subs de Auth0 (`auth0|…`, `google-oauth2|…`).
 * - `<@&roleId>`: un rol del servidor.
 * - `@everyone`: todos los que ven el canal.
 *
 * El texto se guarda tal cual; lo que se parsea acá es lo que cuenta para las notificaciones. Lo que mande
 * el cliente aparte del texto no se usa.
 */

/** Tope de usuarios y roles distintos por mensaje. Los que sobran quedan como texto. */
export const MAX_MENTIONS = 20;

const USER_MENTION = /<@([^\s<>@&]{1,128})>/g;
const ROLE_MENTION = /<@&([^\s<>@&]{1,128})>/g;
// "@everyone" suelto: no "mail@everyone" ni "@everyones"
const EVERYONE = /(?<![\w@])@everyone(?![\w-])/;

export interface ParsedMentions {
  userIds: string[];
  roleIds: string[];
  everyone: boolean;
}

function unique(pattern: RegExp, content: string): string[] {
  return [...new Set([...content.matchAll(pattern)].map((match) => match[1]))];
}

export function parseMentions(content: string): ParsedMentions {
  if (typeof content !== 'string' || content.length === 0) {
    return { userIds: [], roleIds: [], everyone: false };
  }
  const userIds = unique(USER_MENTION, content).slice(0, MAX_MENTIONS);
  const roleIds = unique(ROLE_MENTION, content).slice(0, MAX_MENTIONS - userIds.length);
  return { userIds, roleIds, everyone: EVERYONE.test(content) };
}
