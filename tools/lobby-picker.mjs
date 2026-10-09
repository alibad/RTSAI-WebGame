// Exercise the actual shadcn/Base UI popup instead of browser-native selectOption.
export async function chooseLobbyOption(page,label,value){
 const name=await page.evaluate(({label,value})=>{
  const s=window.store.getState().setup;
  if(label==='Multiplayer map')return s.maps.find(m=>m.id===value)?.title;
  if(label.endsWith(' faction'))return s.factions.find(f=>f.id===value)?.name;
  if(label.endsWith(' difficulty'))return s.bots.find(b=>b.type===value)?.name;
  if(label.endsWith(' team'))return Number(value)?`Team ${value}`:'No team';
 },{label,value});
 if(!name)throw Error(`Unknown lobby option: ${label}=${value}`);
 await page.getByLabel(label,{exact:true}).click();
 if(label.endsWith(' faction'))await page.getByPlaceholder('Search factions…',{exact:true}).fill(name);
 await page.getByRole('option').filter({hasText:name}).click();
}
