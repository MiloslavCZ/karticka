# Kartička — věrnostní QR podle polohy

Jednoduchá PWA appka: otevřeš ji u pokladny a ona sama pozná (podle GPS a
map bodů zájmu z OpenStreetMap), ve kterém obchodě/na které pumpě právě
jsi, a rovnou ukáže ten správný věrnostní QR kód. Nic se neposílá na žádný
server — všechny kartičky se ukládají jen v telefonu (IndexedDB).

## Jak appka funguje

1. Po otevření appka požádá o polohu (GPS).
2. Zeptá se veřejného **OpenStreetMap Overpass API** na obchody/pumpy/kavárny
   apod. v okruhu ~90 m.
3. Porovná jejich názvy s názvy tvých uložených kartiček (funkce
   `namesMatch` v `app.js` — ignoruje diacritiku, velikost písmen, hledá
   i částečnou shodu typu „Orlen“ ⊂ „Orlen Czech Republic“).
4. Podle počtu shod:
   - **žádná shoda** → zobrazí se seznam všech kartiček k ručnímu výběru,
   - **jedna shoda** → rovnou se zobrazí ten jeden QR kód přes celou obrazovku,
   - **víc shod najednou** (např. nákupní centrum) → zobrazí se velká
     tlačítka na výběr (ALBERT / KAUFLAND / SIKO KOUPELNY…).
5. Nahoře je tlačítko **+** pro přidání nové kartičky — nahraje se foto/screenshot
   QR kódu a zadá se název obchodu (ideálně přesně tak, jak se jmenuje na mapě,
   ať appka lépe pozná shodu).

## Nasazení na GitHub Pages (zdarma, bez serveru)

1. Vytvoř si nový veřejný repozitář na GitHubu (např. `karticka`).
2. Nahraj do něj obsah této složky (`index.html`, `styles.css`, `app.js`,
   `manifest.json`, `sw.js`, složku `icons/`) — buď přes web rozhraní
   (drag & drop souborů), nebo přes git:
   ```bash
   git init
   git add .
   git commit -m "Kartička PWA"
   git branch -M main
   git remote add origin https://github.com/TVOJE-JMENO/karticka.git
   git push -u origin main
   ```
3. V repozitáři jdi do **Settings → Pages**.
4. U „Build and deployment“ zvol **Source: Deploy from a branch**,
   větev **main**, složka **/ (root)** → **Save**.
5. Po chvíli se appka objeví na adrese
   `https://TVOJE-JMENO.github.io/karticka/`.

**Důležité:** appka MUSÍ běžet přes **HTTPS** (GitHub Pages to splňuje
automaticky) — bez HTTPS prohlížeč nepovolí ani geolokaci, ani instalaci
jako PWA.

## Instalace do telefonu

- **Android (Chrome):** appka sama po chvíli nabídne dole lištu
  „Nainstalovat appku“ (díky `beforeinstallprompt`). Po klepnutí se přidá
  ikona na plochu a appka běží bez adresního řádku, jako normální appka.
- **iPhone (Safari):** Apple nativní instalační dialog nepodporuje, appka
  proto sama zobrazí návod: klepnout na **Sdílet** → **Přidat na plochu**.
  (Musí se otevřít přímo v **Safari**, ne v jiném prohlížeči nebo
  v in-app prohlížeči např. z Messengeru.)

## Poznámky / co doladit časem

- **Overpass API** je veřejné a zdarma, ale má rozumné rate limity — pro
  osobní/rodinné použití je to naprosto v pohodě. Appka požadavek posílá
  jen když se člověk pohne o víc než ~35 m nebo uplyne 25 s (viz konstanty
  na začátku `app.js`), takže zbytečně nespamuje.
- Pokud appka někde nenajde shodu (např. menší obchod, který OpenStreetMap
  nemá zmapovaný), prostě ukáže seznam všech kartiček k ručnímu výběru —
  appka tedy nikdy nezůstane „naprázdno“.
- Radius shody (`MATCH_RADIUS_M`, výchozí 90 m) i rychlost přepočtu
  (`RECHECK_MIN_DISTANCE_M`, `RECHECK_MIN_INTERVAL_MS`) jde snadno upravit
  na začátku `app.js`.
- Fotky QR kódů se ukládají přímo v telefonu (IndexedDB) — při smazání dat
  prohlížeče / appky se ztratí, žádné cloudové zálohování zatím není (dá se
  případně dodělat přes export/import JSON).
- Ikony appky (`icons/`) jsou jen jednoduchý placeholder v barvách appky —
  klidně je nahraď vlastním logem (stačí zachovat stejné rozměry 192×192
  a 512×512 px).
