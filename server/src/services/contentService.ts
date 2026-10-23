import { sqlite } from '../db/index.js'
import { generateContent } from '../content/v024/recipes.js'
import { importContentV024 } from '../content/v024/importer.js'

/** Shared desktop/Android import. Existing content and stock remain untouched. */
export function importStarterContent() {
  const content = generateContent()
  return sqlite.transaction(() => importContentV024(sqlite, content, { dryRun: false })).immediate()
}
