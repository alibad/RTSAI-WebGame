import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import ts from '../web/node_modules/typescript/lib/typescript.js';
const scratch=path.resolve(process.env.RTSAI_TEST_OUT||'artifacts/relay-unit');fs.mkdirSync(scratch,{recursive:true});
const source=fs.readFileSync('web/src/sim/companion.ts','utf8');const compiled=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ES2022}}).outputText;const target=path.join(scratch,'relay.mjs');fs.writeFileSync(target,compiled);
class Socket {static OPEN=1;constructor(){this.readyState=0;this.sent=[];}send(data){this.sent.push(data);}close(){this.readyState=3;}open(){this.readyState=1;this.onopen?.();}}
globalThis.WebSocket=Socket;const {CompanionRelay}=await import(pathToFileURL(target));const calls=[],states=[];const relay=new CompanionRelay('ws://fixture',{call:(...args)=>calls.push(args)},connected=>states.push(connected));
const packet=(id)=>{const header=new TextEncoder().encode(JSON.stringify({t:'call',id,method:'Observe'}));const buffer=new Uint8Array(4+header.length);new DataView(buffer.buffer).setUint32(0,header.length,true);buffer.set(header,4);return {data:buffer.buffer};};
relay.connect();const first=relay.ws;first.open();first.onmessage(packet(101));const firstCall=calls[0][0];relay.close();relay.connect();const second=relay.ws;second.open();first.onmessage(packet(999));first.onclose();assert.equal(calls.length,1);assert.equal(relay.ws,second);second.onmessage(packet(202));const secondCall=calls[1][0];assert.notEqual(firstCall,secondCall);relay.reply(firstCall,0,'',new Uint8Array());assert.equal(second.sent.length,0);relay.reply(secondCall,0,'',new Uint8Array());assert.equal(second.sent.length,1);
const originalResponse=globalThis.Response;const resolve=[];globalThis.Response=class{arrayBuffer(){return new Promise(done=>resolve.push(done));}};
const pending=relay.pushObservation(()=>new Uint8Array([8,1,82,2,1,2]));await Promise.resolve();relay.close();relay.connect();const third=relay.ws;third.open();for(const done of resolve)done(new Uint8Array([1]).buffer);await pending;globalThis.Response=originalResponse;assert.equal(third.sent.length,0);assert.equal(relay.sending,false);assert.equal(relay.lastTick,-1);
third.onmessage({data:new Uint8Array([1]).buffer});assert.equal(third.readyState,3);relay.close();console.log(JSON.stringify({passed:true,staleSocketCallIgnored:true,staleSocketCloseIgnored:true,oldEngineReplyIgnored:true,oldCompressedObservationDiscarded:true,monotonicCalls:true,malformedFrameClosed:true,states}));
