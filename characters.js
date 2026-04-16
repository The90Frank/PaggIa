/*
 * characters.js — Definizione dei personaggi giocabili e dei loro superpoteri.
 *
 * Ogni personaggio ha un potere unico che si attiva colpendo un target speciale (verde).
 * Il potere si attiva una sola volta per tiro.
 *
 * TIPI DI POTERE:
 *   blast    — Esplosione: distrugge tutti i target entro BLAST_RADIUS px
 *   spooky   — Palla Fantasma: la palla respawna dall'alto dopo essere caduta
 *   multiball— Triball: spawna 2 palle extra con velocità ruotate di ±20°
 *   freeze   — Congelamento: i target mobili si bloccano per il resto del tiro
 */

export const CHARACTERS = [
  {
    id: 'stella',
    name: 'Stella',
    emoji: '💥',
    color: '#e74c3c',
    power: 'Esplosione',
    desc: 'Colpisci un target verde per distruggere tutti i bersagli nel raggio di 180px',
    type: 'blast'
  },
  {
    id: 'boo',
    name: 'Boo',
    emoji: '👻',
    color: '#9b59b6',
    power: 'Palla Fantasma',
    desc: 'Colpisci un target verde: la palla cade e respawna dall\'alto un\'altra volta',
    type: 'spooky'
  },
  {
    id: 'trio',
    name: 'Trio',
    emoji: '🎯',
    color: '#2980b9',
    power: 'Triball',
    desc: 'Colpisci un target verde: dal punto di impatto partono 2 palle extra',
    type: 'multiball'
  },
  {
    id: 'zen',
    name: 'Zen',
    emoji: '❄️',
    color: '#16a085',
    power: 'Congelamento',
    desc: 'Colpisci un target verde: i target mobili si bloccano per il resto del tiro',
    type: 'freeze'
  }
];
