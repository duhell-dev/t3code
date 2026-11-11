# duHell-Fork von T3 Code

Dieser Fork baut eigene T3-Releases. Rechner, die einmal auf einen Fork-Bau
umgestellt sind, holen sich über den Update-Knopf (und `t3 update`) ab dann nur
noch Releases aus diesem Fork.

## Zweige und Workflows

| Was | Wozu |
| --- | --- |
| `main` | reiner Spiegel von `pingdotgg/t3code`, nie selbst darauf committen |
| `duhell` | Standardzweig mit unseren Änderungen; daraus entstehen die Releases |
| `.github/workflows/sync-upstream.yml` | täglich 04:17 UTC: Original nach `main` spiegeln, `main` in `duhell` mergen, danach Release anstoßen |
| `.github/workflows/duhell-release.yml` | bei jedem Push auf `duhell` und per Hand: CLI-Archive Linux x64 und Windows x64 bauen, als Release veröffentlichen |

Alle anderen Workflows stammen aus dem Original und sind abgeschaltet. Taucht
beim Abgleich eine neue Workflow-Datei des Originals auf, schaltet der Sync sie
gleich ab.

Unsere Änderungen am Code des Originals:

- `packages/shared/src/cliRelease.ts:6`: `CLI_RELEASE_REPOSITORY = "duhell-dev/t3code"`.
  Davon hängen Release-Liste, Download-URL und `SHA256SUMS` des Updaters ab.

## Eine Änderung machen

1. Auf `duhell` committen und pushen (direkt oder per Pull Request nach `duhell`).
2. Von selbst: Der Workflow „duHell Release“ baut (etwa 20 bis 30 Minuten) und
   legt ein Release `v<Version>` an, zum Beispiel `v0.1.9-nightly.20261111.1000001`,
   mit `t3-<Version>-linux-x64.tar.gz`, `t3-<Version>-win32-x64.zip` und `SHA256SUMS`.
3. Rechner mit Fork-Bau sehen die neue Version beim nächsten Update-Check.
   Der Update-Knopf beziehungsweise `t3 update --yes` installiert sie.

Per Hand auslösen: Actions → „duHell Release“ → „Run workflow“, oder
`gh workflow run duhell-release.yml -R duhell-dev/t3code --ref duhell`.

### Versionsnummer

`<Basis>-nightly.<JJJJMMTT>.<1000000 + Laufnummer>`, Basis wie im Original
(Version aus `apps/desktop/package.json`, Patch + 1). Der Updater erkennt nur
Nightlies genau in diesem Schema (`cliReleaseChannelOf`), daher sind keine
Buchstaben wie `duhell` möglich. Fork-Bauten erkennt man an der siebenstelligen
letzten Zahl (das Original zählt bei etwa 4500) und am Release-Titel
„T3 Code duHell Nightly …“. Am selben Tag ist ein Fork-Bau also immer neuer als
jedes Original-Nightly. An späteren Tagen entscheidet das Datum.

## Was der Fork-Bau ändert und was nicht

- `t3 update`, der Update-Knopf und der Track-Wechsel laden Archiv und Prüfsummen
  nur noch von `github.com/duhell-dev/t3code/releases/download/v<Version>/`.
- Die npm-Abfrage (`apps/server/src/cloud/npmRelease.ts`, nur im Dialog
  „Update track“) liefert weiter Versionsnummern des Originals. Ein Fork-Bau
  kann sie trotzdem nicht installieren: Die Nummer gibt es im Fork nicht, der
  Download endet mit 404 und der Meldung „No release archive was published for
  t3@…“. Es wird nichts installiert. Die Fork-Nummern (ab 1000000) kollidieren nie
  mit denen des Originals.
- Dasselbe gilt, wenn eine Desktop-App des Originals verbundene Fork-Server auf
  ihre eigene Version „mitziehen“ will: Das schlägt mit derselben Meldung fehl
  und lässt den Server, wie er ist.
- Signiert sind die Fork-Bauten nicht (kein Authenticode unter Windows).
  Windows SmartScreen kann beim ersten Start warnen.

## Rechner umstellen (einmalig)

Vorher den Release-Namen holen, auf den umgestellt wird (das neueste Fork-Nightly):

```sh
V=$(curl -fsSL "https://api.github.com/repos/duhell-dev/t3code/releases?per_page=100" \
  | python3 -c 'import json,re,sys; print(next(r["tag_name"][1:] for r in json.load(sys.stdin) if not r["draft"] and re.fullmatch(r"v[^-+]+-nightly\.\d{8}\.\d+", r["tag_name"])))')
echo "$V"
```

Eigene Auto-Update-Skripte zuerst abschalten. Ein Skript, das `npm i -g t3@nightly`
ausführt oder sich nach `npm view t3@nightly` richtet, holt sonst das Original
zurück (npm kennt nur Original-Bauten). Danach `t3 update` ohne npm reicht,
denn ein Fork-Bau fragt von selbst den Fork.

