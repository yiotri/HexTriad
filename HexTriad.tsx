import React, { useMemo, useState } from 'react';
import { Client } from 'boardgame.io/react';
import type { BoardProps } from 'boardgame.io/react';
import { INVALID_MOVE } from 'boardgame.io/core';
import type { Ctx, Game } from 'boardgame.io';

/**********************
 * Game Types & Config
 **********************/
export type PlayerID = string;

export type Piece = 'EMPTY' | 'SQUARE' | 'CIRCLE' | 'TRIANGLE' | 'HEX';

export interface Cell {
  piece: Piece;
  owner: PlayerID | null; // null for EMPTY
}

export interface GState {
  size: number; // board is size x size
  board: Cell[]; // length = size * size
  hexCount: Record<PlayerID, number>; // scoreboard
  pendingHexOptions: number[] | null; // cells eligible for hex placement after a triad
  lastTriad: number[] | null; // last triad (for UI)
  lastMove: number | null; // cell of the most recent placement (for UI)
  squaresLeft: Record<PlayerID, number>; // each player's remaining squares
  lastTriadOptions: number | null; // how many valid pairs the last triad could have used (one was picked at random)
}

export type TriadPair = { circle: number; square: number };

export interface GameOver {
  winner?: PlayerID;
  draw?: boolean;
  reason?: string;
}

const BOARD_SIZE = 5; // default board (5x5 tested best); 7x7 also offered

/**********************
 * Helpers
 **********************/
const idx = (row: number, col: number, size: number) => row * size + col;

const inBounds = (r: number, c: number, size: number) => r >= 0 && r < size && c >= 0 && c < size;

const emptyCell = (): Cell => ({ piece: 'EMPTY', owner: null });

const isValidIndex = (G: GState, i: number) => Number.isInteger(i) && i >= 0 && i < G.board.length;

/** 8-neighborhood (orthogonal + diagonal). */
export const neighborsWithDiagonals = (i: number, size: number): number[] => {
  if (!Number.isInteger(i) || !Number.isInteger(size)) return [];
  const r = Math.floor(i / size);
  const c = i % size;
  const res: number[] = [];
  for (let dr = -1; dr <= 1; dr++) {
    for (let dc = -1; dc <= 1; dc++) {
      if (dr === 0 && dc === 0) continue;
      const rr = r + dr;
      const cc = c + dc;
      if (inBounds(rr, cc, size)) res.push(idx(rr, cc, size));
    }
  }
  return res;
};

/** True if cell i touches a piece of `kind`; pass `owner` to count only that player's pieces. */
const hasAdjPiece = (G: GState, i: number, kind: Piece, owner?: PlayerID): boolean => {
  if (!isValidIndex(G, i)) return false;
  return neighborsWithDiagonals(i, G.size).some(
    (n) => G.board[n]?.piece === kind && (owner === undefined || G.board[n].owner === owner)
  );
};

/**
 * Candidate (circle, square) pairs around cell i that a triangle by `player` could use.
 * Rule: the pair may be any colors, but at least one of the two must belong to the mover.
 */
export const triadPairs = (G: GState, i: number, player: PlayerID): TriadPair[] => {
  const N = neighborsWithDiagonals(i, G.size); // ascending index order
  const circles = N.filter((n) => G.board[n]?.piece === 'CIRCLE');
  const squares = N.filter((n) => G.board[n]?.piece === 'SQUARE');
  const pairs: TriadPair[] = [];
  for (const circle of circles) {
    for (const square of squares) {
      if (G.board[circle].owner === player || G.board[square].owner === player) pairs.push({ circle, square });
    }
  }
  return pairs;
};

/** A triangle needs an adjacent circle and square (any colors), at least one of them the mover's. */
const canPlaceTriangle = (G: GState, i: number, player: PlayerID): boolean => triadPairs(G, i, player).length > 0;

/** Remove triangle + circle + square and open hex placement on those three cells. */
const resolveTriad = (G: GState, triangle: number, pair: TriadPair) => {
  const triad = [triangle, pair.circle, pair.square];
  for (const cell of triad) G.board[cell] = emptyCell();
  G.pendingHexOptions = [...triad];
  G.lastTriad = [...triad];
  G.lastMove = null;
};

/** Pick one of the valid pairs uniformly at random (boardgame.io's seeded random when available). */
const pickRandomPair = (pairs: TriadPair[], random?: MoveContext['random']): TriadPair => {
  const r = random?.Number ? random.Number() : Math.random();
  return pairs[Math.min(pairs.length - 1, Math.floor(r * pairs.length))];
};

/** Size of the player's largest group of connected hexes (diagonals connect). Used to break ties. */
export const largestHexGroup = (G: GState, player: PlayerID): number => {
  const seen = new Set<number>();
  let best = 0;
  G.board.forEach((cell, start) => {
    if (cell.piece !== 'HEX' || cell.owner !== player || seen.has(start)) return;
    let size = 0;
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const x = stack.pop()!;
      size++;
      for (const n of neighborsWithDiagonals(x, G.size)) {
        if (!seen.has(n) && G.board[n].piece === 'HEX' && G.board[n].owner === player) {
          seen.add(n);
          stack.push(n);
        }
      }
    }
    best = Math.max(best, size);
  });
  return best;
};

/** Squares per player: about a third of the board (8 on 5x5, 16 on 7x7). */
export const squareLimit = (size: number): number => Math.round((size * size) / 3);

export const createInitialState = (size: number = BOARD_SIZE): GState => ({
  size,
  board: Array.from({ length: size * size }, emptyCell),
  hexCount: { '0': 0, '1': 0 },
  pendingHexOptions: null,
  lastTriad: null,
  lastMove: null,
  squaresLeft: { '0': squareLimit(size), '1': squareLimit(size) },
  lastTriadOptions: null,
});

/** True if `player` can place any piece right now (square with supply left, circle, or triangle). */
export const hasLegalMove = (G: GState, player: PlayerID): boolean =>
  G.board.some(
    (cell, i) =>
      cell.piece === 'EMPTY' &&
      ((G.squaresLeft[player] ?? 0) > 0 || hasAdjPiece(G, i, 'SQUARE') || canPlaceTriangle(G, i, player))
  );

