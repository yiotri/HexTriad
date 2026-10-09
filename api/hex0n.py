"""HEX0N core rules in plain Python (no dependencies).

Two players place pieces on an N x N board. "Touching" always means the 8
surrounding cells (diagonals included).

  square    any empty cell; each player has a limited supply (about N*N / 3)
  circle    an empty cell touching any square
  triangle  an empty cell touching a circle and a square, at least one of
            them yours (or both yours, with opponent_pieces=False). The three
            pieces are removed and, in the same turn, you place a hex on one
            of the three cleared cells. A hex is permanent and scores 1.
  pass      only allowed when you have no other legal move

The game ends when neither player can move. Most hexes wins; on equal hexes
the larger connected group of hexes wins (tie_break=True), else it's a draw.

Moves are plain integers so the game plugs into OpenSpiel:
  action = kind * N*N + cell    (kind: SQUARE, CIRCLE, TRIANGLE, HEX)
  action = N*N * 4              pass
If a triangle touches several valid circle+square pairs, one is removed at
random. That pick is an explicit chance step: current_player() returns CHANCE
and chance_outcomes() lists the pairs, each equally likely.

    game = Hex0n(size=5)
    state = game.new_state()
    state.apply_action(game.action(SQUARE, row=2, col=2))
"""

SQUARE, CIRCLE, TRIANGLE, HEX = range(4)
KIND_NAMES = ("square", "circle", "triangle", "hex")
CHANCE, TERMINAL = -1, -4  # the same ids OpenSpiel uses


class Hex0n:
    """Game settings and the pieces derived from them (shared by all states)."""

    def __init__(self, size=5, tie_break=True, opponent_pieces=True):
        self.size = size
        self.cells = size * size
        self.tie_break = tie_break              # equal hexes: largest hex group wins
        self.opponent_pieces = opponent_pieces  # triads may use an opponent's circle or square
        self.squares_per_player = round(self.cells / 3)  # 8 on 5x5, 16 on 7x7
        self.pass_action = 4 * self.cells
        self.num_actions = self.pass_action + 1
        self.neighbors = [self._neighbors(c) for c in range(self.cells)]

    def _neighbors(self, cell):
        r, c = divmod(cell, self.size)
        return [rr * self.size + cc
                for rr in (r - 1, r, r + 1) for cc in (c - 1, c, c + 1)
                if (rr, cc) != (r, c) and 0 <= rr < self.size and 0 <= cc < self.size]

    def new_state(self):
        return Hex0nState(self)

    def action(self, kind, row, col):
        """Action id for placing `kind` at (row, col)."""
        return kind * self.cells + row * self.size + col

    def max_game_length(self):
        """Safe upper bound on the number of actions in a game (chance steps included).

        Every triad leaves a permanent hex, so there are at most N*N triads. Each
        triad is a triangle, a chance pick and a hex, and removes one circle. The
        squares run out. A pass is always followed by a real move.
        """
        moves = 2 * self.squares_per_player + 2 * self.cells + 3 * self.cells
        return 2 * moves + 1


