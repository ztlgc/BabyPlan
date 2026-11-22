import type { AuthContext } from '../auth/types.js';

declare module 'fastify' {
  interface FastifyRequest {
    auth: AuthContext;
  }

  interface FastifyInstance {
    authenticate: (request: FastifyRequest) => Promise<void>;
    requireFamilyRole: (
      source: 'params' | 'child',
      roles?: ReadonlyArray<'owner' | 'caregiver'>,
    ) => (request: FastifyRequest) => Promise<void>;
  }
}
