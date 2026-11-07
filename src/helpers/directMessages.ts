import { Types } from 'mongoose';

const DM_ID_PREFIX = 'dm-';
const INBOX_PREFIX = 'inbox:';

/** Códigos de negocio de un DM rechazado (extensión de RFC 7807, campo `code`). */
export const DM_PENDING = 'DM_PENDING';
export const DM_NOT_DELIVERABLE = 'DM_NOT_DELIVERABLE';

/** Un DM usa `dm-<ObjectId>` como `channelId`: así `Message`, `ReadState` y las rutas de canal no cambian. */
export function isDmChannel(channelId: string): boolean {
  return channelId.startsWith(DM_ID_PREFIX);
}

export function toDmChannelId(conversationId: Types.ObjectId): string {
  return `${DM_ID_PREFIX}${conversationId.toString()}`;
}

/** El ObjectId de un `dm-…`, o undefined si no tiene esa forma. */
export function parseDmChannelId(channelId: string): Types.ObjectId | undefined {
  const id = channelId.slice(DM_ID_PREFIX.length);
  if (!isDmChannel(channelId) || id.length !== 24 || !Types.ObjectId.isValid(id)) return undefined;
  return new Types.ObjectId(id);
}

/** Canal del socket por usuario: es también la clave de Redis (`inbox:<userId>`). */
export function inboxChannelId(userId: string): string {
  return `${INBOX_PREFIX}${userId}`;
}

export function isInboxChannel(channelId: string): boolean {
  return channelId.startsWith(INBOX_PREFIX);
}
