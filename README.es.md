# pi-verboo-provider

[English](./README.md) · **Español**

**Verboo Code como provider de primera clase para pi** — un catálogo de modelos en vivo y rico en
capacidades, con niveles de razonamiento por modelo y una taxonomía de errores documentada, en lugar
de una lista de IDs de modelos mantenida a mano.

Pi incluye una integración declarativa de Verboo (`~/.pi/agent/models.json`): se codifican los IDs a
mano y nada los valida contra la clave, expone la capacidad de esfuerzo de razonamiento ni explica
los errores estructurados de Verboo. Este paquete registra `verboo` de forma programática y cubre
esas carencias.

## Instalación

1. Comando oficial (npm):

   ```bash
   pi install npm:@ivancavero/pi-verboo-provider
   ```

2. Alternativa sin npm (se instala directamente desde la fuente git):

   ```bash
   pi install git:github.com/ivan-cavero/pi-verboo-provider
   ```

3. Instalación local al proyecto (escribe `.pi/settings.json` en el proyecto actual) — se agrega `-l`:

   ```bash
   pi install -l npm:@ivancavero/pi-verboo-provider
   ```

4. Comandos de una línea que instalan Pi si falta y después el paquete:

   macOS/Linux:

   ```bash
   curl -fsSL https://raw.githubusercontent.com/ivan-cavero/pi-verboo-provider/main/install.sh | sh
   ```

   Windows PowerShell:

   ```powershell
   irm https://raw.githubusercontent.com/ivan-cavero/pi-verboo-provider/main/install.ps1 | iex
   ```

5. Los instaladores prefieren el paquete npm publicado y recurren a la fuente git cuando npm no está
   disponible. Se puede definir `VERBOO_PI_SOURCE` para sobrescribir la fuente que usa el instalador.

Instalar el paquete no basta para ver modelos: primero hay que autenticarse (siguiente sección).

## Autenticación

El paquete por sí solo no basta: **el provider debe estar autenticado antes de que aparezca cualquier
modelo.** Con el paquete instalado y sin credenciales, `pi --list-models verboo` imprime:

```
No models available. Use /login to log into a provider via OAuth or API key.
```

### Recomendado: `/login verboo` (persistente)

1. Iniciar pi.
2. Escribir `/login verboo`.
3. Pegar la clave de API de Verboo cuando se solicite.
4. La clave queda almacenada para sesiones posteriores y los modelos pasan a estar disponibles.

### Alternativa: `VERBOO_API_KEY`

Exportar la clave en el entorno donde se ejecuta `pi`:

```bash
export VERBOO_API_KEY=...
```

### Precedencia

| Origen | Precedencia |
|---|---|
| `VERBOO_API_KEY` | Se usa cuando no hay ninguna credencial almacenada |
| `/login verboo` | La credencial almacenada gana sobre la variable de entorno |

Una variable de entorno vacía no cuenta como configurada. El provider queda sin configurar hasta que
una de las dos fuentes proporcione una clave no vacía.

## Cómo se usa

Instalar → autenticarse → listar los modelos → elegir uno con `/model`.

```bash
# 1. Install (see above).
# 2. Authenticate: run /login verboo inside pi, or export VERBOO_API_KEY=...
pi --list-models verboo     # lists the models available to your key
```

Sin autenticación, el mismo comando imprime `No models available. Use /login to log into a provider
via OAuth or API key.` Después, ejecutar `/model` dentro de pi para elegir uno de los modelos listados.

## Qué incluye

| Capacidad | Este paquete | `models.json` declarativo de Verboo | `pi-nan-provider` |
|---|---|---|---|
| Descubrimiento de modelos | Capacidades en vivo de `/models` × catálogo de respaldo versionado | IDs que se escriben a mano | IDs en vivo × models.dev |
| Niveles de razonamiento por modelo | Derivados de los `effort_levels` de cada modelo | Se configuran manualmente | Fijos por catálogo |
| Ventana de contexto / visión | Se leen del propio Verboo | Se adivinan o se escriben | Desde models.dev |
| Manejo de errores | status/code documentado → causa + solución | Texto sin procesar del provider | Heurística de desbordamiento para el 400 opaco |
| Auth | `VERBOO_API_KEY` + `/login verboo` (gana la clave almacenada) | Solo interpolación de variables de entorno | Clave almacenada/variable de entorno |

