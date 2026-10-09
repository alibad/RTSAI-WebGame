import { useEffect, useRef, useState } from 'react';
import { MessageSquare, X } from 'lucide-react';
import { Button } from '../components/ui/button';
export type ChatMessage = { id: string; author: string; text: string };
export function MatchChat({ messages, send, inputLabel = 'Room chat message' }: {
 messages: ChatMessage[]; send: (text: string) => Promise<void>; inputLabel?: string;
}) {
 const [open,setOpen]=useState(false),[draft,setDraft]=useState(''),[sending,setSending]=useState(false),[error,setError]=useState(''),[now,setNow]=useState(Date.now());
 const input=useRef<HTMLInputElement>(null),log=useRef<HTMLDivElement>(null),arrivals=useRef(new Map<string,number>()),pending=useRef(false),previousFocus=useRef<HTMLElement|null>(null);
 for(const m of messages)if(!arrivals.current.has(m.id))arrivals.current.set(m.id,Date.now());
 function compose(){previousFocus.current=document.activeElement instanceof HTMLElement?document.activeElement:null;setOpen(true);}
 function close(){setOpen(false);if(previousFocus.current?.isConnected&&!previousFocus.current.closest('.mp-corner-chat'))previousFocus.current.focus({preventScroll:true});else document.querySelector<HTMLCanvasElement>('canvas.stage')?.focus({preventScroll:true});}
 useEffect(()=>{if(open)input.current?.focus();},[open]);
 useEffect(()=>{const ids=new Set(messages.map(m=>m.id));for(const id of arrivals.current.keys())if(!ids.has(id))arrivals.current.delete(id);},[messages]);
 useEffect(()=>{if(log.current)log.current.scrollTop=log.current.scrollHeight;},[messages.length,open]);
 useEffect(()=>{const timer=setInterval(()=>setNow(Date.now()),1000);return()=>clearInterval(timer);},[]);
 useEffect(()=>{
  const key=(e:KeyboardEvent)=>{
   if(e.isComposing||e.repeat||e.ctrlKey||e.metaKey||e.altKey)return;
   if(open&&e.key==='Escape'&&e.target instanceof Node&&input.current?.closest('.mp-corner-chat')?.contains(e.target)){e.preventDefault();e.stopImmediatePropagation();close();return;}
   const target=e.target as HTMLElement|null;
   if(e.key!=='Enter'||open||target?.closest('input,textarea,select,button,a,[contenteditable="true"],[role="dialog"]'))return;
   e.preventDefault();e.stopImmediatePropagation();compose();
  };
  window.addEventListener('keydown',key,true);return()=>window.removeEventListener('keydown',key,true);
 },[open]);
 async function submit(){const text=draft.trim();if(!text||pending.current)return;pending.current=true;setSending(true);setError('');try{await send(text);setDraft('');close();}catch(e){setError(e instanceof Error?e.message:'Message could not be sent. Try again.');input.current?.focus();}finally{pending.current=false;setSending(false);}}
 const visible=open?messages.slice(-100):messages.filter(m=>now-(arrivals.current.get(m.id)??0)<15000).slice(-4);
 return <section aria-label="Match chat" className={`mp-corner-chat ${open?'is-open hud-panel':''}`}>
  <div className="mp-corner-chat-heading"><Button variant="ghost" size="sm" aria-expanded={open} onClick={()=>open?close():compose()}><MessageSquare size={14}/>Chat<kbd>Enter</kbd></Button>{open&&<Button variant="ghost" size="sm" aria-label="Close room chat" onClick={close}><X size={14}/></Button>}</div>
  <div ref={log} role="log" aria-label="Chat messages" aria-live="polite" aria-relevant="additions" className="mp-corner-chat-feed">{visible.map(m=><p key={m.id}><strong>{m.author}</strong><span>{m.text}</span></p>)}{open&&!messages.length&&<p className="mp-chat-empty">Coordinate with your commanders here.</p>}</div>
  {open&&<form onSubmit={e=>{e.preventDefault();void submit();}}><input ref={input} aria-label={inputLabel} placeholder="Message your commanders..." maxLength={500} value={draft} onChange={e=>setDraft(e.target.value)} onKeyDown={e=>{if(!e.nativeEvent.isComposing)e.stopPropagation();}}/><Button size="sm" type="submit" disabled={sending||!draft.trim()}>{sending?'Sending...':'Send'}</Button><small>Enter to send <span>Esc to return to game</span></small>{error&&<p role="alert" className="mp-chat-send-error">{error}</p>}</form>}
 </section>;
}
