# Design Board for phones

The phone version of Design Board: compare new designs row by row (the original first, then v1, v2, v3…), star favourites, comment, send a design to a shop, or send it to **To be edited** with a copy of its original and a ready-to-paste ChatGPT prompt.

It works with the same Google Drive folders and the same shared log as the Windows app, so stars, comments and moves made on the phone show up on the computers, and the other way round.

- Open it in Chrome (Android) or Safari (iPhone) and choose **Add to Home Screen** to get an app icon.
- Sign in with the Google account that has your design folders.
- This repository holds only the page's code. There are no passwords, no files and no business data in it. Your designs stay in your Google Drive, and only the Google accounts added as test users in the Google Cloud project can sign in.

## How it fits with the Windows app

| | Phone | Windows app |
|---|---|---|
| Reads | the Designs folder, `_Design Board/shops.csv` and every `log-*.csv` | the same |
| Writes | its own log file, `log-<name>-phone-xxxx.csv` | `log-<name>-<computer>.csv` |
| Moves files | with the Google Drive API (never copies or deletes, except copying a row's original into To be edited) | through Google Drive for desktop |
| Edit requests.xlsx | – | kept up to date |
| Shops | finds the shop folders by itself from `shops.csv` | where shops are added |

## Safety

Same rules as the Windows app: files are only moved, never overwritten or deleted; if a name is taken, " (2)" is added; every move is logged first or put back; every move can be undone from the toast or the Move log.

## Setup (once)

1. Google Cloud project with the **Google Drive API** turned on.
2. OAuth consent screen: **External**, in **Testing**, with each person's Google account added as a test user.
3. OAuth client of type **Web application** with this site as an authorised JavaScript origin, e.g. `https://<github-user>.github.io`.
4. Put the client ID in `config.js` (it isn't a secret).

## Files

```
index.html, styles.css   the page
app.js                   the screens
board.js                 loading the board from Drive; star, comment, move, send to edit, undo
drive.js                 Google sign-in (in the browser) and the Drive API calls
core.js                  logic shared with the Windows app (logs, rows, prompt): must stay identical
tests/                   logic tests, and the whole app at iPhone size against a pretend Google Drive
```

Run the tests with `node --test tests/core.test.mjs` and `node --test tests/phone.e2e.mjs` (needs Playwright and Python with Pillow).