Queda deliberadamente fuera del alcance: los puentes MCP, un comando de uso/cuota y un saneador de
payload (payload sanitizer) — la sonda demostró que Verboo acepta todas las formas de payload que
rompían Nan — véase [Procedencia](#procedencia).

## Modelos

La tabla siguiente es la **línea de base incluida en el paquete / ejemplo**: el catálogo versionado en
el paquete para que pi pueda arrancar sin red. La lista en vivo es la autoritativa: el provider la
obtiene de `GET /models`, que "devuelve únicamente los modelos disponibles para la clave autenticada",
así que el conjunto depende de la cuenta, el plan y el rol. Es posible ver más, menos o distintos
modelos que esta línea de base.

Los niveles de razonamiento son los niveles de pi que realmente se ofrecen, derivados de los
esfuerzos declarados por Verboo. `maxTokens` es `65536` para todos los modelos — véase la advertencia
a continuación.

| ID de modelo | Ventana de contexto | Visión | Niveles de razonamiento de pi admitidos |
|---|---:|---:|---|
| `deepseek-v4-flash` | 1,048,576 | no | `high`, `max` |
| `deepseek-v4-flash-0731` | 1,048,576 | no | `low`, `medium`, `high`, `xhigh`, `max` |
| `deepseek-v4.1-flash` | 1,048,576 | sí | `low`, `high`, `xhigh`, `max` |
| `glm-5.3-flash` | 1,048,576 | sí | `low`, `high`, `max` |
| `mimo-v2.5` | 1,048,576 | sí | solo `off` |
| `qwen3.8-27b` | 262,144 | sí | `off`, `low`, `medium`, `xhigh` |

Notas registradas en el catálogo generado: Verboo informa `vision: true` para `deepseek-v4.1-flash`
(la configuración de pi/OpenCode solía marcarlo como solo texto), y `mimo-v2.5` no declara capacidad
de razonamiento pero emite `reasoning_content` en las respuestas.

### Advertencia sobre `maxTokens`

Verboo no publica **ningún límite de tokens de salida**. `65536` es una cota conservadora, no un
límite publicado: la sonda midió que se aceptan `262144` en los modelos de contexto de 1M y que se
rechazan en el upstream (`502`) en `qwen3.8-27b`, donde se aceptaron `131072`. Se puede sobrescribir
por modelo cuando se necesita ese margen:

```json
{
  "providers": {
    "verboo": {
      "modelOverrides": {
        "deepseek-v4-flash": { "maxTokens": 262144 }
      }
    }
  }
}
```

`modelOverrides` cambia los metadatos de los modelos que proporciona la extensión sin reemplazar el
catálogo. El mismo mecanismo puede fijar `contextWindow`, `thinkingLevelMap`, `input` o `compat`.

### Actualización de modelos

**No existe un temporizador periódico.** El catálogo se actualiza solo en estos momentos:

| Momento | ¿Actualización por red? | Notas |
|---|---|---|
| **Arranque** de pi interactivo/RPC | Sí, en segundo plano | Primero se muestran la línea de base y el catálogo en caché; la actualización en vivo se ejecuta después, con un tiempo límite de 15 s. Se omite con `--offline` / `PI_OFFLINE=1`. |
| Apertura de **`/model`** | Sí, en segundo plano | La instantánea actual se muestra de inmediato; la actualización se ejecuta por detrás. |
| Después de que **`/login verboo`** tenga éxito | Sí, solo ese provider | |
| **`pi update --models`** | Sí, forzada | El único comando explícito para forzar una actualización. |
| Registro de extensión / cambio de credencial | **No** (solo caché) | Sin llamada de red. |
| **`pi --list-models`** | **No** | Solo imprime la instantánea actual (línea de base versionada + caché). No actualiza. |

- **Caché**: `~/.pi/agent/models-store.json` contiene una entrada por provider con los modelos y una
  marca de tiempo `checkedAt`. Solo se escribe **después** de una obtención en vivo correcta.
- **Orden de respaldo**: catálogo en caché → línea de base versionada. Si la obtención falla o la red
  no está permitida, se usa el catálogo en caché (y luego la línea de base); el catálogo anterior no
  se descarta.
- **Sin TTL/ETag para este provider**: el `fetchModels` de este provider no tiene control de frescura,
  por lo que cada actualización que usa la red realiza un `GET /models` en vivo (a diferencia del
  catálogo integrado de pi, que usa una ventana de 4 h).
- **La autenticación es obligatoria para la lista en vivo**: `fetchModels` se omite por completo
  cuando no se resuelve ninguna credencial (véase [Autenticación](#autenticación)).
- **Consecuencia**: un modelo añadido o modificado del lado de Verboo aparece después de la siguiente
  actualización (arranque, apertura de `/model` o `pi update --models`), nunca al instante. Para
  incorporar ahora un modelo nuevo de Verboo, ejecutar `pi update --models` o volver a abrir `/model`.

## Niveles de razonamiento

El `thinkingLevelMap` de cada modelo proviene de los `effort_levels` de Verboo de ese modelo: `none`
se asigna al `off` de pi, los esfuerzos con el mismo nombre se propagan tal cual, y cada nivel de pi
no admitido es un `null` explícito para que pi no lo ofrezca. La distinción importa porque pi-ai
trata un nivel *omitido* como admitido.

**El razonamiento no se puede desactivar en la mayoría de los modelos.** Solo `qwen3.8-27b` declara
`none`, por lo que es el único modelo cuyo `off` es real. En los demás, `off` no está admitido y pi
ajusta la petición hacia arriba hasta el nivel admitido más cercano (normalmente el `default_effort`
del propio Verboo).

## Taxonomía de errores

Los errores de Verboo están documentados y estructurados. El provider los convierte en un mensaje
accionable — y un desbordamiento de contexto en la frase de desbordamiento que pi reconoce, para que
pi compacte y reintente.

| Señal de Verboo | Clasificación | Qué hacer |
|---|---|---|
| `413`, o un `400` en una petición que excede la ventana | desbordamiento de contexto | pi compacta y reintenta automáticamente |
| `428` / `terms_acceptance_required` | términos | aceptar en el `acceptUrl` devuelto (se muestra la versión) |
| `401` | acceso | comprobar que `VERBOO_API_KEY` es válida; una credencial almacenada obsoleta también puede causar un 401, así que volver a ejecutar `/login verboo` |
| `403` | acceso | comprobar que el plan incluye la función; listar modelos con `GET /models` |
| `402` | saldo | añadir crédito; la solución es el saldo, no el catálogo |
| `404` | modelo | actualizar el catálogo y elegir un id listado |
| `429` | límite de tasa | esperar la ventana de límite de tasa del servidor y reintentar |
| `500` / `502` / `503` | transitorio | reintentar en breve |

Un `400` que no excede la ventana del modelo se deja intacto — los errores de validación no
relacionados nunca se reetiquetan como desbordamiento.

## Desarrollo

```bash
bun install
bun run typecheck        # tsc --noEmit
bun test                 # no network; fetch is guarded in tests
bun run probe-verboo     # live compat/cap probes -> scripts/probe-report.json
bun run generate-catalog # rebuild src/catalog.generated.ts from /models
```

`probe-verboo` y `generate-catalog` necesitan `VERBOO_API_KEY`; fallan de forma explícita sin ella y
nunca escriben la clave en ningún lugar. `generate-catalog` es idempotente byte a byte y se niega a
adivinar datos de capacidad.

## Mantenimiento: publicación

Publicado como `@ivancavero/pi-verboo-provider@0.1.0` en npm (público) y listado en la galería de Pi
en <https://pi.dev/packages/@ivancavero/pi-verboo-provider>. Para publicar una versión futura:

1. Subir `version` en `package.json`.
2. Iniciar sesión en npm: `npm login` (hay que poseer el scope `@ivancavero`).
3. Publicar de forma pública: `npm publish --access public`

Antes de publicar, hay que ejecutar `bun test` y `bun run typecheck`: no existe un script
`prepublishOnly`, así que nada los ejecuta automáticamente.

Descubrimiento: la palabra clave `pi-package` (ya presente en `package.json`) hace que el paquete sea
elegible para la galería de paquetes de Pi en <https://pi.dev/packages>. No hay un paso de envío
aparte. Los campos opcionales `pi.image` y `pi.video` añaden vistas previas en la galería.

## Procedencia

Las flags de compat se **miden, no se suponen**: `scripts/probe-report.json` registra las sondas en
vivo (uso del stream con y sin `stream_options`, `reasoning_effort: "max"`, `tools` vacíos, campos
desconocidos, `reasoning_content` reproducido y los intentos de límite de salida por modelo). Las
cabeceras de `src/catalog.generated.ts` incluyen la hora de obtención y notas por modelo. El precio
es cero porque Verboo no publica ninguno — los valores desconocidos se registran, nunca se inventan.