export function computeGameOver(G: GState): GameOver | undefined {
  if (G.pendingHexOptions) return undefined; // a hex is about to be placed
  const full = !G.board.some((c) => c.piece === 'EMPTY');
  if (!full && (hasLegalMove(G, '0') || hasLegalMove(G, '1'))) return undefined; // someone can still play
  const a = G.hexCount['0'] ?? 0;
  const b = G.hexCount['1'] ?? 0;
  if (a > b) return { winner: '0', reason: 'more hexagons' };
  if (b > a) return { winner: '1', reason: 'more hexagons' };
  const g0 = largestHexGroup(G, '0');
  const g1 = largestHexGroup(G, '1');
  if (g0 > g1) return { winner: '0', reason: 'largest hex group' };
  if (g1 > g0) return { winner: '1', reason: 'largest hex group' };
  return { draw: true };
}

/**********************
 * Moves (boardgame.io >= 0.50 signature: ({ G, ctx, playerID, events }, ...args))
 **********************/
interface MoveContext {
  G: GState;
  ctx: Ctx;
  playerID: PlayerID;
  events: {
    endTurn?: () => void;
    setStage?: (stage: string) => void;
  };
  random?: { Number?: () => number };
}

export function placeSquare({ G, playerID, events }: MoveContext, i: number) {
  if (G.pendingHexOptions) return INVALID_MOVE;
  if (!isValidIndex(G, i) || G.board[i].piece !== 'EMPTY') return INVALID_MOVE;

  if ((G.squaresLeft[playerID] ?? 0) <= 0) return INVALID_MOVE; // out of squares

  G.board[i] = { piece: 'SQUARE', owner: playerID };
  G.squaresLeft[playerID] -= 1;
  G.lastMove = i;
  events.endTurn?.();
}

export function placeCircle({ G, playerID, events }: MoveContext, i: number) {
  if (G.pendingHexOptions) return INVALID_MOVE;
  if (!isValidIndex(G, i) || G.board[i].piece !== 'EMPTY') return INVALID_MOVE;
  if (!hasAdjPiece(G, i, 'SQUARE')) return INVALID_MOVE;

  G.board[i] = { piece: 'CIRCLE', owner: playerID };
  G.lastMove = i;
  events.endTurn?.();
}

export function placeTriangle({ G, playerID, events, random }: MoveContext, i: number) {
  if (G.pendingHexOptions) return INVALID_MOVE;
  if (!isValidIndex(G, i) || G.board[i].piece !== 'EMPTY') return INVALID_MOVE;
  const pairs = triadPairs(G, i, playerID);
  if (pairs.length === 0) return INVALID_MOVE;

  // If the triangle touches several valid circle+square pairs, one is removed at random.
  resolveTriad(G, i, pickRandomPair(pairs, random));
  G.lastTriadOptions = pairs.length;
  events.setStage?.('placeHex'); // same turn continues: the player must now place a hex
}

/** Pass is only allowed when the player has no legal placement (e.g. out of squares, nothing else fits). */
export function pass({ G, playerID, events }: MoveContext) {
  if (G.pendingHexOptions || hasLegalMove(G, playerID)) return INVALID_MOVE;
  G.lastMove = null;
  events.endTurn?.();
}

export function placeHexagon({ G, playerID, events }: MoveContext, i: number) {
  if (!G.pendingHexOptions || !G.pendingHexOptions.includes(i)) return INVALID_MOVE;
  if (G.board[i].piece !== 'EMPTY') return INVALID_MOVE;

  G.board[i] = { piece: 'HEX', owner: playerID };
  G.hexCount[playerID] = (G.hexCount[playerID] ?? 0) + 1;
  G.pendingHexOptions = null;
  G.lastMove = i;
  events.endTurn?.();
}

/**********************
 * Game Definition
 **********************/
export const BOARD_SIZES = [5, 7] as const;

export const makeHexTriad = (size: number = BOARD_SIZE): Game<GState> => ({
  name: 'hextriad',

  setup: () => createInitialState(size),

  turn: {
    activePlayers: { currentPlayer: 'main' },
    stages: {
      main: {
        moves: { placeSquare, placeCircle, placeTriangle, pass },
      },
      placeHex: {
        moves: { placeHexagon },
      },
    },
  },

  endIf: ({ G }) => computeGameOver(G),
});

export const HexTriad = makeHexTriad(BOARD_SIZE);

/**********************
 * Bot
 * Looks ahead by running the real move functions on a copy of the state,
 * so it always follows exactly the same rules as a human player.
 **********************/
export type BotLevel = 'easy' | 'hard';
export type BotAction = {
  move: 'placeSquare' | 'placeCircle' | 'placeTriangle' | 'placeHexagon' | 'pass';
  i: number;
};

const copyState = (G: GState): GState => JSON.parse(JSON.stringify(G));
const quietContext = (G: GState, playerID: PlayerID): MoveContext => ({ G, playerID, ctx: {} as Ctx, events: {} });
const other = (p: PlayerID): PlayerID => (p === '0' ? '1' : '0');
const randomOf = <T,>(xs: T[]): T => xs[Math.floor(Math.random() * xs.length)];

/** Number of empty cells where `player` could complete a triad right now. */
const triadSpotCount = (G: GState, player: PlayerID) =>
  G.board.reduce((n, cell, i) => n + (cell.piece === 'EMPTY' && canPlaceTriangle(G, i, player) ? 1 : 0), 0);

/** Position score from `player`'s view, taken right after their move (opponent to play next). */
const evaluatePosition = (G: GState, player: PlayerID): number => {
  const opp = other(player);
  let v = 100 * ((G.hexCount[player] ?? 0) - (G.hexCount[opp] ?? 0));
  const theirSpots = triadSpotCount(G, opp);
  const mySpots = triadSpotCount(G, player);
  if (theirSpots > 0) v -= 80 + 5 * theirSpots; // they can score next turn
  v += mySpots >= 2 ? 45 : mySpots === 1 ? 20 : 0; // one spot can be blocked, two rarely can
  v += 3 * (largestHexGroup(G, player) - largestHexGroup(G, opp)); // tiebreak awareness
  return v + Math.random() * 0.5; // break ties randomly
};

