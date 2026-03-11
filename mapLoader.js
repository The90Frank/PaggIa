/*
 * mapLoader.js — Caricamento asincrono della mappa JSON dal server.
 *
 * Usato da game.js e editor.js per caricare map.json al bootstrap.
 * Ritorna l'oggetto mappa parsato, o null in caso di errore.
 * Cache disabilitata (no-store) per sviluppo.
 */

/**
 * Carica una mappa JSON da URL.
 * @param {string} url - Path al file JSON (default: './map.json')
 * @returns {Promise<object|null>} Oggetto mappa o null se errore
 */
export async function loadMap(url = './map.json'){
  try{
    const res = await fetch(url, {cache: "no-store"});
    if(!res.ok) throw new Error('Unable to load map: ' + res.status);
    const json = await res.json();
    return json;
  } catch(err){
    console.error(err);
    return null;
  }
}
