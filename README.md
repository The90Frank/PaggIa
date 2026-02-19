# PaggIa

A physics-based cannon game built with vanilla JavaScript and HTML5 Canvas. Aim, shoot, and hit targets with realistic gravity, bouncing, and collision detection.

## How to play

1. Open `index.html` in a browser
2. Move the mouse to aim - a trajectory preview is drawn in real time
3. Click to fire the ball
4. Hit all targets before running out of shots
5. Each target hit scores 100 points

## Features

- **Real-time trajectory preview** with bounce prediction
- **Physics simulation** with configurable gravity and restitution
- **Circular and rotated rectangular targets**
- **Adjustable parameters** via the control panel (gravity, speed, ball radius, max bounces, etc.)
- **Level configuration** loaded from `map.json`

## Project structure

```
PaggIa/
├── index.html        # Entry point with canvas and controls
├── logic.js          # Game state, rendering, input handling, animation
├── engine.js         # Physics engine: trajectory, collisions, reflections
├── mapLoader.js      # Async JSON map loader
├── map.json          # Level layout and physics parameters
├── styles.css        # UI styling (dark theme, responsive)
└── styles_game.css   # Game element colors and theming
```

## Configuration

Edit `map.json` to customize the level:

| Parameter | Default | Description |
|---|---|---|
| `gravity` | 980 | Gravity in px/s² |
| `restitution` | 0.8 | Bounce energy retention (0-1) |
| `ballRadius` | 10 | Ball radius in px |
| `defaultSpeed` | 700 | Shot speed in px/s |
| `shotsTotal` | 10 | Number of available shots |

Targets can be `circle` (x, y, r) or `rect` (x, y, width, height, angle).

## Tech stack

- Vanilla JavaScript (ES6 modules)
- HTML5 Canvas 2D API
- No external dependencies

## License

Apache License 2.0 - see [LICENSE](LICENSE) for details.
