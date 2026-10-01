/**
 * HEX0N rules: state, moves and the boardgame.io game definition. No React, no UI, so both the page
 * (Hexon.tsx) and the online server (../server) can use it.
 */
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

export const BOARD_SIZE = 5; // default board (5x5 tested best); 7x7 also offered

/**********************
 * Helpers
 **********************/
export const idx = (row: number, col: number, size: number) => row * size + col;

export const inBounds = (r: number, c: number, size: number) => r >= 0 && r < size && c >= 0 && c < size;

export const emptyCell = (): Cell => ({ piece: 'EMPTY', owner: null });

export const isValidIndex = (G: GState, i: number) => Number.isInteger(i) && i >= 0 && i < G.board.length;

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
export const hasAdjPiece = (G: GState, i: number, kind: Piece, owner?: PlayerID): boolean => {
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
export const canPlaceTriangle = (G: GState, i: number, player: PlayerID): boolean => triadPairs(G, i, player).length > 0;

/** Remove triangle + circle + square and open hex placement on those three cells. */
export const resolveTriad = (G: GState, triangle: number, pair: TriadPair) => {
  const triad = [triangle, pair.circle, pair.square];
  for (const cell of triad) G.board[cell] = emptyCell();
  G.pendingHexOptions = [...triad];
  G.lastTriad = [...triad];
  G.lastMove = null;
};

/** Pick one of the valid pairs uniformly at random (boardgame.io's seeded random when available). */
export const pickRandomPair = (pairs: TriadPair[], random?: MoveContext['random']): TriadPair => {
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
export interface MoveContext {
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

/**
 * Internal only: decides who moves first. A new game always begins with player 0 (blue) to move;
 * when the coin flip says player 1 (red) should start, the board forces this silent pass before
 * anything is shown. It is only legal on the untouched opening position, so it can never be used
 * later in a game. No sound, no message, no highlight.
 */
export function yieldStart({ G, ctx, playerID, events }: MoveContext) {
  if (playerID !== '0' || (ctx?.currentPlayer !== undefined && ctx.currentPlayer !== '0')) return INVALID_MOVE;
  if (G.pendingHexOptions || G.board.some((c) => c.piece !== 'EMPTY')) return INVALID_MOVE;
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

/**
 * Who moves first, decided by boardgame.io's seeded random (so in an online match the server decides it,
 * and both players see the same start). Only for the first turn; after that turns simply alternate.
 */
const RANDOM_FIRST = {
  first: ({ ctx, random }: any) =>
    ctx.turn === 0 ? (random.Number() < 0.5 ? 0 : 1) : (ctx.playOrderPos + 1) % ctx.playOrder.length,
  next: ({ ctx }: any) => (ctx.playOrderPos + 1) % ctx.playOrder.length,
};

/**
 * randomFirst: false (the default) = blue (player 0) always opens, as the training notebook expects
 * (it flips its own coin with yieldStart). The page and the online server pass true.
 */
export const makeHexon = (size: number = BOARD_SIZE, randomFirst = false): Game<GState> => ({
  name: 'hexon',

  setup: () => createInitialState(size),

  turn: {
    ...(randomFirst ? { order: RANDOM_FIRST } : {}),
    activePlayers: { currentPlayer: 'main' },
    stages: {
      main: {
        moves: { placeSquare, placeCircle, placeTriangle, pass, yieldStart },
      },
      placeHex: {
        moves: { placeHexagon },
      },
    },
  },

  endIf: ({ G }) => computeGameOver(G),
});

export const Hexon = makeHexon(BOARD_SIZE);

/** Online play: one game per board size, each with its own name so the server keeps them apart. */
export const onlineGameName = (size: number) => `hexon-${size}`;
export const makeOnlineHexon = (size: number): Game<GState> => ({ ...makeHexon(size, true), name: onlineGameName(size) });

