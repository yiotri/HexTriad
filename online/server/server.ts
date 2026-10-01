/**
 * HEX0N online server: runs the matches (the real game state lives here, so nobody can cheat the
 * random triad pair or who starts) and pairs up anonymous players.
 *
 *   POST /quickmatch/:size   -> { matchID, playerID, credentials }
 *     If someone is waiting for a game on that board size, you join them (you are red, '1');
 *     otherwise you become the one waiting (blue, '0'). The page then connects to the match by socket.
 *
 * Settings (environment variables):
 *   PORT     port to listen on (hosts usually set this; default 8000)
 *   ORIGINS  comma-separated addresses of the site(s) allowed to use the server,
 *            e.g. https://yoursite.com  (localhost is always allowed for testing)
 */
import { Server, Origins } from 'boardgame.io/server';
import { BOARD_SIZES, makeOnlineHexon, onlineGameName } from '../source/game';

const PORT = Number(process.env.PORT ?? 8000);
const ORIGINS = (process.env.ORIGINS ?? '').split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);

const server = Server({
  games: BOARD_SIZES.map((n) => makeOnlineHexon(n)),
  origins: [...ORIGINS, Origins.LOCALHOST],
});

/** The one player (per board size) waiting for an opponent. */
const waiting = new Map<number, { matchID: string; since: number }>();
/** A waiting player whose page has not connected yet counts as present for this long. */
const CONNECT_GRACE_MS = 15_000;

const lobby = (path: string, body: object) =>
  fetch(`http://127.0.0.1:${PORT}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
    .then(async (r) => {
      if (!r.ok) throw new Error(`${path}: ${r.status} ${await r.text()}`);
      return r.json() as Promise<any>;
    });

/** Is the player waiting in this match still there? (Closing the tab or pressing Offline disconnects them.) */
async function stillWaiting(w: { matchID: string; since: number }): Promise<boolean> {
  const found = await server.db.fetch(w.matchID, { metadata: true });
  const p0 = found?.metadata?.players?.['0'];
  if (!p0 || found.metadata.players['1']?.name) return false; // gone, or already taken
  if (p0.isConnected === true) return true;
  return p0.isConnected === undefined && Date.now() - w.since < CONNECT_GRACE_MS;
}

/** One request at a time, so two players arriving together can't both become "the one waiting". */
let queue: Promise<unknown> = Promise.resolve();
const serialized = <T,>(fn: () => Promise<T>): Promise<T> => {
  const run = queue.then(fn, fn);
  queue = run.catch(() => undefined);
  return run;
};

async function quickMatch(size: number) {
  const game = onlineGameName(size);
  const w = waiting.get(size);
  if (w && (await stillWaiting(w))) {
    waiting.delete(size);
    const { playerCredentials } = await lobby(`/games/${game}/${w.matchID}/join`, { playerID: '1', playerName: 'anonymous' });
    return { matchID: w.matchID, playerID: '1', credentials: playerCredentials };
  }
  const { matchID } = await lobby(`/games/${game}/create`, { numPlayers: 2 });
  const { playerCredentials } = await lobby(`/games/${game}/${matchID}/join`, { playerID: '0', playerName: 'anonymous' });
  waiting.set(size, { matchID, since: Date.now() });
  return { matchID, playerID: '0', credentials: playerCredentials };
}

server.router.post('/quickmatch/:size', async (ctx) => {
  const size = Number(ctx.params.size);
  if (!(BOARD_SIZES as readonly number[]).includes(size)) ctx.throw(404, 'no such board size');
  try {
    ctx.body = await serialized(() => quickMatch(size));
  } catch (e) {
    console.error('quickmatch failed:', e);
    ctx.throw(500, 'quickmatch failed');
  }
});

/** Finished or abandoned matches are removed after a day, so the in-memory store doesn't grow forever. */
setInterval(async () => {
  const old = await server.db.listMatches({ where: { updatedBefore: Date.now() - 24 * 3600_000 } });
  await Promise.all(old.map((id) => server.db.wipe(id)));
}, 3600_000);

server.run(PORT, () => console.log(`HEX0N server on port ${PORT}; allowed sites: ${ORIGINS.join(', ') || '(localhost only)'}`));
