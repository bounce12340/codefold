[English](README.md) | [繁體中文](README.zh-TW.md) | [简体中文](README.zh-CN.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Français](README.fr.md) (actuel) | [Español](README.es.md)

# CodeFold

CodeFold est un canevas de nœuds 2D pour VS Code, destiné à la supervision humaine.
Il replie un workspace TS/JS/Python en groupes de dossiers, développe localement les
zones en cours de modification, représente la coverage par des flux lumineux pendant
les tests et emploie une sémantique d’état fixe : jaune = modification, rouge = erreur,
vert = test réussi et gris bleuté = inconnu.

L’architecture principale actuelle prend en charge :

- Les fichiers, fonctions, class methods et arêtes import/call/contains.
- FileSystemWatcher et les edit/spawn/done/report events de plusieurs agents.
- VS Code Diagnostics, la coverage Vitest/Jest/pytest et les failure stacks.
- Quatre sources d’erreur pouvant coexister : `test`, `diagnostic`, `runtime` et `agent`.
- Un canevas 2D natif DOM＋SVG. La vue 3D est conservée uniquement comme mode de
  démonstration ; ouvrez-la avec **CodeFold: Open 3D View** (`codefold.open3d`).

## Démarrer la version de développement à partir de zéro

Prérequis : VS Code 1.90+, Node.js 18+, npm et Git.

```powershell
git clone https://github.com/bounce12340/codefold.git
Set-Location codefold
npm ci
npm run typecheck
npm run test
npm run build
code .
```

Dans VS Code, appuyez sur `F5` et choisissez **Run CodeFold Extension**. Lorsque le
nouvel Extension Development Host s’ouvre :

1. Utilisez `File → Open Folder…` pour ouvrir le repo TS/JS/Python à surveiller.
2. Le fichier `.vscode/settings.json` versionné dans ce repository définit
   `codefold.openOnStartup` sur `true` ; le canevas 2D s’ouvre donc automatiquement.
   Vous pouvez toujours exécuter **CodeFold: Open** manuellement si vous le fermez ou
   devez le rouvrir. La valeur livrée par défaut est `false` : les workspace ordinaires
   où l’extension est installée ne l’ouvrent pas automatiquement sans activation par
   l’utilisateur.
3. Ouvrez `View → Output`, sélectionnez **CodeFold**, puis notez `Agent hook endpoint`
   et `Agent hook token`. L’endpoint se lie uniquement à `127.0.0.1` ; récupérez à
   nouveau ces deux valeurs après chaque redémarrage de l’Extension Host.
4. Cliquez sur le titre d’un dossier pour le développer manuellement, sur la flèche
   d’un fichier pour développer ses fonctions, une fois pour consulter la barre
   latérale et deux fois pour ouvrir le fichier.

Pour ouvrir la démonstration 3D distincte, exécutez **CodeFold: Open 3D View**
(`codefold.open3d`). Elle est réservée à l’affichage et n’est pas reliée au flux
d’état employé par les Phase ultérieures.

Vous pouvez également valider le canevas dans un navigateur sans démarrer VS Code :

```powershell
npm run build
npm run preview
```

Ouvrez `http://127.0.0.1:4173/tools/preview/`.

## Paramètres

Dans l’Extension Development Host, appuyez sur `Ctrl+,` et recherchez `CodeFold` :

| Paramètre | Valeur par défaut | Utilité |
|---|---:|---|
| `codefold.openOnStartup` | `false` | Booléen ; ouvrir automatiquement le canevas 2D au chargement d’un workspace |
| `codefold.testCommand.javascript` | vide | Si vide, essayer Jest local selon package.json, puis Vitest ; n’installe jamais de paquet |
| `codefold.testCommand.python` | vide | Si vide, utiliser `python -m coverage run -m pytest` |
| `codefold.testCoverage.javascript` | `coverage/coverage-final.json` | Chemin JSON Istanbul/c8 |
| `codefold.testCoverage.python` | `coverage.json` | Chemin JSON coverage.py |
| `codefold.runTestsOnSave` | `false` | Exécuter les tests configurés après l’enregistrement ; désactivé par défaut, car les commandes peuvent avoir des effets de bord |
| `codefold.ignorePaths` | `[]` | Globs workspace-relative supplémentaires, comme `**/generated/**` ; rouvrir le canevas après modification |
| `codefold.flashAnimations` | `true` | Désactiver les clignotements editing/error tout en conservant les formes statiques et les couleurs d’état ; respecte aussi reduced motion |

Cliquez sur **Run tests** dans l’angle inférieur droit du canevas ou exécutez
**CodeFold: Run Tests**. Le projet cible doit déjà disposer de son propre coverage
provider (par exemple, Vitest coverage, Jest coverage ou coverage.py), et sa commande
doit réécrire le JSON report indiqué ci-dessus. CodeFold ne modifie pas les dépendances
du projet cible.

## Connecter les hooks d’agents

Le bridge partagé est
[`examples/hooks/codefold-hook.mjs`](examples/hooks/codefold-hook.mjs). Commencez par
définir les variables suivantes dans le **même PowerShell que celui utilisé pour
démarrer l’agent CLI** :

