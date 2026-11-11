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

Sonst nichts. Insbesondere meldet T3 Claude-Prozesse wie im Original als
`CLAUDE_CODE_ENTRYPOINT=t3-code` (`apps/server/src/provider/Drivers/ClaudeHome.ts`).

## Eine Änderung machen

1. Auf `duhell` committen und pushen (direkt oder per Pull Request nach `duhell`).
2. Von selbst: Der Workflow „duHell Release“ baut (etwa 20 bis 30 Minuten) und
   legt ein Release `v<Version>` an, zum Beispiel `v0.1.9-nightly.20261111.1000004`,
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

Ein Rechner wird nur einmal von Hand umgestellt. Danach fragt sein Updater
von selbst den Fork.

**Wichtig vor jedem Wechsel:** Eigene Auto-Update-Skripte abschalten, die sich
nach npm richten (`npm view t3@nightly`, `npm i -g t3@nightly`, zum Beispiel
`t3up` mit `t3up.timer`). npm kennt nur Original-Bauten; so ein Skript würde den
Rechner zurück aufs Original holen. `t3 update` und der Update-Knopf reichen
danach, ein Fork-Bau fragt von selbst den Fork.

`t3 update … --yes` startet den Dienst neu und unterbricht laufende
Agenten-Schritte, Terminals und verbundene Clients. Also dann umstellen, wenn
gerade nichts läuft.

### Gemeinsame Befehle (Linux)

```sh
# Neueste Fork-Version, genau wie der Updater sie findet (erstes Nightly der Release-Liste)
V=$(curl -fsSL "https://api.github.com/repos/duhell-dev/t3code/releases?per_page=100" \
  | python3 -c 'import json,re,sys; print(next(r["tag_name"][1:] for r in json.load(sys.stdin) if not r["draft"] and re.fullmatch(r"v[^-+]+-nightly\.\d{8}\.\d+", r["tag_name"])))')
# Version, die der T3-Dienst dieser Home gerade fährt
aktiv() { python3 -c 'import json,os; print(json.load(open(os.path.expanduser("~/.t3/runtime/service-state.json")))["activeVersion"])'; }
echo "Fork: $V   aktiv: $(aktiv)"
```

**Wechsel** eines T3-Dienstes (`t3code.service`, Runtimes unter
`~/.t3/runtime/versions/<Version>`), als der Benutzer, dem der Dienst gehört:

```sh
T3CODE_RELEASE_BASE_URL=https://github.com/duhell-dev/t3code/releases/download \
  ~/.t3/runtime/versions/"$(aktiv)"/t3 update "$V" --yes
```

Die laufende Original-CLI lädt dabei Archiv und `SHA256SUMS` aus dem Fork, prüft
die Prüfsumme, startet zur Kontrolle `t3 --version` und startet den Dienst auf
der neuen Version neu. Meldet sie „older than the installed …“, läuft ein
Original-Nightly von einem späteren Tag: erst einen frischen Fork-Bau auslösen
(siehe „Eine Änderung machen“) und mit dessen Version wiederholen.

**Prüfen**, ob der Rechner den Fork-Bau fährt:

```sh
aktiv                                    # letzte Zahl siebenstellig, z. B. 0.1.9-nightly.20261111.1000004
systemctl --user is-active t3code.service
ps -eo args | grep -E '[r]untime/versions/[^/]+/t3 (serve|__service)'   # gleiche Version im Pfad
curl -fsS -o /dev/null -w '%{http_code}\n' \
  "https://github.com/duhell-dev/t3code/releases/download/v$(aktiv)/SHA256SUMS"   # 200 = Release aus dem Fork
```

In der Oberfläche zeigt Settings → About dieselbe Version.

**Zurück zum Original:**

```sh
O=$(npm view t3@nightly version)         # neuestes Original-Nightly
T3CODE_RELEASE_BASE_URL=https://github.com/pingdotgg/t3code/releases/download \
  ~/.t3/runtime/versions/"$(aktiv)"/t3 update "$O" --allow-downgrade --yes
systemctl --user enable --now t3up.timer 2>/dev/null || true   # nur wenn vorher abgeschaltet
```

