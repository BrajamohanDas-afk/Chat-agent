import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { z } from 'zod';
import { config } from '../config.js';
import { enqueue } from '../db/client.js';
import {
  allEpisodes,
  createSession,
  createTurn,
  getSession,
  getTrace,
  listSessions,
  recentTurns,
  updateTurnStatus,
} from '../db/repo.js';
import { runTurn } from '../graph/build.js';
import { createEmitter } from './stream.js';

const ChatBody = z.strictObject({
  sessionId: z.string().min(1).optional(),
  message: z.string().min(1).max(8_000),
});

export async function buildServer() {
  const app = Fastify({ logger: true });
  await app.register(fastifyStatic, { root: join(process.cwd(), 'public') });

  app.get('/health', async () => ({ ok: true }));

  app.post('/api/demo', async () => {
    const { seedDemo } = await import('../../seed/demo.js');
    return seedDemo();
  });

  app.get('/api/sessions', async () => ({
    sessions: listSessions().map((session) => ({
      id: session.id,
      title: session.title,
      createdAt: session.created_at,
      isSynthetic: session.is_synthetic,
    })),
  }));

  app.get('/api/sessions/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const session = getSession(id);
    if (!session) return reply.code(404).send({ error: 'Session not found' });

    return {
      session: {
        id: session.id,
        title: session.title,
        createdAt: session.created_at,
        isSynthetic: session.is_synthetic,
      },
      turns: recentTurns(id, 100).map((turn) => ({
        id: turn.id,
        role: turn.role,
        text: turn.text,
        createdAt: turn.created_at,
        isSynthetic: turn.is_synthetic,
      })),
      episodes: allEpisodes()
        .filter((episode) => episode.session_id === id)
        .map((episode) => ({
          id: episode.id,
          question: episode.question,
          answer: episode.answer,
          createdAt: episode.created_at,
          isSynthetic: episode.is_synthetic,
        })),
    };
  });

  app.get('/api/trace/:turnId', async (request, reply) => {
    const { turnId } = request.params as { turnId: string };
    const trace = getTrace(turnId);
    if (trace === null) return reply.code(404).send({ error: 'Trace not found' });
    return { trace };
  });

  app.post('/api/chat', async (request, reply) => {
    const parsed = ChatBody.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: parsed.error.message });
    }

    let sessionId = parsed.data.sessionId;
    if (!sessionId) {
      sessionId = randomUUID();
      createSession({
        id: sessionId,
        title: parsed.data.message.slice(0, 60),
        created_at: new Date().toISOString(),
      });
    } else if (!getSession(sessionId)) {
      return reply.code(404).send({ error: 'Session not found' });
    }

    const sid = sessionId;
    const session = getSession(sid);
    if (!session) return reply.code(404).send({ error: 'Session not found' });

    reply.hijack();
    const emit = createEmitter(reply.raw);
    const turnId = randomUUID();
    const started = Date.now();

    try {
      await enqueue(sid, async () => {
        const now = new Date().toISOString();
        const recent = recentTurns(sid, 8);
        createTurn({
          id: turnId,
          session_id: sid,
          role: 'user',
          text: parsed.data.message,
          created_at: now,
          isSynthetic: session.is_synthetic,
        });
        await runTurn({
          sessionId: sid,
          turnId,
          userText: parsed.data.message,
          now,
          timezone: config.timezone,
          recent: recent.map((turn) => ({ role: turn.role, text: turn.text })),
          isSynthetic: session.is_synthetic,
          emit,
        });
      });
      emit({ type: 'done', turnId, sessionId: sid, latencyMs: Date.now() - started });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try {
        updateTurnStatus(turnId, 'failed');
      } catch {
        // The turn may not have been created; the stream still gets the error.
      }
      emit({ type: 'error', message });
    } finally {
      if (!reply.raw.writableEnded) reply.raw.end();
    }
  });

  return app;
}
