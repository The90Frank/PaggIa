// mapLoader.js
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