`--allow-downgrade` ist nötig, weil ein Fork-Bau vom selben Tag die höhere Nummer trägt.

### Je Rechner

**pc1, privater T3** (`t3code.service`, Port 3773)

1. `systemctl --user disable --now t3up.timer`
2. Gemeinsame Befehle, dann „Wechsel“.
3. „Prüfen“.
4. Zurück: „Zurück zum Original“.

`t3up` ohne `--local` aktualisiert auch pc2. Auf umgestellten Rechnern also
`t3up` nicht mehr von Hand aufrufen.

**pc1, Duell-T3** (`t3-duell.service`, intern Port 3775, außen 8446, Home `~/.t3-duell`)

Dieser Dienst startet über den npm-Starter (`…/node_modules/t3/bin/t3.mjs`).
Der startet immer die Runtime **seiner npm-Version**, also einen Original-Bau,
und nutzt dafür die Runtimes aus `~/.t3`. Er hat keinen eigenen Updater. Deshalb:

1. Erst den privaten T3 auf pc1 umstellen (oben). Dann liegt die Fork-Runtime in `~/.t3/runtime/versions/$V/`.
2. Starter anlegen, der immer die aktive Version des privaten T3 nimmt:

   ```sh
   mkdir -p ~/.local/bin
   cat > ~/.local/bin/t3-aktiv <<'EOF'
   #!/bin/sh
   v=$(python3 -c 'import json,os; print(json.load(open(os.path.expanduser("~/.t3/runtime/service-state.json")))["activeVersion"])') || exit 1
   exec "$HOME/.t3/runtime/versions/$v/t3" "$@"
   EOF
   chmod +x ~/.local/bin/t3-aktiv
   ```

3. `systemctl --user edit --full t3-duell.service`, die alte `ExecStart`-Zeile
   notieren (für den Rückweg) und ersetzen durch:

   ```ini
   ExecStart=%h/.local/bin/t3-aktiv serve --mode web --base-dir %h/.t3-duell --host 127.0.0.1 --port 3775 --no-browser
   ```

4. Den Wächter `t3-duell-nachziehen` (startet den Duell-T3 neu, wenn eine neue
   Version da ist) auf dieselbe Quelle umstellen: Statt der Version aus der
   npm-`package.json` die `activeVersion` aus `~/.t3/runtime/service-state.json`
   als Sollversion lesen. Sonst vergleicht er mit einem Original-Stand.
5. `systemctl --user daemon-reload && systemctl --user restart t3-duell.service`

Prüfen:

```sh
ps -o args= -p "$(systemctl --user show -p MainPID --value t3-duell.service)"
# muss .../.t3/runtime/versions/<Fork-Version>/t3 serve ... zeigen
```

Zurück: alte `ExecStart`-Zeile wieder eintragen, den Wächter zurückstellen,
`daemon-reload`, `restart`. Danach den privaten T3 auf pc1 zurückstellen, sonst
startet der npm-Starter eine Runtime, die nicht mehr da ist.

**pc2, privater T3** (`t3code.service`, Port 3773)

Wie pc1, privater T3: `t3up.timer` abschalten, „Wechsel“, „Prüfen“, Rückweg wie dort.

**pc2, Team-T3** (eigener Benutzer, eigener `t3code.service`, Port 3774)

Alles als der Benutzer des Team-T3 und mit dessen `~/.t3`. Für `systemctl --user`
braucht die Sitzung dessen Laufzeitordner:

```sh
sudo -iu <team-benutzer>
export XDG_RUNTIME_DIR=/run/user/$(id -u)
systemctl --user list-timers | grep -i t3     # eigenes Auto-Update? dann abschalten
# danach: Gemeinsame Befehle, "Wechsel", "Prüfen" wie oben
```

Zurück wie oben, als derselbe Benutzer.

**Windows-PC mit T3-Desktop-App** (Nepo)