### Linux, T3 als Dienst (`t3code.service`, Ordner `~/.t3/runtime/versions/<Version>`)

Als der Benutzer, dem der Dienst gehört:

```sh
# 1. eigenes Auto-Update stoppen, falls vorhanden (Beispiel t3up)
systemctl --user disable --now t3up.timer 2>/dev/null || true

# 2. mit der laufenden (Original-)CLI auf den Fork-Bau wechseln
CUR=$(python3 -c 'import json,os; print(json.load(open(os.path.expanduser("~/.t3/runtime/service-state.json")))["activeVersion"])')
T3CODE_RELEASE_BASE_URL=https://github.com/duhell-dev/t3code/releases/download \
  ~/.t3/runtime/versions/"$CUR"/t3 update "$V" --yes
```

`t3 update` lädt das Archiv aus dem Fork, prüft es gegen `SHA256SUMS`, startet
`t3 --version` zur Kontrolle und startet den Dienst auf der neuen Version neu.
Meldet er „older than the installed …“, läuft auf dem Rechner ein Original-Nightly
von einem späteren Tag. Dann zuerst einen frischen Fork-Bau auslösen (siehe oben)
und mit dessen Version wiederholen; `--allow-downgrade` nur, wenn das Original
höchstens einen Tag voraus ist.

Hat der Rechner einen zweiten T3 auf einer eigenen Home (`--base-dir`), der über
den npm-Starter `t3` läuft (`…/node_modules/t3/bin/t3.mjs`): Der npm-Starter
startet immer die Runtime **seiner** npm-Version, also eines Original-Baus. Den
`ExecStart` dieses Dienstes deshalb auf die Runtime des umgestellten Haupt-T3
zeigen lassen. Dafür ein kleiner Starter, der immer die aktive Version des
Haupt-T3 nimmt:

```sh
mkdir -p ~/.local/bin
cat > ~/.local/bin/t3-aktiv <<'EOF'
#!/bin/sh
v=$(python3 -c 'import json,os; print(json.load(open(os.path.expanduser("~/.t3/runtime/service-state.json")))["activeVersion"])') || exit 1
exec "$HOME/.t3/runtime/versions/$v/t3" "$@"
EOF
chmod +x ~/.local/bin/t3-aktiv
```

Im Dienst (`systemctl --user edit --full <dienst>`) dann zum Beispiel:

```ini
ExecStart=%h/.local/bin/t3-aktiv serve --mode web --base-dir %h/.t3-duell --host 127.0.0.1 --port 3775 --no-browser
```

und danach `systemctl --user daemon-reload && systemctl --user restart <dienst>`.
Ein Wächter, der den zweiten T3 nach einer neuen npm-Version neu startet, muss
dann ebenfalls `activeVersion` statt der npm-Paketversion vergleichen.

### Je Rechner

| Rechner | Was zu tun ist |
| --- | --- |
| pc1, privater T3 (`t3code.service`, Port 3773) | Abschnitt „Linux, T3 als Dienst“. Vorher `t3up.timer` abschalten. |
| pc1, Duell-T3 (`t3-duell.service`, intern Port 3775, außen 8446) | Läuft über den npm-Starter und nutzt die Runtimes aus `~/.t3`. Erst den privaten T3 auf pc1 umstellen, dann `ExecStart` wie oben ändern, Wächter `t3-duell-nachziehen` anpassen, Dienst neu starten. |
| pc2, privater T3 (`t3code.service`, Port 3773) | Abschnitt „Linux, T3 als Dienst“ als Besitzer dieses Dienstes. Vorher `t3up.timer` abschalten. |
| pc2, Team-T3 (eigener Benutzer, Port 3774) | Abschnitt „Linux, T3 als Dienst“ als der Benutzer des Team-T3, mit dessen `~/.t3`. |
| Windows-PC mit Desktop-App | Siehe nächster Abschnitt. Die Desktop-App kann nicht auf einen Fork-Bau wechseln. |

### Windows mit T3-Desktop-App

Die Desktop-App hat einen **eigenen Update-Weg**: Sie aktualisiert sich als
Installer über den Electron-Updater aus den Releases des Originals. Dieser Fork
baut keine Desktop-Installer. Auch `C:\Users\<name>\.t3\bin\t3.cmd` ist nur ein
Shim, den die App schreibt; er startet die **in der App gebündelte** CLI, keine
Runtime aus `runtime\versions`. Ein `t3 update` darüber ändert an der App nichts.

Was das heißt:

- Die Desktop-App bleibt ein Original-Bau und aktualisiert sich weiter vom Original.
  Als Client für Fork-Server funktioniert sie. Ihr „Alles aktualisieren“ will
  Fork-Server auf die App-Version ziehen; das schlägt ungefährlich fehl (siehe oben).