const bestHexCell = (G: GState, player: PlayerID, level: BotLevel): number => {
  const options = G.pendingHexOptions ?? [];
  if (level === 'easy') return randomOf(options);
  let best = options[0];
  let bestScore = -Infinity;
  for (const h of options) {
    const H = copyState(G);
    placeHexagon(quietContext(H, player), h);
    const score = evaluatePosition(H, player);
    if (score > bestScore) [best, bestScore] = [h, score];
  }
  return best;
};

/**
 * Expected value of a triangle at `i`: the pair is random, so average over pairs;
 * the hex is the bot's own choice, so take the best hex for each pair.
 */
const triangleValue = (G: GState, i: number, player: PlayerID): number => {
  const pairs = triadPairs(G, i, player);
  let total = 0;
  for (const pair of pairs) {
    const T = copyState(G);
    resolveTriad(T, i, pair);
    let best = -Infinity;
    for (const h of T.pendingHexOptions ?? []) {
      const H = copyState(T);
      placeHexagon(quietContext(H, player), h);
      best = Math.max(best, evaluatePosition(H, player));
    }
    total += best;
  }
  return total / pairs.length;
};

/** Choose the bot's next action for the current stage. Returns null when nothing is legal. */
export function chooseBotAction(G: GState, player: PlayerID, level: BotLevel): BotAction | null {
  if (G.pendingHexOptions) return { move: 'placeHexagon', i: bestHexCell(G, player, level) };

  const empty = G.board.map((c, i) => (c.piece === 'EMPTY' ? i : -1)).filter((i) => i >= 0);
  if (empty.length === 0) return null;
  const triangles = empty.filter((i) => canPlaceTriangle(G, i, player));
  const circles = empty.filter((i) => hasAdjPiece(G, i, 'SQUARE'));
  const squares = (G.squaresLeft[player] ?? 0) > 0 ? empty : [];
  if (!triangles.length && !circles.length && !squares.length) return { move: 'pass', i: -1 };

  if (level === 'easy') {
    if (triangles.length) return { move: 'placeTriangle', i: randomOf(triangles) };
    const setups = circles.filter((i) => {
      const H = copyState(G);
      placeCircle(quietContext(H, player), i);
      return triadSpotCount(H, player) > 0;
    });
    if (setups.length) return { move: 'placeCircle', i: randomOf(setups) };
    if (squares.length) return { move: 'placeSquare', i: randomOf(squares) };
    return { move: 'placeCircle', i: randomOf(circles) };
  }

  // hard: try every legal action (triangles with every hex choice) and keep the best position
  let best: BotAction = { move: 'pass', i: -1 };
  let bestScore = -Infinity;
  const consider = (action: BotAction, H: GState) => {
    const score = evaluatePosition(H, player);
    if (score > bestScore) [best, bestScore] = [action, score];
  };
  for (const i of squares) {
    const H = copyState(G);
    placeSquare(quietContext(H, player), i);
    consider({ move: 'placeSquare', i }, H);
  }
  for (const i of circles) {
    const H = copyState(G);
    placeCircle(quietContext(H, player), i);
    consider({ move: 'placeCircle', i }, H);
  }
  for (const i of triangles) {
    const score = triangleValue(G, i, player);
    if (score > bestScore) [best, bestScore] = [{ move: 'placeTriangle', i }, score];
  }
  return best;
}

/**********************
 * UI Components
 **********************/
export type Opponent = 'human' | 'bot-easy' | 'bot-hard';
const BOT_PLAYER: PlayerID = '1';
const MatchSettings = React.createContext<{ opponent: Opponent; showHints: boolean }>({ opponent: 'human', showHints: true });
const playerName = (p: PlayerID, opponent: Opponent) =>
  opponent === 'human' ? `Player ${Number(p) + 1}` : p === BOT_PLAYER ? 'Bot' : 'You';
type ShapeChoice = 'SQUARE' | 'CIRCLE' | 'TRIANGLE';

const PlayerColors: Record<string, string> = {
  '0': '#2563eb',
  '1': '#dc2626',
};

function ShapeSVG({ piece, color, size = 36 }: { piece: Piece; color: string; size?: number | string }) {
  if (piece === 'EMPTY') return null;
  if (piece === 'SQUARE')
    return (
      <svg width={size} height={size} viewBox="0 0 100 100">
        <rect x="15" y="15" width="70" height="70" rx="8" fill={color} />
      </svg>
    );
  if (piece === 'CIRCLE')
    return (
      <svg width={size} height={size} viewBox="0 0 100 100">
        <circle cx="50" cy="50" r="35" fill={color} />
      </svg>
    );
  if (piece === 'TRIANGLE')
    return (
      <svg width={size} height={size} viewBox="0 0 100 100">
        <polygon points="50,15 85,85 15,85" fill={color} />
      </svg>
    );
  return (
    <svg width={size} height={size} viewBox="0 0 100 100">
      <polygon points="25,10 75,10 95,50 75,90 25,90 5,50" fill={color} />
    </svg>
  );
}

/**
 * Faint diagonal guides between the centers of diagonally adjacent cells.
 * Orthogonal adjacency is already shown by the cell grid, so only diagonals are drawn.
 */
