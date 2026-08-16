# Kartička — věrnostní QR podle polohy

PWA appka: otevřeš ji u pokladny a ona sama pozná, ve kterém obchodě/na
které pumpě právě jsi, a rovnou ukáže ten správný věrnostní QR kód. Nic se
neposílá na žádný server — všechno se ukládá jen v telefonu (IndexedDB).

## Jak appka pozná, kde jsi (v tomto pořadí)

1. **Vlastní uložená místa kartičky** (`locations`) — když si u kartičky
   klepneš na **„📍 Uložit, že jsem tady“**, appka si zapamatuje přesné GPS
   souřadnice. Příště porovnání proběhne okamžitě, bez internetu — funguje
   i pro obchody uvnitř nákupních center, které mapy nikdy nezmapují.
2. **Lokální databáze poboček podle značky** — u kartiček, kde jsi při
   přidávání vybral značku z našeptávače (Kaufland, Albert, OMV...), appka
   na pozadí jednorázově stáhne (přes OpenStreetMap Overpass) souřadnice
   **všech poboček té značky v ČR** a uloží si je do telefonu. Odteď se
   porovnává jen s touto malou lokální databází — žádné dotazy na síť za
   běhu, appka funguje i offline.
3. **Živý dotaz na OpenStreetMap** — záložní metoda, použije se jen pro
   kartičky bez přiřazené značky (vlastní/neznámý název) nebo pro značky,
   které se ještě nestihly stáhnout.
4. **Ruční výběr ze seznamu** — když appka nic nenajde.

Když appka najde shodu přes bod 2 nebo 3, rovnou si tu polohu zapamatuje
jako bod 1 pro příště — appka se tedy postupně sama zrychluje.

## Proč ne "stáhnout úplně všechny obchody v ČR"

Kompletní databáze všech obchodů by byla zbytečně velká (desítky až stovky
MB) a navíc by nevyřešila hlavní problém: OpenStreetMap u drtivé většiny
nákupních center nemá zmapované jednotlivé obchody uvnitř, jen budovu
centra jako celek. Proto je bod 1 (vlastní ruční potvrzení) nejspolehlivější
metoda a zůstává na prvním místě.

## Přidání kartičky

V modálu pro přidání kartičky napiš pár písmen názvu obchodu (`kau`, `alb`,
`omv`...) — appka nabídne shody ze zabudovaného seznamu značek
(`brands.js`, ~50 běžných řetězců v ČR). Po výběru se ke kartičce uloží
`brandId` a appka na pozadí stáhne pobočky té značky.

Pokud tvůj obchod v seznamu není, klidně napiš vlastní text — kartička se
uloží bez `brandId` a appka ji bude hledat přes živý dotaz na mapu (bod 3
výše) nebo přes ruční „Uložit, že jsem tady“ (bod 1).

### Staré kartičky (bez značky)

Kartičky vytvořené před touto verzí appky nemají `brandId` — dál fungují
přesně jako předtím (bod 3 + bod 1). V jejich detailu je teď navíc odkaz
**„Přiřadit značku“**, kterým jim značku můžeš přiřadit dodatečně a získat
tak rychlejší rozpoznávání i pro ně.

## Nasazení na GitHub Pages

1. Vytvoř veřejný repozitář na GitHubu a nahraj do něj **všechny soubory**
   z této složky (`index.html`, `styles.css`, `app.js`, `brands.js`,
   `manifest.json`, `sw.js`, `.nojekyll`, složku `icons/`).
2. V repozitáři: **Settings → Pages → Source: Deploy from a branch**,
   větev **main**, složka **/ (root)** → **Save**.
3. Appka poběží na `https://tvoje-jmeno.github.io/nazev-repa/`.
4. Appka MUSÍ běžet přes HTTPS (GitHub Pages to splňuje automaticky) —
   bez toho prohlížeč nepovolí geolokaci ani instalaci jako PWA.

## Instalace do telefonu

- **Android (Chrome):** appka sama nabídne dole lištu „Nainstalovat appku“.
- **iPhone (Safari):** appka zobrazí vlastní návod — Sdílet → Přidat na
  plochu. Musí se otevřít přímo v Safari (ne v in-app prohlížeči).

## Struktura IndexedDB

- **`cards`** — `{ id, brandId, name, image, createdAt, locations[] }`
- **`pois`** — `{ id, brandId, lat, lon }` (jen souřadnice, žádné adresy,
  telefony ani otevírací doby — databáze zůstává maximálně malá), index na
  `brandId` pro rychlý výběr jen relevantních poboček
- **`syncMeta`** — `{ brandId, syncedAt, poiCount }` — kdy a kolik poboček
  bylo pro danou značku naposledy staženo (re-sync po 30 dnech, nebo ručně
  tlačítkem „🔄 Aktualizovat pobočky“ v detailu kartičky)

## Přidání další značky

Stačí přidat záznam do `brands.js`:
```js
{ id: 99, name: "Nová Značka" }
```
Nepovinné pole `q` slouží jako přesnější vyhledávací text pro OpenStreetMap
dotaz (např. `q: "dm"` pro „dm drogerie markt“), pokud se liší od
zobrazovaného jména. Žádný jiný kód se měnit nemusí.

## Poznámky

- Radius automatického rozpoznání (`AUTO_MATCH_RADIUS_M`, 100 m) se mírně
  rozšiřuje podle přesnosti GPS (`coords.accuracy`), max. o dalších 150 m
  — u nepřesné polohy tak appka spíš nabídne víc kandidátů na výběr, než
  aby automaticky vybrala špatný obchod.
- Overpass API je veřejné a zdarma, používá se jen zřídka (jednou za měsíc
  na značku, plus jako záložní metoda) — žádné agresivní zatěžování.
- Fotky QR kódů a poloha se ukládají jen v telefonu; při smazání dat
  prohlížeče/appky se ztratí, žádné cloudové zálohování zatím není.
