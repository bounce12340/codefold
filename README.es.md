[English](README.md) | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Français](README.fr.md) | [Español](README.es.md) (actual)

# CodeFold

CodeFold es un lienzo de nodos 2D para VS Code destinado a la supervisión humana.
Pliega un workspace de TS/JS/Python en grupos de carpetas, expande localmente las
zonas que se están editando, representa la coverage como flujos de luz durante las
pruebas y utiliza una semántica de estados fija: amarillo = edición, rojo = error,
verde = prueba superada y gris azulado = desconocido.

La arquitectura principal actual admite:

- Archivos, funciones, class methods y aristas import/call/contains.
- FileSystemWatcher y edit/spawn/done/report events de varios agentes.
- VS Code Diagnostics, coverage de Vitest/Jest/pytest y failure stacks.
- Cuatro fuentes de errores que pueden coexistir: `test`, `diagnostic`, `runtime` y `agent`.
- Un lienzo 2D nativo con DOM＋SVG. La vista 3D se conserva únicamente como modo de
  demostración; ábrela con **CodeFold: Open 3D View** (`codefold.open3d`).

## Iniciar la versión de desarrollo desde cero

Requisitos: VS Code 1.90+, Node.js 18+, npm y Git.

```powershell
git clone https://github.com/bounce12340/codefold.git
Set-Location codefold
npm ci
npm run typecheck
npm run test
npm run build
code .
```

En VS Code, pulsa `F5` y elige **Run CodeFold Extension**. Cuando se abra el nuevo
Extension Development Host:

1. Usa `File → Open Folder…` para abrir el repo TS/JS/Python que quieras supervisar.
2. El archivo `.vscode/settings.json` incluido en este repository establece
   `codefold.openOnStartup` en `true`, por lo que el lienzo 2D se abre automáticamente.
   Si lo cierras o necesitas volver a abrirlo, todavía puedes ejecutar manualmente
   **CodeFold: Open**. El valor predeterminado de la versión distribuida es `false`;
   por ello, no se abre automáticamente en los workspace con una instalación normal,
   salvo que el usuario lo habilite.
3. Abre `View → Output`, selecciona **CodeFold** y anota `Agent hook endpoint` y
   `Agent hook token`. El endpoint solo se enlaza a `127.0.0.1`; vuelve a obtener
   ambos valores cada vez que se reinicie el Extension Host.
4. Haz clic en el título de una carpeta para expandirla manualmente y en la flecha de
   un archivo para expandir sus funciones; haz un solo clic para consultar la barra
   lateral y doble clic para abrir el archivo.

Para abrir la demostración 3D independiente, ejecuta **CodeFold: Open 3D View**
(`codefold.open3d`). Es exclusivamente visual y no está conectada al flujo de estados
que utilizan las Phase posteriores.

También puedes validar el lienzo en un navegador sin iniciar VS Code:

```powershell
npm run build
npm run preview
```

Abre `http://127.0.0.1:4173/tools/preview/`.

## Configuración

En el Extension Development Host, pulsa `Ctrl+,` y busca `CodeFold`:

| Configuración | Valor predeterminado | Finalidad |
|---|---:|---|
| `codefold.openOnStartup` | `false` | Booleano; abrir automáticamente el lienzo 2D al cargar un workspace |
| `codefold.testCommand.javascript` | vacío | Si está vacío, probar Jest local según package.json y después Vitest; nunca instala paquetes |
| `codefold.testCommand.python` | vacío | Si está vacío, usar `python -m coverage run -m pytest` |
| `codefold.testCoverage.javascript` | `coverage/coverage-final.json` | Ruta del JSON de Istanbul/c8 |
| `codefold.testCoverage.python` | `coverage.json` | Ruta del JSON de coverage.py |
| `codefold.runTestsOnSave` | `false` | Ejecutar las pruebas configuradas después de guardar; desactivado de forma predeterminada porque los comandos pueden tener efectos secundarios |
| `codefold.ignorePaths` | `[]` | Globs workspace-relative adicionales, como `**/generated/**`; vuelve a abrir el lienzo después de modificarlos |
| `codefold.flashAnimations` | `true` | Desactivar los destellos de editing/error y conservar las formas estáticas y los colores de estado; también respeta reduced motion |

Haz clic en **Run tests** en la esquina inferior derecha del lienzo o ejecuta
**CodeFold: Run Tests**. El proyecto de destino debe tener ya instalado su propio
coverage provider (por ejemplo, Vitest coverage, Jest coverage o coverage.py), y su
comando debe volver a escribir el JSON report indicado arriba. CodeFold no modifica
las dependencias del proyecto de destino.