```powershell
$env:CODEFOLD_URL = 'http://127.0.0.1:49152/events' # Replace with the Output value
$env:CODEFOLD_TOKEN = '<token shown in Output>'
$env:CODEFOLD_AGENT_NAME = 'claude-main'
$env:CODEFOLD_BRIDGE = (Resolve-Path 'C:\path\to\codefold\examples\hooks\codefold-hook.mjs')
```

Le bridge nécessite Node.js 18+ et lit le hook JSON depuis stdin. Les erreurs de
l’endpoint produisent un exit code non nul au lieu d’être ignorées silencieusement.
Si l’agent surveille un autre repo, `CODEFOLD_BRIDGE` doit toujours pointer vers le
chemin absolu du bridge dans le clone CodeFold.

### Claude Code

Fusionnez la configuration suivante dans `.claude/settings.local.json` du repo
surveillé :

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

Redémarrez Claude Code et utilisez `/hooks` pour vérifier les quatre groupes de hook.
La [hooks reference](https://code.claude.com/docs/en/hooks) officielle de Claude Code
décrit les emplacements des settings, les matcher, le stdin event schema et confirme
que `shell` est un champ command-hook pris en charge, dont la valeur `"powershell"`
sélectionne PowerShell sous Windows.

> **N'ajoutez pas de tableau `args` à ces entrées de hook.** Dès que `args` est
> défini, `shell` est ignoré, car la forme exec contourne entièrement le shell. Les
> exemples ci-dessus utilisent délibérément la forme shell : c'est précisément ce qui
> rend `"shell": "powershell"` effectif. Ajouter `args` le désactiverait
> silencieusement.

### Codex CLI

Les Codex build prenant en charge `/hooks` peuvent employer la même structure
lifecycle dans `.codex/hooks.json` du repo surveillé. Sous Windows, utilisez
`commandWindows` pour indiquer explicitement le bridge :

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

Redémarrez Codex CLI, puis utilisez `/hooks` pour examiner et approuver les
repo-local hooks. Si votre Codex build ne propose pas `/hooks`, vous pouvez tout de
même employer le localhost endpoint de la section suivante ; ne supposez pas que les
champs lifecycle non pris en charge sont transmis automatiquement.

## Tester directement edit, report et le cycle de vie multi-agent

Les commandes suivantes valident l’intégralité du flux de données sans démarrer
d’agent :

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

Lorsque `level` est omis dans `agent_report`, sa valeur par défaut est error. Pour
effacer le rapport du même agent sur la même cible, envoyez `level='info'` ; cela
supprime uniquement la source `agent`, sans effacer diagnostic/test/runtime :

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

Résultat attendu : la hiérarchie affiche d’abord main → worker et le nœud en cours de
modification porte un badge worker. Pendant report, le nœud est rouge et la barre
latérale présente l’agent et le message. Après resolve, l’état rouge disparaît s’il
ne reste aucune autre error source. Après done, les badges des nœuds disparaissent et
les compteurs actif/modification de la barre d’état reviennent à zéro. Un token
incorrect doit recevoir HTTP 401, et CodeFold Output doit contenir une entrée de log.

## Smoke checklist à partir de zéro

Suivez ces éléments dans l’ordre pour reproduire tout le flux de l’architecture
principale :

- [ ] `npm ci`, `npm run typecheck`, `npm run test` et `npm run build` réussissent.
- [ ] Appuyer sur F5 pour ouvrir l’Extension Development Host ; confirmer que le
      paramètre du workspace de développement ouvre automatiquement le canevas 2D
      (ou exécuter **CodeFold: Open** pour le rouvrir manuellement).
- [ ] Configurer la commande de test et le coverage JSON du projet cible dans
      Settings, puis cliquer manuellement sur **Run tests**.
- [ ] Envoyer edit/spawn/report/resolve/done comme décrit ci-dessus et vérifier le
      canevas, la barre latérale, les badges et la barre d’état.
- [ ] Installer les hooks Claude Code ou Codex, laisser l’agent modifier un vrai
      fichier, puis relancer les tests.

Le dernier élément exige un véritable VS Code Extension Host et l’agent CLI
correspondant. Le preview dans le navigateur valide uniquement l’affichage et le DOM
du véritable renderer ; il ne remplace ni VS Code Diagnostics, ni la surveillance
des fichiers, ni le runner externe.

Pour davantage de champs de hook et des conseils de dépannage, consultez
[`docs/agent-hooks.md`](docs/agent-hooks.md). Pour les orientations futures, consultez
[`ROADMAP.md`](ROADMAP.md).

## Sécurité et limites

- Le hook server se lie uniquement à `127.0.0.1`, utilise un port aléatoire et un
  token aléatoire à chaque démarrage, et traite les requêtes dans leur ordre d’arrivée
  HTTP.
- Toutes les fonctionnalités s’exécutent localement ; aucune ne dépend d’un service
  cloud.
- La première version prend uniquement en charge TS/JS/TSX/JSX/Python, un seul repo
  et environ 2 000 fichiers.
- Le coverage JSON n’a pas d’ordre temporel réel ; le flux lumineux est donc
  actuellement une approximation stable. Consultez ROADMAP pour plus de détails.
