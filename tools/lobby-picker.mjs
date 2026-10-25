// Exercise the actual shadcn/Base UI pickers (web/src/components/ui/fields.tsx) instead of browser-native selectOption:
// OptionSelect (a Select popup of options) and SearchSelect (a Combobox popup whose search field narrows the options).
// `label` is the picker's aria-label: the match lobby's "Multiplayer map", "Player 2 faction", "AI 1 faction",
// "AI 1 difficulty", "AI 1 team" (ui/Multiplayer.tsx), or the skirmish screen's "Opponent 1 nation" and
// "Opponent 1 AI profile" (ui/Setup.tsx). `value` is the option's id (map id, faction id, bot type, team number).
export async function chooseLobbyOption(page,label,value){
 const name=await page.evaluate(({label,value})=>{
  const s=window.store.getState().setup;
  if(label==='Multiplayer map'||label==='Map')return s.maps.find(m=>m.id===value)?.title;
  if(label.endsWith(' faction')||label.endsWith(' nation'))return s.factions.find(f=>f.id===value)?.name;
  if(label.endsWith(' difficulty')||label.endsWith(' AI profile'))return s.bots.find(b=>b.type===value)?.name;
  if(label.endsWith(' team'))return Number(value)?`Team ${value}`:'No team';
 },{label,value});
 if(!name)throw Error(`Unknown lobby option: ${label}=${value}`);
 await page.getByLabel(label,{exact:true}).click();
 // Both pickers portal their popup to <body>. A SearchSelect popup opens with its search input (placeholder
 // "Search…" / "Search nations…" / "Find a map…"); typing the option's name narrows the list to it.
 const popup=page.locator('[data-slot="combobox-content"], [data-slot="select-content"]').last();
 await popup.waitFor();
 const search=popup.locator('input');
 if(await search.count())await search.fill(name);
 await popup.getByRole('option').filter({hasText:name}).first().click();
 await popup.waitFor({state:'hidden',timeout:10000}).catch(()=>{});
}
