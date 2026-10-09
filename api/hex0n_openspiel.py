"""Registers HEX0N with OpenSpiel as "python_hex0n".

    import pyspiel, hex0n_openspiel
    game = pyspiel.load_game("python_hex0n", {"size": 5, "tie_break": True, "opponent_pieces": True})

All rules live in hex0n.py; this file only adapts them to OpenSpiel's interface.
"""
import numpy as np
import pyspiel
from open_spiel.python.observation import IIGObserverForPublicInfoGame

from hex0n import CHANCE, TERMINAL, Hex0n

_DEFAULTS = {"size": 5, "tie_break": True, "opponent_pieces": True}

_GAME_TYPE = pyspiel.GameType(
    short_name="python_hex0n",
    long_name="Python HEX0N",
    dynamics=pyspiel.GameType.Dynamics.SEQUENTIAL,
    chance_mode=pyspiel.GameType.ChanceMode.EXPLICIT_STOCHASTIC,  # the random triad pick
    information=pyspiel.GameType.Information.PERFECT_INFORMATION,
    utility=pyspiel.GameType.Utility.ZERO_SUM,
    reward_model=pyspiel.GameType.RewardModel.TERMINAL,
    max_num_players=2,
    min_num_players=2,
    provides_information_state_string=True,
    provides_information_state_tensor=False,
    provides_observation_string=True,
    provides_observation_tensor=True,
    parameter_specification=_DEFAULTS,
)


class Hex0nGame(pyspiel.Game):
    def __init__(self, params=None):
        p = {**_DEFAULTS, **(params or {})}
        self.rules = Hex0n(p["size"], p["tie_break"], p["opponent_pieces"])
        info = pyspiel.GameInfo(
            num_distinct_actions=self.rules.num_actions,
            max_chance_outcomes=16,  # at most 4 circles x 4 squares around a triangle
            num_players=2,
            min_utility=-1.0,
            max_utility=1.0,
            utility_sum=0.0,
            max_game_length=self.rules.max_game_length(),
        )
        super().__init__(_GAME_TYPE, info, p)

    def new_initial_state(self):
        return Hex0nSpielState(self)

    def make_py_observer(self, iig_obs_type=None, params=None):
        # Same split as OpenSpiel's tic_tac_toe.py: the board for observations,
        # the move history when an information state (perfect recall) is asked for.
        if iig_obs_type is None or (iig_obs_type.public_info and not iig_obs_type.perfect_recall):
            return Hex0nObserver(self.rules.size)
        return IIGObserverForPublicInfoGame(iig_obs_type, params)


class Hex0nSpielState(pyspiel.State):
    def __init__(self, game):
        super().__init__(game)
        self.s = game.rules.new_state()  # the actual game state (hex0n.Hex0nState)

    def current_player(self):
        p = self.s.current_player()
        if p == TERMINAL:
            return pyspiel.PlayerId.TERMINAL
        return pyspiel.PlayerId.CHANCE if p == CHANCE else p

    def _legal_actions(self, player):
        return self.s.legal_actions()

    def chance_outcomes(self):
        return self.s.chance_outcomes()

    def _apply_action(self, action):
        self.s.apply_action(action)

    def _action_to_string(self, player, action):
        return self.s.action_to_string(action)

    def is_terminal(self):
        return self.s.is_terminal()

    def returns(self):
        return self.s.returns()

    def __str__(self):
        return str(self.s)


class Hex0nObserver:
    """Board planes from the observing player's point of view, shape (11, N, N):

    0-3   my square, circle, triangle, hex       4-7   the opponent's
    8     empty                                  9     cells where a hex may go now
    10    my squares left minus the opponent's, scaled to [-1, 1] (whole plane)
    """

    def __init__(self, size):
        shape = (11, size, size)
        self.tensor = np.zeros(np.prod(shape), np.float32)
        self.dict = {"observation": self.tensor.reshape(shape)}

    def set_from(self, state, player):
        s, obs = state.s, self.dict["observation"]
        obs.fill(0)
        planes = obs.reshape(11, -1)  # one row per plane, one column per cell
        for cell, piece in enumerate(s.board):
            if piece is None:
                planes[8, cell] = 1
            else:
                kind, owner = piece
                planes[kind + (0 if owner == player else 4), cell] = 1
        for cell in s.hex_options or []:
            planes[9, cell] = 1
        diff = s.squares_left[player] - s.squares_left[1 - player]
        planes[10] = diff / s.game.squares_per_player

    def string_from(self, state, player):
        return str(state.s)


# OpenSpiel may ship its own python_hex0n one day; register only if it is not there yet.
if _GAME_TYPE.short_name not in pyspiel.registered_names():
    pyspiel.register_game(_GAME_TYPE, Hex0nGame)