Seit 11.11.2026 baut jedes Fork-Release auch den Windows-Installer (NSIS, x64, die
`.exe` im Release, App „T3 Code (Nightly)“) samt `nightly.yml` für den Electron-Updater. Weil er in
`duhell-dev/t3code` gebaut wird, zeigt sein Update-Feed auf diesen Fork
(`scripts/build-desktop-artifact.ts`, `GITHUB_REPOSITORY`). Der Server in der App
ist derselbe Fork-Code, `t3 update` und „Alles aktualisieren“ holen also auch
aus dem Fork.

Umstellen (einmalig, am Windows-PC):

1. T3 Code beenden (Tray-Symbol → Quit).
2. Neuestes Release unter <https://github.com/duhell-dev/t3code/releases> öffnen,
   die `.exe` laden und starten. Der Installer ersetzt die
   Original-App an derselben Stelle, Einstellungen, Threads und Kopplungen bleiben.
3. SmartScreen warnt, weil der Bau nicht signiert ist: „Weitere Informationen“ →
   „Trotzdem ausführen“.
4. Prüfen: Settings → About zeigt eine Version mit siebenstelliger letzter Zahl.

Danach holt der Update-Knopf der App nur noch Fork-Releases. Fehlt in einem
Release der Installer (Desktop-Bau gescheitert), meldet der Updater einen Fehler
und bleibt auf seiner Version, bis das nächste Release ihn wieder enthält.

Zurück: Original-Installer von <https://github.com/pingdotgg/t3code/releases>
installieren (gleicher Weg, Daten bleiben).

## Wer ein Release auslösen kann

Jeder Push auf `duhell` erzeugt ein Release, und jeder umgestellte Rechner
installiert es beim nächsten Update. Auslösen können:

- alle mit Schreibrecht auf `duhell-dev/t3code`. `duhell` hat keinen Branch-Schutz;
  wer Schreibrecht hat, kann direkt pushen oder „Run workflow“ drücken;
- der tägliche Abgleich: Er mergt das Original **ungeprüft** nach `duhell` und
  stößt danach das Release an. Was die Betreuer des Originals committen, landet
  so ohne menschlichen Blick auf unseren Rechnern. Bei Original-Nightlies war das
  vorher genauso.

`SHA256SUMS` liegt im selben Release wie die Archive und wird vom selben Lauf
geschrieben. Die Prüfsumme schützt deshalb nur gegen kaputte oder abgebrochene
Downloads, nicht gegen ein absichtlich schlechtes Release. Signiert ist nichts.

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

Achtung: Issues sind in diesem Repository abgeschaltet. Dann kann der Abgleich
das Issue nicht anlegen, und der Lauf endet nur rot unter Actions → „Sync upstream“
(so am 11.11.2026). Ohne Token muss jemand mit Workflow-Recht von Hand mergen
(siehe „Sync-Konflikt“, dort zusätzlich `git push origin upstream/main:main`).

Mit gesetztem `SYNC_TOKEN` pusht der Abgleich damit; der Push auf `duhell`
startet das Release dann von selbst. Läuft das Token ab, erscheint wieder das Issue.

Das Token kann nur dieses eine Repository lesen und beschreiben, samt
Workflow-Dateien. Wer im Repository Schreibrecht hat, könnte es über einen
eigenen Workflow auslesen; er hätte damit aber nicht mehr Rechte als ohnehin.

Wege ohne Token gibt es, sie sind aber schlechter:

- Den Abgleich auf einem eigenen Rechner laufen lassen: Der braucht dann eine
  dauerhafte GitHub-Anmeldung mit Workflow-Recht, meist mit viel mehr Rechten als
  dieses Token, und er muss jeden Tag laufen.
- Workflow-Änderungen des Originals beim Abgleich weglassen: Dann darf `main` kein
  Spiegel mehr sein, und `duhell` kann das Original nicht mehr echt mergen (sonst
  pusht der Merge die Workflow-Commits doch mit). Man müsste jeden Tag einen
  selbstgebauten Sammel-Commit erzeugen und sich den letzten Stand des Originals
  merken. Konflikte ließen sich dann nicht mehr mit einem einfachen `git merge`
  lösen, und die Herkunft der Änderungen ginge verloren.
