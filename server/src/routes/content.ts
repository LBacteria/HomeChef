import type { FastifyInstance } from 'fastify'
import { importStarterContent } from '../services/contentService.js'

export function registerContentRoutes(app: FastifyInstance): void {
  app.post('/api/content/starter', {
    schema: { body: { type: 'object', additionalProperties: false, required: ['pack'], properties: { pack: { type: 'string', const: 'v024' } } } },
  }, async () => importStarterContent())
}
