"""HEX0N for TextArena: a two-player text environment.

Lives in integrations/textarena/. Moves are a piece letter, a column letter and
a row number, in brackets: [Sb2] is a square on column B, row 2. Long forms
work too: [square b2], [Square B 2]. Pieces: S square, C circle, T triangle,
H hex. Columns start at A on the left, rows at 1 on the top.

After a triangle completes a triad, the same player gets a second turn to
place the hex. If the triangle touches several circle+square pairs, the
removed pair is drawn with the env's seeded RNG. A player whose only legal
move is pass is passed automatically.

    import textarena as ta
    import hex0n_env  # registers HEX0N-v0 and HEX0N-v0-7x7
    env = ta.make("HEX0N-v0")
    env.reset(num_players=2, seed=0)
"""
import random
import re
import sys
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

import textarena as ta

# core rules in api/
sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "api"))
from hex0n import Hex0n, CHANCE, KIND_NAMES  # noqa: E402

LETTERS = "SCTH"
MOVE_RE = re.compile(r"\b(square|circle|triangle|hex|[scth])\s*([a-z])\s*,?\s*(\d{1,2})\b", re.I)
BRACKET_RE = re.compile(r"\[([^\[\]]*)\]")
PLAYER_NAMES = ("Blue", "Red")


class Hex0nEnv(ta.Env):
    def __init__(self, size: int = 5, tie_break: bool = True, opponent_pieces: bool = True):
        super().__init__()
        self.game = Hex0n(size=size, tie_break=tie_break, opponent_pieces=opponent_pieces)

    # ----- notation --------------------------------------------------------

    def _cell_name(self, cell: int) -> str:
        r, c = divmod(cell, self.game.size)
        return f"{chr(97 + c)}{r + 1}"

    def _move_name(self, action: int) -> str:
        kind, cell = divmod(action, self.game.cells)
        return LETTERS[kind] + self._cell_name(cell)

    def _parse(self, text: str) -> Optional[int]:
        """Action id for the last move written in brackets (else bare), or None."""
        candidates = [m for b in BRACKET_RE.findall(text) for m in MOVE_RE.finditer(b)]
        candidates = candidates or list(MOVE_RE.finditer(text))
        if not candidates:
            return None
        kind_s, col_s, row_s = candidates[-1].groups()
        col, row = ord(col_s.lower()) - 97, int(row_s) - 1
        if not (0 <= col < self.game.size and 0 <= row < self.game.size):
            return -1
        return self.game.action(LETTERS.index(kind_s[0].upper()), row, col)

    # ----- rendering -------------------------------------------------------

    def _render_board(self) -> str:
        n, s = self.game.size, self.hstate
        lines = ["   " + " ".join(chr(65 + c) for c in range(n))]
        for r in range(n):
            row = s.board[r * n:(r + 1) * n]
            lines.append(f"{r + 1:>2} " + " ".join(
                "." if p is None else (LETTERS[p[0]] if p[1] == 0 else LETTERS[p[0]].lower()) for p in row))
        return "\n".join(lines)

    def _legal_moves_str(self) -> str:
        groups: Dict[int, list] = {}
        for a in self.hstate.legal_actions():
            kind, cell = divmod(a, self.game.cells)
            groups.setdefault(kind, []).append(self._cell_name(cell))
        return "\n".join(f"  {KIND_NAMES[k]} ({LETTERS[k]}): {' '.join(cells)}" for k, cells in sorted(groups.items()))

    def _observe(self):
        s, pid = self.hstate, self.state.current_player_id
        task = "place the hex" if s.hex_options else "place a piece"
        self.state.add_observation(message=(
            f"Board (Blue = capitals, Red = lower case):\n{self._render_board()}\n\n"
            f"Hexes: Blue {s.hexes[0]}, Red {s.hexes[1]}. "
            f"Squares left: Blue {s.squares_left[0]}, Red {s.squares_left[1]}.\n"
            f"{PLAYER_NAMES[pid]} (Player {pid}) to {task}. Legal moves:\n{self._legal_moves_str()}"
        ), observation_type=ta.ObservationType.GAME_BOARD)

    def _prompt(self, player_id: int, game_state: Dict[str, Any]) -> str:
        g = self.game
        triad_rule = "at least one of the two yours" if g.opponent_pieces else "both of them yours"
        tie = "the larger connected group of hexes wins" if g.tie_break else "it is a draw"
        return (
            f"You are Player {player_id} ({PLAYER_NAMES[player_id]}) in HEX0N on a {g.size}x{g.size} board. "
            f"Your pieces are shown in {'capitals' if player_id == 0 else 'lower case'}.\n"
            "'Touching' means the 8 surrounding cells, diagonals included. Each turn you place one piece:\n"
            f"- Square (S): any empty cell. You have {g.squares_per_player} in total; removed squares do not come back.\n"
            "- Circle (C): an empty cell touching a square of either color.\n"
            f"- Triangle (T): an empty cell touching a circle and a square, {triad_rule}. "
            "The triangle, circle and square are removed (one pair at random if several qualify), "
            "and you immediately get another turn to place a hex (H) on one of the three cleared cells.\n"
            "Hexes are permanent and score 1 each. You pass automatically when you have no legal move. "
            f"The game ends when neither player can move. Most hexes wins; on equal hexes {tie}.\n\n"
            "Columns are letters (A on the left), rows are numbers (1 on top). "
            "Write your move in brackets as piece letter, column, row: e.g. '[Sb2]' places a square on B2, "
            "'[Tc3]' a triangle on C3, '[Hc3]' a hex on C3.\n"
        )

    # ----- game flow -------------------------------------------------------

    def reset(self, num_players: int, seed: Optional[int] = None):
        self.state = ta.TwoPlayerState(num_players=num_players, seed=seed, max_turns=self.game.max_game_length())
        self.hstate = self.game.new_state()
        self.rng = random.Random(seed)
        self.state.reset(game_state={"board": self.hstate.board}, player_prompt_function=self._prompt)
        self._observe()

    def _apply(self, action: int):
        """Apply a player's action, then resolve chance steps and automatic passes."""
        s, pid = self.hstate, self.state.current_player_id
        s.apply_action(action)
        msg = f"{PLAYER_NAMES[pid]} played {self._move_name(action)}."
        while not s.is_terminal():
            if s.current_player() == CHANCE:
                s.apply_action(self.rng.randrange(len(s.pairs)))
            elif s.legal_actions() == [self.game.pass_action]:
                s.apply_action(self.game.pass_action)
                msg += f" {PLAYER_NAMES[1 - s.player]} has no legal move and passes."
            else:
                break
        if s.hex_options and s.current_player() == pid:
            cleared = ", ".join(self._cell_name(c) for c in s.hex_options)
            msg += f" Triad completed: {cleared} cleared. {PLAYER_NAMES[pid]} now places the hex on one of them."
        self.state.add_observation(message=msg, observation_type=ta.ObservationType.GAME_ACTION_DESCRIPTION)

    def _finish(self):
        s, w = self.hstate, self.hstate.winner()
        score = f"Hexes: Blue {s.hexes[0]}, Red {s.hexes[1]}"
        if s.hexes[0] == s.hexes[1] and self.game.tie_break:
            score += f"; largest hex group: Blue {s.largest_group(0)}, Red {s.largest_group(1)}"
        if w is None:
            self.state.set_draw(reason=f"Draw. {score}.")
        else:
            self.state.set_winner(player_id=w, reason=f"{PLAYER_NAMES[w]} (Player {w}) wins. {score}.")

    def step(self, action: str) -> Tuple[bool, ta.Info]:
        pid = self.state.current_player_id
        self.state.add_observation(from_id=pid, message=action, observation_type=ta.ObservationType.PLAYER_ACTION)
        move = self._parse(action)
        if move is None:
            self.state.set_invalid_move(reason="No move found. Write it like '[Sb2]': piece letter (S, C, T, H), column letter, row number.")
        elif move == -1 or move not in self.hstate.legal_actions():
            self.state.set_invalid_move(reason=f"'{action.strip()[:40]}' is not a legal move now. Legal moves:\n{self._legal_moves_str()}")
        else:
            self._apply(move)
            if self.hstate.is_terminal():
                self._finish()
            else:
                self.state.manually_set_current_player_id(self.hstate.current_player())
        result = self.state.step(rotate_player=False)
        if not self.state.done:
            self._observe()
        return result


def _register():
    from textarena.envs import BOARDGAME_WRAPPERS, DEFAULT_WRAPPERS
    from textarena.envs.registration import ENV_REGISTRY, register_with_versions
    wrappers = {"default": DEFAULT_WRAPPERS, "-train": BOARDGAME_WRAPPERS}
    for env_id, size in (("HEX0N-v0", 5), ("HEX0N-v0-7x7", 7)):
        if env_id not in ENV_REGISTRY:
            register_with_versions(id=env_id, entry_point=Hex0nEnv, wrappers=wrappers, size=size)


_register()
