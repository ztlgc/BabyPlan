import { z } from 'zod';
import type { FastifyInstance } from 'fastify';
import type { Pool } from 'pg';
import { parseInput } from '../http/validation.js';
import type { DeletionEvent, DeletionJournal } from '../jobs/deletion-journal.js';
import {
  createFamilyBook,
  createMeasurement,
  createMemory,
  createObservation,
  deleteFamilyBook,
  deleteMeasurement,
  deleteMemory,
  deleteObservation,
  getFamilyBooks,
  listMeasurements,
  listMemories,
  listObservations,
  restoreMemory,
  restoreMeasurement,
  restoreObservation,
  updateFamilyBook,
  updateMeasurement,
  updateMemory,
  updateObservation,
} from './service.js';

const dateString = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(value => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
});
const uuidParam = z.strictObject({ childId: z.uuid() });
const memoryParam = z.strictObject({ memoryId: z.uuid() });
const measurementParam = z.strictObject({ measurementId: z.uuid() });
const observationParam = z.strictObject({ observationId: z.uuid() });
const familyParam = z.strictObject({ familyId: z.uuid() });
const bookParam = z.strictObject({ bookId: z.uuid() });
const operationRevision = z.strictObject({ operationId: z.uuid(), baseRevision: z.number().int().min(0) });
const pagination = {
  cursor: z.string().min(1).max(4096).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  from: dateString.optional(),
  to: dateString.optional(),
};

const memoryCreateSchema = z.strictObject({
  operationId: z.uuid(),
  id: z.uuid(),
  localDate: dateString,
  type: z.enum(['quote', 'story', 'first']),
  text: z.string().min(1).max(2000),
  firstConfirmed: z.boolean(),
  mediaIds: z.array(z.uuid()).max(20),
});

const memoryUpdateSchema = z.strictObject({
  operationId: z.uuid(),
  localDate: dateString,
  type: z.enum(['quote', 'story', 'first']),
  text: z.string().min(1).max(2000),
  firstConfirmed: z.boolean(),
  mediaIds: z.array(z.uuid()).max(20),
  baseRevision: z.number().int().min(0),
});

const memoryDeleteSchema = operationRevision.extend({ permanent: z.boolean() });

const measurementBase = {
  localDate: dateString,
  kind: z.enum(['height', 'weight']),
  value: z.number().positive().max(300),
  unit: z.enum(['cm', 'kg']),
  method: z.enum(['recumbent', 'standing', 'scale']),
  source: z.enum(['home', 'clinic']),
  operationId: z.uuid(),
};
const measurementCreateSchema = z.strictObject({ id: z.uuid(), ...measurementBase });
const measurementUpdateSchema = z.strictObject({ ...measurementBase, baseRevision: z.number().int().min(0) });

const observationBase = {
  guideId: z.string().min(1).max(60),
  localDate: dateString,
  value: z.enum(['noticed', 'not_yet_observed', 'discuss']),
  note: z.string().max(2000),
  operationId: z.uuid(),
};
const observationCreateSchema = z.strictObject({ id: z.uuid(), ...observationBase });
const observationUpdateSchema = z.strictObject({ ...observationBase, baseRevision: z.number().int().min(0) });

const bookCreateSchema = z.strictObject({
  operationId: z.uuid(),
  title: z.string().min(1).max(100),
  editionId: z.uuid().nullable(),
  language: z.string().min(1).max(60),
  note: z.string().max(2000),
});
const bookUpdateSchema = z.strictObject({
  operationId: z.uuid(),
  baseRevision: z.number().int().min(0),
  note: z.string().max(2000),
});

