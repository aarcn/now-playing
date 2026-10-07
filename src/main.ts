import { connectBridge } from './bridge'
import { finishLogin } from './auth'
import { bindSettings, loadPrefs, renderSettings } from './settings'
import { startGlasses } from './glasses'

const bridge = await connectBridge()
const loginError = await finishLogin()

await loadPrefs()
bindSettings()
await renderSettings(loginError)

// Outside the Even app (e.g. a normal browser) only the settings page runs.
if (bridge) await startGlasses()
