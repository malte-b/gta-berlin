/**
 * Interface language: German by default, English on request.
 *
 * t('key', { name: value }) looks a string up in the current language and
 * fills in its {name} placeholders; {n|Baum|Bäume} picks the singular when
 * n is 1. Static text in index.html carries a
 * data-i18n (text), data-i18n-html (markup), data-i18n-placeholder or
 * data-i18n-title attribute naming its key and is filled in by applyStatic().
 * The choice comes from ?lang=, else what this browser chose last, else
 * German. Names from the datasets (a market, a street) stay as published.
 */

export type Lang = 'de' | 'en';

const de = {
  'page.title': 'Berlin — Das Spiel',
  'boot.sub': 'aus offenen Geodaten gebaut',
  'boot.start': 'starte…',
  'boot.manifest': 'lese Manifest…',
  'boot.textures': 'Bodentexturen',
  'boot.sky': 'Himmelslicht',
  'boot.city': 'lade die Stadt',
  'boot.tile': 'lade Kachel {k}',
  'boot.ready': 'bereit',
  'boot.failed': 'Laden fehlgeschlagen: {e}',

  'keys.help': '<kbd>W A S D</kbd> bewegen · <kbd>Q</kbd> <kbd>E</kbd> drehen · <kbd>R</kbd> <kbd>F</kbd> neigen<br>'
    + '<kbd>Shift</kbd> rennen · <kbd>Leertaste</kbd> springen<br>'
    + 'nach oben schauen und vorwärts laufen zum Fliegen · in den Boden fliegen zum Landen<br>'
    + '<kbd>1</kbd> zu Fuß · <kbd>2</kbd> Rad · <kbd>3</kbd> Scooter · <kbd>4</kbd> Auto<br>'
    + '<kbd>H</kbd> fliegen · <kbd>C</kbd> Kamera · <kbd>N</kbd> Nacht · <kbd>T</kbd> Beschriftung<br>'
    + '<kbd>G</kbd> Schatten · <kbd>M</kbd> Kartenzoom · <kbd>X</kbd> zum Start<br>'
    + '<kbd>L</kbd> Datenebenen · <kbd>/</kbd> Suche · <kbd>Esc</kbd> Maus freigeben<br>'
    + '<kbd>P</kbd> Spielmodi',
  'layers.title': 'Datenebenen',
  'layers.add': '+ GeoJSON oder CSV hinzufügen (oder Datei hineinziehen)',
  'layers.note': 'Dateien werden nur in diesem Browser gelesen und nirgendwohin hochgeladen. Punkte brauchen lat/lon oder EPSG:25833.',
  'layers.none': 'noch keine',
  'layers.remove': 'Ebene entfernen',
  'layers.added': '{name}: {n} Punkte',
  'layers.inArea': '{n} im gebauten Gebiet',
  'layers.outside': '{n} außerhalb Berlins ausgelassen',
  'layer.toiletten': 'Öffentliche Toiletten',
  'layer.schulen': 'Schulen',
  'err.noPoints': 'keine verwendbaren Punkte',
  'err.farAway': 'keiner der {n} Punkte liegt bei Berlin – bitte die Koordinatenspalten prüfen',
  'err.json': 'kein gültiges JSON – erwartet wird GeoJSON oder eine .csv-Datei',
  'err.noFeatures': 'keine Features – erwartet wird eine GeoJSON-FeatureCollection',
  'err.crs': 'Koordinaten wie {x}, {y} passen zu keinem lesbaren System (WGS84, EPSG:25833, Web Mercator)',
  'err.csvEmpty': 'die CSV hat keine Datenzeilen',
  'err.csvCols': 'keine Koordinatenspalten: lat/lon (WGS84) oder x/y (EPSG:25833) nötig',
  'search.placeholder': 'Adresse oder Ort…',
  'search.link': 'Link',
  'search.linkTitle': 'Link zu diesem Ort kopieren',
  'search.looking': 'suche „{q}“…',
  'search.failed': 'Suche fehlgeschlagen: {e}',
  'search.busy': 'die letzte Suche läuft noch',
  'search.none': 'kein Treffer für „{q}“',
  'search.outside': '{name} liegt außerhalb der geladenen Kacheln (~{d} m entfernt)',
  'credits': 'Gebäude, Straßen © OpenStreetMap-Mitwirkende (ODbL), modelliert mit OSM2World · '
    + 'Gelände: ALS Berlin · Luftbilder: TrueDOP 2024 · Bäume: Baumbestand Berlin (dl-de/zero-2.0)',

  'credits.short': '© OpenStreetMap-Mitwirkende (ODbL) · Geodaten Berlin (dl-de/zero-2.0)',
  'hud.fps': 'fps', 'hud.draws': 'Draws', 'hud.tris': 'Mio. Dreiecke',
  'hud.buildings': 'Gebäude', 'hud.trees': 'Bäume', 'hud.tiles': 'Kacheln',
  'hud.zoom': 'M — {n} M',
  'move.foot': 'zu Fuß', 'move.bike': 'auf dem Rad', 'move.scooter': 'auf dem E-Scooter',
  'move.car': 'am Steuer', 'move.flying': 'im Flug', 'move.sleigh': 'in Santas Schlitten',

  'hint.foot': 'zu Fuß',
  'hint.bike': 'auf dem Rad – Shift tritt kräftiger',
  'hint.scooter': 'auf dem E-Scooter',
  'hint.car': 'im Auto – W/S Gas, A/D lenken',
  'hint.cam0': 'Verfolgerkamera', 'hint.cam1': 'nah dran', 'hint.cam2': 'Ego-Perspektive',
  'hint.night': 'Nacht', 'hint.day': 'Tag',
  'hint.flyOn': 'Flug – Shift für Boost, Leertaste/Strg hoch und runter',
  'hint.flyOff': 'wieder am Boden',
  'hint.airborne': 'in der Luft – nach unten schauen und in den Boden fliegen zum Landen',
  'hint.landed': 'gelandet',
  'hint.labelsOn': 'Beschriftung an', 'hint.labelsOff': 'Beschriftung aus',
  'hint.layersOn': 'Datenebenen eingeblendet', 'hint.layersOff': 'Datenebenen ausgeblendet',
  'hint.respawn': 'zurück am Start',
  'hint.shadowsOn': 'Schatten an', 'hint.shadowsOff': 'Schatten aus',
  'hint.linkCopied': 'Link zu diesem Ort kopiert',
  'hint.free': 'Freies Erkunden · klicken zum Umsehen · P für Spielmodi',
  'hint.setup': 'Strecke wird vorbereitet…',
  'hint.noFair': 'In diesem Build gibt es keinen fairen Start – gespielt wird hier, ohne Wertung',
  'hint.cantStart': 'Start fehlgeschlagen: {e}',
  'hint.notIn': 'nicht bei {game}',
  'hint.sleighFlies': 'der Schlitten fliegt sowieso',
  'hint.noFlying': 'in diesem Spiel wird nicht geflogen',
  'hint.pEnds': 'P beendet das Spiel',

  'menu.free.title': 'Freies Erkunden',
  'menu.free.blurb': 'Laufen, radeln, fahren und fliegen durch ganz Berlin. Mit L eigene Datenebenen hinzufügen.',
  'menu.free.source': 'alles offene Daten',
  'menu.notPlayed': 'heutige Strecke: noch nicht gespielt',
  'menu.todayBest': 'heute bestes: {n} {unit}',
  'menu.random': '🎲 Zufall', 'menu.randomTitle': 'eine neue Strecke',
  'menu.here': '📍 hier', 'menu.hereTitle': 'hier starten, wo du stehst (ohne Wertung)',
  'menu.note': 'Ein Klick auf einen Modus spielt die Strecke des Tages – derselbe Start für alle, '
    + 'also vergleichbare Punkte · 🎲 neue Strecke · 📍 genau hier (ohne Wertung) · <kbd>P</kbd> holt dieses Menü zurück',
  'menu.challenge': '{emoji} Herausforderung: {title}',
  'menu.challengeText': 'Jemand hat dir Strecke {seed} geschickt. Gleicher Start, gleiche Ziele – schlag die Punktzahl.',
  'menu.start': 'Los',
  'menu.unranked': 'dort gespielt, wo du standest – ohne Wertung',
  'menu.today': 'Strecke des Tages · Bestwert {best}',
  'menu.course': 'Strecke {seed} · Bestwert {best}',
  'menu.newBest': '★ neuer Bestwert auf dieser Strecke! ({course})',
  'menu.data': 'Daten: {src}',
  'menu.again': 'Nochmal', 'menu.newCourse': '🎲 Neue Strecke', 'menu.freeRoam': 'Freies Erkunden',
  'menu.share': 'Strecke teilen', 'menu.copied': 'Link kopiert',
  'menu.abandoned': 'Spiel abgebrochen.',

  'game.go': 'LOS!',
  'dur.s': '{n} Sekunden',
  'dur.m': '{n} {n|Minute|Minuten}',
  'game.none': 'in der Nähe ist nichts mehr',
  'game.noTargets': 'hier im gebauten Gebiet gibt es keine Ziele',

  'mode.markets.title': 'Weihnachtsmarkt-Sause',
  'mode.markets.blurb': 'Flieg mit Santas Schlitten über die Stadt und wirf über möglichst vielen Weihnachtsmärkten Geschenke ab – in {dur}.',
  'mode.markets.controls': 'W schneller · S langsamer · Shift Boost · A D lenken · Maus oder R F steigen',
  'mode.markets.source': 'Weihnachtsmärkte 2025 · SenWEB, kuratiert von ODIS',
  'mode.markets.unit': 'Märkte', 'mode.markets.unit1': 'Markt',
  'mode.markets.score': '<b>{n}</b> {n|Weihnachtsmarkt|Weihnachtsmärkte} beschenkt',
  'mode.markets.hit': '🎁 Ho ho ho! {name}',
  'mode.markets.won': 'Frohe Weihnachten, Berlin!', 'mode.markets.lost': 'Feierabend, Santa',
  'mode.markets.line': '{n} von {of} Weihnachtsmärkten haben Geschenke bekommen.',

  'mode.heat.title': 'Hitzewelle',
  'mode.heat.blurb': '34 °C und es wird heißer. Bleib im Schatten der Bäume, hüpf von Trinkbrunnen zu Planschen, kühlen Räumen und Badestellen und halte {dur} durch.',
  'mode.heat.controls': 'Schatten bremst die Hitze · Rennen heizt auf · 1 2 3 zu Fuß, Rad, Scooter',
  'mode.heat.source': 'Trinkbrunnen, Zierbrunnen, Kühle Räume, Badestellen · im Geist der Erfrischungskarte',
  'mode.heat.unit': 'Abkühlungen', 'mode.heat.unit1': 'Abkühlung',
  'mode.heat.score': '<b>{n}</b> {n|Abkühlung|Abkühlungen}',
  'mode.heat.shade': '🌳 Schatten', 'mode.heat.sun': '☀️ Sonne',
  'mode.heat.warn': '🥵 Überhitzung! Such Wasser oder Schatten',
  'mode.heat.drink': 'Trinkbrunnen – ahh, kaltes Wasser',
  'mode.heat.splash': 'Platsch! Rein in den Brunnen',
  'mode.heat.indoor': 'Kühler Raum – Klimaanlage!',
  'mode.heat.swim': 'Ab ins Wasser! Komplett abgekühlt',
  'mode.heat.won': 'Hitze besiegt!', 'mode.heat.lost': 'Hitzschlag!',
  'mode.heat.wonLine': '{dur} durchgehalten und {n}-mal abgekühlt.',
  'mode.heat.lostLine': 'Nach {time} überhitzt, mit {n} {n|Abkühlung|Abkühlungen}.',
  'mode.heat.tip': 'Tipp: Geh im Schatten der Straßenbäume – Rennen heizt dich auf.',

  'mode.giessen.title': 'Gieß den Kiez',
  'mode.giessen.blurb': 'Junge Straßenbäume haben Durst. Füll deinen Wassersack an einer Straßenpumpe und gieß in {dur} so viele Bäume wie möglich. Je jünger der Baum, desto mehr braucht er.',
  'mode.giessen.controls': 'an der Pumpe stehen füllt auf · am 💧-Baum stehen gießt · 1 2 zu Fuß, Rad',
  'mode.giessen.source': 'Baumkataster (Bäume unter 15 Jahren) · OSM-Straßenpumpen wie bei Gieß den Kiez',
  'mode.giessen.unit': 'Bäume', 'mode.giessen.unit1': 'Baum',
  'mode.giessen.score': '<b>{n}</b> {n|Baum|Bäume} gegossen · <b>{l}</b> L',
  'mode.giessen.tree': 'Jungbaum, {age}', 'mode.giessen.age1': '1 Jahr', 'mode.giessen.ageN': '{n} Jahre',
  'mode.giessen.age0': 'unter 1 Jahr',
  'mode.giessen.pump': 'Straßenpumpe',
  'mode.giessen.full': '🪣 Voll! Ab zu den Bäumen',
  'mode.giessen.thanks': '🌳 Danke! {name} hat {l} L bekommen',
  'mode.giessen.empty': '🪣 Leer – such eine Straßenpumpe 🚰',
  'mode.giessen.watering': 'gieße… {got}/{need} L',
  'mode.giessen.pumping': 'pumpe…',
  'mode.giessen.bag': '{l} L im Sack',
  'mode.giessen.won': 'Der Kiez sagt danke!', 'mode.giessen.lost': 'Jeder Liter zählt',
  'mode.giessen.line': 'Du hast {n} {n|jungen Baum|junge Bäume} mit {l} Litern gegossen.',
  'mode.giessen.real': 'Die echten Bäume warten auf giessdenkiez.de – adoptier einen!',

  'mode.toilets.title': 'Klo-Notstand',
  'mode.toilets.blurb': 'Finde {goal} öffentliche Toiletten in {dur}. Deine Blase wartet nicht: Ist sie voll, kannst du nur noch watscheln.',
  'mode.toilets.controls': '1 2 3 4 zu Fuß, Rad, Scooter, Auto – alles erlaubt',
  'mode.toilets.source': 'Öffentliche Toiletten Berlin',
  'mode.toilets.unit': 'Toiletten', 'mode.toilets.unit1': 'Toilette',
  'mode.toilets.score': '<b>{n}</b> / {goal} Toiletten',
  'mode.toilets.full': '😬 Blase voll – nur noch Watscheln!',
  'mode.toilets.waddle': '😬 watschel…', 'mode.toilets.bladder': 'Blase {p} %',
  'mode.toilets.hit': '🚽 Puh! {name}',
  'mode.toilets.won': 'Erleichtert!', 'mode.toilets.lost': 'Zu spät…',
  'mode.toilets.wonLine': 'Alle {goal} Toiletten in {time}.',
  'mode.toilets.lostLine': '{n} von {goal} Toiletten in {dur}.',

  'mode.doener.title': 'Döner-Marathon',
  'mode.doener.blurb': 'Iss in {dur} bei so vielen Dönerläden wie möglich. Jeder Döner gibt einen Geschwindigkeitsschub – und macht dich ein bisschen schwerer.',
  'mode.doener.controls': 'in einen 🥙 laufen zum Essen · 1 2 3 zu Fuß, Rad, Scooter',
  'mode.doener.source': 'Dönerläden aus OpenStreetMap',
  'mode.doener.unit': 'Döner', 'mode.doener.unit1': 'Döner',
  'mode.doener.score': '<b>{n}</b> Döner',
  'mode.doener.power': '⚡ Döner-Power!',
  'mode.doener.weight': '{kg} kg Döner an Bord',
  'mode.doener.hit': '🥙 Mit alles! {name}',
  'mode.doener.won': 'Döner-Legende', 'mode.doener.lost': 'Satt.',
  'mode.doener.line': '{n} Döner in {dur} – {kg} kg.',
};