export function registerGrowthRoutes(
  app: FastifyInstance, pool: Pool, journal: DeletionJournal | null,
  onDeletion: (event: DeletionEvent) => void,
): void {
  app.post('/v2/children/:childId/memories', {
    preHandler: [app.authenticate, app.requireFamilyRole('child')],
  }, async (request, reply) => {
    const params = parseInput(uuidParam, request.params);
    const body = parseInput(memoryCreateSchema, request.body);
    const memory = await createMemory(pool, request.auth.userId, request.auth.deviceId, params.childId, body);
    return reply.code(201).send(memory);
  });

  app.get('/v2/children/:childId/memories', {
    preHandler: [app.authenticate, app.requireFamilyRole('child')],
  }, async request => {
    const params = parseInput(uuidParam, request.params);
    const query = parseInput(z.strictObject({
      ...pagination,
      type: z.enum(['quote', 'story', 'first']).optional(),
      deleted: z.enum(['true', 'false']).transform(value => value === 'true').optional(),
    }), request.query);
    return listMemories(pool, request.auth.userId, params.childId, query);
  });

  app.patch('/v2/memories/:memoryId', { preHandler: app.authenticate }, async request => {
    const params = parseInput(memoryParam, request.params);
    const body = parseInput(memoryUpdateSchema, request.body);
    return updateMemory(pool, request.auth.userId, request.auth.deviceId, params.memoryId, body);
  });

  app.delete('/v2/memories/:memoryId', { preHandler: app.authenticate }, async request => {
    const params = parseInput(memoryParam, request.params);
    const body = parseInput(memoryDeleteSchema, request.body);
    return deleteMemory(pool, request.auth.userId, request.auth.deviceId, params.memoryId, body, journal, onDeletion);
  });

  app.post('/v2/memories/:memoryId/restore', { preHandler: app.authenticate }, async request => {
    const params = parseInput(memoryParam, request.params);
    const body = parseInput(operationRevision, request.body);
    return restoreMemory(pool, request.auth.userId, request.auth.deviceId, params.memoryId, body);
  });

  app.post('/v2/children/:childId/measurements', {
    preHandler: [app.authenticate, app.requireFamilyRole('child')],
  }, async (request, reply) => {
    const params = parseInput(uuidParam, request.params);
    const body = parseInput(measurementCreateSchema, request.body);
    const measurement = await createMeasurement(pool, request.auth.userId, request.auth.deviceId, params.childId, body);
    return reply.code(201).send(measurement);
  });

  app.get('/v2/children/:childId/measurements', {
    preHandler: [app.authenticate, app.requireFamilyRole('child')],
  }, async request => {
    const params = parseInput(uuidParam, request.params);
    const query = parseInput(z.strictObject({
      ...pagination,
      deleted: z.enum(['true', 'false']).transform(value => value === 'true').optional(),
    }), request.query);
    return listMeasurements(pool, request.auth.userId, params.childId, query);
  });

  app.patch('/v2/measurements/:measurementId', { preHandler: app.authenticate }, async request => {
    const params = parseInput(measurementParam, request.params);
    const body = parseInput(measurementUpdateSchema, request.body);
    return updateMeasurement(pool, request.auth.userId, request.auth.deviceId, params.measurementId, body);
  });

  app.delete('/v2/measurements/:measurementId', { preHandler: app.authenticate }, async request => {
    const params = parseInput(measurementParam, request.params);
    const body = parseInput(operationRevision, request.body);
    return deleteMeasurement(pool, request.auth.userId, request.auth.deviceId, params.measurementId, body);
  });

  app.post('/v2/measurements/:measurementId/restore', { preHandler: app.authenticate }, async request => {
    const params = parseInput(measurementParam, request.params);
    const body = parseInput(operationRevision, request.body);
    return restoreMeasurement(pool, request.auth.userId, request.auth.deviceId, params.measurementId, body);
  });

  app.post('/v2/children/:childId/observations', {
    preHandler: [app.authenticate, app.requireFamilyRole('child')],
  }, async (request, reply) => {
    const params = parseInput(uuidParam, request.params);
    const body = parseInput(observationCreateSchema, request.body);
    const observation = await createObservation(pool, request.auth.userId, request.auth.deviceId, params.childId, body);
    return reply.code(201).send(observation);
  });

  app.get('/v2/children/:childId/observations', {
    preHandler: [app.authenticate, app.requireFamilyRole('child')],
  }, async request => {
    const params = parseInput(uuidParam, request.params);
    const query = parseInput(z.strictObject({
      ...pagination,
      deleted: z.enum(['true', 'false']).transform(value => value === 'true').optional(),
    }), request.query);
    return listObservations(pool, request.auth.userId, params.childId, query);
  });

  app.patch('/v2/observations/:observationId', { preHandler: app.authenticate }, async request => {
    const params = parseInput(observationParam, request.params);
    const body = parseInput(observationUpdateSchema, request.body);
    return updateObservation(pool, request.auth.userId, request.auth.deviceId, params.observationId, body);
  });

  app.delete('/v2/observations/:observationId', { preHandler: app.authenticate }, async request => {
    const params = parseInput(observationParam, request.params);
    const body = parseInput(operationRevision, request.body);
    return deleteObservation(pool, request.auth.userId, request.auth.deviceId, params.observationId, body);
  });

  app.post('/v2/observations/:observationId/restore', { preHandler: app.authenticate }, async request => {
    const params = parseInput(observationParam, request.params);
    const body = parseInput(operationRevision, request.body);
    return restoreObservation(pool, request.auth.userId, request.auth.deviceId, params.observationId, body);
  });

  app.get('/v2/families/:familyId/books', {
    preHandler: [app.authenticate, app.requireFamilyRole('params')],
  }, async request => {
    const params = parseInput(familyParam, request.params);
    return getFamilyBooks(pool, request.auth.userId, params.familyId);
  });

  app.post('/v2/families/:familyId/books', {
    preHandler: [app.authenticate, app.requireFamilyRole('params')],
  }, async (request, reply) => {
    const params = parseInput(familyParam, request.params);
    const body = parseInput(bookCreateSchema, request.body);
    const book = await createFamilyBook(pool, request.auth.userId, request.auth.deviceId, params.familyId, body);
    return reply.code(201).send(book);
  });

  app.patch('/v2/family-books/:bookId', { preHandler: app.authenticate }, async request => {
    const params = parseInput(bookParam, request.params);
    const body = parseInput(bookUpdateSchema, request.body);
    return updateFamilyBook(pool, request.auth.userId, request.auth.deviceId, params.bookId, body);
  });

  app.delete('/v2/family-books/:bookId', { preHandler: app.authenticate }, async request => {
    const params = parseInput(bookParam, request.params);
    const body = parseInput(operationRevision, request.body);
    return deleteFamilyBook(pool, request.auth.userId, request.auth.deviceId, params.bookId, body);
  });
}
