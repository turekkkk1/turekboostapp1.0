# TurekBoost

Prosta, realnie działająca aplikacja desktopowa dla graczy:

- **Analiza sieci** — ping w czasie rzeczywistym (aktualny/średni czas, jitter, min/max, % utraty pakietów) do wybranego serwera lub własnego hosta, z wykresem na żywo.
- **PC Boost** — podgląd CPU/RAM, lista procesów wg zużycia pamięci z możliwością zamknięcia, oraz jednoklikowe akcje: tryb wysokiej wydajności zasilania, czyszczenie cache DNS, optymalizacja parametrów TCP.

Wszystkie dane są prawdziwe — czytane bezpośrednio z systemu (ping, systeminformation), bez żadnych fikcyjnych/udawanych wartości.

## Uruchomienie (tryb deweloperski)

Wymaga zainstalowanego [Node.js](https://nodejs.org) (wersja 18+).

```bash
npm install
npm start
```

## Budowanie pliku .exe (Windows)

```bash
npm run build
```

Gotowy instalator pojawi się w folderze `dist/`. Uruchom to polecenie na Windowsie (lub w środowisku CI z Windowsem) — `electron-builder` domyślnie buduje pod platformę, na której jest odpalany.

## Wysyłka wersji portable

Jeśli chcesz wysłać aplikację bez instalatora, uruchom:

```bash
npm run build:portable
```

Spakuj cały folder `dist/win-unpacked` do RAR-a. Znajdujący się w nim `TurekBoost.exe` musi pozostać razem z pozostałymi plikami i folderem `resources`. Znajomy powinien najpierw wypakować RAR, a dopiero potem uruchomić `TurekBoost.exe`.

## Uwagi

- Akcje "Tryb wysokiej wydajności", "Optymalizuj TCP" oraz część funkcji boost działają tylko na Windows (używają `powercfg` i `netsh`).
- Niektóre akcje (zmiana planu zasilania, `netsh`) mogą wymagać uruchomienia aplikacji jako administrator — jeśli akcja zwróci błąd uprawnień, uruchom TurekBoost prawym przyciskiem → "Uruchom jako administrator".
- Ta wersja **nie** zawiera tunelowania/przekierowania trasy sieciowej (jak w ExitLag) — to wymagałoby własnej infrastruktury serwerów VPN w wielu lokalizacjach. Może być dodane w kolejnym etapie jako osobny moduł.

## Struktura projektu

```
netboost/
├── package.json
└── src/
    ├── main.js        # proces główny Electron: ping, system info, akcje boost
    ├── preload.js      # bezpieczny most API do renderera
    └── renderer/
        ├── index.html
        ├── style.css
        └── renderer.js
```