## Conectar hooks de agentes

El bridge compartido es
[`examples/hooks/codefold-hook.mjs`](examples/hooks/codefold-hook.mjs). Primero,
define las siguientes variables en el **mismo PowerShell que se utiliza para iniciar
el agent CLI**:

```powershell
$env:CODEFOLD_URL = 'http://127.0.0.1:49152/events' # Replace with the Output value
$env:CODEFOLD_TOKEN = '<token shown in Output>'
$env:CODEFOLD_AGENT_NAME = 'claude-main'
$env:CODEFOLD_BRIDGE = (Resolve-Path 'C:\path\to\codefold\examples\hooks\codefold-hook.mjs')
```

El bridge requiere Node.js 18+ y lee el hook JSON desde stdin. Los errores del
endpoint generan un exit code distinto de cero en lugar de ignorarse silenciosamente.
Si el agente supervisa otro repo, `CODEFOLD_BRIDGE` debe seguir apuntando a la ruta
absoluta del bridge dentro del clone de CodeFold.

### Claude Code

Combina lo siguiente en `.claude/settings.local.json` dentro del repo supervisado:

```json
{
  "hooks": {
    "PreToolUse": [{
      "matcher": "Write|Edit",
      "hooks": [{
        "type": "command",
        "command": "node \"$env:CODEFOLD_BRIDGE\"",
        "shell": "powershell"
      }]
    }],
    "PostToolUse": [{
      "matcher": "Write|Edit",
      "hooks": [{
        "type": "command",
        "command": "node \"$env:CODEFOLD_BRIDGE\"",
        "shell": "powershell"
      }]
    }],
    "SubagentStart": [{
      "hooks": [{
        "type": "command",
        "command": "node \"$env:CODEFOLD_BRIDGE\"",
        "shell": "powershell"
      }]
    }],
    "SubagentStop": [{
      "hooks": [{
        "type": "command",
        "command": "node \"$env:CODEFOLD_BRIDGE\"",
        "shell": "powershell"
      }]
    }]
  }
}
```

Reinicia Claude Code y utiliza `/hooks` para confirmar los cuatro grupos de hook. La
[hooks reference](https://code.claude.com/docs/en/hooks) oficial de Claude Code
documenta las ubicaciones de settings, los matcher, el stdin event schema y que
`shell` es un campo command-hook compatible cuyo valor `"powershell"` selecciona
PowerShell en Windows.

> **No añadas un arreglo `args` a estas entradas de hook.** En cuanto se define
> `args`, `shell` se ignora, porque la forma exec omite por completo el shell. Los
> ejemplos anteriores usan deliberadamente la forma shell: eso es justamente lo que
> hace que `"shell": "powershell"` surta efecto. Añadir `args` lo desactivaría de
> forma silenciosa.

### Codex CLI

Las versiones de Codex que admiten `/hooks` pueden utilizar la misma estructura de
lifecycle en `.codex/hooks.json` dentro del repo supervisado. En Windows, usa
`commandWindows` para indicar explícitamente el bridge:

```json
{
  "description": "Report Codex edits and subagents to CodeFold.",
  "hooks": {
    "PreToolUse": [{
      "matcher": "Edit|Write",
      "hooks": [{
        "type": "command",
        "command": "node /absolute/path/to/codefold/examples/hooks/codefold-hook.mjs",
        "commandWindows": "node C:\\absolute\\path\\to\\codefold\\examples\\hooks\\codefold-hook.mjs"
      }]
    }],
    "PostToolUse": [{
      "matcher": "Edit|Write",
      "hooks": [{
        "type": "command",
        "command": "node /absolute/path/to/codefold/examples/hooks/codefold-hook.mjs",
        "commandWindows": "node C:\\absolute\\path\\to\\codefold\\examples\\hooks\\codefold-hook.mjs"
      }]
    }],
    "SubagentStart": [{
      "hooks": [{
        "type": "command",
        "command": "node /absolute/path/to/codefold/examples/hooks/codefold-hook.mjs",
        "commandWindows": "node C:\\absolute\\path\\to\\codefold\\examples\\hooks\\codefold-hook.mjs"
      }]
    }],
    "SubagentStop": [{
      "hooks": [{
        "type": "command",
        "command": "node /absolute/path/to/codefold/examples/hooks/codefold-hook.mjs",
        "commandWindows": "node C:\\absolute\\path\\to\\codefold\\examples\\hooks\\codefold-hook.mjs"
      }]
    }]
  }
}
```

Reinicia Codex CLI y utiliza `/hooks` para inspeccionar y confiar en los repo-local
hooks. Si tu Codex build no ofrece `/hooks`, puedes seguir utilizando el localhost
endpoint de la sección siguiente; no des por hecho que los campos lifecycle no
compatibles se notifican automáticamente.

## Probar directamente edit, report y el ciclo de vida multiagente

Los comandos siguientes validan el flujo de datos completo sin iniciar un agente:

```powershell
$headers = @{ Authorization = "Bearer $env:CODEFOLD_TOKEN" }

function Send-CodeFoldEvent([hashtable]$Event) {
  $body = $Event | ConvertTo-Json -Compress
  Invoke-RestMethod $env:CODEFOLD_URL -Method Post -Headers $headers `
    -ContentType 'application/json' -Body $body
}