type Key = keyof typeof de;

const en: Record<Key, string> = {
  'page.title': 'Berlin — The Game',
  'boot.sub': 'built from open geodata',
  'boot.start': 'starting…',
  'boot.manifest': 'reading manifest…',
  'boot.textures': 'ground textures',
  'boot.sky': 'sky lighting',
  'boot.city': 'loading the city',
  'boot.tile': 'loading tile {k}',
  'boot.ready': 'ready',
  'boot.failed': 'failed to load: {e}',

  'keys.help': '<kbd>W A S D</kbd> move · <kbd>Q</kbd> <kbd>E</kbd> turn · <kbd>R</kbd> <kbd>F</kbd> tilt<br>'
    + '<kbd>Shift</kbd> sprint · <kbd>Space</kbd> jump<br>'
    + 'look up and walk forward to fly · fly into the ground to land<br>'
    + '<kbd>1</kbd> foot · <kbd>2</kbd> bike · <kbd>3</kbd> scooter · <kbd>4</kbd> car<br>'
    + '<kbd>H</kbd> fly · <kbd>C</kbd> camera · <kbd>N</kbd> night · <kbd>T</kbd> labels<br>'
    + '<kbd>G</kbd> shadows · <kbd>M</kbd> map zoom · <kbd>X</kbd> respawn<br>'
    + '<kbd>L</kbd> data layers · <kbd>/</kbd> search · <kbd>Esc</kbd> release mouse<br>'
    + '<kbd>P</kbd> game modes',
  'layers.title': 'Data layers',
  'layers.add': '+ add GeoJSON or CSV (or drop a file)',
  'layers.note': 'Files are read in this browser and not uploaded anywhere. Points need lat/lon or EPSG:25833.',
  'layers.none': 'none yet',
  'layers.remove': 'remove this layer',
  'layers.added': '{name}: {n} points',
  'layers.inArea': '{n} in the built area',
  'layers.outside': '{n} outside Berlin left out',
  'layer.toiletten': 'Public toilets',
  'layer.schulen': 'Schools',
  'err.noPoints': 'no usable points',
  'err.farAway': 'none of its {n} points is near Berlin - check the coordinate columns',
  'err.json': 'not valid JSON - expected GeoJSON or a .csv file',
  'err.noFeatures': 'no features - expected a GeoJSON FeatureCollection',
  'err.crs': 'coordinates like {x}, {y} are in no system this reads (WGS84, EPSG:25833, Web Mercator)',
  'err.csvEmpty': 'the CSV has no data rows',
  'err.csvCols': 'no coordinate columns: need lat/lon (WGS84) or x/y (EPSG:25833)',
  'search.placeholder': 'address or place…',
  'search.link': 'link',
  'search.linkTitle': 'copy a link to this spot',
  'search.looking': 'looking up "{q}"…',
  'search.failed': 'lookup failed: {e}',
  'search.busy': 'still looking up the last one',
  'search.none': 'no match for "{q}"',
  'search.outside': '{name} is outside the downloaded tiles (~{d} m away)',
  'credits': 'Buildings, streets © OpenStreetMap contributors (ODbL), modelled by OSM2World · '
    + 'terrain: ALS Berlin · photos: TrueDOP 2024 · trees: Baumbestand Berlin (dl-de/zero-2.0)',

  'credits.short': '© OpenStreetMap contributors (ODbL) · Berlin geodata (dl-de/zero-2.0)',
  'hud.fps': 'fps', 'hud.draws': 'draws', 'hud.tris': 'M tris',
  'hud.buildings': 'buildings', 'hud.trees': 'trees', 'hud.tiles': 'tiles',
  'hud.zoom': 'M — {n} M',
  'move.foot': 'on foot', 'move.bike': 'on a bike', 'move.scooter': 'on an e-scooter',
  'move.car': 'driving', 'move.flying': 'flying', 'move.sleigh': "in Santa's sleigh",

  'hint.foot': 'on foot',
  'hint.bike': 'on a bike — Shift to push harder',
  'hint.scooter': 'on an e-scooter',
  'hint.car': 'in the car — W/S throttle, A/D steer',
  'hint.cam0': 'third person', 'hint.cam1': 'close', 'hint.cam2': 'first person',
  'hint.night': 'night', 'hint.day': 'day',
  'hint.flyOn': 'flying — Shift to boost, Space/Ctrl up-down',
  'hint.flyOff': 'back on the ground',
  'hint.airborne': 'airborne — look down and fly into the ground to land',
  'hint.landed': 'landed',
  'hint.labelsOn': 'labels on', 'hint.labelsOff': 'labels off',
  'hint.layersOn': 'data layers shown', 'hint.layersOff': 'data layers hidden',
  'hint.respawn': 'back at the start',
  'hint.shadowsOn': 'shadows on', 'hint.shadowsOff': 'shadows off',
  'hint.linkCopied': 'link to this spot copied',
  'hint.free': 'free roam · click to look around · P for game modes',
  'hint.setup': 'setting up the course…',
  'hint.noFair': 'no fair start in this build — playing where you stand, unranked',
  'hint.cantStart': 'could not start: {e}',
  'hint.notIn': 'not in {game}',
  'hint.sleighFlies': 'the sleigh is always flying',
  'hint.noFlying': 'no flying in this game',
  'hint.pEnds': 'P ends the game',

  'menu.free.title': 'Free roam',
  'menu.free.blurb': 'Walk, ride, drive and fly through Berlin. Add your own data layers with L.',
  'menu.free.source': 'all of it open data',
  'menu.notPlayed': "today's course: not played yet",
  'menu.todayBest': "today's best: {n} {unit}",
  'menu.random': '🎲 random', 'menu.randomTitle': 'a new course',
  'menu.here': '📍 here', 'menu.hereTitle': 'start where you stand (unranked)',
  'menu.note': "a mode plays today's course — the same start for everyone, so scores compare · "
    + '🎲 a new course · 📍 right where you are (unranked) · <kbd>P</kbd> brings this menu back',
  'menu.challenge': '{emoji} Challenge: {title}',
  'menu.challengeText': 'Someone sent you course {seed}. Same start, same targets — beat their score.',
  'menu.start': 'Start',
  'menu.unranked': 'played where you stood — unranked',
  'menu.today': "today's course · best {best}",
  'menu.course': 'course {seed} · best {best}',
  'menu.newBest': '★ new best on this course! ({course})',
  'menu.data': 'Data: {src}',
  'menu.again': 'Again', 'menu.newCourse': '🎲 New course', 'menu.freeRoam': 'Free roam',
  'menu.share': 'Share course', 'menu.copied': 'link copied',
  'menu.abandoned': 'Game abandoned.',

  'game.go': 'GO!',
  'dur.s': '{n} seconds',
  'dur.m': '{n} {n|minute|minutes}',
  'game.none': 'nothing left nearby',
  'game.noTargets': 'no targets in the built area here',

  'mode.markets.title': 'Christmas Market Dash',
  'mode.markets.blurb': "Fly Santa's sleigh over the city and drop presents on as many Christmas markets as you can in {dur}.",
  'mode.markets.controls': 'W faster · S slower · Shift boost · A D steer · mouse or R F climb',
  'mode.markets.source': 'Weihnachtsmärkte 2025 · SenWEB, curated by ODIS',
  'mode.markets.unit': 'markets', 'mode.markets.unit1': 'market',
  'mode.markets.score': '<b>{n}</b> {n|Christmas market|Christmas markets} visited',
  'mode.markets.hit': '🎁 Ho ho ho! {name}',
  'mode.markets.won': 'Merry Christmas, Berlin!', 'mode.markets.lost': 'Clocking off, Santa',
  'mode.markets.line': '{n} of {of} Christmas markets got presents.',

  'mode.heat.title': 'Heat Wave',
  'mode.heat.blurb': '34 °C and climbing. Stay in the shade of the trees, hop between drinking fountains, splash pools, cool rooms and bathing spots, and survive {dur}.',
  'mode.heat.controls': 'shade slows the heat · running speeds it up · 1 2 3 foot, bike, scooter',
  'mode.heat.source': 'Trinkbrunnen, Zierbrunnen, Kühle Räume, Badestellen · in the spirit of the Erfrischungskarte',
  'mode.heat.unit': 'cool spots', 'mode.heat.unit1': 'cool spot',
  'mode.heat.score': '<b>{n}</b> {n|cool spot|cool spots}',
  'mode.heat.shade': '🌳 shade', 'mode.heat.sun': '☀️ sun',
  'mode.heat.warn': '🥵 Overheating! Find water or shade',
  'mode.heat.drink': 'Drinking fountain — ahh, cold water',
  'mode.heat.splash': 'Splash! Straight into the fountain',
  'mode.heat.indoor': 'Cool room — air conditioning!',
  'mode.heat.swim': 'Into the lake! Fully cooled down',
  'mode.heat.won': 'You beat the heat!', 'mode.heat.lost': 'Heatstroke!',
  'mode.heat.wonLine': 'Survived {dur} and cooled off {n} {n|time|times}.',
  'mode.heat.lostLine': 'Overheated after {time}, with {n} {n|cool spot|cool spots} visited.',
  'mode.heat.tip': 'Tip: walk in the shade of the street trees — running heats you up.',

  'mode.giessen.title': 'Water the Kiez',
  'mode.giessen.blurb': 'Young street trees are thirsty. Fill your water bag at a street pump and water as many trees as you can in {dur}. The younger the tree, the more it needs.',
  'mode.giessen.controls': 'stand at a pump to fill up · stand at a 💧 tree to water it · 1 2 foot, bike',
  'mode.giessen.source': 'Baumkataster (trees under 15 years) · OSM street pumps, as in Gieß den Kiez',
  'mode.giessen.unit': 'trees', 'mode.giessen.unit1': 'tree',
  'mode.giessen.score': '<b>{n}</b> {n|tree|trees} watered · <b>{l}</b> L',
  'mode.giessen.tree': 'young tree, {age}', 'mode.giessen.age1': '1 year', 'mode.giessen.ageN': '{n} years',
  'mode.giessen.age0': 'under a year',
  'mode.giessen.pump': 'street pump',
  'mode.giessen.full': '🪣 Full! Off to the trees',
  'mode.giessen.thanks': '🌳 Thank you! {name} got {l} L',
  'mode.giessen.empty': '🪣 Empty — find a street pump 🚰',
  'mode.giessen.watering': 'watering… {got}/{need} L',
  'mode.giessen.pumping': 'pumping…',
  'mode.giessen.bag': '{l} L in the bag',
  'mode.giessen.won': 'The Kiez says thank you!', 'mode.giessen.lost': 'Every litre counts',
  'mode.giessen.line': 'You watered {n} young {n|tree|trees} with {l} litres.',
  'mode.giessen.real': 'The real trees are on giessdenkiez.de — adopt one!',

  'mode.toilets.title': 'Toilet Emergency',
  'mode.toilets.blurb': "Find {goal} public toilets in {dur}. Your bladder doesn't wait: when it's full, you can only waddle.",
  'mode.toilets.controls': '1 2 3 4 foot, bike, scooter, car — anything goes',
  'mode.toilets.source': 'Öffentliche Toiletten Berlin',
  'mode.toilets.unit': 'toilets', 'mode.toilets.unit1': 'toilet',
  'mode.toilets.score': '<b>{n}</b> / {goal} toilets',
  'mode.toilets.full': '😬 Bladder full — you can only waddle!',
  'mode.toilets.waddle': '😬 waddling…', 'mode.toilets.bladder': 'bladder {p}%',
  'mode.toilets.hit': '🚽 Phew! {name}',
  'mode.toilets.won': 'Relieved!', 'mode.toilets.lost': 'Too late…',
  'mode.toilets.wonLine': 'All {goal} toilets in {time}.',
  'mode.toilets.lostLine': '{n} of {goal} toilets in {dur}.',

  'mode.doener.title': 'Döner Marathon',
  'mode.doener.blurb': 'Eat at as many kebab shops as you can in {dur}. Every Döner is a burst of speed — and makes you a little heavier.',
  'mode.doener.controls': 'run into a 🥙 to eat · 1 2 3 foot, bike, scooter',
  'mode.doener.source': 'Kebab shops from OpenStreetMap',
  'mode.doener.unit': 'Döner', 'mode.doener.unit1': 'Döner',
  'mode.doener.score': '<b>{n}</b> Döner',
  'mode.doener.power': '⚡ Döner power!',
  'mode.doener.weight': '{kg} kg of Döner on board',
  'mode.doener.hit': '🥙 With everything! {name}',
  'mode.doener.won': 'Döner legend', 'mode.doener.lost': 'Stuffed.',
  'mode.doener.line': '{n} Döner in {dur} — {kg} kg.',
};

