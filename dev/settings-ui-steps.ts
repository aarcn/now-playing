// Drives the phone settings page like a user would, for the settings-ui
// test scenario. Logs "[ui] ..." lines that dev/sim-test.mjs waits on.
import type { EvenAppBridge } from '@evenrealities/even_hub_sdk'

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))
const $ = (sel: string) => document.querySelector<HTMLElement>(sel)!
const saved = async (bridge: EvenAppBridge) => JSON.parse((await bridge.getLocalStorage('prefs_v1')) || '{}')
const guide = () => [...document.querySelectorAll('#guide tr')].map(tr => tr.textContent)

export async function run(bridge: EvenAppBridge) {
  const log = (...a: unknown[]) => console.log('[ui]', ...a)

  $('[data-tab="settings"]').click()
  log('settings tab visible', !$('#tab-settings').hidden && $('#tab-home').hidden)

  $('[data-pref="albumArt"]').click()
  await sleep(300)
  log('albumArt saved', (await saved(bridge)).albumArt)

  $('[data-pref="nextSwipe"] [data-value="up"]').click()
  await sleep(300)
  log('nextSwipe saved', (await saved(bridge)).nextSwipe, $('[data-pref="nextSwipe"] [data-value="up"]').getAttribute('aria-pressed'))

  const tapLeft = $('[data-pref="tapLeft"]') as HTMLSelectElement
  tapLeft.value = 'like'
  tapLeft.dispatchEvent(new Event('change'))
  await sleep(300)
  log('tapLeft saved', (await saved(bridge)).tapLeft)
  log('guide', JSON.stringify(guide()))

  $('[data-pref="glanceSeconds"] [data-value="10"]').click()
  await sleep(300)
  log('glance saved', (await saved(bridge)).glanceSeconds)

  await sleep(1500)
  $('#teach').click()
  log('teach waiting', $('#teach').textContent)
  for (let i = 0; i < 100 && ($('#teach') as HTMLButtonElement).disabled; i++) await sleep(200)
  log('teach result', $('#teach-hint').textContent, (await saved(bridge)).nextSwipe)

  await sleep(500)
  $('#reset-prefs').click()
  await sleep(300)
  log('reset', JSON.stringify(await saved(bridge)))
  log('done')
}
