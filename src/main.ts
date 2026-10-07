import { connectBridge } from './bridge'
import { finishLogin } from './auth'
import { loadPrefs } from './prefs'
import { bindSettings, renderAccount } from './settings'
import { startGlasses } from './glasses'

const bridge = await connectBridge()
const loginError = await finishLogin()

await loadPrefs()
bindSettings()
await renderAccount(loginError)

// Outside the Even app (e.g. a normal browser) only the phone screen runs.
if (bridge) await startGlasses()
