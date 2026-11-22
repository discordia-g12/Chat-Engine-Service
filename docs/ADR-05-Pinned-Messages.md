## ADR 05: Mensajes fijados

**Contexto:**
La historia "Fijar un mensaje" pide fijar y desfijar mensajes, y ver la lista de fijados, tanto en un canal
de servidor como en un DM, desde web y mobile. La web ya tenía la UI (panel "Mensajes fijados", badge en
el header y "fijar mensaje" en el menú del mensaje), pero solo cambiaba estado local.

Restricciones que condicionan el diseño:

* **DM y canal comparten modelo y rutas.** Un DM usa `dm-<conversationId>` como `channelId`, y
  `channelAccessGuard` ya resuelve el acceso de los dos casos: participante del DM, o permisos de Core en el
  canal.
* **Los permisos los decide Core.** `MANAGE_MESSAGES` ya existe, y la UI de roles lo describe como "Borrar y
  fijar mensajes de otros miembros". El acceso al canal ya devuelve `can_manage_messages`.
* **Los clientes ya mezclan `MESSAGE_UPDATED` y `DM_MESSAGE_UPDATED`** en su caché de mensajes.
* **El historial se pagina.** Un mensaje fijado puede ser más viejo que la primera página cargada.

**Decisión:**

* **El estado vive en el mensaje:** `pinned` (default `false`), `pinnedAt` y `pinnedBy`, con un índice
  parcial `{ channelId: 1, pinnedAt: -1 }` sobre `pinned: true`. El payload siempre lleva `pinned`, también
  en `false`, para que un desfijado pise el estado del cliente. `pinnedAt` y `pinnedBy` solo van si está
  fijado.
* **Rutas**, todas detrás de `channelAccessGuard`:
  * `PUT /channels/:channelId/messages/:messageId/pin` fija.
  * `DELETE` sobre la misma ruta desfija.
  * `GET /channels/:channelId/pins` lista los fijados, del fijado más reciente al más viejo, sin borrados.
* **Quién puede:** en un canal de servidor, quien tenga `MANAGE_MESSAGES` (el dueño y `ADMINISTRATOR`
  siempre). El autor no puede fijar su propio mensaje sin ese permiso. En un DM puede cualquiera de los dos
  participantes.
* **Es idempotente:** fijar algo ya fijado devuelve `200` con el mensaje y no publica nada.
* **Límite de 50 fijados por canal o DM** (`PINNED_LIMIT`). El 51.º responde `409`. Se cuenta antes de
  guardar, sin transacción: dos fijados simultáneos pueden pasarlo por uno, y se acepta.
* **No se fija un mensaje borrado** (`404`). Borrar un mensaje fijado lo desfija y libera el lugar.
* **Realtime:** el cambio se publica como `MESSAGE_UPDATED` en el canal y, en un DM, como
  `DM_MESSAGE_UPDATED` en el inbox de los dos participantes. Es el mismo camino que la edición.
* **Sin evento de auditoría por ahora.** Queda anotado en la deuda técnica.

**Alternativas descartadas:**

| Alternativa | Por qué se descartó |
|---|---|
| Colección aparte `PinnedMessage { channelId, messageId, pinnedBy, pinnedAt }` | Obliga a un join para listar, y a mantener las dos colecciones sincronizadas al borrar. El flag en `Message` viaja solo en el payload, así historial, socket y búsqueda ya muestran si un mensaje está fijado. |
| Eventos nuevos `MESSAGE_PINNED` / `MESSAGE_UNPINNED` | Hay que sumarlos en `chatSocket`, `inboxSocket` y `useInbox` de los clientes. Con `MESSAGE_UPDATED` el mensaje se actualiza con el merge que ya existe, y los clientes solo agregan la sincronización de la lista de fijados. |
| Permiso nuevo `PIN_MESSAGES` en Core | Necesita migración de `bit_positions`, cambios en la UI de roles y en `/access`. `MANAGE_MESSAGES` ya cubre fijar según su descripción. Se puede separar después cambiando solo la regla de `setPinned`. |
| Un toggle (`POST …/pin`) | Dos clientes que fijan a la vez terminarían desfijando. Con `PUT`/`DELETE` el resultado no depende del estado previo. |
| Calcular los fijados filtrando las páginas cargadas en el cliente | No ve los fijados viejos, que no están cargados. |

**Consecuencias:**

* Una consulta `countDocuments` extra por fijado, sobre un índice parcial chico.
* Un cliente que se reconecta no recibe los cambios de fijado de mensajes viejos (`getMissedMessages` solo
  repone mensajes nuevos). Lo resuelve releyendo `GET /pins` al abrir el panel.
* Compatibilidad: solo se suman campos. Los mensajes viejos no tienen `pinned` y se leen como `false`.