Send-CodeFoldEvent @{
  type='agent_edit_start'; agent_id='main'; agent_name='Claude main'
  node_id='src/index.ts#activate'
}
Send-CodeFoldEvent @{
  type='agent_spawn'; agent_id='worker'; agent_name='Review worker'
  parent_agent_id='main'
}
Send-CodeFoldEvent @{
  type='agent_edit_start'; agent_id='worker'; path='src/extension.ts'
}
Send-CodeFoldEvent @{
  type='agent_report'; agent_id='worker'; path='src/extension.ts'
  message='Response can be sent twice on this branch.'
}
```

Cuando `agent_report` omite `level`, su valor predeterminado es error. Para borrar el
informe del mismo agente sobre el mismo destino, envía `level='info'`; esto solo
elimina la fuente `agent` y no borra diagnostic/test/runtime:

```powershell
Send-CodeFoldEvent @{
  type='agent_report'; agent_id='worker'; path='src/extension.ts'
  level='info'; message='Double-send branch resolved.'
}
Send-CodeFoldEvent @{
  type='agent_edit_end'; agent_id='worker'; path='src/extension.ts'
}
Send-CodeFoldEvent @{ type='agent_done'; agent_id='worker' }
Send-CodeFoldEvent @{ type='agent_done'; agent_id='main' }
```

Resultado esperado: la jerarquía muestra primero main → worker y el nodo en edición
muestra una insignia worker. Durante report, el nodo aparece en rojo y la barra
lateral muestra el agente y el mensaje. Después de resolve, el estado rojo desaparece
si no queda ninguna otra error source. Después de done, desaparecen las insignias de
los nodos y los recuentos activo/edición de la barra de estado vuelven a cero. Un
token no válido debe recibir HTTP 401, y CodeFold Output debe contener una entrada
de log.

## Smoke checklist desde cero

Sigue estos elementos en orden para reproducir el flujo completo de la arquitectura
principal:

- [ ] `npm ci`, `npm run typecheck`, `npm run test` y `npm run build` se completan correctamente.
- [ ] Pulsar F5 para abrir el Extension Development Host; confirmar que la configuración
      del workspace de desarrollo abre automáticamente el lienzo 2D (o ejecutar
      **CodeFold: Open** para volver a abrirlo manualmente).
- [ ] Configurar el comando de pruebas y el coverage JSON del proyecto de destino en
      Settings y, después, hacer clic manualmente en **Run tests**.
- [ ] Enviar edit/spawn/report/resolve/done como se describe arriba y verificar el
      lienzo, la barra lateral, las insignias y la barra de estado.
- [ ] Instalar los hooks de Claude Code o Codex, dejar que el agente edite un archivo
      real y volver a ejecutar las pruebas.

El último elemento requiere un VS Code Extension Host real y el agent CLI
correspondiente. El preview del navegador solo valida la presentación visual y el
DOM del renderer real; no sustituye a VS Code Diagnostics, la supervisión de archivos
ni el runner externo.

Para consultar más campos de hook y soluciones de problemas, consulta
[`docs/agent-hooks.md`](docs/agent-hooks.md). Para conocer las líneas futuras, consulta
[`ROADMAP.md`](ROADMAP.md).

## Seguridad y limitaciones

- El hook server solo se enlaza a `127.0.0.1`, utiliza un port aleatorio y un token
  aleatorio en cada inicio, y procesa las solicitudes en el orden de llegada HTTP.
- Todas las funciones se ejecutan localmente; no existe ninguna dependencia de
  servicios cloud.
- La primera versión solo admite TS/JS/TSX/JSX/Python, un único repo y unos 2 000
  archivos.
- El coverage JSON no contiene un orden temporal real, por lo que el flujo de luz es
  actualmente una aproximación estable; consulta ROADMAP para obtener más detalles.
