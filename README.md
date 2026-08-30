# UKFacebookCarAssistant

A Tampermonkey userscript that adds a floating research widget to Facebook Marketplace to speed up buying a car. Everything runs client-side - no external API, no server, no cost.

## Features

1. **MOT Check** - enter a UK plate, opens the official [check-mot.service.gov.uk](https://www.check-mot.service.gov.uk) results page in a new tab. Keeps a capped history of the last 20 checks, stored locally, each one a clickable link.
2. **Price Filter** - set a min and/or max price and matching listings on the search grid are hidden. Leave both blank to disable.
3. **Watchlist** - a list of searches (one per line, e.g. `Hyundai i10`), each matching a listing title if it contains all the words on that line, in any order. Import/export as `.txt`. Leave empty to disable.
4. **Time-Waster Scoring** - on an individual listing page, the description is checked for red flags (no firm price, scam phrasing, missing mileage/MOT/service history mentions). Two or more flags collapses the listing behind a warning banner you can expand.

## Install

1. Install [Tampermonkey](https://www.tampermonkey.net/) in your browser.
2. Open `car-buying-assistant.user.js` and let Tampermonkey pick it up, or paste its contents into a new script.
3. Visit `facebook.com/marketplace` - the widget appears floating in the top right and can be dragged or collapsed.

## Known limitations

- Facebook Marketplace has no stable class names, so listing selectors target structural patterns (e.g. anchors linking to `/marketplace/item/`) and will need maintenance if Facebook changes its markup.
- Time-waster scoring only runs on individual listing pages, never on the search grid, because Facebook doesn't expose full descriptions in bulk.
- The watchlist is 100% local - it only matches what you've typed in yourself, not a full specs lookup.

## Storage

All data (MOT history, watchlist, filter settings) is stored locally via Tampermonkey's `GM_setValue`/`GM_getValue` - nothing leaves your browser.
