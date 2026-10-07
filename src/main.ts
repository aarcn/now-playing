import { connectBridge } from './bridge'
import { finishLogin } from './auth'
import { bindSettings, renderSettings } from './settings'
import { startGlasses } from './glasses'

const bridge = await connectBridge()
const loginError = await finishLogin()

bindSettings()
await renderSettings(loginError)

// Outside the Even app (e.g. a desktop browser) only the settings page runs.
if (bridge) await startGlasses()