function DiagonalGuidesSVG({ size }: { size: number }) {
  const w = 800;
  const step = w / size;
  const c = (k: number) => k * step + step / 2;
  const lines: Array<[number, number, number, number]> = [];
  for (let r = 0; r + 1 < size; r++) {
    for (let col = 0; col < size; col++) {
      if (col + 1 < size) lines.push([c(col), c(r), c(col + 1), c(r + 1)]);
      if (col - 1 >= 0) lines.push([c(col), c(r), c(col - 1), c(r + 1)]);
    }
  }
  return (
    <svg
      viewBox={`0 0 ${w} ${w}`}
      preserveAspectRatio="none"
      className="absolute inset-0 w-full h-full pointer-events-none"
      aria-hidden
    >
      {lines.map(([x1, y1, x2, y2], k) => (
        <line
          key={k}
          x1={x1}
          y1={y1}
          x2={x2}
          y2={y2}
          stroke="#94a3b8"
          strokeOpacity={0.18}
          strokeWidth={1}
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
  );
}

function ScoreBadge({ name, player, count, group, squares, active }: { name: string; player: PlayerID; count: number; group: number; squares: number; active: boolean }) {
  return (
    <div
      className={`flex items-center gap-2 text-sm px-3 py-2 rounded-lg border ${active ? 'bg-white shadow-sm' : 'border-transparent'}`}
      style={active ? { borderColor: PlayerColors[player] } : undefined}
    >
      <div className="w-3 h-3 rounded-full" style={{ background: PlayerColors[player] }} />
      <div>
        <span className="font-medium">{name}</span>: <b>{count}</b> HEX{' '}
        <span className="text-gray-500">(largest group {group})</span>
        <div className="text-xs text-gray-500">
          {squares} {squares === 1 ? 'square' : 'squares'} left
        </div>
      </div>
    </div>
  );
}

function BoardUI({ G, ctx, moves, isActive }: BoardProps<GState>) {
  const { opponent, showHints } = React.useContext(MatchSettings);
  const [choice, setChoice] = useState<ShapeChoice>('SQUARE');
  const size = G.size;
  const stage = ctx.activePlayers?.[ctx.currentPlayer] ?? 'main';
  const gameover = ctx.gameover as GameOver | undefined;
  const current = ctx.currentPlayer as PlayerID;
  const currentColor = PlayerColors[current] ?? '#111827';
  const botTurn = opponent !== 'human' && current === BOT_PLAYER && !gameover;
  const name = (p: PlayerID) => playerName(p, opponent);

  // Bot plays automatically on its turn (including its hex placement).
  React.useEffect(() => {
    if (!botTurn) return;
    const timer = setTimeout(() => {
      const action = chooseBotAction(G, BOT_PLAYER, opponent === 'bot-hard' ? 'hard' : 'easy');
      if (action) (moves as Record<string, (i: number) => void>)[action.move](action.i);
    }, stage === 'main' ? 650 : 450);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botTurn, G, stage, opponent]);

  const squaresLeft = G.squaresLeft[current] ?? 0;
  const mustPass = !gameover && !botTurn && stage === 'main' && !hasLegalMove(G, current);
  React.useEffect(() => {
    if (choice === 'SQUARE' && squaresLeft === 0) setChoice('CIRCLE'); // switch away once squares run out
  }, [choice, squaresLeft]);

  const onCellClick = (i: number) => {
    if (!isActive || gameover || botTurn) return;
    if (stage === 'placeHex') {
      moves.placeHexagon(i);
      return;
    }
    if (choice === 'SQUARE') moves.placeSquare(i);
    else if (choice === 'CIRCLE') moves.placeCircle(i);
    else moves.placeTriangle(i);
  };

  const legalHint = useMemo(() => {
    const arr: boolean[] = Array(G.board.length).fill(false);
    if (gameover || botTurn) return arr;
    for (let i = 0; i < G.board.length; i++) {
      if (G.board[i].piece !== 'EMPTY') continue;
      if (stage === 'placeHex') {
        arr[i] = !!G.pendingHexOptions?.includes(i);
        continue;
      }
      if (choice === 'SQUARE') arr[i] = squaresLeft > 0;
      else if (choice === 'CIRCLE') arr[i] = hasAdjPiece(G, i, 'SQUARE');
      else arr[i] = canPlaceTriangle(G, i, current);
    }
    return arr;
  }, [G, choice, stage, gameover, current, botTurn]);

  const randomNote =
    (G.lastTriadOptions ?? 1) > 1 ? ` (${G.lastTriadOptions} pairs were possible; one was removed at random)` : '';
  const endWhy = G.board.some((c) => c.piece === 'EMPTY') ? 'no one can place a piece' : 'board full';
  const status = gameover
    ? gameover.draw
      ? `Game over (${endWhy}): equal hexes and equal largest groups. The game is a draw.`
      : gameover.reason === 'largest hex group'
      ? `Game over (${endWhy}): hexes are tied, and ${name(gameover.winner!)} ${opponent !== 'human' && gameover.winner !== BOT_PLAYER ? 'win' : 'wins'} with the largest connected hex group.`
      : `Game over (${endWhy}): ${name(gameover.winner!)} ${opponent !== 'human' && gameover.winner !== BOT_PLAYER ? 'win' : 'wins'} with more hexes.`
    : botTurn
    ? stage === 'placeHex'
      ? `Bot formed a triad${randomNote} and is placing its hex…`
      : 'Bot is thinking…'
    : stage === 'placeHex'
    ? `Triad formed${randomNote}. Choose a highlighted cell for your hex.`
    : mustPass
    ? `${opponent === 'human' ? name(current) + ' has' : 'You have'} no legal placement. Pass the turn.`
    : opponent === 'human'
    ? `${name(current)}'s turn. Pick a shape, then ${showHints ? 'a green cell' : 'a cell'}.`
    : `Your turn. Pick a shape, then ${showHints ? 'a green cell' : 'a cell'}.`;

  const boardWidth = size <= 5 ? 'max-w-md' : 'max-w-xl';

  return (
    <div className="w-full max-w-3xl mx-auto px-4">
      <div className="flex flex-wrap items-center justify-center gap-3 mb-3">
        <ScoreBadge name={name('0')} player="0" count={G.hexCount['0'] ?? 0} group={largestHexGroup(G, '0')} squares={G.squaresLeft['0'] ?? 0} active={!gameover && current === '0'} />
        <ScoreBadge name={name('1')} player="1" count={G.hexCount['1'] ?? 0} group={largestHexGroup(G, '1')} squares={G.squaresLeft['1'] ?? 0} active={!gameover && current === '1'} />
      </div>

      <div
        className={`mb-3 p-3 rounded-lg border text-sm text-center ${
          gameover
            ? 'bg-emerald-50 border-emerald-200'
            : stage === 'placeHex'
            ? 'bg-yellow-50 border-yellow-200'
            : 'bg-white border-gray-200'
        }`}
        role="status"
        aria-live="polite"
      >
        {status}
      </div>

      <div className={`flex justify-center gap-2 mb-3 ${!gameover && stage === 'main' && !botTurn ? '' : 'invisible'}`}>
        {(['SQUARE', 'CIRCLE', 'TRIANGLE'] as ShapeChoice[]).map((s) => {
          const out = s === 'SQUARE' && squaresLeft === 0;
          return (
            <button
              key={s}
              onClick={() => setChoice(s)}
              disabled={out}
              className={`px-3 py-2 rounded-xl shadow-sm text-sm border bg-white ${choice === s ? 'border-black' : 'border-gray-300'} ${out ? 'opacity-40 cursor-not-allowed' : ''}`}
              title={out ? 'No squares left' : `Place a ${s.toLowerCase()}`}
            >
              <div className="flex items-center gap-2">
                <ShapeSVG piece={s} color={currentColor} size={28} />
                <span>
                  {s.charAt(0) + s.slice(1).toLowerCase()}
                  {s === 'SQUARE' && <span className="text-gray-500"> ({squaresLeft})</span>}
                </span>
              </div>
            </button>
          );
        })}
        {mustPass && (
          <button onClick={() => moves.pass()} className="px-3 py-2 rounded-xl shadow-sm text-sm border border-black bg-white">
            Pass
          </button>
        )}
      </div>

      {/* Board: a single grid of cells; adjacency includes diagonals */}
      <div className={`relative w-full ${boardWidth} mx-auto aspect-square border border-gray-300 rounded-xl overflow-hidden bg-white`}>
        <DiagonalGuidesSVG size={size} />
        <div
          className="relative grid w-full h-full"
          style={{ gridTemplateColumns: `repeat(${size}, 1fr)`, gridTemplateRows: `repeat(${size}, 1fr)` }}
        >
          {G.board.map((cell, i) => (
            <button
              type="button"
              key={i}
              onClick={() => onCellClick(i)}
              aria-label={cell.piece === 'EMPTY' ? `Empty cell ${i}` : `${cell.piece.toLowerCase()} of ${name(cell.owner!)}, cell ${i}`}
              className="relative flex items-center justify-center focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-gray-700"
              style={{
                cursor: botTurn || gameover ? 'default' : 'pointer',
                background: G.pendingHexOptions?.includes(i)
                  ? 'rgba(234, 179, 8, 0.25)'
                  : showHints && legalHint[i]
                  ? 'rgba(16, 185, 129, 0.12)'
                  : 'transparent',
                borderRight: i % size !== size - 1 ? '1px solid #e5e7eb' : undefined,
                borderBottom: Math.floor(i / size) !== size - 1 ? '1px solid #e5e7eb' : undefined,
                boxShadow: G.lastMove === i
                  ? 'inset 0 0 0 3px rgba(17, 24, 39, 0.35)'
                  : undefined,
              }}
            >
              <ShapeSVG piece={cell.piece} color={cell.owner ? PlayerColors[cell.owner] : '#111827'} size="60%" />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/**********************
 * Client Wiring
 **********************/
// Single local client with no playerID: it always acts as whoever's turn it is.
// Against the bot, the board component plays the second player's (red) turns automatically.
const makeClient = (n: number) =>
  Client<GState>({ game: makeHexTriad(n), numPlayers: 2, board: BoardUI, debug: false });
const clientsBySize = new Map(BOARD_SIZES.map((n) => [n as number, makeClient(n)]));

const OPPONENTS: { id: Opponent; label: string }[] = [
  { id: 'human', label: 'Human' },
  { id: 'bot-easy', label: 'Bot: easy' },
  { id: 'bot-hard', label: 'Bot: hard' },
];

function Choice<T extends string | number>({ label, value, options, onChange }: {
  label: string; value: T; options: { id: T; label: string }[]; onChange: (v: T) => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-center gap-2" role="group" aria-label={label}>
      <span className="text-sm text-gray-600 w-20 text-right">{label}</span>
      {options.map((o) => (
        <button
          key={String(o.id)}
          onClick={() => onChange(o.id)}
          aria-pressed={value === o.id}
          className={`px-3 py-1.5 rounded-lg border text-sm ${value === o.id ? 'border-black bg-white shadow-sm' : 'border-gray-300'}`}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

/**********************
 * Install as app (Chrome / Edge / Android)
 * The browser fires `beforeinstallprompt` when the site can be installed; we keep it so the
 * "Install app" button can show the browser's install dialog. It is captured at load time
 * because the event can fire before React has mounted.
 **********************/
type InstallPromptEvent = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };
let deferredInstall: InstallPromptEvent | null = null;
const installListeners = new Set<() => void>();
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstall = e as InstallPromptEvent;
    installListeners.forEach((f) => f());
  });
  window.addEventListener('appinstalled', () => {
    deferredInstall = null;
    installListeners.forEach((f) => f());
  });
}

function useInstallPrompt() {
  const [canInstall, setCanInstall] = useState(!!deferredInstall);
  React.useEffect(() => {
    const update = () => setCanInstall(!!deferredInstall);
    installListeners.add(update);
    update();
    return () => {
      installListeners.delete(update);
    };
  }, []);
  const install = async () => {
    const e = deferredInstall;
    if (!e) return;
    await e.prompt();
    await e.userChoice.catch(() => undefined);
    deferredInstall = null; // a prompt can only be used once
    setCanInstall(false);
  };
  return { canInstall, install };
}

export default function App() {
  const { canInstall, install } = useInstallPrompt();
  const [boardSize, setBoardSize] = useState<number>(BOARD_SIZE);
  const [opponent, setOpponent] = useState<Opponent>('bot-hard');
  const [gameId, setGameId] = useState(0);
  const [showRules, setShowRules] = useState(false);
  const [showHints, setShowHints] = useState(true);
  const HexTriadClient = clientsBySize.get(boardSize) ?? clientsBySize.get(BOARD_SIZE)!;

  return (
    <div className="min-h-screen bg-gray-50 py-6">
      <h1 className="text-2xl font-semibold text-center mb-4">HexTriad</h1>

      <div className="max-w-3xl mx-auto px-4 mb-4 flex flex-col items-center gap-2">
        <Choice label="Board" value={boardSize} options={BOARD_SIZES.map((n) => ({ id: n as number, label: `${n}×${n}` }))} onChange={setBoardSize} />
        <Choice label="Opponent" value={opponent} options={OPPONENTS} onChange={setOpponent} />
        <div className="flex flex-wrap items-center justify-center gap-3 mt-1">
          <button onClick={() => setGameId((g) => g + 1)} className="px-3 py-1.5 rounded-lg border border-gray-300 text-sm bg-white shadow-sm">
            New game
          </button>
          <label className="flex items-center gap-1.5 text-sm text-gray-700 cursor-pointer select-none">
            <input type="checkbox" checked={showHints} onChange={(e) => setShowHints(e.target.checked)} className="w-4 h-4" />
            Show legal moves
          </label>
          <button onClick={() => setShowRules((v) => !v)} className="text-sm underline text-gray-600" aria-expanded={showRules}>
            {showRules ? 'Hide rules' : 'Show rules'}
          </button>
          {canInstall && (
            <button onClick={install} className="px-3 py-1.5 rounded-lg border border-gray-300 text-sm bg-white shadow-sm">
              Install app
            </button>
          )}
        </div>
        <div className="text-xs text-gray-500">Changing the board or opponent starts a new game. {opponent !== 'human' && 'You play blue and move first.'}</div>
        {showRules && (
          <div className="text-sm text-gray-700 bg-white border border-gray-200 rounded-lg p-4 max-w-xl leading-relaxed">
            Each turn, place one piece. Diagonal cells count as adjacent.
            <br />• <b>Square</b>: any empty cell. Each player has a limited supply: 8 on 5×5, 16 on 7×7.
            <br />• <b>Circle</b>: next to a square of either color.
            <br />• <b>Triangle</b>: next to a circle and a square of any color, as long as at least one of those two is yours.
            Placing it forms a triad: all three pieces are removed and you place a <b>hex</b> on one of those cells.
            The circle and square must each touch the triangle. If more than one valid pair touches it, one pair is removed at random.
            <br />If you have no legal placement, you pass. The game ends when the board is full or neither player can
            place anything. Most hexes wins; if tied, the largest connected group of hexes wins.
          </div>
        )}
      </div>

      <MatchSettings.Provider value={{ opponent, showHints }}>
        <HexTriadClient key={`${boardSize}-${opponent}-${gameId}`} />
      </MatchSettings.Provider>
    </div>
  );
}

/**********************
 * In-File Tests (manual trigger)
 * To run: set window.__RUN_HEXTRIAD_TESTS__ = true in the console, then refresh.
 **********************/
export function runHexTriadTests(): string[] {
  const log: string[] = [];
  const assert = (name: string, cond: boolean) => {
    log.push(`${cond ? '✔' : '✘'} ${name}`);
    if (!cond) throw new Error(`Test failed: ${name}\n${log.join('\n')}`);
  };

  const T = 7; // tests run on a 7x7 board
  const at = (r: number, c: number) => idx(r, c, T);
  const put = (G: GState, r: number, c: number, piece: Piece, owner: PlayerID = '0') => {
    G.board[at(r, c)] = { piece, owner };
  };
  const makeContext = (G: GState, playerID: PlayerID = '0') => {
    const calls: string[] = [];
    const context: MoveContext = {
      G,
      playerID,
      ctx: { currentPlayer: playerID } as Ctx,
      events: {
        endTurn: () => {
          calls.push('endTurn');
        },
        setStage: (s: string) => {
          calls.push(`setStage:${s}`);
        },
      },
    };
    return { context, calls };
  };

  // Setup
  {
    const G = createInitialState(T);
    assert('board starts empty', G.board.length === T * T && G.board.every((c) => c.piece === 'EMPTY'));
    assert('hexCount initialized for both players', G.hexCount['0'] === 0 && G.hexCount['1'] === 0);
  }

  // Adjacency
  assert('corner cell has 3 neighbors', neighborsWithDiagonals(at(0, 0), T).length === 3);
  assert('edge cell has 5 neighbors', neighborsWithDiagonals(at(0, 3), T).length === 5);
  assert('center cell has 8 neighbors', neighborsWithDiagonals(at(3, 3), T).length === 8);

  // Squares
  {
    const G = createInitialState(T);
    const { context, calls } = makeContext(G);
    placeSquare(context, at(3, 3));
    assert('square placed anywhere on empty board', G.board[at(3, 3)].piece === 'SQUARE' && G.board[at(3, 3)].owner === '0');
    assert('square ends the turn', calls.includes('endTurn'));
    assert('square on occupied cell rejected', placeSquare(context, at(3, 3)) === INVALID_MOVE);
    assert(
      'out-of-range / non-integer index rejected',
      placeSquare(context, -1) === INVALID_MOVE &&
        placeSquare(context, T * T) === INVALID_MOVE &&
        placeSquare(context, 1.5) === INVALID_MOVE
    );
  }

  // Circles
  {
    const G = createInitialState(T);
    put(G, 3, 3, 'SQUARE');
    const { context, calls } = makeContext(G);
    assert('circle without adjacent square rejected', placeCircle(context, at(0, 0)) === INVALID_MOVE && G.board[at(0, 0)].piece === 'EMPTY');
    placeCircle(context, at(2, 2));
    assert('circle diagonal to a square accepted', G.board[at(2, 2)].piece === 'CIRCLE');
    assert('circle ends the turn', calls.includes('endTurn'));
    assert('circle on occupied cell rejected', placeCircle(context, at(3, 3)) === INVALID_MOVE);
  }

  // Triangle requirements
  {
    const G = createInitialState(T);
    put(G, 3, 3, 'SQUARE');
    const { context } = makeContext(G);
    assert('triangle with only an adjacent square rejected', placeTriangle(context, at(3, 4)) === INVALID_MOVE);
  }
  {
    const G = createInitialState(T);
    put(G, 3, 3, 'CIRCLE');
    const { context } = makeContext(G);
    assert('triangle with only an adjacent circle rejected', placeTriangle(context, at(3, 4)) === INVALID_MOVE);
  }

  // Triad + hex flow
  {
    const G = createInitialState(T);
    put(G, 0, 0, 'SQUARE');
    put(G, 0, 1, 'CIRCLE');
    const { context, calls } = makeContext(G);
    const t = at(1, 0); // adjacent to both (0,0) and (0,1)
    placeTriangle(context, t);
    const triad = [t, at(0, 1), at(0, 0)];
    assert('triad pending after triangle', JSON.stringify(G.pendingHexOptions) === JSON.stringify(triad));
    assert('triad cells cleared', triad.every((i) => G.board[i].piece === 'EMPTY'));
    assert('triangle enters placeHex stage without ending turn', calls.includes('setStage:placeHex') && !calls.includes('endTurn'));

    assert('square blocked while hex pending', placeSquare(context, at(5, 5)) === INVALID_MOVE);
    assert('circle blocked while hex pending', placeCircle(context, at(5, 5)) === INVALID_MOVE);
    assert('triangle blocked while hex pending', placeTriangle(context, at(5, 5)) === INVALID_MOVE);
    assert('hex outside triad rejected', placeHexagon(context, at(5, 5)) === INVALID_MOVE && G.pendingHexOptions !== null);

    placeHexagon(context, at(0, 1));
    assert('hex placed, owned and counted', G.board[at(0, 1)].piece === 'HEX' && G.board[at(0, 1)].owner === '0' && G.hexCount['0'] === 1);
    assert('pending cleared and turn ended after hex', G.pendingHexOptions === null && calls.includes('endTurn'));
    assert('hex without pending triad rejected', placeHexagon(context, at(0, 0)) === INVALID_MOVE);
  }

  // Hex scoring for player 1
  {
    const G = createInitialState(T);
    put(G, 0, 0, 'SQUARE', '1');
    put(G, 0, 1, 'CIRCLE', '1');
    const { context } = makeContext(G, '1');
    placeTriangle(context, at(1, 1));
    placeHexagon(context, at(1, 1));
    assert('player 1 hex counted separately', G.hexCount['1'] === 1 && G.hexCount['0'] === 0);
  }

  // Ownership rule: pair may be mixed, but must include at least one of the mover's pieces
  {
    const G = createInitialState(T);
    put(G, 0, 0, 'SQUARE', '1');
    put(G, 0, 1, 'CIRCLE', '1');
    const { context } = makeContext(G, '0');
    assert("triangle rejected next to a pair made only of opponent pieces", placeTriangle(context, at(1, 0)) === INVALID_MOVE);
  }
  {
    const G = createInitialState(T);
    put(G, 0, 0, 'SQUARE', '1'); // opponent's square
    put(G, 0, 1, 'CIRCLE', '0'); // own circle
    const { context } = makeContext(G, '0');
    placeTriangle(context, at(1, 0));
    assert("mixed pair (own circle + opponent square) forms a triad", JSON.stringify(G.pendingHexOptions) === JSON.stringify([at(1, 0), at(0, 1), at(0, 0)]));
    assert("mixed triad removes the opponent's square too", G.board[at(0, 0)].piece === 'EMPTY');
  }
  {
    const G = createInitialState(T);
    put(G, 0, 0, 'SQUARE', '0'); // own square
    put(G, 0, 1, 'CIRCLE', '1'); // opponent's circle
    const { context } = makeContext(G, '0');
    assert("mixed pair (own square + opponent circle) is allowed", placeTriangle(context, at(1, 0)) !== INVALID_MOVE && G.pendingHexOptions !== null);
  }
  // Several valid pairs: one is removed at random
  {
    // own square (0,0), own circle (0,1), opponent square (0,2); triangle at (1,1) touches all three
    const setup = () => {
      const G = createInitialState(T);
      put(G, 0, 0, 'SQUARE', '0');
      put(G, 0, 1, 'CIRCLE', '0');
      put(G, 0, 2, 'SQUARE', '1');
      return G;
    };
    const withRandom = (G: GState, r: number) => ({ ...makeContext(G, '0').context, random: { Number: () => r } });
    {
      const G = setup();
      const { context, calls } = makeContext(G, '0');
      placeTriangle({ ...context, random: { Number: () => 0 } }, at(1, 1));
      assert('two valid pairs: triad resolves immediately, straight to hex placement', calls.includes('setStage:placeHex') && G.pendingHexOptions !== null);
      assert('number of possible pairs is recorded for the message', G.lastTriadOptions === 2);
      assert('random value 0 removes the first pair (own square)', G.board[at(0, 0)].piece === 'EMPTY' && G.board[at(0, 2)].piece === 'SQUARE');
    }
    {
      const G = setup();
      placeTriangle(withRandom(G, 0.99), at(1, 1));
      assert("random value near 1 removes the last pair (opponent's square)", G.board[at(0, 2)].piece === 'EMPTY' && G.board[at(0, 0)].piece === 'SQUARE');
      assert('removed pieces always include the triangle and the circle', G.board[at(1, 1)].piece === 'EMPTY' && G.board[at(0, 1)].piece === 'EMPTY');
    }
    {
      // 2 circles x 2 squares around (1,1); pair (opp circle + opp square) is not valid for P0
      const counts: Record<string, number> = {};
      const trials = 3000;
      for (let k = 0; k < trials; k++) {
        const G = createInitialState(T);
        put(G, 0, 0, 'SQUARE', '0');
        put(G, 0, 2, 'SQUARE', '1');
        put(G, 2, 0, 'CIRCLE', '0');
        put(G, 2, 2, 'CIRCLE', '1');
        placeTriangle(makeContext(G, '0').context, at(1, 1)); // uses Math.random
        const key = [at(0, 0), at(0, 2), at(2, 0), at(2, 2)].filter((c) => G.board[c].piece === 'EMPTY').join('+');
        counts[key] = (counts[key] ?? 0) + 1;
      }
      const keys = Object.keys(counts);
      const invalid = `${at(0, 2)}+${at(2, 2)}`; // opponent square + opponent circle
      assert('random removal only ever picks valid pairs', keys.length === 3 && !(invalid in counts));
      assert('each valid pair is picked about equally often', keys.every((k) => Math.abs(counts[k] / trials - 1 / 3) < 0.05));
    }
    {
      const G = createInitialState(T);
      put(G, 0, 0, 'SQUARE', '0');
      put(G, 0, 1, 'CIRCLE', '0');
      placeTriangle(makeContext(G, '0').context, at(1, 0));
      assert('single valid pair: recorded as 1 option', G.lastTriadOptions === 1);
    }
    for (const level of ['easy', 'hard'] as BotLevel[]) {
      const G = setup();
      const a = chooseBotAction(G, '0', level);
      assert(`${level} bot plays the triangle when one is available`, a?.move === 'placeTriangle');
      placeTriangle(makeContext(G, '0').context, a!.i);
      assert(`${level} bot's triad also goes straight to hex placement`, chooseBotAction(G, '0', level)?.move === 'placeHexagon');
    }
  }

  // Board size option
  {
    const small = createInitialState(3);
    assert('3x3 board has 9 empty cells', small.size === 3 && small.board.length === 9 && small.board.every((c) => c.piece === 'EMPTY'));
    assert('3x3 center touches all 8 other cells', neighborsWithDiagonals(4, 3).length === 8);
    const g3 = (makeHexTriad(3).setup as () => GState)();
    const g7 = (makeHexTriad(7).setup as () => GState)();
    assert('game factory respects board size', g3.board.length === 9 && g7.board.length === 49);

    const { context } = makeContext(small);
    placeSquare(context, 0); // top-left
    placeCircle(context, 4); // center, diagonal to the square
    placeTriangle(context, 1); // top-middle, touches both
    assert('triad forms on 3x3 using a diagonal link', JSON.stringify(small.pendingHexOptions) === JSON.stringify([1, 4, 0]));
  }

  // Game end
  {
    const G = createInitialState(T);
    assert('no game over while cells are empty', computeGameOver(G) === undefined);
    for (let i = 0; i < G.board.length; i++) G.board[i] = { piece: 'SQUARE', owner: '0' };
    G.hexCount = { '0': 2, '1': 1 };
    assert('player 0 wins with more hexes', computeGameOver(G)?.winner === '0');
    G.hexCount = { '0': 1, '1': 3 };
    assert('player 1 wins with more hexes', computeGameOver(G)?.winner === '1');
    G.hexCount = { '0': 2, '1': 2 };
    assert('equal hexes and equal groups is a draw', computeGameOver(G)?.draw === true);
  }
  {
    const G = createInitialState(T);
    for (let i = 0; i < G.board.length; i++) G.board[i] = { piece: 'SQUARE', owner: '0' };
    // P0: two separate hexes; P1: two touching hexes (diagonal) -> P1 wins the tie
    G.board[at(0, 0)] = { piece: 'HEX', owner: '0' };
    G.board[at(0, 4)] = { piece: 'HEX', owner: '0' };
    G.board[at(4, 4)] = { piece: 'HEX', owner: '1' };
    G.board[at(5, 5)] = { piece: 'HEX', owner: '1' };
    G.hexCount = { '0': 2, '1': 2 };
    assert('largest group counts diagonal links', largestHexGroup(G, '1') === 2 && largestHexGroup(G, '0') === 1);
    const over = computeGameOver(G);
    assert('tied hexes broken by largest group', over?.winner === '1' && over?.reason === 'largest hex group');
  }
  assert('default board is 5x5', createInitialState().size === 5 && BOARD_SIZES[0] === 5);

  // Bot
  for (const level of ['easy', 'hard'] as BotLevel[]) {
    const G = createInitialState(T);
    put(G, 3, 3, 'SQUARE', '1');
    put(G, 3, 4, 'CIRCLE', '1');
    const a = chooseBotAction(G, '1', level);
    assert(`${level} bot completes an available triad`, a?.move === 'placeTriangle' && canPlaceTriangle(G, a.i, '1'));
    placeTriangle(makeContext(G, '1').context, a!.i);
    const h = chooseBotAction(G, '1', level);
    assert(`${level} bot places its hex on a triad cell`, h?.move === 'placeHexagon' && G.pendingHexOptions!.includes(h.i));
  }
  {
    const G = createInitialState(T);
    const a = chooseBotAction(G, '1', 'hard');
    assert('bot opens with a square on an empty board', a?.move === 'placeSquare');
    for (let i = 0; i < G.board.length; i++) G.board[i] = { piece: 'SQUARE', owner: '0' };
    assert('bot returns null on a full board', chooseBotAction(G, '1', 'hard') === null);
  }

  // Square limit
  {
    assert('square limit is 8 on 5x5 and 16 on 7x7', squareLimit(5) === 8 && squareLimit(7) === 16);
    const G = createInitialState(T);
    assert('both players start with the full square supply', G.squaresLeft['0'] === 16 && G.squaresLeft['1'] === 16);
    const { context } = makeContext(G, '0');
    placeSquare(context, at(3, 3));
    assert('placing a square uses one from the supply', G.squaresLeft['0'] === 15 && G.squaresLeft['1'] === 16);
    G.squaresLeft['0'] = 0;
    assert('square rejected when the supply is empty', placeSquare(context, at(0, 0)) === INVALID_MOVE && G.board[at(0, 0)].piece === 'EMPTY');
    assert('circles still allowed without squares left', placeCircle(context, at(2, 2)) !== INVALID_MOVE);
    assert('pass rejected while a legal placement exists', pass(context) === INVALID_MOVE);
  }
  {
    // nobody has squares, no squares on the board: nobody can move -> game ends even with empty cells
    const G = createInitialState(T);
    G.squaresLeft = { '0': 0, '1': 0 };
    G.board[at(0, 0)] = { piece: 'HEX', owner: '0' };
    G.hexCount = { '0': 1, '1': 0 };
    const { context, calls } = makeContext(G, '1');
    assert('pass allowed when stuck', pass(context) !== INVALID_MOVE && calls.includes('endTurn'));
    assert('bot passes when stuck', chooseBotAction(G, '1', 'hard')?.move === 'pass' && chooseBotAction(G, '1', 'easy')?.move === 'pass');
    const over = computeGameOver(G);
    assert('game ends when neither player can place anything', over?.winner === '0');
  }
  {
    // one player stuck, the other can still play -> game continues
    const G = createInitialState(T);
    G.squaresLeft = { '0': 0, '1': 3 };
    assert('game continues while one player can still move', computeGameOver(G) === undefined && !hasLegalMove(G, '0') && hasLegalMove(G, '1'));
  }

  return log;
}

if (typeof window !== 'undefined' && (window as any).__RUN_HEXTRIAD_TESTS__) {
  try {
    // eslint-disable-next-line no-console
    console.log('[HexTriad Tests]\n' + runHexTriadTests().join('\n'));
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[HexTriad Tests] FAILED', e);
  }
}
