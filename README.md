# Now Playing

Spotify for the Even Realities G2: what's playing at a glance, gestures for the everyday stuff, and a menu that reaches your whole library and every playback control.

## On the glasses

| Gesture | Does |
|---|---|
| Tap | Play / pause |
| Swipe down | Next song (flip it on the phone screen if you prefer swipe up) |
| Swipe up | Restart the song, or go to the previous one if you're in the first 5 seconds |
| Double-tap | Open the menu; double-tap again to go back a level |

The now-playing screen shows the song and artist, a status line (clock, ♥ if the song is in your Liked Songs, shuffle/repeat), the progress bar, and "Next:" with the song after this one, then up to three lines of lyrics when they're on. With the album cover on, the song details, progress bar and "Next:" sit beside the cover ("Next:" level with its bottom edge) and the lyrics run full-width below. The playing device is in the menu, not on the screen.

**Menu**

- **Library**: Playlists, Albums, Artists, Podcasts, Liked Songs, Recently played
  - Every playlist, album and artist opens with **Play** and **Shuffle play**, then its songs.
  - Tap a song for **Play from here**, **Add to queue**, **Like/Unlike**, **Go to album**, **Go to artist**.
  - Podcasts resume episodes where you left off.
- **Up next**: see the queue, tap a song to skip ahead to it
- **Like / Unlike** the current song or episode
- **Shuffle** on/off, **Repeat** off / all / one song
- **Lyrics** on/off: the line being sung plus the next one, timed to the song
- **Volume**: louder, quieter, or a preset (when the device allows remote volume)
- **Seek**: restart, back/forward 10 or 30 seconds
- **Device**: move playback to any Spotify Connect device
- **Album / Artist / Show** of what's playing
- **Exit**

## Settings (phone app → Settings)

| Setting | Options |
|---|---|
| Next song | Swipe up or swipe down (the other swipe goes back). **Teach**: tap it, then swipe on the glasses the way you want. |
| Swiping back | Restarts the song first, or always goes to the previous song |
| Tap on the left arm / right arm | Play/pause, next, previous, like/unlike, or open the menu, set separately per arm |
| Album cover | Shows the cover beside the song |
| Lyrics | Time-synced lyrics on the now-playing screen (also toggled from the glasses menu) |
| Clock | Time of day in the status line |
| Right side of the progress bar | Song length or time left |
| Glance mode | Off, or hide the screen after 5/10/30 s; it comes back on song changes or a touch (a tap while hidden only wakes it) |
| Update speed | Fast, normal, or battery saver |

Swipes don't report which arm they came from (the SDK only says up or down), but taps do, which is why taps can be set per arm. The R1 ring's tap always plays/pauses.

## Setup (each user)

Spotify only lets a Development Mode app have 5 users, so each user connects their own free Spotify developer app:

1. Create an app at [developer.spotify.com/dashboard](https://developer.spotify.com/dashboard) and tick **Web API**. Spotify Premium is required.
2. Add the Redirect URI shown on the app's phone screen.
3. Paste the Client ID and tap **Connect**.

Sign-in uses PKCE, so no client secret is ever entered or stored.

**Google / Apple / Facebook sign-in** doesn't work inside the Even app's WebView (those providers block embedded sign-in). Either choose Spotify's email-code login, or open the app's URL in your phone's browser, connect there, tap **Copy sign-in key**, and paste it under **Sign-in key** in the Even app.

## Known limits (Spotify's rules, not bugs)

- **Followed playlists** (other people's, Daily Mix, Discover Weekly) can be played and shuffled, but Spotify doesn't share their track lists with Development Mode apps.
- **Liked Songs** can't be played as one big context through the API, so Play starts the newest 50 and Shuffle plays a random 50-song stretch of your library.
- **Search** isn't included: the glasses have no keyboard and voice input would need a paid speech-to-text service.
- **Volume** is unavailable on devices that block remote volume (iPhones, mostly).
- **Lyrics** aren't in Spotify's public API (Spotify's in-app lyrics come from Musixmatch through a private endpoint that needs the user's web-login cookie and breaks Spotify's developer terms). This app uses [LRCLIB](https://lrclib.net), a free community database. Coverage is good for popular music but not complete; some songs only have untimed lyrics, which the app can't follow along with. LRCLIB's lyrics are crowd-sourced, not licensed from publishers: fine for personal use, but think about that before publishing the app widely.
- **Album covers** load from Spotify's image servers. If a cover can't be downloaded, that song uses the text layout; after three failures in a row the app stops trying until the setting is switched off and on.

## Develop

```bash
npm install
npm run dev                      # Vite on :5173
npm run pack                     # build and pack now-playing.ehpk
npx evenhub qr --url https://<you>.github.io/<repo>/   # sideload the hosted build
```

Spotify sign-in needs HTTPS, or `http://127.0.0.1` locally (Spotify rejects `localhost`). Pushing to `main` deploys to GitHub Pages via `.github/workflows/pages.yml`; turn on Pages → "GitHub Actions" once in the repo settings.

### Testing without a Spotify account

`dev/mock-spotify.ts` is a stateful fake of the Spotify API (playlists with emoji names, followed playlists, devices, queue, podcasts), including the delay Spotify has before reporting changes. `dev/mock.html` runs the real app against it.

```bash
npm test                                     # text sanitizer and lyrics parser unit tests
npm run mock                                 # serves http://127.0.0.1:5173/dev/mock.html
npx evenhub-simulator "http://127.0.0.1:5173/dev/mock.html?scenario=default" --automation-port 9898
npm run test:e2e -- default                  # drives the simulator and checks every flow
```

Scenarios: `default` (every screen and control), `faults` (no active device, rate limiting, dropped connection, 502s, a request that never answers, an expired token racing a rotated refresh token), `logged-out`, `settings` (every setting switched on, including covers and glance mode), `settings-ui` (clicks through the phone's Settings tab, including Teach, and checks the glasses react), `lyrics` (timing, untimed lyrics, the remaster-title fallback, no lyrics, instrumentals, caching). The fake lyrics are placeholder text, not real songs. Restart the simulator with the matching `?scenario=` before each run.

## Layout

- `src/glasses.ts`: glasses screens, menus and gestures
- `src/spotify.ts`: Spotify Web API client (player, library, errors, rate limits, timeouts)
- `src/auth.ts`: PKCE sign-in, token refresh, sign-in keys
- `src/settings.ts`: phone screen (Home and Settings tabs)
- `src/prefs.ts`: settings, saved on the phone
- `src/art.ts`: album covers, contrast-stretched and dithered for the 16-shade display
- `src/lyrics.ts`: LRCLIB lookup, LRC parsing, current-line lookup
- `src/text.ts`: makes text safe for the glasses font
- `src/bridge.ts`: Even bridge connection, call queue, storage