- Soll auf dem Windows-PC selbst ein Fork-**Server** laufen, dann daneben die
  Fork-CLI installieren und als Dienst betreiben (PowerShell):

  ```powershell
  $env:T3CODE_RELEASE_BASE_URL = "https://github.com/duhell-dev/t3code/releases/download"
  $env:T3CODE_VERSION = "<V>"   # Fork-Version, siehe oben
  irm https://raw.githubusercontent.com/duhell-dev/t3code/duhell/scripts/install.ps1 | iex
  & "$HOME\.local\bin\t3.exe" service install
  ```

  Den lokalen Server der Desktop-App dann ausschalten und die App mit diesem
  Server verbinden. Achtung: Das Installskript legt `t3.exe` nach
  `~\.local\bin`, der Shim der App liegt in `~\.t3\bin`. Wer in `PATH` zuerst
  steht, ist „`t3`“.

### Prüfen, ob ein Rechner den Fork-Bau fährt

```sh
python3 -c 'import json,os; print(json.load(open(os.path.expanduser("~/.t3/runtime/service-state.json")))["activeVersion"])'
# Fork-Bau: letzte Zahl siebenstellig, zum Beispiel 0.1.9-nightly.20261111.1000001
ps -eo args | grep -E 'runtime/versions/[^/]+/t3 (serve|__service)'   # Pfad zeigt dieselbe Version
systemctl --user is-active t3code.service
```

Die Version muss als Release in `https://github.com/duhell-dev/t3code/releases`
stehen. In der Oberfläche zeigt Settings → About dieselbe Version.
Unter Windows: `& "$HOME\.local\bin\t3.exe" --version`.

## Zurück zum Original

Linux, Dienst (die Fork-CLI zieht mit der Basis-URL wieder vom Original):

```sh
O=$(npm view t3@nightly version)      # neuestes Original-Nightly
T3CODE_RELEASE_BASE_URL=https://github.com/pingdotgg/t3code/releases/download \
  ~/.t3/runtime/versions/"$(python3 -c 'import json,os; print(json.load(open(os.path.expanduser("~/.t3/runtime/service-state.json")))["activeVersion"])')"/t3 \
  update "$O" --allow-downgrade --yes
systemctl --user enable --now t3up.timer 2>/dev/null || true   # nur wenn vorher abgeschaltet
```

`--allow-downgrade` ist nötig, weil ein Fork-Bau vom selben Tag eine höhere
Nummer trägt. Ein geänderter `ExecStart` für einen zweiten T3 wird wieder auf
den npm-Starter zurückgestellt. Windows: den Fork-Dienst mit
`t3.exe service uninstall` entfernen und den lokalen Server der Desktop-App
wieder einschalten.

## Sync-Konflikt

Der tägliche Abgleich ändert nichts, wenn der Merge kollidiert, und legt ein
Issue „Sync mit Original: Konflikt“ an. Lösen:

```sh
git clone https://github.com/duhell-dev/t3code.git && cd t3code   # oder vorhandenen Klon nehmen
git checkout duhell && git pull
git fetch origin main
git merge origin/main          # Konflikte lösen, dabei unsere Änderungen behalten
git commit && git push origin duhell
```

Der Push löst das Release selbst aus. Das Issue danach schließen. `main` nie
anfassen: Der Spiegel muss ein reiner Vorlauf des Originals bleiben, sonst
scheitert der Abgleich beim Spiegeln.

## Token für den Abgleich

Das Standard-Token von GitHub Actions darf keine Änderungen an
`.github/workflows/` pushen. Ändert das Original eine Workflow-Datei (das passiert
an den meisten Tagen), bricht der Abgleich ab und legt das Issue „Sync mit
Original blockiert: Token mit Workflow-Recht fehlt“ an. `main` und `duhell`
bleiben dann unverändert, es entsteht kein Release.

Abhilfe, einmalig:

1. github.com → oben rechts Profilbild → **Settings** → links ganz unten
   **Developer settings** → **Personal access tokens** → **Fine-grained tokens**
   → **Generate new token**.
2. Name: `duhell-sync`. Expiration: 1 Jahr. **Resource owner: `duhell-dev`**.
3. Repository access: **Only select repositories** → `duhell-dev/t3code`.
4. Permissions → Repository permissions: **Contents: Read and write**,
   **Workflows: Read and write**. (Metadata: Read-only setzt GitHub selbst.)
   Sonst nichts.
5. **Generate token**, den Wert kopieren.
6. `github.com/duhell-dev/t3code` → **Settings** → **Secrets and variables** →
   **Actions** → **New repository secret**. Name `SYNC_TOKEN`, Wert einfügen, speichern.
7. Falls die Organisation Token-Freigaben verlangt: unter
   `github.com/organizations/duhell-dev/settings/personal-access-token-requests`
   freigeben.
8. Actions → „Sync upstream“ → **Run workflow**.

Mit gesetztem `SYNC_TOKEN` pusht der Abgleich damit; der Push auf `duhell`
startet das Release dann von selbst. Läuft das Token ab, erscheint wieder das Issue.
