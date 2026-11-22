## ADR 06: Presencia (estado elegido, tiempo real e inactividad)

**Contexto:**
El usuario elige su estado (Conectado, Ausente, No molestar, Invisible) y los demás lo ven en la lista de
amigos, los DMs y la lista de miembros de un servidor. Hasta ahora:

* El estado elegido no salía del cliente: Chat solo sabía si había un inbox conectado (`presence:<userId>`,
  TTL 60 s) y respondía `online` u `offline`. Invisible no escondía nada y al recargar se perdía la elección.
* Auth tiene una columna `activity_status`, pero nadie la actualiza.
* Los demás se enteraban por polling a `POST /presence` cada 30 s.

Restricciones:

* **La conexión ya vive en Chat.** El inbox WS y su heartbeat son la única señal de que alguien está.
* **Varias instancias.** El inbox de un usuario y el de quien lo mira pueden estar en instancias distintas;
  ya hay pub/sub de Redis para los mensajes (`channel:<id>`, `inbox:<id>`).
* **Quién mira a quién no se puede calcular en Chat.** Además de amigos y DMs (que Chat podría conocer), la
  lista de miembros de un servidor muestra a cualquiera de sus miembros, y eso es de Core.

**Decisión:**

* **El estado elegido va en Chat, en Redis:** `presence:pref:<userId>` sin TTL, con
  `GET`/`PUT /presence/me`. Lo que ven los demás se calcula al leer: desconectado, suspendido o invisible es
  `offline`; conectado, lo que eligió. `activity_status` de Auth no se usa.
* **Tiempo real por suscripción:** el cliente manda por el inbox `PRESENCE_SUBSCRIBE` con los ids que tiene en
  pantalla (hasta 500, reemplaza la lista anterior) y recibe un `PRESENCE_SNAPSHOT` con su estado actual.
  Cada cambio visible se publica en el canal de Redis `presence-updates` (`{ userId, status }`); todas las
  instancias lo reciben y cada una lo reenvía como `PRESENCE_UPDATE` a sus sockets suscriptos a ese usuario,
  con el id tal como lo pidieron (alias de login federado incluidos).
* **Solo se publican transiciones:** la renovación del heartbeat usa `SET … EX 60 GET` y publica solo si el
  valor anterior era otro (recién conectado, o activo ↔ inactivo). Borrar la clave al cerrarse el último
  socket publica `offline`. Cambiar el estado elegido publica el estado nuevo, y `MY_STATUS` al inbox del
  propio usuario para sus otras sesiones.
* **Inactividad:** el cliente manda `ACTIVITY { idle }`. La clave de conexión pasa a valer `idle` solo si
  todas las pestañas del usuario en esa instancia están inactivas. Quien eligió Conectado se ve Ausente; No
  molestar e Invisible no cambian. Como vive en la clave de conexión, vence con ella y nunca pisa la
  preferencia guardada.
* **El polling queda como respaldo**, cada 60 s en vez de 30.

**Alternativas descartadas:**

| Alternativa | Por qué se descartó |
|---|---|
| Guardar el estado en Auth (`activity_status`) | Chat tendría que consultar Auth en cada lectura de presencia o cachearlo, y la conexión ya está en Chat. Dos servicios para un solo dato. |
| Avisar a amigos y conversaciones en vez de suscripción | No cubre la lista de miembros de un servidor (sus miembros son de Core) y obliga a consultar Auth en cada cambio. La suscripción además manda solo lo que el cliente muestra. |
| Publicar a todos los inbox conectados | Cada cambio llega a todos los usuarios: crece con el cuadrado de los conectados. |
| Un canal de Redis por usuario observado (`presence:<id>`) | Una instancia tendría que suscribirse y desuscribirse a miles de canales según lo que muestran sus sockets. Con un solo canal, el filtro es un `Map` en memoria. Se puede cambiar si el volumen lo pide sin tocar el protocolo del cliente. |
| Inactividad como cambio de estado elegido (`PUT /presence/me` con `idle`) | Si el usuario cierra la pestaña estando inactivo, al volver arranca Ausente. La inactividad es de la sesión, no una elección. |
| Keyspace notifications de Redis para el vencimiento | Requiere configurar Redis (`notify-keyspace-events`) y solo cubre el caso de una instancia caída. El polling lo resuelve. |

**Consecuencias:**

* Si una instancia de Chat se cae, las claves de sus usuarios vencen sin aviso (hasta 60 s) y los demás lo
  ven en el próximo polling (hasta 60 s más).
* La inactividad se junta por instancia: con pestañas en dos instancias, gana la última que renovó la
  clave. Con una sola instancia por nodo, alcanza.
* Cada `PRESENCE_SUBSCRIBE` resuelve los ids con Auth (`/internal/users/{id}/canonical`, cacheado). Si Auth no
  responde no llega el snapshot, pero el socket sigue abierto y el polling cubre.
* `POST /presence` sigue respondiendo el estado de cualquier id, como antes. No se agregó control de quién
  puede ver a quién.
* Mobile cierra el inbox en segundo plano: al bloquear el teléfono figura desconectado, no ausente.
* Compatibilidad: un cliente viejo no manda `PRESENCE_SUBSCRIBE` y sigue con polling; uno nuevo contra un
  Chat viejo no recibe eventos y también sigue con polling. Conviene desplegar Chat antes que la WebApp.
