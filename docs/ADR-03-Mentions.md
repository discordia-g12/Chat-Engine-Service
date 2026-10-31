## ADR 03: Menciones de usuario, de rol y @everyone

**Contexto:**
La historia optativa #46 ("Menciones") pide, según sus criterios de aceptación:

* mencionar a un usuario y que reciba una notificación destacada (CA 1);
* que un miembro con permisos mencione a un rol y la reciban todos los que lo tienen (CA 2);
* que un miembro con el permiso correspondiente use `@everyone` y la reciban todos los del canal (CA 3);
* que si no tiene ese permiso, el sistema no lo permita o lo trate como texto plano (CA 4).

También cierra el CA 3 de #27: el indicador distinto cuando hay una mención sin leer. ADR-02 ya dejó
`mentionCount` en `GET /unread` (en 0) para llenarlo sin cambiar el contrato.

Restricciones que condicionan el diseño:

* **Los permisos los decide Core.** El permiso `MENTION_EVERYONE` ya existe en Server-Roles-Core
  (`app/core/permissions.py`), con overrides por canal. Chat no tiene que replicarlo.
* **Chat no conoce a los miembros ni sus roles.** Para saber a quién le llega una mención de rol hay que
  preguntarle a Core.
* **Lo no leído se calcula al leer** (ADR-02): no se escribe nada por cada miembro cuando llega un mensaje.
* **El cliente no es confiable.** Lo que decide quién recibe una notificación lo tiene que calcular el
  servidor.

**Decisión:**

* **Formato en el texto:** `<@userId>`, `<@&roleId>` y `@everyone`. El texto se guarda tal cual; la web lo
  muestra como `@nombre` y `@rol`. Los ids de usuario son los subs de Auth0 (`auth0|…`, `google-oauth2|…`).
  El composer de la web inserta los tokens al elegir del autocompletado.
* **Chat parsea el texto al enviar** (`src/helpers/mentions.ts`) y guarda en el mensaje lo que notifica:
  `mentionUserIds`, `mentionRoleIds` y `mentionEveryone`. Solo se guardan si hay alguna. Lo que mande el
  cliente aparte del texto no se usa. Como mucho 20 usuarios y roles distintos por mensaje; los que sobran
  quedan como texto.
* **Mencionar a `@everyone` o a un rol exige `MENTION_EVERYONE`** en el canal (el dueño y `ADMINISTRATOR`
  lo tienen siempre). Mencionar a un usuario no exige nada.
* **Sin el permiso, es texto plano (CA 4):** el mensaje se envía con `@everyone` o `<@&rol>` en el texto,
  pero sin `mentionEveryone` ni `mentionRoleIds`. No cuenta como mención ni se resalta. Rechazar el mensaje
  castigaría a quien escribe "@everyone" sin intención de notificar a nadie.
* **El permiso se consulta al enviar, y solo si hace falta:** si el texto tiene `@everyone` o una mención
  de rol, Chat llama a `GET /internal/channels/{id}/access`, que ahora también devuelve
  `can_mention_everyone` y `mentionable_role_ids` (los roles del servidor del canal, sin el por defecto).
  Los roles que no son de ese servidor se descartan. No se reutiliza lo que se consultó al abrir el
  WebSocket: así un cambio de permisos rige desde el mensaje siguiente. Un mensaje sin esas menciones no
  consulta nada.
* **Si Core no responde en esa consulta, el mensaje falla con `503`** y no se guarda, igual que el
  historial y `/unread` (ADR-02). Enviarlo sin la mención haría perder la notificación sin que nadie se
  entere; así el usuario ve el error y reintenta. Los mensajes sin `@everyone` ni roles no dependen de Core.
* **A quién le llega se resuelve al leer, no al enviar.** El mensaje guarda los ids de rol y el flag; en
  `GET /unread` se cuentan los mensajes no leídos que mencionan al usuario, a `@everyone` o a alguno de sus
  roles. Los roles del usuario vienen en la misma llamada que ya se hacía a Core,
  `GET /internal/users/{id}/visible-channels` (campo nuevo `role_ids`, sin los roles por defecto).
  `@everyone` le llega a quien ve el canal, porque `/unread` solo cuenta los canales visibles (CA 3).
* **`mentionCount`** usa la misma condición que `unreadCount` (mensajes de otros, después del último
  leído) más las menciones, con el mismo tope de 100. Siempre es menor o igual que `unreadCount`, y solo se
  calcula en los canales que tienen algo sin leer. Un mensaje que menciona al usuario de varias formas cuenta
  una vez.
* **El payload del mensaje** (WebSocket e historial) suma `mentions: { users, roles, everyone }`, con lo
  que notifica. La web lo usa para resaltar el mensaje. Los mensajes anteriores a #46 vienen con listas
  vacías.

**Alternativas descartadas:**

| Alternativa | Por qué se descartó |
|---|---|
| Expandir al enviar: guardar la lista de usuarios alcanzados | Con `@everyone` serían todos los miembros del servidor en cada mensaje, y Chat tendría que pedirle a Core los miembros de un rol en cada envío. La lista queda vieja cuando cambian los roles. Resolver al leer es una consulta acotada que ya se hacía. |
| Que el cliente mande las menciones aparte del texto | El cliente podría notificar a quien quiera, o decir que menciona a `@everyone` sin el permiso. El texto es la única fuente y el servidor lo valida. |
| Rechazar el mensaje si usa `@everyone` sin permiso (CA 4) | La historia acepta las dos opciones. Texto plano es lo que hace Discord y no frena una conversación por escribir una palabra. |
| Flag `mentionable` por rol (cualquiera menciona los roles marcados) | Necesita migración en Core, un campo más y un toggle en la configuración de roles. El CA 2 pide "un miembro con permisos", y `MENTION_EVERYONE` ya existe. Se puede sumar después sin cambiar el formato: solo cambia la regla que Chat aplica al enviar. |
| Usar el permiso calculado al abrir el WebSocket | Evita una llamada por mensaje con `@everyone`, pero un permiso quitado seguiría valiendo mientras dure la conexión. Esos mensajes son pocos y la llamada es la misma que ya se hace al conectar. |
| Índice para las menciones (`{ channelId, mentionUserIds, _id }`) | El conteo recorre el tramo no leído del canal con el índice `{ channelId, _id }` de ADR-02, y solo en canales con algo sin leer. Se agrega si las pruebas de carga lo piden. |

**Consecuencias:**

* `GET /unread` hace una consulta más por canal con no leídos. La llamada a Core es la misma.
* Un mensaje con `@everyone` o un rol hace una llamada sincrónica a Core al enviarse. Tiene el mismo
  pendiente de resiliencia que ADR-02 (sin timeout ni reintentos).
* La resolución al leer hace que, si a alguien le dan un rol, cuenten como mención los mensajes no leídos
  que ya mencionaban ese rol. Es un caso chico y aceptado.
* Los mensajes viejos con `@nombre` en texto plano no se convierten: no notifican.
* Compatibilidad: Core y Chat solo suman campos. Un Chat nuevo con un Core viejo no recibe
  `can_mention_everyone` (lo toma como `false`: texto plano) ni `role_ids` (solo cuentan las menciones
  directas). Un cliente viejo ignora `mentions`. El orden de deploy es Core, Chat y la web.
* Tests: `tests/mentions.test.ts` (parser, permiso al enviar, texto plano sin permiso, Core caído, payload,
  `mentionCount` y su tope) y `tests/PermissionService.test.ts` (campos nuevos de `/access` y
  `/visible-channels`). Del lado de Core, `tests/test_internal_mentions.py`.
