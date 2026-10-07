import { glassesText, clip, clipPx, approxPx, label, mmss, width } from '../src/text.ts'
const cases: [string, string][] = [
  ['🔥🔥 Gym Bangers 🔥', 'Gym Bangers'],
  ['Don’t Stop Me Now', "Don't Stop Me Now"],
  ['Song – Remastered 2011', 'Song - Remastered 2011'],
  ['Wait…', 'Wait...'],
  ['❤️ Love ♥ ★', 'Love ♥ ★'],
  ['Beyoncé © 2016 ™', 'Beyoncé © 2016 ™'],
  ['🇯🇵 日本の歌', '日本の歌'],
  ['👨‍👩‍👧 family', 'family'],
  ['A B   C', 'A B C'],
]
let fail = 0
const check = (got: unknown, want: unknown, what: string) => { if (got !== want) { fail++; console.log("FAIL", what, JSON.stringify(got), "want", JSON.stringify(want)) } }
for (const [i, want] of cases) { const got = glassesText(i); if (got !== want) { fail++; console.log('FAIL', JSON.stringify(i), '->', JSON.stringify(got), 'want', JSON.stringify(want)) } }
check(clip('A very long playlist name that keeps going and going forever', 20), 'A very long playl...', 'clip by width')
check(new TextEncoder().encode(clip('日本語の長いプレイリストの名前がここにありますよね本当に長い', 42, 63)).length <= 63, true, 'clip by bytes')
check(width('日本'), 4, 'CJK counts double')
check(label('🔥🔥🔥', 'Untitled'), 'Untitled', 'all-emoji fallback')
check(mmss(3725000), '1:02:05', 'hours')
check(mmss(65000), '1:05', 'minutes')
check(mmss(-5), '0:00', 'negative')
// approxPx is calibrated to simulator measurements (it may err a little wide, never much narrow)
const near = (est: number, measured: number) => est >= measured - 5 && est <= measured * 1.12
check(near(approxPx('Next: Redbone \u00B7 Childish Ga...'), 250), true, 'approxPx vs measured 250px')
check(near(approxPx('Queen \u00B7 A Night at the Opera'), 244), true, 'approxPx vs measured 244px')
check(approxPx(clipPx('WWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWWW', 396)) <= 396, true, 'clipPx keeps all-caps within width')
check(clipPx('Short', 396), 'Short', 'clipPx leaves short text alone')
console.log(fail ? `${fail} failures` : 'all text tests pass')
process.exit(fail ? 1 : 0)
