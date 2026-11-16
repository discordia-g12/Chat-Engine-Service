## ADR 04: Búsqueda de mensajes por texto y autor

**Contexto:**
La historia "Buscar mensajes" pide que un miembro de un servidor encuentre mensajes sin scrollear el
historial. Según sus criterios de aceptación:

* buscar un término y recibir los mensajes que lo contienen, **solo de los canales a los que tiene acceso**
  (CA 1);
* filtrar por un autor (CA 2);
* que el sistema indique cuando no hay resultados (CA 3).

Restricciones que condicionan el diseño:

* **Los permisos los decide Core.** Qué canales ve un usuario depende de su membresía, sus roles y los
  overrides de cada canal (`VIEW_CHANNELS`). Chat no lo replica.
* **Los mensajes no guardan el servidor.** Solo tienen `channelId`, así que para acotar a un servidor hace
  falta la lista de sus canales.
* **El cliente no es confiable.** Si mandara la lista de canales donde buscar, podría pedir uno que no ve.

**Decisión:**

* **Endpoint:** `GET /servers/:serverId/messages/search?q=&authorId=&limit=&before=` (detrás de Kong,
  `/api/v1/chat/servers/:serverId/messages/search`). Hace falta `q`, `authorId` o los dos: se puede buscar
  solo por autor.
* **Los canales los da Core:** `GET /internal/users/{id}/visible-channels` suma el parámetro opcional
  `server_id` y devuelve solo los canales de texto de ese servidor con `VIEW_CHANNELS`. Es la misma consulta
  que ya usa `/unread` (ADR-02), con un filtro más. Si el usuario no es miembro (o está baneado, o el
  servidor está suspendido), la lista viene vacía y la búsqueda no devuelve nada, sin revelar si hay
  coincidencias.
* **Texto:** el término se busca literal (se escapan los caracteres especiales) en cualquier parte del
  contenido, sin distinguir mayúsculas ni tildes: "cancion" encuentra "Canción". Se recorta y tiene que
  tener entre 1 y 100 caracteres.
* **Autor:** `authorId` es el id de usuario (el `X-User-Id`, sub de Auth0), el mismo que trae cada mensaje.
  La web lo elige de la lista de miembros del servidor.
* **Los borrados no aparecen** (`isDeleted`), ni los DMs: solo se busca en canales de servidor.
* **Orden y paginación:** del más nuevo al más viejo, 25 por página (hasta 50). Se pide uno de más para
  saber si hay otra página sin contar todo. La respuesta es `{ messages, hasMore, nextCursor }`;
  `nextCursor` va como `before` en el pedido siguiente.
* **Sin resultados (CA 3):** `200` con `messages: []`. Que no haya coincidencias no es un error; la web
  muestra el estado vacío.
* **Errores:** `400` si falta el término y el autor, o algún filtro no es válido (`serverId` no es UUID,
  `limit` fuera de rango, `before` no es un id de mensaje); `401` sin `X-User-Id`; `503` si Core no
  responde, igual que el historial y `/unread`.

**Alternativas descartadas:**

| Alternativa | Por qué se descartó |
|---|---|
| Índice de texto de Mongo (`$text`) | Busca palabras enteras con stemming por idioma: "deplo" no encuentra "deploy" y hay que fijar el idioma de cada mensaje. El CA 1 pide los mensajes que *contienen* el término. Además solo admite un índice de texto por colección. |
| Motor de búsqueda aparte (Atlas Search, Elasticsearch) | Resuelve relevancia y volumen, pero suma infraestructura y sincronización para el tamaño actual del sistema. Se puede sumar después sin cambiar el contrato del endpoint. |
| Que el cliente mande los canales donde buscar | Podría pedir canales que no ve. Core es la fuente de los permisos. |
| Endpoint de Core nuevo (`/internal/servers/{id}/visible-channels`) | Duplicaría el cálculo de permisos que ya hace `visible-channels`. Un parámetro opcional mantiene un solo camino y no rompe a quien no lo manda. |
| `403` en un servidor donde no es miembro | Habría que distinguir en Core "no es miembro" de "no ve ningún canal". Con la lista vacía, el resultado es el mismo para los dos casos y no se filtra nada. |

**Consecuencias:**

* La búsqueda por texto usa una expresión regular sin ancla: Mongo recorre los mensajes de los canales
  visibles con el índice `{ channelId, _id }` y compara el contenido de cada uno. Con el volumen actual
  alcanza; si las pruebas de carga lo piden, el siguiente paso es Atlas Search (ver alternativas).
* El filtro por autor tampoco tiene índice propio (`{ channelId, authorId, _id }`): se agrega si hace falta,
  igual que el de menciones en ADR-03.
* Las menciones se guardan como tokens (`<@auth0|…>`), así que buscar "auth0" encuentra los mensajes con
  menciones. Buscar el nombre de alguien no encuentra sus menciones; para eso está el filtro por autor.
* Cada búsqueda hace una llamada sincrónica a Core, con el mismo pendiente de resiliencia que ADR-02 (sin
  timeout ni reintentos).
* Compatibilidad: un Core anterior ignora `server_id` y devuelve los canales de todos los servidores del
  usuario. La búsqueda seguiría respetando los permisos, pero mezclaría servidores: hay que desplegar Core
  antes que Chat.
