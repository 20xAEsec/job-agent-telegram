// Preloaded by bunfig.toml: every test file shares one throwaway JOBAGENT_ROOT, so tests never touch real data/.
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

const tmp = mkdtempSync(join(tmpdir(), 'jobagent-'))
process.env.JOBAGENT_ROOT = tmp
delete process.env.JOBAGENT_DRY_RUN
process.on('exit', () => rmSync(tmp, { recursive: true, force: true }))
