import { parseSynced, lineAt, simplifyTitle } from '../src/lyrics.ts'

let fail = 0
const check = (got: unknown, want: unknown, what: string) => {
  const g = JSON.stringify(got), w = JSON.stringify(want)
  if (g !== w) { fail++; console.log('FAIL', what, g, 'want', w) }
}

const lrc = '[ti:Test]\n[00:01.50] first line\n[00:04.00]\n[00:06.25][01:06.25] repeated chorus\n[1:10.123] three-digit millis\nno timestamp here'
const lines = parseSynced(lrc)
check(lines.map(l => l.ms), [1500, 4000, 6250, 66250, 70123], 'timestamps (incl. multi-stamp, 3-digit ms, 1-digit minutes)')
check(lines.map(l => l.text), ['first line', '', 'repeated chorus', 'repeated chorus', 'three-digit millis'], 'texts (metadata tags skipped)')

check(lineAt(lines, 0), -1, 'before the first line')
check(lineAt(lines, 1500), 0, 'exactly on a line')
check(lineAt(lines, 5000), 1, 'between lines')
check(lineAt(lines, 999999), 4, 'after the last line')
check(lineAt([], 1000), -1, 'no lines')

check(simplifyTitle('Song Title - Remastered 2011'), 'Song Title', 'remaster suffix')
check(simplifyTitle('Song Title – Live at Wembley'), 'Song Title', 'en-dash suffix')
check(simplifyTitle('Song Title (feat. Someone)'), 'Song Title', 'feat.')
check(simplifyTitle('Song Title [with Someone]'), 'Song Title', 'with')
check(simplifyTitle('Self-Titled'), 'Self-Titled', 'hyphen inside a word is kept')
check(simplifyTitle('Plain'), 'Plain', 'unchanged')
check(simplifyTitle('Don\u2019t Stop \u2013 Remastered'), "Don't Stop", 'curly apostrophe made straight')

console.log(fail ? `${fail} failures` : 'all lyrics tests pass')
process.exit(fail ? 1 : 0)