class Hex0nState:
    def __init__(self, game):
        self.game = game
        self.board = [None] * game.cells  # each cell: None or (kind, owner)
        self.player = 0                   # whose turn it is (player 0 starts)
        self.squares_left = [game.squares_per_player] * 2
        self.hexes = [0, 0]
        self.pairs = []          # (circle, square) pairs waiting for the chance pick
        self.triangle = None     # cell of the triangle waiting for that pick
        self.hex_options = None  # the cleared cells, while a hex must be placed
        self.over = False

    # ----- queries ---------------------------------------------------------

    def current_player(self):
        if self.over:
            return TERMINAL
        return CHANCE if self.pairs else self.player

    def is_terminal(self):
        return self.over

    def legal_actions(self):
        if self.over:
            return []
        if self.pairs:  # chance step: outcome k removes pairs[k]
            return list(range(len(self.pairs)))
        if self.hex_options:
            return [HEX * self.game.cells + c for c in self.hex_options]
        return self._placements(self.player) or [self.game.pass_action]

    def chance_outcomes(self):
        """[(outcome, probability)] at a chance step, else []."""
        return [(k, 1 / len(self.pairs)) for k in range(len(self.pairs))]

    def triad_pairs(self, cell, player):
        """(circle, square) pairs touching `cell` that a triangle by `player` could remove."""
        near = [(n, self.board[n]) for n in self.game.neighbors[cell] if self.board[n]]
        circles = [(n, p[1]) for n, p in near if p[0] == CIRCLE]
        squares = [(n, p[1]) for n, p in near if p[0] == SQUARE]
        mine = any if self.game.opponent_pieces else all  # how many of the two must be mine
        return [(c, s) for c, c_owner in circles for s, s_owner in squares
                if mine((c_owner == player, s_owner == player))]

    def _touches(self, cell, kind):
        return any(self.board[n] and self.board[n][0] == kind for n in self.game.neighbors[cell])

    def _placements(self, player):
        """Every square, circle and triangle `player` could place now."""
        n, actions = self.game.cells, []
        for cell in range(n):
            if self.board[cell] is not None:
                continue
            if self.squares_left[player] > 0:
                actions.append(SQUARE * n + cell)
            if self._touches(cell, SQUARE):
                actions.append(CIRCLE * n + cell)
            if self.triad_pairs(cell, player):
                actions.append(TRIANGLE * n + cell)
        return sorted(actions)

    def largest_group(self, player):
        """Size of `player`'s largest group of touching hexes."""
        seen, best = set(), 0
        for start in range(self.game.cells):
            if self.board[start] != (HEX, player) or start in seen:
                continue
            stack, size = [start], 0
            seen.add(start)
            while stack:
                cell = stack.pop()
                size += 1
                for n in self.game.neighbors[cell]:
                    if n not in seen and self.board[n] == (HEX, player):
                        seen.add(n)
                        stack.append(n)
            best = max(best, size)
        return best

    def winner(self):
        """0 or 1 once the game is over; None for a draw or a game still running."""
        if not self.over:
            return None
        a, b = self.hexes
        if a == b and self.game.tie_break:
            a, b = self.largest_group(0), self.largest_group(1)
        return None if a == b else (0 if a > b else 1)

    def returns(self):
        """[+1, -1], [-1, +1] or [0, 0] at the end; [0, 0] before it."""
        w = self.winner()
        return [0.0, 0.0] if w is None else [1.0 - 2 * w, 2 * w - 1.0]

    # ----- making moves ----------------------------------------------------

    def apply_action(self, action):
        if action not in self.legal_actions():
            raise ValueError(f"illegal action {action}")
        if self.pairs:  # chance picked which pair goes
            self._remove_triad(self.pairs[action])
            return
        if action == self.game.pass_action:
            self._end_turn()
            return
        kind, cell = divmod(action, self.game.cells)
        p = self.player
        self.board[cell] = (kind, p)
        if kind == SQUARE:
            self.squares_left[p] -= 1
        elif kind == HEX:
            self.hexes[p] += 1
            self.hex_options = None
        elif kind == TRIANGLE:
            pairs = self.triad_pairs(cell, p)
            self.triangle = cell
            if len(pairs) == 1:
                self._remove_triad(pairs[0])
            else:
                self.pairs = pairs  # wait for the chance step
            return  # same player continues with the hex
        self._end_turn()

    def _remove_triad(self, pair):
        cleared = sorted([self.triangle, *pair])
        for cell in cleared:
            self.board[cell] = None
        self.hex_options = cleared
        self.pairs, self.triangle = [], None

    def _end_turn(self):
        self.player = 1 - self.player
        if not self._placements(0) and not self._placements(1):
            self.over = True

    # ----- helpers ---------------------------------------------------------

    def clone(self):
        new = object.__new__(Hex0nState)
        new.__dict__.update(self.__dict__)
        new.board, new.squares_left, new.hexes = self.board[:], self.squares_left[:], self.hexes[:]
        new.pairs = self.pairs[:]
        new.hex_options = self.hex_options and self.hex_options[:]
        return new

    def action_to_string(self, action):
        if self.pairs:
            circle, square = self.pairs[action]
            return f"remove circle {self._rc(circle)} + square {self._rc(square)}"
        if action == self.game.pass_action:
            return "pass"
        kind, cell = divmod(action, self.game.cells)
        return f"{KIND_NAMES[kind]} {self._rc(cell)}"

    def _rc(self, cell):
        return "(%d,%d)" % divmod(cell, self.game.size)

    def __str__(self):
        """Player 0 in capitals (S C T H), player 1 in lower case, '.' empty."""
        rows = []
        for r in range(self.game.size):
            row = self.board[r * self.game.size:(r + 1) * self.game.size]
            rows.append(" ".join("." if p is None else
                                 "SCTH"[p[0]] if p[1] == 0 else "scth"[p[0]] for p in row))
        who = {TERMINAL: "game over", CHANCE: "chance"}.get(self.current_player(),
                                                           f"player {self.player} to move")
        rows.append(f"hexes {self.hexes}  squares left {self.squares_left}  {who}")
        return "\n".join(rows)


if __name__ == "__main__":
    # Play one random game and print it.
    import random
    state = Hex0n().new_state()
    while not state.is_terminal():
        action = random.choice(state.legal_actions())
        print(state.current_player(), state.action_to_string(action))
        state.apply_action(action)
    print(state, "\nwinner:", state.winner())
