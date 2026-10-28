# practicemeter

A practice timer for musicians that only runs while your instrument is sounding. Put your phone on the music stand, press Start and play. When you stop to talk, check messages or stare out the window, the clock stops with you.

**Try it:** https://a2m33.github.io/practicemeter/

![practicemeter showing a running session, the daily goal ring and two weeks of practice history](docs/screenshot.png)

## Why

A normal timer counts everything between Start and Stop. You set it for an hour, answer two texts, tune for five minutes, chat with your teacher, and the timer still says an hour. practicemeter listens through the microphone and adds time only while you play. Short gaps between phrases still count, so a breath or a page turn doesn't punish you.

At the end of a session you see two numbers: how long you sat there and how long you played. The ratio between them is your efficiency.

## Features

- Big practice clock with a clear state: Playing, Short pause or Paused, shown with a label and a shape as well as colour
- Session length and efficiency (time played divided by time elapsed)
- Live level meter with the threshold line, so you can see what the app hears
- Sensitivity slider for quiet instruments, distant phones and noisy rooms
- Adjustable pause allowance, from 1 to 10 seconds (3 by default)
- Daily goal with a progress ring, 30 minutes unless you change it
- Bar chart of the last 14 days, with the minutes printed on every bar
- Streak of consecutive days you reached your goal
- CSV export of your daily totals, and a reset button
- Keeps the screen awake while listening, in browsers that support the Screen Wake Lock API
- Space starts and stops; works with a keyboard and a screen reader
- Light and dark themes that follow your system setting
- Works offline once loaded: no accounts, no server, no tracking

## How detection works

About 25 times a second the app measures the loudness of the microphone signal in decibels. For the first two seconds it measures the room to find the noise floor. After that it keeps tracking the floor as a low percentile of the last 30 seconds. The floor drops quickly when the room gets quieter and climbs slowly when it gets louder, so a fan or air conditioner that never switches off ends up treated as background.

Sound counts as playing when it rises a set number of decibels above the floor. The sensitivity slider sets that distance, between 6 and 24 dB. Sound has to last at least 150 ms before the clock starts, which filters out a dropped pencil or a knock on the stand. When you stop, the clock holds. Start again within the pause allowance and the gap counts; wait longer and the app drops the gap and pauses.

Loudness alone can't tell a held note from a steady machine hum. If you hold one perfectly even drone for more than half a minute without any break, the floor may start creeping up towards it. Normal playing has enough rests and dynamics that this doesn't happen.

The detection code lives in `detector.js`. It has no browser dependencies, and `tests/detector.test.mjs` runs it against simulated sessions.

## Privacy

Your browser analyses the sound on your own device to measure how loud it is. The app never records audio, never stores it and never sends it anywhere. Your daily totals and settings live in your browser's local storage and stay on your device until you export or reset them.

## Run locally

You need a browser and nothing else. There is no build step.

```sh
git clone https://github.com/A2M33/practicemeter.git
cd practicemeter
python -m http.server 8000
```

Then open http://localhost:8000. Browsers only share the microphone with secure pages; localhost counts as secure. Opening `index.html` straight from disk works in some browsers and not in others.

To look around without a microphone, add `?demo` to the address. Demo mode fills in sample history and a running session, and it never touches your saved data.

Run the tests with Node 18 or newer:

```sh
node tests/detector.test.mjs
```

## License

MIT. See [LICENSE](LICENSE).