const DICTS: Record<Lang, Record<Key, string>> = { de, en };

function initial(): Lang {
  const q = new URLSearchParams(location.search).get('lang');
  if (q === 'de' || q === 'en') return q;
  try {
    const s = localStorage.getItem('berlin.lang');
    if (s === 'de' || s === 'en') return s;
  } catch { /* storage blocked */ }
  return 'de';
}

export let lang: Lang = initial();
const listeners: (() => void)[] = [];

/** A string in the current language, with {name} placeholders filled in. */
export function t(key: Key | string, vars: Record<string, string | number> = {}): string {
  const s = DICTS[lang][key as Key] ?? de[key as Key] ?? key;
  return s
    .replace(/\{(\w+)\|([^|}]*)\|([^}]*)\}/g, (_m, k: string, one: string, many: string) =>
      (Number(vars[k]) === 1 ? one : many))
    .replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

/** Is there a translation for this key? (Layer names, for one, may not.) */
export function has(key: string): boolean {
  return key in de;
}

/** Numbers the way the language writes them: 1,5 kg or 1.5 kg. */
export function num(n: number, digits = 1): string {
  return n.toLocaleString(lang === 'de' ? 'de-DE' : 'en-GB',
                          { minimumFractionDigits: digits, maximumFractionDigits: digits });
}

export function setLang(l: Lang): void {
  if (l === lang) return;
  lang = l;
  try { localStorage.setItem('berlin.lang', l); } catch { /* storage blocked */ }
  applyStatic();
  for (const f of listeners) f();
}

/** Run f whenever the language changes. */
export function onLang(f: () => void): void {
  listeners.push(f);
}

/** Fill in every element in index.html that names a key. */
export function applyStatic(): void {
  document.documentElement.lang = lang;
  document.title = t('page.title');
  for (const e of document.querySelectorAll<HTMLElement>('[data-i18n]')) e.textContent = t(e.dataset.i18n!);
  for (const e of document.querySelectorAll<HTMLElement>('[data-i18n-html]')) e.innerHTML = t(e.dataset.i18nHtml!);
  for (const e of document.querySelectorAll<HTMLInputElement>('[data-i18n-placeholder]')) {
    e.placeholder = t(e.dataset.i18nPlaceholder!);
  }
  for (const e of document.querySelectorAll<HTMLElement>('[data-i18n-title]')) e.title = t(e.dataset.i18nTitle!);
  for (const b of document.querySelectorAll<HTMLElement>('[data-lang]')) {
    b.classList.toggle('on', b.dataset.lang === lang);
  }
}
