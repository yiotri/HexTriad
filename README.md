# HEX0N

HEX0N is a two-player abstract strategy game. You place squares, circles and triangles on a small grid and complete square–circle–triangle triads, which collapse into permanent hexes. Most hexes wins.

It offers an abstract layer for modeling the economic reasoning of intelligent agents: players spend a scarce, depletable resource, build on each other's investments, and weigh uncertain payoffs against an adaptive opponent. It is also well suited to benchmarking AI agents of any kind, from search programs and reinforcement learners to LLMs.

- **Play it:** open `site/index.html` in a browser. Play a friend on the same screen or take on the built-in bot.
- **Use it in code:** `api/` has the rules in plain Python, plus an [OpenSpiel](https://github.com/google-deepmind/open_spiel) adapter.
- **Listen to it:** `sound/` holds generative music made from games played by four AI agents, each trained under its own set of rules.

## Rules

Two players, Blue (player 0) and Red (player 1), share an N×N board. It is 5×5 by default; 7×7 is the extended mode. "Touching" always means the 8 surrounding cells, diagonals included.

On your turn you place one piece:

| Piece | Where it can go |
|---|---|
| **Square** | Any empty cell. Each player has a limited supply of `round(N²/3)`: 8 on 5×5, 16 on 7×7. Squares that are removed do not come back. |
| **Circle** | An empty cell touching a square of either color. |
| **Triangle** | An empty cell touching a circle and a square (any colors), as long as at least one of the two is yours. |

**Triads.** When you place a triangle, the triangle, the circle and the square are all removed. Then, in the same turn, you place a **hex** on one of those three cleared cells. Hexes are permanent and each one scores a point. If the triangle touches several eligible circle+square pairs, one of them is chosen at random, each with equal chance.

**Passing.** You may pass only when you have no legal placement.

**End of the game.** The game ends when neither player can move (for example, when the board is full). The player with more hexes wins. If both have the same number, the player with the larger connected group of hexes (diagonals connect) wins. If those are equal too, the game is a draw.

## Python

`api/hex0n.py` is the rules engine. It is a single file with no dependencies. Moves are integers.

```python
from hex0n import Hex0n, SQUARE, CIRCLE

game = Hex0n(size=5)                   # tie_break=True, opponent_pieces=True by default
state = game.new_state()
state.apply_action(game.action(SQUARE, row=2, col=2))
state.apply_action(game.action(CIRCLE, row=1, col=1))
print(state)                           # Blue in capitals, Red in lower case
print([state.action_to_string(a) for a in state.legal_actions()][:5])
```

Running `python hex0n.py` plays one random game and prints it.

### Variants

| Parameter | Default | Effect |
|---|---|---|
| `size` | `5` | Board width and height. |
| `tie_break` | `True` | With equal hexes, the larger connected hex group wins. If `False`, equal hexes is simply a draw. |
| `opponent_pieces` | `True` | A triad may use an opponent's circle or square. If `False`, both must be the mover's own. |

## OpenSpiel

```bash
pip install open_spiel
```

```python
import pyspiel
import hex0n_openspiel  # registers "python_hex0n" (run from the python/ folder)

game = pyspiel.load_game("python_hex0n", {"size": 5, "tie_break": True, "opponent_pieces": True})
```

Once the game is loaded, OpenSpiel's algorithms work on it as they do on any built-in game, for example MCTS, AlphaZero and the RL environments.

- **Actions:** `kind × N² + cell`, where kind is 0 square, 1 circle, 2 triangle, 3 hex, and `cell = row × N + col`. Pass is `4 × N²`. That gives 101 actions on 5×5.
- **Chance:** a triangle that touches more than one eligible pair creates a chance node. `chance_outcomes()` lists the pairs with equal probability. A triangle with only one eligible pair resolves directly. The game type is `EXPLICIT_STOCHASTIC` with perfect information.
- **Observation:** 11 planes × N × N, seen from the observing player's side:
  - planes 0–3: own squares, circles, triangles, hexes
  - planes 4–7: the opponent's squares, circles, triangles, hexes
  - plane 8: empty cells
  - plane 9: cells where a hex may be placed
  - plane 10: the difference in squares left
- **Returns:** +1 / −1 for a win or loss, 0 for a draw.

The rules engine has been checked against the game's own implementation (`online/source/game.ts`) on 3,000 random games on 4×4, 5×5 and 7×7 boards. The legal moves agreed at all 177,228 steps, and every final result matched.

## Build the light version

You need Node.js 18 or later:

```bash
npm install
npm run build
```

## Online play

`online/` contains the multiplayer server and the rules file it shares with the page (`online/source/game.ts`, built on [boardgame.io](https://boardgame.io)). To run the server, you need Node.js 18 or later:

```bash
cd online/server
npm install
npm run build
ORIGINS=https://yoursite.example npm start   # the address of the site hosting the game
```

The server keeps matches in memory, so restarting it ends games in progress. To test on one computer, leave out `ORIGINS` (localhost is always allowed).

## Music

`sound/` holds two album sides and their cover:

- **Eight sonifications.** These are games played by four AI agents, each trained under its own set of rules, with every move a note. Four duels are played as drum-machine pads, and four as two pianos drifting apart.
- **Nine soundtrack tracks.** These come from a later version of the game. The music is synthesized in real time.

## Repository layout

| Path | Contents |
|---|---|
| `site/` | The polished version: a single self-contained page that can be installed as an app. |
| `HexTriad.tsx`, `entry.tsx`, `tw.in.css`, `build-html.js`, `sw.template.js`, `public/` | Source of the light version: rules, bot and UI in one React file. |
| `api/` | Rules engine and OpenSpiel adapter. |
| `online/` | Multiplayer server and its shared rules. |
| `sound/` | Generative soundtrack and sonification of agentic play. |
| `specs/` | Product, game and engineering specification (PDF). |
